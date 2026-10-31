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
    from . import pose_depth, da_depth
except ImportError:  # 直接以脚本方式运行时
    from atlas_io import get_manager, _match
    import pose_depth
    import da_depth

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


# ---------------- 提示词模板 ----------------
# 图号分工（与当前接线一致，改动请同步 README 与前端预设）：
#   图 1 = 人像（是谁）、图 2 = 衣装（穿什么）、图 3 = 姿势（怎么摆）。
#   Qwen-Image 2.1 的 latent 尺寸取自第一张图，因此画布比例由人像图决定。
# 姿势靠什么跟住：
#   1) 姿势接在 image_3，配 depth 模式（姿势卡片「◐ 转深度图」）时控制力最强；
#   2) 提示词里把图 3 说成「只取姿态结构、不继承外观」，并明确禁止继承线稿。
# 需要的话可用占位符 {姿势描述} 把素材自带的姿势中文名（+类别补语）写进提示词，
# 内置两版预设都不带它。
# 注意：不要写"不微笑 / 不要露齿"。cfg=1.0 没有负向条件，"微笑"二字会被当成
# 正向关键词，越写越笑。要平静就正面描述：神情平静、嘴唇自然合拢、嘴角平放。
# 两版预设模板（前端「📝 提示词」里可以一键套用，也可以完全自己写）。
PROMPT_LINECOAT = (
    "严格保留图 1 人物的面部特征、脸型、五官比例、发型、肤色与皮肤质感，保持同一个人物身份，不换脸。"
    "人物穿戴图 2 全套服饰，复刻服装版型、剪裁、面料纹理、配色与装饰细节，"
    "衣物跟随姿态自然贴合身体，生成符合受力变化的布料褶皱，不复制图 2 的人脸、姿态。\n"
    "图 3 是线稿动态参考，"
    "仅提取画面里的全身姿态、躯干朝向、四肢位置、重心、透视与肢体比例；"
    "禁止继承线稿、轮廓线条、关节、素描白底、空白头部。\n"
    "表情根据当前肢体动作全新生成，表情、神态和身体姿态协调适配，不沿用任意一张参考图自带的表情。"
    "画面仅出现这一名角色，肢体完整无截断，人体结构准确。"
    "柔和均匀棚拍光，低干扰中性灰纯色背景，皮肤肌理真实，服装纹理清晰，"
    "统一光影与自然接触阴影。输出一张完整摄影作品，"
    "禁止线稿、素描草图、拼贴、分屏、多余人物、畸形手指、文字、水印。"
)

PROMPT_DEPTH = (
    "严格保留图 1 人物的面部特征、脸型、五官比例、发型、肤色与真实皮肤质感，保持同一个人物身份，不换脸。"
    "将图 2 服装完整穿到该人物身上，复刻服装版型、剪裁结构、面料纹理、配色与装饰细节，"
    "衣物自然贴合身体与动作，产生合理褶皱和受力变化，不复制图 2 的人脸、姿势或背景。\n"
    "图 3 是深度图与姿态结构参考，"
    "仅用于控制最终人物的躯干朝向、四肢位置、动作姿态、重心分配、观察角度、前后层次和空间透视关系；"
    "不要继承图 3 中的人物身份、脸部、服装、背景或任何外观内容。"
    "最终人物只采用图 3 提供的动作结构，不保留图 3 的原表情。\n"
    "表情根据当前动作重新生成：结合姿态的情绪、身体重心和手部动作，设计自然、合理、符合动作语境的新表情，"
    "表情与眼神、嘴部、面部肌肉协调，不机械沿用参考表情。"
    "三者融合为同一个人物，画面仅出现一人，根据姿势需要保留完整肢体，人物与服装结构连续自然。\n"
    "柔和均匀棚拍光，低干扰中性灰摄影空间，细节层次清晰，真实皮肤纹理，合理人体结构，"
    "清晰服装纹理，统一光影与自然接触阴影。输出一张完整摄影作品，"
    "避免三图拼贴、分屏、多余人物、重复肢体、畸形手指、文字和水印。"
)

DEFAULT_PROMPT = PROMPT_LINECOAT

# 姿势类别 -> 身体状态补语（只补"整个人在什么状态"，不描述具体四肢，
# 具体姿态交给图 1 和姿势名）
_POSE_BODY = [
    (("趴", "卧"), "整个人躺在地面上，身体贴着地面"),
    (("坐",), "整个人坐在地面上"),
    (("跪", "蹲"), "双膝着地，蹲跪在地面上"),
    (("站", "立"), "双脚站在地面上"),
]


def _pose_sentence(item):
    """把姿势条目编成一句可直接进提示词的中文描述。"""
    if not item:
        return "自然站立"
    name = (item.get("name") or item.get("id") or "").strip()
    cat = ((item.get("sub") or {}).get("category") or "").strip()
    body = ""
    for keys, desc in _POSE_BODY:
        if any(k in cat for k in keys):
            body = desc
            break
    seg = name
    if cat:
        seg += f"（{cat}" + (f"：{body}" if body else "") + "）"
    if cat and not any(k in cat for k in ("站", "立")):
        seg += "，不要站姿"
    return seg


def build_prompt(template, pose_item, has_pose=True):
    tpl = (template or DEFAULT_PROMPT).strip() or DEFAULT_PROMPT
    sentence = _pose_sentence(pose_item) if has_pose else "自然站立"
    out = tpl.replace("{姿势描述}", sentence)
    out = out.replace("{姿势}", (pose_item or {}).get("name", "") if has_pose else "")
    return out


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
            # 放 optional：旧工作流没有这一项时也能跑（缺省用 DEFAULT_PROMPT），
            # 不会被判成 required_input_missing。
            "optional": {
                "提示词模板": ("STRING", {"default": DEFAULT_PROMPT, "multiline": True,
                                      "tooltip": "可用占位符：{姿势描述} = 姿势名+类别（推荐）；{姿势} = 仅姿势名。"
                                                 "本节点会把它填好后从「提示词」输出口送出，直接连给文本编码器。"}),
                # 必须排在提示词模板之后：widgets_values 按位置赋值，插到中间会让旧工作流错位。
                # 存的是「当前要转深度图的那一张姿势的 ID」，空 = 全部输出线稿。
                # 前端点姿势卡片里的「转深度图」就写入当前 ID；换图时自动清空。
                "姿势深度ID": ("STRING", {"default": "", "multiline": False,
                                       "tooltip": "只把这一张姿势转成深度图。换图后前端会自动清空，恢复线稿。"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "STRING", "STRING")
    RETURN_NAMES = ("人像", "衣装", "姿势", "信息", "提示词")
    FUNCTION = "load"

    def load(self, 质量, 随机种子, 每次随机,
             启用_人像, 启用_衣装, 启用_姿势,
             人像_选定ID, 衣装_选定ID, 姿势_选定ID,
             人像_分区, 人像_发型, 衣装_季节, 衣装_品类, 衣装_色系,
             姿势_系列, 姿势_分类, 姿势_视角, 提示词模板=None, 姿势深度ID=""):
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
        pose_item = None
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

            if kind == "pose":
                pose_item = item
            img = m.get_image(item, q)
            if img is None:
                the_url = item.get("thumb_url") if q == "thumb" else item.get("full_url")
                print(f"[RuiC PoseAtlas] {label}：取图失败 id={item.get('id')} url={the_url}")
                out_imgs.append(_placeholder())
                out_info.append(f"【{label}】取图失败：{item['id']}")
                continue
            tag = ""
            if kind == "pose" and str(姿势深度ID or "").strip() == str(item.get("id")):
                dep_img, how = da_depth.pose_to_depth(img)
                if dep_img is None:
                    tag = "　·　深度图已跳过（转不出来，保持线稿）"
                else:
                    img = dep_img
                    tag = "　·　深度图（DA）" if how == "da" else "　·　深度图（内置）"
            out_imgs.append(_to_tensor(img))
            out_info.append(f"【{label}】{item['id']}　·　{item['name']}"
                            f"　·　{img.width}×{img.height}{tag}")

        prompt = build_prompt(提示词模板, pose_item, has_pose=bool(启用_姿势))
        return (out_imgs[0], out_imgs[1], out_imgs[2], "\n".join(out_info), prompt)
