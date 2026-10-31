"""前端用的轻量接口：姿势深度图预览 + 深度模型状态/下载。"""

from __future__ import annotations

import asyncio
import io

from aiohttp import web

try:
    from .atlas_io import get_manager
    from . import da_depth
except ImportError:  # pragma: no cover
    from atlas_io import get_manager
    import da_depth

_CACHE = {}
_CACHE_MAX = 256


def _render(kind: str, item_id: str, quality: str):
    m = get_manager(None)
    item = m.get_item_by_id(kind, item_id) if m else None
    if item is None:
        return None
    img = m.get_image(item, quality)
    if img is None:
        return None
    img, _how = da_depth.pose_to_depth(img)
    if img is None:          # 转不出来，前端会退回线稿预览
        return None
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=88)
    return buf.getvalue()


def _render_cached(kind: str, item_id: str, quality: str):
    key = (kind, item_id, quality)
    if key in _CACHE:
        return _CACHE[key]
    data = _render(kind, item_id, quality)
    if data:
        if len(_CACHE) >= _CACHE_MAX:
            _CACHE.clear()
        _CACHE[key] = data
    return data


def register():
    try:
        from server import PromptServer
        routes = PromptServer.instance.routes
    except Exception as e:  # pragma: no cover
        print(f"[RuiC PoseAtlas] 接口未注册（{e}），前端会退回显示原线稿预览。")
        return

    @routes.get("/ruic/depth")
    async def _ruic_depth(request):
        kind = request.query.get("kind", "pose")
        item_id = request.query.get("id", "")
        quality = request.query.get("q", "thumb")
        if not item_id:
            return web.Response(status=400, text="missing id")
        try:
            data = await asyncio.to_thread(_render_cached, kind, item_id, quality)
        except Exception as e:
            print(f"[RuiC PoseAtlas] 深度预览失败 {kind}/{item_id}: {e}")
            return web.Response(status=500, text=str(e))
        if not data:
            return web.Response(status=404, text="not found")
        return web.Response(body=data, content_type="image/jpeg",
                            headers={"Cache-Control": "public, max-age=86400"})

    @routes.get("/ruic/depth/status")
    async def _ruic_depth_status(request):
        try:
            return web.json_response(da_depth.status())
        except Exception as e:
            return web.json_response({"ready": False, "error": str(e)})

    @routes.post("/ruic/depth/download")
    async def _ruic_depth_download(request):
        try:
            started = da_depth.start_download()
            return web.json_response({"started": started, **da_depth.status()})
        except Exception as e:
            return web.json_response({"started": False, "error": str(e)}, status=500)

    print("[RuiC PoseAtlas] 接口已注册：GET /ruic/depth、/ruic/depth/status、POST /ruic/depth/download")
