"""RuiC-PoseAtlas 数据加载与取图。

三种素材：
  - pose     姿势：data/poses.json -> poses[]，每组含 1-5 个视角变体
  - costume  衣装：data/costumes.json -> costumes[]
  - portrait 人像：data/faces.json -> images[]（原图仅在远程）

图片/数据来源（按优先级）：
  1) 本地仓库目录（atlas_path 指向克隆后的仓库）
  2) 远程多线路（同一份站点的不同 CDN，任一条通即可）：
       - https://hruiccc.github.io/RuiC-PoseAtlas/            （GitHub Pages，主站）
       - https://fastly.jsdelivr.net/gh/HRuiCcc/RuiC-PoseAtlas@main/   （国内通常最快）
       - https://cdn.jsdelivr.net/gh/HRuiCcc/RuiC-PoseAtlas@main/
     站点根目录 == 仓库根目录，所以 data/、thumbs/、costume/thumbs/、portrait/thumbs/
     在三路上路径一致，可互为镜像。
  3) 人像原图直连 pages.dev（仅在仓库里没有该文件时使用）

国内网络要点：
  - 解析结果里 IPv6 常排在前面，而 Python 的 urllib 不像浏览器那样会快速回退 IPv4，
    容易卡在不通的 IPv6 上直到超时 -> 这里请求期间强制优先 IPv4。
  - 三份 JSON 会缓存到本地磁盘，首次成功后即便断网也能启动；缩略图同样本地缓存。
"""

import contextlib
import hashlib
import http.client
import io
import json
import os
import socket
import ssl
import tempfile
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import List, Optional

# ---- 站点根地址（= 仓库根）与各 CDN 镜像 ----
GH_PAGES = "https://hruiccc.github.io/RuiC-PoseAtlas/"
JSDELIVR_FASTLY = "https://fastly.jsdelivr.net/gh/HRuiCcc/RuiC-PoseAtlas@main/"
JSDELIVR_CDN = "https://cdn.jsdelivr.net/gh/HRuiCcc/RuiC-PoseAtlas@main/"

# 顺序即尝试顺序；主站排第一，失败会很快切到 jsDelivr
SITE_BASES = [GH_PAGES, JSDELIVR_FASTLY, JSDELIVR_CDN]

REMOTE_DATA_BASE = GH_PAGES + "data/"
PORTRAIT_REMOTE = "https://ai-portrait-gallery.pages.dev/img/"

# 模块级缓存：key -> AtlasManager
_MANAGERS = {}

# 节点目录（用于存放 JSON / 图片缓存，重启后依然有效）
_NODE_DIR = Path(__file__).resolve().parent
_DATA_CACHE_DIR = _NODE_DIR / ".cache" / "data"

_FALLBACK_CHOICES = {
    "pose_series": ["ALL"],
    "pose_category": ["ALL"],
    "pose_angle": ["ALL"],
    "costume_cat": ["ALL"],
    "costume_group": ["ALL"],
    "costume_color": ["ALL"],
    "portrait_sec": ["ALL"],
    "portrait_hair": ["ALL"],
}

_HTTP_TIMEOUT = 12
_JSON_TIMEOUT = 8              # 三份数据 JSON 较小，超时压短，失败能尽快切线路
_IMG_TIMEOUT = 8
_DATA_TTL = 7 * 24 * 3600      # 数据缓存有效期（秒）
_DATA_STALE_OK = 90 * 24 * 3600  # 全部线路都失败时，允许使用多久以内的旧缓存

# 线路健康度：连续失败的线路会被降权（记录到 3 分钟内）
_BAD_BASE = {}

# 断网熔断：全部线路都失败后，一段时间内不再尝试联网（避免每次排队都卡几分钟）
_NET_DOWN_UNTIL = 0.0
_NET_COOLDOWN = 60.0


def _net_is_down() -> bool:
    return time.time() < _NET_DOWN_UNTIL


def _mark_net_down(reason: str = "") -> None:
    global _NET_DOWN_UNTIL
    _NET_DOWN_UNTIL = time.time() + _NET_COOLDOWN
    if reason:
        print(f"[RuiC PoseAtlas] 网络不可用（{reason}），{int(_NET_COOLDOWN)} 秒内不再重试联网，"
              f"将使用本地缓存；若缓存缺失则输出 1x1 占位。")


def _base_rank(base: str) -> int:
    t = _BAD_BASE.get(base)
    if t and time.time() - t < 180:
        return 1
    return 0


def _ordered_bases() -> List[str]:
    return sorted(SITE_BASES, key=_base_rank)


def _read_json(path: Path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


_GAI_LOCK = threading.Lock()


@contextlib.contextmanager
def _ipv4_preferred():
    """兜底方案：请求期间让 DNS 只返回 IPv4（仅在自定义连接不可用时使用）。"""
    with _GAI_LOCK:
        orig = socket.getaddrinfo

        def _gai(host, port, family=0, type=0, proto=0, flags=0):
            try:
                infos = orig(host, port, socket.AF_INET, type, proto, flags)
                if infos:
                    return infos
            except Exception:
                pass
            return orig(host, port, family, type, proto, flags)

        socket.getaddrinfo = _gai
        try:
            yield
        finally:
            socket.getaddrinfo = orig


class _IPv4HTTPSConnection(http.client.HTTPSConnection):
    """只解析 A 记录（IPv4）再连接。

    国内很多网络 IPv6 不通，而解析结果通常把 AAAA 排在前面；浏览器会并发尝试并很快
    回退 IPv4，Python 的 urllib 则会在第一个地址上干等到超时（实测 4.2s vs 0.9s）。
    """

    def connect(self):
        infos = socket.getaddrinfo(self.host, self.port,
                                   socket.AF_INET, socket.SOCK_STREAM)
        sock = None
        last_err = None
        for af, socktype, proto, _canon, sa in infos:
            try:
                s = socket.socket(af, socktype, proto)
                s.settimeout(self.timeout)
                s.connect(sa)
                sock = s
                break
            except OSError as e:
                last_err = e
                try:
                    s.close()
                except Exception:
                    pass
        if sock is None:
            raise last_err or OSError("connect failed")
        if self._tunnel_host:
            self.sock = sock
            self._tunnel()
        self.sock = self._context.wrap_socket(
            sock, server_hostname=self._tunnel_host or self.host)


def _build_opener(force_direct: bool):
    """force_direct=True 时忽略一切代理（环境变量/系统代理），直连。"""
    def make_handler():
        ctx = ssl.create_default_context()

        class _Handler(urllib.request.HTTPSHandler):
            def __init__(self):
                super().__init__(context=ctx)

            def https_open(self, req):
                return self.do_open(_IPv4HTTPSConnection, req, context=ctx)

        return _Handler()

    try:
        if force_direct:
            # 空 ProxyHandler 会覆盖环境变量与系统代理，即纯直连
            return urllib.request.build_opener(
                urllib.request.ProxyHandler({}), make_handler())
        return urllib.request.build_opener(make_handler())
    except Exception:
        return None


try:
    _OPENER_DIRECT = _build_opener(True)   # 直连（首选）
except Exception:
    _OPENER_DIRECT = None
try:
    _OPENER_PROXY = _build_opener(False)   # 走系统/环境代理（次选）
except Exception:
    _OPENER_PROXY = None

# 最近一次失败原因（供上层打印）
_LAST_ERR = ""

# 直连连续失败计数：达到阈值后改为"代理优先"，避免每个请求都先白等一次超时
_DIRECT_FAILS = 0
_DIRECT_FAIL_LIMIT = 2


def _fetch_bytes(url: str, timeout: int = _HTTP_TIMEOUT, retries: int = 0) -> Optional[bytes]:
    """下载：先直连，再走代理，最后系统默认。

    ComfyUI 是独立进程，可能继承到失效的代理环境变量（例如 Clash 关了但变量还在），
    那样每个请求都会连上本地代理后挂到超时。所以这里优先无视代理直连；
    若直连连续失败，则自动改为代理优先。
    """
    global _LAST_ERR, _DIRECT_FAILS
    modes = []
    if _OPENER_DIRECT is not None:
        modes.append(("direct", _OPENER_DIRECT))
    if _OPENER_PROXY is not None:
        modes.append(("proxy", _OPENER_PROXY))
    modes.append(("default", None))   # 兜底：urllib 默认 + 限制 IPv4
    if _DIRECT_FAILS >= _DIRECT_FAIL_LIMIT:
        modes.sort(key=lambda m: 0 if m[0] == "proxy" else 1)

    last_err = None
    for attempt in range(retries + 1):
        for name, op in modes:
            try:
                req = urllib.request.Request(url, headers={
                    "User-Agent": "Mozilla/5.0 (RuiC-PoseAtlas-Loader)",
                    "Accept": "*/*",
                })
                if op is None:
                    with _ipv4_preferred():
                        with urllib.request.urlopen(req, timeout=timeout) as r:
                            data = r.read()
                else:
                    with op.open(req, timeout=timeout) as r:
                        data = r.read()
                if name == "direct":
                    _DIRECT_FAILS = 0
                return data
            except urllib.error.HTTPError as e:
                # 4xx/5xx 属于"服务器有回应"，不算直连不可用
                last_err = e
                if name == "direct":
                    _DIRECT_FAILS = 0
            except Exception as e:
                last_err = e
                if name == "direct":
                    _DIRECT_FAILS += 1
        if attempt < retries:
            time.sleep(0.4 * (attempt + 1))
    _LAST_ERR = f"{type(last_err).__name__}: {last_err}" if last_err else "unknown"
    return None


def _fetch_json_multi(name: str) -> Optional[dict]:
    """按线路顺序拉取 data/<name>，任一条成功即用。"""
    if _net_is_down():
        return None
    for base in _ordered_bases():
        url = base + "data/" + name
        data = _fetch_bytes(url, timeout=_JSON_TIMEOUT)
        if not data:
            _BAD_BASE[base] = time.time()
            continue
        try:
            obj = json.loads(data.decode("utf-8"))
        except Exception:
            continue
        _BAD_BASE.pop(base, None)
        return obj
    _mark_net_down(f"{name} 三条线路均失败（{_LAST_ERR}）")
    return None


def _cache_file(name: str) -> Path:
    return _DATA_CACHE_DIR / name


def _cache_age(name: str) -> Optional[float]:
    p = _cache_file(name)
    try:
        return time.time() - p.stat().st_mtime
    except Exception:
        return None


def _write_cache(name: str, obj) -> None:
    try:
        _DATA_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        p = _cache_file(name)
        tmp = p.with_suffix(p.suffix + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
        os.replace(tmp, p)
    except Exception:
        pass


class AtlasManager:
    def __init__(self, root: Optional[str] = None):
        self.root = Path(root) if root and Path(root).exists() else None
        self.items: List[dict] = []
        self.kinds: dict = {"pose": [], "costume": [], "portrait": []}
        self.choice_lists: dict = dict(_FALLBACK_CHOICES)
        self.by_id = {}
        self._load()

    # ---------- 加载 ----------
    def _load_json_named(self, name: str) -> Optional[dict]:
        # 1) 本地仓库目录
        if self.root:
            local = self.root / "data" / name
            if local.exists():
                try:
                    return _read_json(local)
                except Exception:
                    pass

        # 2) 本地缓存（新鲜则直接用，启动快、断网也能用）
        age = _cache_age(name)
        if age is not None and age < _DATA_TTL:
            try:
                return _read_json(_cache_file(name))
            except Exception:
                pass

        # 3) 多线路远程
        obj = _fetch_json_multi(name)
        if obj:
            _write_cache(name, obj)
            return obj

        # 4) 过期缓存兜底
        if age is not None and age < _DATA_STALE_OK:
            print(f"[RuiC PoseAtlas] {name} 在线获取失败，使用本地缓存（{age/3600:.1f} 小时前）。")
            try:
                return _read_json(_cache_file(name))
            except Exception:
                pass

        print(f"[RuiC PoseAtlas] {name} 获取失败：三条线路均不可达（GitHub Pages / jsDelivr）。")
        return None

    def _load(self):
        # 三个 JSON 并行下载，冷启动更快（已缓存时几乎瞬时）
        names = ("poses.json", "costumes.json", "faces.json")
        try:
            with ThreadPoolExecutor(max_workers=3) as ex:
                pose, costume, face = list(ex.map(self._load_json_named, names))
        except Exception:
            pose, costume, face = (self._load_json_named(n) for n in names)

        if pose:
            self._load_poses(pose)
        if costume:
            self._load_costumes(costume)
        if face:
            self._load_faces(face)

        for kind in self.kinds:
            self.kinds[kind] = [it for it in self.items if it["kind"] == kind]
        self.by_id = {(it["kind"], it["id"]): it for it in self.items}
        self._build_choice_lists()

    def get_item_by_id(self, kind: str, id_: str):
        return self.by_id.get((kind, id_))

    def _load_poses(self, data):
        for pose in data.get("poses", []):
            names = pose.get("names", {})
            base_name = names.get("zh") or names.get("en") or pose.get("id", "")
            for v in pose.get("variants", []):
                angle = v.get("angle", "")
                self.items.append({
                    "kind": "pose",
                    "id": f"{pose.get('id')}_{angle}",
                    "name": f"{base_name} · {angle}",
                    "thumb_rel": v.get("thumb"),
                    "full_rel": v.get("full"),
                    "thumb_url": (GH_PAGES + v["thumb"]) if v.get("thumb") else None,
                    "full_url": (GH_PAGES + v["full"]) if v.get("full") else None,
                    "sub": {
                        "series": pose.get("series", ""),
                        "category": pose.get("category", ""),
                        "angle": angle,
                    },
                })

    def _load_costumes(self, data):
        for c in data.get("costumes", []):
            self.items.append({
                "kind": "costume",
                "id": c.get("id", ""),
                "name": c.get("id", ""),
                "thumb_rel": c.get("thumb"),
                "full_rel": c.get("image"),
                "thumb_url": (GH_PAGES + c["thumb"]) if c.get("thumb") else None,
                "full_url": (GH_PAGES + c["image"]) if c.get("image") else None,
                "sub": {
                    "cat": c.get("cat", ""),
                    "group": c.get("group", ""),
                    "color": c.get("color", ""),
                    "tags": c.get("tags", []),
                },
            })

    def _load_faces(self, data):
        for img in data.get("images", []):
            self.items.append({
                "kind": "portrait",
                "id": img.get("id", ""),
                "name": f"{img.get('sec', '')}/{img.get('hair', '')}",
                "thumb_rel": img.get("thumb"),
                "full_rel": img.get("full"),
                "thumb_url": img.get("thumb_remote") or (
                    (GH_PAGES + img["thumb"]) if img.get("thumb") else None),
                "full_url": img.get("full_remote") or (
                    (GH_PAGES + img["full"]) if img.get("full") else None),
                "sub": {
                    "sec": img.get("sec", ""),
                    "hair": img.get("hair", ""),
                    "style": img.get("style", ""),
                },
            })

    def _build_choice_lists(self):
        def keys(kind, field):
            vals = set()
            for it in self.kinds.get(kind, []):
                v = it["sub"].get(field)
                if isinstance(v, list):
                    vals.update(v)
                elif v:
                    vals.add(v)
            return ["ALL"] + sorted(str(x) for x in vals)

        self.choice_lists = {
            "pose_series": keys("pose", "series"),
            "pose_category": keys("pose", "category"),
            "pose_angle": keys("pose", "angle"),
            "costume_cat": keys("costume", "cat"),
            "costume_group": keys("costume", "group"),
            "costume_color": keys("costume", "color"),
            "portrait_sec": keys("portrait", "sec"),
            "portrait_hair": keys("portrait", "hair"),
        }

    # ---------- 选择 ----------
    def select(self, kind: str, filters: dict, rng):
        pool = list(self.kinds.get(kind, []))
        for field, val in filters.items():
            if not val or val == "ALL":
                continue
            pool = [it for it in pool if _match(it["sub"].get(field), val)]
        if not pool:
            return None
        return rng.choice(pool)

    # ---------- 取图 ----------
    def _cache_dir(self) -> Path:
        if self.root:
            d = self.root / ".ruic_cache"
        else:
            d = _NODE_DIR / ".cache" / "img"
        try:
            d.mkdir(parents=True, exist_ok=True)
        except Exception:
            return Path(tempfile.gettempdir())
        return d

    @staticmethod
    def _cached_path(cache_dir: Path, key: str, url: str) -> Path:
        ext = ".png" if url.lower().endswith(".png") else (
            ".jpg" if url.lower().endswith(".jpg") else ".webp")
        h = hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]
        return cache_dir / (h + ext)

    def candidate_urls(self, item, quality: str) -> List[str]:
        """按线路顺序给出该素材的候选地址（镜像之间路径一致，可互换）。

        缩略图：优先按相对路径走各镜像（thumbs 在各站点都齐全，命中快）。
        原图：优先用 item 自带的 primary 地址。人像原图（4.5GB 级）并未随仓库发布，
        portrait/img/*.png 在 GitHub Pages 与 jsDelivr 上均为 404，只有 primary
        （ai-portrait-gallery.pages.dev）能取到，先试镜像只会白等三个 404。
        """
        rel = item.get("thumb_rel") if quality == "thumb" else item.get("full_rel")
        primary = item.get("thumb_url") if quality == "thumb" else item.get("full_url")
        urls: List[str] = []

        def _add(u):
            if u and u not in urls:
                urls.append(u)

        if quality != "thumb":
            _add(primary)
        if rel:
            rel = str(rel).lstrip("/")
            for base in _ordered_bases():
                _add(base + rel)
        if quality == "thumb":
            _add(primary)
        return urls

    def get_image(self, item, quality: str, allow_remote: bool = True):
        if item is None:
            return None
        rel = item["thumb_rel"] if quality == "thumb" else item["full_rel"]
        urls = self.candidate_urls(item, quality)

        # 1) 本地仓库目录
        if self.root and rel:
            local = self.root / rel
            if local.exists():
                from PIL import Image
                return Image.open(local).convert("RGB")

        if not allow_remote or not urls:
            return None

        # 2) 磁盘缓存（以相对路径为 key：换线路也不会重复下载）
        from PIL import Image
        cache_dir = self._cache_dir()
        cpath = self._cached_path(cache_dir, str(rel or urls[0]), urls[0])
        if cpath.exists():
            try:
                return Image.open(cpath).convert("RGB")
            except Exception:
                try:
                    cpath.unlink()
                except Exception:
                    pass

        # 3) 依次尝试各线路
        if _net_is_down():
            print(f"[RuiC PoseAtlas] 网络处于冷却期，跳过远程取图：{item.get('id')}")
            return None
        for url in urls:
            data = _fetch_bytes(url, timeout=_IMG_TIMEOUT)
            if not data:
                continue
            try:
                img = Image.open(io.BytesIO(data)).convert("RGB")
            except Exception:
                continue
            try:
                cpath.write_bytes(data)
            except Exception:
                pass
            return img

        print(f"[RuiC PoseAtlas] 取图失败（已尝试 {len(urls)} 条线路）：{item.get('id')}　"
              f"最后错误：{_LAST_ERR}")
        print(f"[RuiC PoseAtlas] 首个线路示例：{urls[0] if urls else '无'}")
        return None


def _match(value, wanted):
    if isinstance(value, list):
        return wanted in value
    return str(value) == str(wanted)


def get_manager(path: Optional[str]) -> Optional[AtlasManager]:
    key = path or "__REMOTE__"
    m = _MANAGERS.get(key)
    # 只有缓存里确实有数据才复用；若为空（首次加载时网络抖动/超时），
    # 则重建一次，避免"空管理器被永久缓存 → 永远输出 1x1"。
    if m is not None and m.items:
        return m
    m = AtlasManager(path)  # 本地不存在时自动退化为远程模式
    if m.items:
        k = m.kinds
        print(f"[RuiC PoseAtlas] 素材库已就绪：共 {len(m.items)} 项"
              f"（人像 {len(k['portrait'])} / 衣装 {len(k['costume'])} / 姿势 {len(k['pose'])}）")
    else:
        print("[RuiC PoseAtlas] 警告：素材库加载为空（三条线路均不可达），本次将输出 1x1 占位；"
              "下次排队会自动重建。可尝试开启代理，或检查能否访问 hruiccc.github.io。")
    _MANAGERS[key] = m
    return m


def choice_lists_for(path: str) -> dict:
    m = get_manager(path)
    if m and m.items:
        return m.choice_lists
    return dict(_FALLBACK_CHOICES)
