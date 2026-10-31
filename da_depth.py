"""真实深度模型（DepthAnything V2 Small）接入 + 自动下载 + 内置兜底。

为什么用它
----------
姿势素材是三维人偶的白底线稿。DepthAnything 在这类图上表现很好：输出一张干净的
立体人形灰度图，比纯形态学的"距离变换体积图"更贴近真实几何，侧面 / 高位这类
线稿跟不住的姿势明显更稳。实测 vits(95MB) / vitb(372MB) / vitl(1.25GB) 三档在
这类线稿上视觉几乎无差别，所以选最小的 vits。

零硬依赖
--------
1. 本机装了 comfyui_controlnet_aux → 只借用它的 DPT 实现（不改它任何文件）；
2. 权重缺失 → 前端弹确认框，用户同意后从魔搭下载 95MB 到插件自己的 .cache/models；
3. 上面都没有 → 回退 pose_depth 的内置体积图，节点照常能跑。
"""

from __future__ import annotations

import os
import sys
import threading
import urllib.request

MODEL_FILE = "depth_anything_v2_vits.pth"
MODEL_MB = 94.6
MIN_SHORT = 518       # DA 训练分辨率
MAX_SHORT = 1024      # 再大只是变慢，细节不会更多
MIN_BYTES = 80 * 1024 * 1024

_PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
_CUSTOM_NODES = os.path.dirname(_PLUGIN_DIR)

# 魔搭在国内直连可用；HF 作为备用（大概率连不上，但聊胜于无）
_URLS = [
    "https://www.modelscope.cn/models/depth-anything/Depth-Anything-V2-Small"
    "/resolve/master/" + MODEL_FILE,
    "https://huggingface.co/depth-anything/Depth-Anything-V2-Small"
    "/resolve/main/" + MODEL_FILE,
]

_DL = {"running": False, "pct": 0, "error": "", "done": False}
_LOCK = threading.Lock()


# ---------------------------------------------------------------- 路径探测
def _aux_dir():
    """找 comfyui_controlnet_aux 的安装目录（名字可能有大小写/连字符差异）。"""
    try:
        for name in sorted(os.listdir(_CUSTOM_NODES)):
            if "controlnet" not in name.lower() or "aux" not in name.lower():
                continue
            p = os.path.join(_CUSTOM_NODES, name)
            if os.path.isdir(os.path.join(p, "src", "custom_controlnet_aux")):
                return p
    except Exception:
        pass
    return None


def _candidate_paths():
    out = [os.path.join(_PLUGIN_DIR, ".cache", "models", MODEL_FILE)]
    aux = _aux_dir()
    if aux:
        out.append(os.path.join(aux, "ckpts", "depth-anything",
                                "Depth-Anything-V2-Small", MODEL_FILE))
        out.append(os.path.join(aux, "ckpts", MODEL_FILE))
    return out


def model_path():
    """返回一个可用的权重路径；没有则 None。"""
    for p in _candidate_paths():
        try:
            if os.path.isfile(p) and os.path.getsize(p) >= MIN_BYTES:
                return p
        except OSError:
            pass
    return None


def status():
    p = model_path()
    return {
        "ready": bool(p),
        "path": p or _candidate_paths()[0],
        "aux": _aux_dir() is not None,
        "downloading": _DL["running"],
        "pct": _DL["pct"],
        "error": _DL["error"],
        "mb": MODEL_MB,
    }


# ---------------------------------------------------------------- 下载
def _fetch(url, tmp):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (RuiC PoseAtlas)"})
    # 先直连（魔搭不走代理更快），失败再试系统代理
    openers = [urllib.request.build_opener(urllib.request.ProxyHandler({})),
               urllib.request.build_opener()]
    err = None
    for op in openers:
        try:
            with op.open(req, timeout=40) as r, open(tmp, "wb") as f:
                total = int(r.headers.get("Content-Length") or 0)
                got = 0
                while True:
                    chunk = r.read(262144)
                    if not chunk:
                        break
                    f.write(chunk)
                    got += len(chunk)
                    if total:
                        _DL["pct"] = max(1, min(99, int(got * 100 / total)))
            if os.path.getsize(tmp) >= MIN_BYTES:
                return
            err = RuntimeError("文件不完整")
        except Exception as e:  # noqa: BLE001
            err = e
    raise err or RuntimeError("下载失败")


def _do_download():
    dst = _candidate_paths()[0]
    tmp = dst + ".part"
    last = ""
    try:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        for url in _URLS:
            try:
                _DL["pct"] = 0
                _fetch(url, tmp)
                os.replace(tmp, dst)
                _DL.update(running=False, pct=100, done=True, error="")
                print(f"[RuiC PoseAtlas] 深度模型下载完成：{dst}")
                return
            except Exception as e:  # noqa: BLE001
                last = f"{url.split('/')[2]}：{e}"
                print(f"[RuiC PoseAtlas] 深度模型下载失败（{last}）")
        _DL.update(running=False, error=last or "下载失败")
    finally:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass


def start_download():
    """启动后台下载；已在下载中则直接返回 False。"""
    with _LOCK:
        if _DL["running"]:
            return False
        _DL.update(running=True, pct=0, error="", done=False)
    threading.Thread(target=_do_download, daemon=True).start()
    return True


# ---------------------------------------------------------------- 推理
_DET = None


def _detector():
    global _DET
    if _DET is not None:
        return _DET
    aux = _aux_dir()
    if not aux:
        raise RuntimeError("没找到 comfyui_controlnet_aux，无法使用深度模型")
    path = model_path()
    if not path:
        raise RuntimeError("深度模型未下载")
    for p in (os.path.join(aux, "src"), aux):
        if p not in sys.path:
            sys.path.insert(0, p)
    import torch  # noqa: F401
    from custom_controlnet_aux.depth_anything_v2.dpt import DepthAnythingV2
    from custom_controlnet_aux.depth_anything_v2 import DepthAnythingV2Detector

    model = DepthAnythingV2(encoder="vits", features=64, out_channels=[48, 96, 192, 384])
    model.load_state_dict(torch.load(path, map_location="cpu"))
    model.eval()
    det = DepthAnythingV2Detector(model, MODEL_FILE)
    try:
        import comfy.model_management as mm
        dev = mm.get_torch_device()
    except Exception:
        dev = "cuda" if torch.cuda.is_available() else "cpu"
    det.to(dev)
    _DET = det
    print(f"[RuiC PoseAtlas] 深度模型已加载：{os.path.basename(path)} @ {dev}")
    return det


def convert(img):
    """线稿 -> 深度图（尺寸与原图完全一致，保证出图画布不变）。"""
    global _DET
    import numpy as np
    import torch
    from PIL import Image

    det = _detector()
    rgb = img.convert("RGB")
    arr = np.asarray(rgb)
    h, w = arr.shape[:2]
    short = max(MIN_SHORT, min(MAX_SHORT, min(h, w)))
    try:
        with torch.no_grad():
            dep = det.model.infer_image(arr[:, :, ::-1].copy(), input_size=short)
        dep = np.asarray(dep, dtype=np.float32)
        mn, mx = float(dep.min()), float(dep.max())
        dep = (dep - mn) / (mx - mn) * 255.0 if mx > mn else np.zeros_like(dep)
        out = Image.fromarray(dep.astype(np.uint8), mode="L").resize((w, h), Image.LANCZOS)
        return out.convert("RGB")
    except Exception:
        _DET = None      # 例如显存不足：丢掉缓存，下次重新加载
        raise


def pose_to_depth(img):
    """姿势线稿 -> 深度图。返回 (图, 方式)；方式 = 'da' / 'cpu' / None（都失败）。"""
    if model_path():
        try:
            return convert(img), "da"
        except Exception as e:  # noqa: BLE001
            print(f"[RuiC PoseAtlas] 深度模型推理失败，改用内置体积图：{e}")
    try:
        try:
            from . import pose_depth
        except ImportError:
            import pose_depth  # type: ignore
        out = pose_depth.lineart_to_depth(img)
        if out is not None:
            return out, "cpu"
    except Exception as e:  # noqa: BLE001
        print(f"[RuiC PoseAtlas] 内置体积图也失败：{e}")
    return None, None
