from .nodes import RuiCPoseAtlasLoader

WEB_DIRECTORY = "web"

NODE_CLASS_MAPPINGS = {
    "RuiCPoseAtlasLoader": RuiCPoseAtlasLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "RuiCPoseAtlasLoader": "三图组合 · RuiC 图鉴",
}

try:
    from . import api as _api

    _api.register()
except Exception as _e:  # 预览接口不是必需能力，失败不影响节点
    print(f"[RuiC PoseAtlas] 预览接口加载失败（不影响出图）：{_e}")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
