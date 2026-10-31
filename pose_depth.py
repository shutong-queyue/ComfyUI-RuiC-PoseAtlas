"""姿势素材预处理：把「白底黑线的人偶线稿」转成「有体积感的灰度深度图」。

为什么需要它
------------
素材库里的姿势参考是三维人偶的白底线稿：大片留白 + 细细的轮廓线。
Qwen-Image-Edit 对这类图的构图权重很低 —— 尤其侧躺、高位俯视这类姿态，
模型会退回参考服装图里的站姿。换成一张"实心、有明暗"的灰度图后，
人形边界变成一整块连续区域，模型更容易把它当成"人体轮廓"而不是"几根线"。

为什么不用 Depth Anything
------------------------
线稿本身没有真实景深信息，任何深度模型对它都只能"猜"。而这里要的其实只是
"把轮廓内填实 + 给一点体积感"，用形态学 + 距离变换就能做到，几十毫秒、
零模型下载、零额外依赖（只用到 ComfyUI 自带的 opencv / numpy）。
若装了 comfyui_controlnet_aux，用户仍可在工作流里自行接 DepthAnything，
本模块不与之冲突。

算法
----
1. 灰度化 -> 取反，线条变高值，用 Otsu 二值化；
2. 极小闭运算补断线（核要小，否则手指缝会被糊死）；
3. 从四角泛洪填充「外部白区」，没被填到的就是人体内部 —— 这比大核闭运算
   精确得多，手指之间的缝隙会自然保留；
4. 对内部掩膜做距离变换：中心离边界远 -> 亮，边缘 -> 暗，得到浮雕感；
   再抬一个亮度下限，避免细手臂/手指暗到和背景分不清；
5. 用掩膜的外轮廓压暗一圈，保留清晰的人形边界；背景纯黑。
"""

from __future__ import annotations

import numpy as np
from PIL import Image

try:
    import cv2
except Exception:  # pragma: no cover - ComfyUI 正常都带 opencv
    cv2 = None


def available() -> bool:
    return cv2 is not None


def _fill_holes(line: np.ndarray) -> np.ndarray:
    """从四角泛洪填外部白区，返回「人体内部」掩膜。轮廓必须闭合，否则会漏。"""
    h, w = line.shape
    ff = line.copy()
    m = np.zeros((h + 2, w + 2), np.uint8)
    for seed in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        cv2.floodFill(ff, m, seed, 255)
    return (m[1:-1, 1:-1] == 0).astype(np.uint8) * 255


def _seal_edges(line: np.ndarray) -> np.ndarray:
    """把「被画布切断」的人体断口封上。

    上半身像是胸像，人体在画面底边被裁断，轮廓是个开口；侧卧图也常压在左右边。
    泛洪会从这个口子灌进去，把整个身体当成外部背景，于是输出一张近乎全黑的图。
    这里在断口所在的那条边上，把“最外侧两个接触点”之间连成一条线，等于把口子缝上。
    """
    h, w = line.shape
    out = line.copy()
    edges = [
        ("bottom", line[h - 1, :], lambda a, b: out.__setitem__((slice(h - 1, h), slice(a, b + 1)), 255)),
        ("top", line[0, :], lambda a, b: out.__setitem__((slice(0, 1), slice(a, b + 1)), 255)),
        ("left", line[:, 0], lambda a, b: out.__setitem__((slice(a, b + 1), slice(0, 1)), 255)),
        ("right", line[:, w - 1], lambda a, b: out.__setitem__((slice(a, b + 1), slice(w - 1, w)), 255)),
    ]
    for _name, arr, draw in edges:
        idx = np.nonzero(arr > 0)[0]
        if idx.size >= 4 and (idx.max() - idx.min()) >= max(4, int(len(arr) * 0.03)):
            draw(int(idx.min()), int(idx.max()))
    return out


# 闭运算核的比例（相对图像短边）。从小到大试：核小能保留手指缝，
# 但某些视角（斜角、手臂压住躯干）线稿本身是断的，需要更大的核把缺口缝上。
_RATIOS = (0.008, 0.014, 0.022, 0.034, 0.050, 0.070, 0.095)
_MIN_COVER = 0.06      # 人体通常占画面 15%~40%；低于 6% 说明轮廓没闭合、泛洪漏了


def _body_mask(gray: np.ndarray):
    """线稿 -> 实心人体掩膜。返回 None 表示这张图轮廓补不上，不适合转深度。"""
    h, w = gray.shape
    inv = 255 - gray
    _, base = cv2.threshold(inv, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if int(base.sum()) == 0:
        return None
    base = _seal_edges(base)

    best, best_cover = None, -1.0
    short = min(h, w)
    for r in _RATIOS:
        k = max(3, int(round(short * r)) | 1)
        if k > 3:
            ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
            line = cv2.morphologyEx(base, cv2.MORPH_CLOSE, ker)
        else:
            line = base
        body = _fill_holes(line)
        cover = float(body.mean()) / 255.0
        if cover >= _MIN_COVER:
            return body
        if cover > best_cover:
            best, best_cover = body, cover
    return None


def lineart_to_depth(img: Image.Image):
    """线稿 -> 灰度体积图，尺寸与原图完全一致（image_1 的尺寸决定出图画布，不能变）。

    返回 None 表示这张素材轮廓补不上（例如某些斜角视角线稿是断的），
    调用方应原样输出线稿，而不是输出一张黑图。
    """
    if cv2 is None:
        return None
    rgb = img.convert("RGB")
    gray = np.array(rgb.convert("L"))
    h, w = gray.shape
    if h < 8 or w < 8:
        return None

    body = _body_mask(gray)
    if body is None or int(body.sum()) == 0:
        return None

    # 补回原始线条：某些视角（斜角、手臂贴在躯干前）轮廓补不上，只能靠大核闭运算
    # 强行缝合，代价是细手臂会被抹平。把原始线条并回掩膜，至少保住手臂的位置。
    inv = 255 - gray
    _, base = cv2.threshold(inv, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    mask = cv2.bitwise_or(body, base)

    dist = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    mx = float(dist.max()) or 1.0
    d = np.clip(dist / mx, 0.0, 1.0) ** 0.60
    d = 0.45 + 0.55 * d                      # 亮度下限：细手臂不会黑成背景
    ks = max(3, min(9, int(round(min(h, w) * 0.004)) | 1))
    d = cv2.GaussianBlur(d, (ks, ks), 0)
    dep = (d * 240.0 + 10.0).astype(np.float32)

    edge = cv2.morphologyEx(mask, cv2.MORPH_GRADIENT,
                            np.ones((3, 3), np.uint8)).astype(np.float32) / 255.0
    edge = cv2.GaussianBlur(edge, (3, 3), 0)
    out = dep * (1.0 - 0.70 * edge)
    out[mask == 0] = 0.0

    arr = np.clip(out, 0, 255).astype(np.uint8)
    return Image.fromarray(arr, mode="L").convert("RGB").resize(rgb.size, Image.BILINEAR)
