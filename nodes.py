"""RuiC-PoseAtlas 三图组合节点（真正可运行版）。

输出：人像 / 衣装 / 姿势 三张 IMAGE（被「屏蔽」的类别输出 1x1 占位图），外加一个 STRING 信息输出。

选取逻辑（两种并存）：
  - 若某类别的「选定ID」非空 → 直接加载该 ID 的图片（前端卡片「🎲 随机」会写入此值，保证预览=出图）。
  - 否则按「随机种子 + 类别偏移」% 素材池长度 确定性选取（前端未锁定时用此公式，与预览一致）。
"""

import random

import numpy as np
import torch
from PIL import Image

try:
    from .atlas_io import get_manager, _match
except ImportError:  # 直接以脚本方式运行时
    from atlas_io import get_manager, _match

# ---------------- 中文显示映射 ----------------
ZH = {
    "duo": "双人", "full_sexy": "性感全身", "full_std": "标准全身", "upper": "上半身",
    "diagonal": "斜角", "front": "正面", "high": "高位", "low": "低位", "side": "侧面",
    "autumn": "秋季", "lingerie": "内衣", "party": "派对", "sexy": "性感", "spring": "春季",
    "summer": "夏季", "swimwear": "泳装", "winter": "冬季",
    "accessory": "配饰", "bag": "包袋", "bottom": "下装", "dress": "连衣裙", "inner": "内搭",
    "outer": "外套", "shoes": "鞋履", "skirt": "半裙", "swim": "泳衣", "top": "上装",
    "beige": "米色", "black": "黑色", "blue": "蓝色", "brown": "棕色", "burgundy": "酒红",
    "cream": "奶油", "gold": "金色", "green": "绿色", "grey": "灰色", "ivory": "象牙白",
    "khaki": "卡其", "lavender": "薰衣草紫", "mint": "薄荷绿", "navy": "藏青", "olive": "橄榄绿",
    "orange": "橙色", "pink": "粉色", "purple": "紫色", "red": "红色", "silver": "银色",
    "white": "白色", "yellow": "黄色",
    "face": "脸模", "styling": "造型",
    "long": "长发", "medium": "中发", "semilong": "中长发", "short": "短发",
}
ZH_TO_EN = {v: k for k, v in ZH.items()}


def _zh(val):
    return "全部" if val in ("ALL", "全部") else ZH.get(val, val)


# 子分类静态默认值（离线/无 JS 时也能用；JS 会按需补全为完整列表）
_SUBCAT_DEFAULTS = {
    "pose_series": ["ALL", "duo", "full_sexy", "full_std", "upper"],
    "pose_category": ["ALL", "侧卧位", "侧坐・女孩坐", "前倾", "可爱系", "后仰・挺背", "后入位",
                      "坐位", "坐位贴身", "坐姿", "性感・大胆系", "扭身", "挤胸・强调事业线系",
                      "正常位（传教士）", "特殊", "立位", "立位贴身", "站姿", "背向坐位", "贴脸系",
                      "贴身", "趴卧", "跪立", "跪立・四肢着地", "蹲姿", "面对面坐位", "骑乘位"],
    "pose_angle": ["ALL", "diagonal", "front", "high", "low", "side"],
    "costume_cat": ["ALL", "autumn", "lingerie", "party", "sexy", "spring", "summer", "swimwear", "winter"],
    "costume_group": ["ALL", "accessory", "bag", "bottom", "dress", "inner", "outer", "shoes", "skirt", "swim", "top"],
    "costume_color": ["ALL", "beige", "black", "blue", "brown", "burgundy", "cream", "gold", "green",
                      "grey", "ivory", "khaki", "lavender", "mint", "navy", "olive", "orange", "pink",
                      "purple", "red", "silver", "white", "yellow"],
    "portrait_sec": ["ALL", "face", "styling"],
    "portrait_hair": ["ALL", "long", "medium", "semilong", "short"],
}


def _options(key):
    return ([_zh(v) for v in _SUBCAT_DEFAULTS[key]],)


def _placeholder():
    """被屏蔽 / 无图时的 1x1 占位张量 [1,1,1,3]。"""
    return torch.zeros((1, 1, 1, 3), dtype=torch.float32)


def _to_tensor(img: Image.Image):
    arr = np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(arr)[None, ...]  # [1,H,W,3]


class RuiCPoseAtlasLoader:
    CATEGORY = "RuiC/三图组合"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 默认第一项即默认值：默认出原图，避免误用缩略图（400x500 级别）
                "质量": (["原图", "缩略图"],),
                "随机种子": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
                "每次随机": ("BOOLEAN", {"default": False}),
                "启用_人像": ("BOOLEAN", {"default": True}),
                "启用_衣装": ("BOOLEAN", {"default": True}),
                "启用_姿势": ("BOOLEAN", {"default": True}),
                "人像_选定ID": ("STRING", {"default": "", "multiline": False,
                                        "tooltip": "留空=按筛选+种子随机；填入ID则直接锁定该图"}),
                "衣装_选定ID": ("STRING", {"default": "", "multiline": False,
                                        "tooltip": "留空=按筛选+种子随机；填入ID则直接锁定该图"}),
                "姿势_选定ID": ("STRING", {"default": "", "multiline": False,
                                        "tooltip": "留空=按筛选+种子随机；填入ID则直接锁定该图"}),
                "人像_分区": _options("portrait_sec"),
                "人像_发型": _options("portrait_hair"),
                "衣装_季节": _options("costume_cat"),
                "衣装_品类": _options("costume_group"),
                "衣装_色系": _options("costume_color"),
                "姿势_系列": _options("pose_series"),
                "姿势_分类": _options("pose_category"),
                "姿势_视角": _options("pose_angle"),
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "STRING")
    RETURN_NAMES = ("人像", "衣装", "姿势", "信息")
    FUNCTION = "load"

    def load(self, 质量, 随机种子, 每次随机,
             启用_人像, 启用_衣装, 启用_姿势,
             人像_选定ID, 衣装_选定ID, 姿势_选定ID,
             人像_分区, 人像_发型, 衣装_季节, 衣装_品类, 衣装_色系,
             姿势_系列, 姿势_分类, 姿势_视角):
        m = get_manager(None)
        q = "thumb" if 质量 == "缩略图" else "full"
        seed = int(随机种子)

        specs = [
            ("portrait", "人像", 启用_人像, 人像_选定ID, 0,
             {"sec": 人像_分区, "hair": 人像_发型}),
            ("costume", "衣装", 启用_衣装, 衣装_选定ID, 1,
             {"cat": 衣装_季节, "group": 衣装_品类, "color": 衣装_色系}),
            ("pose", "姿势", 启用_姿势, 姿势_选定ID, 2,
             {"series": 姿势_系列, "category": 姿势_分类, "angle": 姿势_视角}),
        ]

        out_imgs = []
        out_info = []
        for kind, label, enabled, locked_id, offset, filters in specs:
            if not enabled:
                out_imgs.append(_placeholder())
                out_info.append(f"【{label}】已屏蔽（不参与输出）")
                continue

            item = None
            if locked_id and str(locked_id).strip():
                item = m.get_item_by_id(kind, str(locked_id).strip())
                if item is None:
                    # 前端写入的 ID 可能来自更新版素材库（后端 JSON 缓存较旧）：
                    # 不要直接出 1x1，退回按种子选取，至少保证有图。
                    print(f"[RuiC PoseAtlas] {label}：选定ID未找到（{locked_id}），"
                          f"已回退为按筛选+种子选取。若频繁出现，重启后端以刷新素材库缓存。")
            if item is None:
                pool = list(m.kinds.get(kind, []))
                for field, val in filters.items():
                    if not val or val in ("全部", "ALL"):
                        continue
                    en = ZH_TO_EN.get(val, val)
                    pool = [it for it in pool if _match(it["sub"].get(field), en)]
                if not pool:
                    print(f"[RuiC PoseAtlas] {label}：素材池为空（数据未加载成功）。请确认能访问 "
                          f"hruiccc.github.io 后重新排队即可自动重建。")
                    out_imgs.append(_placeholder())
                    out_info.append(f"【{label}】该子分类下暂无素材")
                    continue
                item = pool[(seed + offset) % len(pool)]

            img = m.get_image(item, q)
            if img is None:
                the_url = item.get("thumb_url") if q == "thumb" else item.get("full_url")
                print(f"[RuiC PoseAtlas] {label}：取图失败 id={item.get('id')} url={the_url}")
                out_imgs.append(_placeholder())
                out_info.append(f"【{label}】取图失败：{item['id']}")
                continue
            out_imgs.append(_to_tensor(img))
            out_info.append(f"【{label}】{item['id']}　·　{item['name']}"
                            f"　·　{img.width}×{img.height}")

        return (out_imgs[0], out_imgs[1], out_imgs[2], "\n".join(out_info))
