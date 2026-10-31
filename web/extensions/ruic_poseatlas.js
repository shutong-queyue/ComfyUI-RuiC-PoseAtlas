// RuiC PoseAtlas 三图组合节点 —— 自定义前端 UI（v5）
// 适配：本机秋叶版 ComfyUI 的核心 app 实例挂在 window.comfyAPI.app.app
//       （外层是命名空间容器，内层才是真 app；官方 scripts/app.js 只是把它再导出一遍）。
// 做法：隐藏全部标准控件，用 addDOMWidget 注入三卡片布局（人像/衣装/姿势），
//       卡片内可切换子分类、🎲 单类随机、屏蔽，并实时预览。
// 同步：预览选中的条目会写回隐藏的「选定ID」控件，后端优先按 ID 出图 => 预览恒等于出图。
// v6 变更：
//   1) 「转深度图」按钮移进姿势卡片，只对当前这一张生效；换图（随机/下一张/点选/改种子）自动还原线稿。
//   2) 第一次点会检查深度模型，缺失时弹确认框并从魔搭下载 95MB，带进度条；取消则不下。
//   3) 提示词面板内置「线稿版 / 深度版」两套预设，点一下填入，也可自己写；底部常驻「深度图控制更精准」提示。
//   5) syncTop()：顶栏「质量 / 种子」在每次读档、每次刷新前回读真实参数值。

const app = (window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app) || window.app;

console.log("[RuiC PoseAtlas] 前端扩展脚本已加载 v6（深度图按钮进姿势卡 / 两版提示词预设），app =", app ? "ok" : "MISSING");

// 三条线路（站点根 = 仓库根，路径一致，可互为镜像）
const SITE_BASES = [
  "https://hruiccc.github.io/RuiC-PoseAtlas/",
  "https://fastly.jsdelivr.net/gh/HRuiCcc/RuiC-PoseAtlas@main/",
  "https://cdn.jsdelivr.net/gh/HRuiCcc/RuiC-PoseAtlas@main/",
];
const GH_PAGES = SITE_BASES[0];
const LIBRARY_URL = GH_PAGES;   // 「打开素材库」跳这里
const DEPTH_API = "/ruic/depth"; // 后端把线稿压成体积图的接口

// EN -> 中文（用于下拉标签）
const ZH = {
  duo: "双人", full_sexy: "性感全身", full_std: "标准全身", upper: "上半身",
  diagonal: "斜角", front: "正面", high: "高位", low: "低位", side: "侧面",
  autumn: "秋季", lingerie: "内衣", party: "派对", sexy: "性感", spring: "春季",
  summer: "夏季", swimwear: "泳装", winter: "冬季",
  accessory: "配饰", bag: "包袋", bottom: "下装", dress: "连衣裙", inner: "内搭",
  outer: "外套", shoes: "鞋履", skirt: "半裙", swim: "泳衣", top: "上装",
  beige: "米色", black: "黑色", blue: "蓝色", brown: "棕色", burgundy: "酒红",
  cream: "奶油", gold: "金色", green: "绿色", grey: "灰色", ivory: "象牙白",
  khaki: "卡其", lavender: "薰衣草紫", mint: "薄荷绿", navy: "藏青", olive: "橄榄绿",
  orange: "橙色", pink: "粉色", purple: "紫色", red: "红色", silver: "银色",
  white: "白色", yellow: "黄色",
  face: "脸模", styling: "造型",
  long: "长发", medium: "中发", semilong: "中长发", short: "短发",
};
const ZH_REV = {};
for (const k in ZH) ZH_REV[ZH[k]] = k;
const zhOf = (v) => ZH[v] || v;

// 三类卡片配置（offset 必须与后端 nodes.py 的 specs 偏移量一致）
const KIND_CFG = [
  {
    key: "portrait", num: "①", title: "人像", en: "Portrait", color: "#e8743b", offset: 0,
    enableW: "启用_人像", lockW: "人像_选定ID",
    filters: [
      { field: "sec", wname: "人像_分区", zh: "分区" },
      { field: "hair", wname: "人像_发型", zh: "发型" },
    ],
  },
  {
    key: "costume", num: "②", title: "衣装", en: "Costume", color: "#19a979", offset: 1,
    enableW: "启用_衣装", lockW: "衣装_选定ID",
    filters: [
      { field: "cat", wname: "衣装_季节", zh: "季节" },
      { field: "group", wname: "衣装_品类", zh: "品类" },
      { field: "color", wname: "衣装_色系", zh: "色系" },
    ],
  },
  {
    key: "pose", num: "③", title: "姿势", en: "Pose", color: "#945ec9", offset: 2,
    enableW: "启用_姿势", lockW: "姿势_选定ID",
    filters: [
      { field: "series", wname: "姿势_系列", zh: "系列" },
      { field: "category", wname: "姿势_分类", zh: "分类" },
      { field: "angle", wname: "姿势_视角", zh: "视角" },
    ],
  },
];

// 悬停提示（把「随机」和「按种子」的区别写清楚）
const HINT_COMBO = "在当前筛选范围内，三类各自随机抽一张。每次点结果都不同，不可复现。";
const HINT_SEED = "清空三类的手动选择，改由「随机种子」这个数字决定选哪张：种子不变，出的图永远不变（可复现）。";

// 两版预设（与 nodes.py 的 PROMPT_LINECOAT / PROMPT_DEPTH 保持一字不差，
// 这样才能在打开面板时判断"当前用的是哪一版"）
// 注意：内置两版都不含 {姿势描述}，想写进具体姿势名请自己加占位符。
const PRESET_LINE =
  "严格保留图 2 人物的面部特征、脸型、五官比例、发型、肤色与皮肤质感，保持同一个人物身份，不换脸。" +
  "人物穿戴图 3 全套服饰，复刻服装版型、剪裁、面料纹理、配色与装饰细节，" +
  "衣物跟随姿态自然贴合身体，生成符合受力变化的布料褶皱，不复制图 3 的人脸、姿态。\n" +
  "图 1 是线稿动态参考，" +
  "仅提取画面里的全身姿态、躯干朝向、四肢位置、重心、透视与肢体比例；" +
  "禁止继承线稿、轮廓线条、关节、素描白底、空白头部。\n" +
  "表情根据当前肢体动作全新生成，表情、神态和身体姿态协调适配，不沿用任意一张参考图自带的表情。" +
  "画面仅出现这一名角色，肢体完整无截断，人体结构准确。" +
  "柔和均匀棚拍光，低干扰中性灰纯色背景，皮肤肌理真实，服装纹理清晰，" +
  "统一光影与自然接触阴影。输出一张完整摄影作品，" +
  "禁止线稿、素描草图、拼贴、分屏、多余人物、畸形手指、文字、水印。";

const PRESET_DEPTH =
  "严格保留图 2 人物的面部特征、脸型、五官比例、发型、肤色与真实皮肤质感，保持同一个人物身份，不换脸。" +
  "将图 3 服装完整穿到该人物身上，复刻服装版型、剪裁结构、面料纹理、配色与装饰细节，" +
  "衣物自然贴合身体与动作，产生合理褶皱和受力变化，不复制图 3 的人脸、姿势或背景。\n" +
  "图 1 是深度图与姿态结构参考，" +
  "仅用于控制最终人物的躯干朝向、四肢位置、动作姿态、重心分配、观察角度、前后层次和空间透视关系；" +
  "不要继承图 1 中的人物身份、脸部、服装、背景或任何外观内容。" +
  "最终人物只采用图 1 提供的动作结构，不保留图 1 的原表情。\n" +
  "表情根据当前动作重新生成：结合姿态的情绪、身体重心和手部动作，设计自然、合理、符合动作语境的新表情，" +
  "表情与眼神、嘴部、面部肌肉协调，不机械沿用参考表情。" +
  "三者融合为同一个人物，画面仅出现一人，根据姿势需要保留完整肢体，人物与服装结构连续自然。\n" +
  "柔和均匀棚拍光，低干扰中性灰摄影空间，细节层次清晰，真实皮肤纹理，合理人体结构，" +
  "清晰服装纹理，统一光影与自然接触阴影。输出一张完整摄影作品，" +
  "避免三图拼贴、分屏、多余人物、重复肢体、畸形手指、文字和水印。";

// 节点尺寸约束（图单位）
const MIN_W = 620;
const MIN_H = 560;

const STYLE = `
.ruic-wrap{width:100%;height:100%;max-height:100%;box-sizing:border-box;
  min-width:0;min-height:0;display:flex;flex-direction:column;gap:8px;
  padding:0 0 8px 0;   /* 底部留白，卡片不贴节点底边 */
  font-family:system-ui,"Microsoft YaHei",sans-serif;color:#e6e6e6;overflow:hidden;}
.ruic-wrap *{box-sizing:border-box;}
.ruic-top{display:flex;flex-direction:column;gap:6px;flex:none;}
.ruic-row{display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden;}
.ruic-row.acts{flex-wrap:nowrap;}
.ruic-row.opts{flex-wrap:wrap;row-gap:6px;}
.ruic-top button{background:#2b2b3a;color:#fff;border:1px solid #444;border-radius:6px;padding:5px 10px;cursor:pointer;
  font-size:12px;white-space:nowrap;flex:none;}
.ruic-top button:hover{border-color:#7c5cff;background:#34344a;}
.ruic-top .ruic-open{margin-left:auto;background:#22304a;border-color:#3a5a8a;color:#bcd8ff;}
.ruic-top .ruic-open:hover{border-color:#5b8fd6;background:#2a3d5c;}
/* 原生控件被隐藏，质量 / 种子 在顶栏给出等价入口 */
.ruic-ctl{display:flex;align-items:center;gap:5px;flex:none;font-size:12px;color:#cfcfe0;}
.ruic-ctl .ruic-lbl{opacity:.72;white-space:nowrap;}
.ruic-top .ruic-quality,.ruic-top .ruic-seed{background:#2b2b3a;color:#fff;border:1px solid #444;
  border-radius:6px;padding:4px 6px;font-size:12px;height:28px;box-sizing:border-box;outline:none;}
.ruic-top .ruic-quality{width:88px;}
.ruic-top .ruic-quality:hover,.ruic-top .ruic-seed:hover{border-color:#7c5cff;}
.ruic-top .ruic-quality:focus,.ruic-top .ruic-seed:focus{border-color:#7c5cff;}
.ruic-top .ruic-seed{width:118px;}
.ruic-top .ruic-seed::-webkit-outer-spin-button,
.ruic-top .ruic-seed::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}
/* 提示词模板编辑区（默认收起） */
.ruic-top .ruic-prompt-btn{margin-left:6px;background:#2a2438;border-color:#5a4a80;color:#d8ccff;}
.ruic-top .ruic-prompt-btn:hover{border-color:#9a7cff;background:#332b45;}
.ruic-prompt{display:none;flex:none;padding:2px 0 8px;}
.ruic-prompt.open{display:block;}
.ruic-prompt-ta{width:100%;height:104px;resize:vertical;background:#14141c;color:#dfe3ee;
  border:1px solid #3a3a4a;border-radius:8px;padding:8px;font-size:12px;line-height:1.55;
  font-family:inherit;outline:none;}
.ruic-prompt-ta:focus{border-color:#7c5cff;}
/* 两版预设 + 底部提示 */
.ruic-presets{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px;}
.ruic-preset-lbl{font-size:11px;color:#8b91a6;flex:none;}
.ruic-preset{background:#2a2438;color:#d8ccff;border:1px solid #5a4a80;border-radius:6px;
  padding:3px 9px;font-size:11px;cursor:pointer;white-space:nowrap;flex:none;}
.ruic-preset:hover{border-color:#9a7cff;background:#332b45;}
.ruic-preset.on{background:#3d2f63;color:#fff;border-color:#9a7cff;}
.ruic-preset-hint{font-size:10px;color:#6f7590;flex:1 1 auto;min-width:0;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;text-align:right;}
.ruic-prompt-foot{font-size:10px;color:#7f86a3;margin-top:5px;line-height:1.5;}
/* 姿势卡片里的「转深度图」按钮 */
.ruic-depth{display:block;width:100%;flex:none;background:#242a3d;color:#9fc0ff;border:1px solid #3a4a70;
  border-radius:6px;padding:3px 6px;font-size:11px;cursor:pointer;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;}
.ruic-depth:hover{border-color:#6aa0e8;background:#2c3550;}
.ruic-depth.on{background:#3a2f56;color:#e8ddff;border-color:#9a7cff;}
.ruic-depth:disabled{opacity:.45;cursor:default;}
/* 深度模型下载确认 / 进度 */
.ruic-dlg{width:min(460px,92vw);background:#1a1a24;border:1px solid #3b3b4e;border-radius:12px;
  padding:18px 20px;box-shadow:0 24px 64px rgba(0,0,0,.6);color:#e6e6e6;
  font-family:system-ui,"Microsoft YaHei",sans-serif;}
.ruic-dlg h3{margin:0 0 10px;font-size:15px;font-weight:600;color:#d8ccff;}
.ruic-dlg p{margin:0 0 8px;font-size:12px;line-height:1.7;color:#b9c0d6;}
.ruic-dlg code{background:#12121a;border:1px solid #33334a;border-radius:4px;padding:1px 5px;
  font-size:11px;color:#9fc0ff;}
.ruic-dlg .ruic-dlg-act{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;}
.ruic-dlg button{background:#2b2b3a;color:#dfe3ee;border:1px solid #444;border-radius:6px;
  padding:6px 14px;font-size:12px;cursor:pointer;}
.ruic-dlg button.pri{background:#4a3a7a;border-color:#8a6ee0;color:#fff;}
.ruic-dlg button:hover{border-color:#9a7cff;}
.ruic-dlg button:disabled{opacity:.45;cursor:default;}
.ruic-bar{height:8px;border-radius:5px;background:#26263a;overflow:hidden;margin:12px 0 6px;}
.ruic-bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#6a4ce0,#9a7cff);transition:width .2s;}
.ruic-dlg .ruic-pct{font-size:11px;color:#8fa2c8;font-variant-numeric:tabular-nums;}
.ruic-cards{flex:1 1 auto;min-height:0;min-width:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));
  gap:8px;overflow:hidden;}
.ruic-card{min-width:0;min-height:0;background:#1c1c28;border:1px solid #333;border-radius:10px;padding:8px;
  display:flex;flex-direction:column;gap:6px;overflow:hidden;}
.ruic-card.blocked{opacity:.5;filter:grayscale(.6);}
.ruic-head{display:flex;align-items:center;gap:5px;min-width:0;flex:none;}
.ruic-badge{width:18px;height:18px;border-radius:50%;color:#fff;display:flex;align-items:center;justify-content:center;
  font-size:11px;font-weight:700;flex:none;}
.ruic-title{font-size:12px;font-weight:600;flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ruic-title small{color:#9aa0b4;font-weight:400;font-size:10px;margin-left:4px;}
.ruic-pin{background:transparent;color:#7d84a0;border:1px solid #3a3d50;border-radius:6px;padding:1px 5px;
  font-size:11px;cursor:pointer;flex:none;line-height:1.5;}
.ruic-pin.on{color:#d9c6ff;border-color:#7a5ec9;background:#2e2645;}
.ruic-pin:hover{border-color:#9a7cff;}
.ruic-block{background:#3a2030;color:#ff9bb0;border:1px solid #5a3040;border-radius:6px;padding:2px 6px;
  font-size:11px;cursor:pointer;flex:none;white-space:nowrap;}
.ruic-block.on{background:#5a3040;color:#fff;border-color:#8a4a60;}
.ruic-prev{position:relative;flex:1 1 0;min-height:56px;min-width:0;background:#0e0e16;border-radius:8px;
  overflow:hidden;display:flex;align-items:center;justify-content:center;cursor:pointer;}
.ruic-prev:hover{outline:1px solid #5a4a8a;outline-offset:-1px;}
.ruic-prev img{width:100%;height:100%;object-fit:contain;display:none;}
.ruic-ph{position:absolute;left:0;right:0;top:0;bottom:0;display:flex;align-items:center;justify-content:center;
  font-size:11px;color:#7a8094;text-align:center;padding:6px;line-height:1.5;}
.ruic-tag{position:absolute;left:5px;bottom:5px;background:rgba(18,18,28,.82);color:#cbb6ff;border:1px solid #5a4a8a;
  border-radius:5px;font-size:10px;padding:1px 5px;pointer-events:none;}
.ruic-filters{display:flex;flex-direction:column;gap:4px;flex:none;}
.ruic-filters label{font-size:11px;color:#9aa0b4;display:flex;align-items:center;gap:6px;min-width:0;}
.ruic-filters label span{flex:none;width:26px;}
.ruic-filters select{flex:1 1 auto;min-width:0;background:#2b2b3a;color:#e6e6e6;border:1px solid #444;
  border-radius:5px;padding:2px 4px;font-size:11px;cursor:pointer;}
.ruic-filters select:hover{border-color:#7c5cff;}
.ruic-foot{display:grid;grid-template-columns:1fr 1fr;gap:4px 6px;flex:none;min-width:0;}
.ruic-fname{min-width:0;font-size:10px;color:#8b91a6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ruic-pager{font-size:10px;color:#8fa2c8;white-space:nowrap;font-variant-numeric:tabular-nums;text-align:right;}
.ruic-rand,.ruic-next{background:#3a2f5a;color:#cbb6ff;border:1px solid #5a4a8a;border-radius:6px;
  padding:3px 6px;font-size:11px;cursor:pointer;white-space:nowrap;min-width:0;
  overflow:hidden;text-overflow:ellipsis;}
.ruic-next{background:#26364f;color:#a9ccff;border-color:#3d5679;}
.ruic-rand:hover{border-color:#9b7bff;background:#453a6a;}
.ruic-next:hover{border-color:#6aa0e8;background:#2f4463;}
.ruic-next:disabled,.ruic-rand:disabled{opacity:.45;cursor:default;}
.ruic-err{background:#3a1f1f;color:#ffb3b3;border:1px solid #5a2a2a;border-radius:8px;padding:12px;
  font-size:12px;line-height:1.6;}
/* ---- 素材选择器（二级弹窗） ---- */
.ruic-mask{position:fixed;inset:0;background:rgba(6,6,10,.62);z-index:10000;display:flex;
  align-items:center;justify-content:center;padding:24px;}
.ruic-picker{width:min(920px,92vw);max-height:min(660px,90vh);background:#1a1a24;border:1px solid #3b3b4e;
  border-radius:12px;display:flex;flex-direction:column;overflow:hidden;
  box-shadow:0 24px 64px rgba(0,0,0,.6);font-family:system-ui,"Microsoft YaHei",sans-serif;color:#e6e6e6;}
.ruic-pk-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #2e2e3e;flex:none;}
.ruic-pk-title{font-size:13px;font-weight:600;flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ruic-pk-title b{color:#cbb6ff;}
.ruic-pk-close{background:#2b2b3a;color:#cfcfe0;border:1px solid #444;border-radius:6px;width:26px;height:26px;
  cursor:pointer;font-size:14px;line-height:1;flex:none;}
.ruic-pk-close:hover{border-color:#ff7d95;color:#ffb3c0;}
.ruic-pk-filters{display:flex;gap:10px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid #2e2e3e;flex:none;}
.ruic-pk-filters label{font-size:11px;color:#9aa0b4;display:flex;align-items:center;gap:5px;}
.ruic-pk-filters select{background:#2b2b3a;color:#e6e6e6;border:1px solid #444;border-radius:5px;
  padding:3px 5px;font-size:11px;cursor:pointer;max-width:150px;}
.ruic-pk-filters select:hover{border-color:#7c5cff;}
.ruic-pk-grid{flex:1 1 auto;min-height:0;overflow:auto;padding:10px 12px;
  display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:8px;align-content:start;}
.ruic-pk-cell{position:relative;background:#0e0e16;border:1px solid #2f2f42;border-radius:8px;
  overflow:hidden;cursor:pointer;aspect-ratio:3/4;display:flex;align-items:center;justify-content:center;}
.ruic-pk-cell:hover{border-color:#7c5cff;}
.ruic-pk-cell.sel{border-color:#9a7cff;box-shadow:0 0 0 2px rgba(154,124,255,.45) inset;}
.ruic-pk-cell img{width:100%;height:100%;object-fit:contain;}
.ruic-pk-cell .ruic-pk-id{position:absolute;left:0;right:0;bottom:0;background:linear-gradient(transparent,rgba(8,8,14,.92));
  color:#b9c0d6;font-size:9px;padding:8px 4px 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;}
.ruic-pk-cell .ruic-pk-ok{position:absolute;right:4px;top:4px;background:#7a5ec9;color:#fff;border-radius:50%;
  width:16px;height:16px;font-size:11px;display:flex;align-items:center;justify-content:center;}
.ruic-pk-empty{grid-column:1/-1;text-align:center;color:#7a8094;font-size:12px;padding:40px 0;}
.ruic-pk-foot{display:flex;align-items:center;gap:8px;padding:9px 12px;border-top:1px solid #2e2e3e;flex:none;
  font-size:11px;color:#9aa0b4;}
.ruic-pk-foot button{background:#2b2b3a;color:#dfe3ee;border:1px solid #444;border-radius:6px;padding:4px 9px;
  font-size:11px;cursor:pointer;white-space:nowrap;}
.ruic-pk-foot button:hover{border-color:#7c5cff;}
.ruic-pk-foot button:disabled{opacity:.4;cursor:default;}
.ruic-pk-foot .ruic-pk-grow{flex:1 1 auto;}
.ruic-pk-count{font-variant-numeric:tabular-nums;color:#8fa2c8;}
`;

function cardHTML(cfg) {
  const filters = cfg.filters.map(f =>
    `<label><span>${f.zh}</span><select data-kind="${cfg.key}" data-field="${f.field}"><option>全部</option></select></label>`
  ).join("");
  return `<div class="ruic-card" data-kind="${cfg.key}">
    <div class="ruic-head">
      <div class="ruic-badge" style="background:${cfg.color}">${cfg.num}</div>
      <div class="ruic-title">${cfg.title}<small>${cfg.en}</small></div>
      <button class="ruic-pin" data-kind="${cfg.key}" title="已锁定某一张。点这里取消锁定，回到「按种子随机」">📌</button>
      <button class="ruic-block" data-kind="${cfg.key}">屏蔽</button>
    </div>
    <div class="ruic-prev" title="点击选择具体素材"><img alt="预览"><div class="ruic-ph">加载中…</div><span class="ruic-tag" style="display:none"></span></div>
    ${cfg.key === "pose" ? `<button class="ruic-depth" data-kind="pose" title="只把当前这一张姿势换成深度图再送给模型（不会影响其它姿势）。换图后自动恢复线稿。">◐ 转深度图</button>` : ``}
    <div class="ruic-filters">${filters}</div>
    <div class="ruic-foot">
      <span class="ruic-fname"></span>
      <span class="ruic-pager" title="当前是筛选结果中的第几张 / 共几张">—</span>
      <button class="ruic-rand" data-kind="${cfg.key}" title="${cfg.title}：在当前筛选范围内随机">🎲 随机</button>
      <button class="ruic-next" data-kind="${cfg.key}" title="跳到当前筛选下的下一张">下一张 ›</button>
    </div>
  </div>`;
}

function setWidget(W, name, value) {
  const w = W[name];
  if (!w) return;
  if (w.value === value) return;
  w.value = value;
  if (typeof w.callback === "function") {
    try { w.callback(value); } catch (e) {}
  }
}

function _match(value, wanted) {
  if (Array.isArray(value)) return value.includes(wanted);
  return String(value) === String(wanted);
}

// 把相对路径展开成多线路候选地址（末尾再补原站/图床直连）
function urlsOf(rel, fallback) {
  const out = [];
  if (rel) {
    const r = String(rel).replace(/^\/+/, "");
    for (const b of SITE_BASES) out.push(b + r);
  }
  if (fallback && !out.includes(fallback)) out.push(fallback);
  return out;
}

function transform(raw) {
  const items = [];
  const byId = {};
  const poses = (raw.poses && raw.poses.poses) || raw.poses || [];
  for (const p of poses) {
    const base = (p.names && (p.names.zh || p.names.en)) || p.id || "";
    for (const v of (p.variants || [])) {
      const angle = v.angle || "";
      const id = `${p.id}_${angle}`;
      const it = {
        kind: "pose", id, name: `${base} · ${angle}`,
        thumb_urls: urlsOf(v.thumb),
        full_urls: urlsOf(v.full),
        sub: { series: p.series || "", category: p.category || "", angle },
      };
      items.push(it); byId["pose/" + id] = it;
    }
  }
  const costumes = (raw.costumes && raw.costumes.costumes) || raw.costumes || [];
  for (const c of costumes) {
    const id = c.id || "";
    const it = {
      kind: "costume", id, name: id,
      thumb_urls: urlsOf(c.thumb),
      full_urls: urlsOf(c.image),
      sub: { cat: c.cat || "", group: c.group || "", color: c.color || "", tags: c.tags || [] },
    };
    items.push(it); byId["costume/" + id] = it;
  }
  const faces = (raw.faces && raw.faces.images) || raw.faces || [];
  for (const im of faces) {
    const id = im.id || "";
    const it = {
      kind: "portrait", id, name: `${im.sec || ""}/${im.hair || ""}`,
      thumb_urls: urlsOf(im.thumb, im.thumb_remote),
      full_urls: urlsOf(im.full, im.full_remote),
      sub: { sec: im.sec || "", hair: im.hair || "", style: im.style || "" },
    };
    items.push(it); byId["portrait/" + id] = it;
  }
  return { items, byId };
}

async function fetchJSON(name) {
  let lastErr = null;
  for (const base of SITE_BASES) {
    try {
      const r = await fetch(base + "data/" + name, { cache: "no-cache" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`加载 ${name} 失败（三条线路均不可达：${lastErr && lastErr.message}）`);
}

async function loadAll() {
  const [poses, costumes, faces] = await Promise.all([
    fetchJSON("poses.json"), fetchJSON("costumes.json"), fetchJSON("faces.json"),
  ]);
  return transform({ poses, costumes, faces });
}

if (!app || typeof app.registerExtension !== "function") {
  console.error("[RuiC PoseAtlas] 无法注册：window.comfyAPI.app.app 缺少 registerExtension，前端 UI 不会注入。请确认 ComfyUI 版本支持该 API。");
} else {
  app.registerExtension({
    name: "RuiC.PoseAtlas.UI",
    async nodeCreated(node) {
      // 本机这个版本可能不设 node.comfyClass，真实类名在 node.type / constructor.comfyClass（KJNodes 同款写法）
      const cls = node.comfyClass || (node.constructor && node.constructor.comfyClass) || node.type || "";
      if (!/RuiC|PoseAtlas/i.test(cls)) return;   // 非本节点的直接放过（不打日志，避免刷屏）
      if (!/^RuiC_?PoseAtlas_?Loader$/i.test(cls)) {
        console.warn("[RuiC PoseAtlas] 类名不匹配，跳过：", cls);
        return;
      }
      console.log("[RuiC PoseAtlas] 自定义 UI 注入 v5 开始，cls =", cls);

      // 收集并隐藏全部标准控件
      const W = {};
      for (const w of node.widgets || []) { w.hidden = true; W[w.name] = w; }
      const STATE = {};
      let DATA = null;
      let PICKER = null;

      // 注入样式（只注入一次）
      if (!document.getElementById("ruic-style")) {
        const st = document.createElement("style");
        st.id = "ruic-style"; st.textContent = STYLE;
        document.head.appendChild(st);
      }

      const hasDepth = !!W["姿势深度ID"];

      const wrap = document.createElement("div");
      wrap.className = "ruic-wrap";
      wrap.innerHTML = `
        <div class="ruic-top">
          <div class="ruic-row acts">
            <button class="ruic-combo" title="${HINT_COMBO}">🎲 随机组合</button>
            <button class="ruic-update" title="${HINT_SEED}">↻ 按种子</button>
            <button class="ruic-prompt-btn" title="编辑自动拼好的提示词模板。占位符 {姿势描述} 会被替换成当前随机到的姿势（名字+类别），{姿势} 只给名字。">📝 提示词</button>
            <button class="ruic-open" title="在浏览器打开 RuiC 图鉴素材库">🔗 素材库</button>
          </div>
          <div class="ruic-row opts">
            <span class="ruic-ctl" title="取图质量：原图 = 素材真实分辨率；缩略图约 400×500，仅适合快速试参。下拉显示的就是实际提交的值">
              <span class="ruic-lbl">质量</span>
              <select class="ruic-quality"><option value="原图">原图</option><option value="缩略图">缩略图</option></select>
            </span>
            <span class="ruic-ctl" title="按种子选图时的数值：改这里可复现或切换组合，等价于原生「随机种子」">
              <span class="ruic-lbl">种子</span>
              <input class="ruic-seed" type="number" min="0" max="18446744073709551615" step="1">
            </span>
          </div>
        </div>
        <div class="ruic-prompt">
          <div class="ruic-presets">
            <span class="ruic-preset-lbl">预设</span>
            <button class="ruic-preset" data-preset="line">📐 线稿版</button>
            <button class="ruic-preset" data-preset="depth">🌗 深度版</button>
            <span class="ruic-preset-hint">点一下填入，也可自己改</span>
          </div>
          <textarea class="ruic-prompt-ta" spellcheck="false"></textarea>
          <div class="ruic-prompt-foot">ⓘ 深度图对姿势的控制更精准 —— 需要时点姿势卡片里的「转深度图」</div>
        </div>
        <div class="ruic-cards">${KIND_CFG.map(cardHTML).join("")}</div>`;

      const qSel = wrap.querySelector(".ruic-quality");
      const sInp = wrap.querySelector(".ruic-seed");

      const seedVal = () => {
        const v = parseInt((W["随机种子"] && W["随机种子"].value) || 0, 10);
        return Number.isFinite(v) ? v : 0;
      };
      // 深度图是「针对某一张」的：只记住那张的 ID，换图即失效（恢复线稿）
      const depthId = () => (W["姿势深度ID"] ? String(W["姿势深度ID"].value || "").trim() : "");
      const setDepthId = (id) => setWidget(W, "姿势深度ID", id || "");

      // 关键修复：顶栏显示必须回读真实参数值。
      // 旧版只在建节点时读一次，读档后工作流里的「缩略图」被写回控件，下拉却还显示「原图」，
      // 于是"明明选了原图却出缩略图"。现在每次读档、每次刷新预览前都对齐一次。
      function syncTop() {
        if (qSel) {
          const raw = String(W["质量"] ? W["质量"].value : "原图");
          const want = raw.indexOf("缩略") >= 0 ? "缩略图" : "原图";
          if (qSel.value !== want) qSel.value = want;
        }
        if (sInp) {
          const v = String(seedVal());
          if (sInp.value !== v) sInp.value = v;
        }
      }

      if (qSel) {
        qSel.addEventListener("change", () => {
          setWidget(W, "质量", qSel.value);
          app.graph.setDirtyCanvas(true, true);
        });
      }
      if (sInp) {
        const commitSeed = () => {
          let v = parseInt(sInp.value, 10);
          if (!Number.isFinite(v) || v < 0) v = 0;
          sInp.value = String(v);
          setWidget(W, "随机种子", v);
          app.graph.setDirtyCanvas(true, true);
        };
        sInp.addEventListener("change", commitSeed);
        sInp.addEventListener("blur", commitSeed);
        sInp.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { commitSeed(); sInp.blur(); }
        });
      }

      // DOM 控件：给一个可增长区间，litegraph 会把节点多余的高度分给它（关键：拖动节点时卡片跟着变）
      let domWidget = null;
      try {
        domWidget = node.addDOMWidget("ruic_ui", "ruic", wrap, {
          serialize: false,
          hideOnZoom: false,
          getMinHeight: () => MIN_H - 40,
          getMaxHeight: () => 8000,
          // 用户拖动节点后立即同步内部尺寸（afterResize 由 addWidget 自动挂到 node.onResize）
          afterResize: (n) => {
            syncSize(n.size);
            requestAnimationFrame(() => syncSize(n.size));
          },
        });
      } catch (e) {
        // 极端情况下 DOM 控件注入失败：回退为默认参数面板，保证节点可用
        for (const w of node.widgets) w.hidden = false;
        console.error("[RuiC PoseAtlas] addDOMWidget 失败，已回退默认面板：", e);
        return;
      }

      // ---- 尺寸同步：让卡片区始终铺满节点（宽高都跟随拖动） ----
      const EST_TOP = 104;  // 仅当容器还没测量出来时，用节点高度估算可用的控件高度（顶栏两行）
      const W_MARGIN = 10;  // 必须与前端 DomWidgets.vue 里的 widget.margin 默认值一致
      function syncSize(size) {
        const s = size || node.size || [MIN_W, MIN_H];
        const p = wrap.parentElement;
        const pw = p ? p.clientWidth : 0;
        const ph = p ? p.clientHeight : 0;
        const estW = Math.max(160, Math.round(s[0] - W_MARGIN * 2));
        const w = Math.max(estW, pw);
        const h = ph > 0
          ? Math.min(ph, Math.round(s[1]))
          : Math.max(110, Math.round(s[1] - EST_TOP));
        const ws = w + "px", hs = h + "px";
        if (wrap.style.width !== ws) wrap.style.width = ws;
        if (wrap.style.height !== hs) wrap.style.height = hs;
        try {
          if (domWidget) domWidget.width = s[0];
        } catch (e) {}
      }

      let _ro = null;
      function bindResizeObserver() {
        const p = wrap.parentElement;
        if (!p || typeof ResizeObserver !== "function") return;
        if (_ro && _ro._target === p) return;
        try { if (_ro) _ro.disconnect(); } catch (e) {}
        _ro = new ResizeObserver(() => syncSize(node.size));
        _ro._target = p;
        _ro.observe(p);
      }

      function ensureMinSize() {
        try {
          const w = Math.max(MIN_W, node.size[0] || 0);
          const h = Math.max(MIN_H, node.size[1] || 0);
          if (node.size[0] < w - 1 || node.size[1] < h - 1) node.setSize([w, h]);
          syncSize(node.size);
          bindResizeObserver();
          app.graph.setDirtyCanvas(true, true);
        } catch (e) {}
      }

      // 读取旧工作流时 graph.configure 会把尺寸与控件值覆盖回存档值，这里再校正一次
      const prevOnConfigure = node.onConfigure;
      node.onConfigure = function () {
        if (typeof prevOnConfigure === "function") {
          try { prevOnConfigure.apply(this, arguments); } catch (e) {}
        }
        setTimeout(() => { syncTop(); ensureMinSize(); }, 60);
        setTimeout(() => { syncTop(); ensureMinSize(); }, 400);
        setTimeout(() => {
          try { node._ruicSyncPrompt && node._ruicSyncPrompt(); } catch (e) {}
          try { node._ruicAdoptAll && node._ruicAdoptAll(); } catch (e) {}
          syncTop();
        }, 120);
      };

      // 顶部按钮
      wrap.querySelector(".ruic-combo").addEventListener("click", () => {
        for (const cfg of KIND_CFG) randomOne(cfg);
      });
      wrap.querySelector(".ruic-update").addEventListener("click", () => {
        for (const cfg of KIND_CFG) {
          STATE[cfg.key].lockedId = null;
          setWidget(W, cfg.lockW, "");
          refreshPreview(cfg);
        }
      });
      wrap.querySelector(".ruic-open").addEventListener("click", () => {
        window.open(LIBRARY_URL, "_blank", "noopener");
      });

      // ---- 提示词模板（自动填姿势）----
      const pBtn = wrap.querySelector(".ruic-prompt-btn");
      const pBox = wrap.querySelector(".ruic-prompt");
      const pTa = wrap.querySelector(".ruic-prompt-ta");
      const syncPromptBox = () => {
        if (!pTa) return;
        const cur = W["提示词模板"] ? String(W["提示词模板"].value || "") : "";
        if (pTa.value !== cur) pTa.value = cur;
      };
      if (pBtn && pBox) {
        pBtn.addEventListener("click", () => {
          const open = !pBox.classList.contains("open");
          pBox.classList.toggle("open", open);
          if (open) { syncPromptBox(); if (pTa) { pTa.scrollTop = 0; pTa.focus(); } }
          // 展开 / 收起时给节点补上（或退回）对应高度，否则会把下面的卡片压扁
          try {
            const delta = 176;
            const base = node.size[1] || MIN_H;
            node.setSize([node.size[0], Math.max(MIN_H, Math.round(base + (open ? delta : -delta)))]);
            requestAnimationFrame(() => syncSize(node.size));
          } catch (e) {}
          app.graph.setDirtyCanvas(true, true);
        });
      }
      if (pTa) {
        pTa.addEventListener("input", () => {
          setWidget(W, "提示词模板", pTa.value);
          markPreset();
          app.graph.setDirtyCanvas(true, true);
        });
        node._ruicSyncPrompt = syncPromptBox;
      }

      // 两版预设：点一下直接写进模板框；不点就自己写。
      const PRESET_MAP = { line: PRESET_LINE, depth: PRESET_DEPTH };
      function markPreset(active) {
        const cur = String((W["提示词模板"] && W["提示词模板"].value) || "").trim();
        wrap.querySelectorAll(".ruic-preset").forEach(b => {
          const on = active ? b.dataset.preset === active : PRESET_MAP[b.dataset.preset] === cur;
          b.classList.toggle("on", !!on);
        });
      }
      wrap.querySelectorAll(".ruic-preset").forEach(btn => {
        btn.addEventListener("click", () => {
          const txt = PRESET_MAP[btn.dataset.preset];
          if (!txt) return;
          if (pTa) { pTa.value = txt; pTa.scrollTop = 0; }
          setWidget(W, "提示词模板", txt);
          if (pBox) pBox.classList.add("open");
          markPreset(btn.dataset.preset);
          app.graph.setDirtyCanvas(true, true);
        });
      });
      setTimeout(() => markPreset(), 300);

      // 卡片事件委托
      wrap.querySelectorAll(".ruic-rand").forEach(btn => {
        btn.addEventListener("click", () => randomOne(KIND_CFG.find(c => c.key === btn.dataset.kind)));
      });
      wrap.querySelectorAll(".ruic-next").forEach(btn => {
        btn.addEventListener("click", () => nextOne(KIND_CFG.find(c => c.key === btn.dataset.kind)));
      });
      wrap.querySelectorAll(".ruic-block").forEach(btn => {
        btn.addEventListener("click", () => toggleBlock(KIND_CFG.find(c => c.key === btn.dataset.kind)));
      });
      wrap.querySelectorAll(".ruic-pin").forEach(btn => {
        btn.addEventListener("click", () => unlock(KIND_CFG.find(c => c.key === btn.dataset.kind)));
      });
      wrap.querySelectorAll(".ruic-filters select").forEach(sel => {
        sel.addEventListener("change", () => {
          applyFilter(KIND_CFG.find(c => c.key === sel.dataset.kind), sel.dataset.field, sel.value);
        });
      });
      // 点预览图 -> 打开素材选择器
      wrap.querySelectorAll(".ruic-prev").forEach(pv => {
        pv.addEventListener("click", () => {
          const kind = pv.closest(".ruic-card").dataset.kind;
          openPicker(KIND_CFG.find(c => c.key === kind));
        });
      });

      // 姿势卡片里的「转深度图」：只影响当前这一张
      const dBtn = wrap.querySelector(".ruic-depth");
      if (dBtn) dBtn.addEventListener("click", () => { toggleDepth(); });

      // 种子变化时刷新未锁定卡片，并同步顶栏输入框
      if (W["随机种子"]) {
        const origCb = W["随机种子"].callback;
        W["随机种子"].callback = (v) => {
          if (typeof origCb === "function") { try { origCb(v); } catch (e) {} }
          if (sInp && String(sInp.value) !== String(v)) sInp.value = String(v);
          for (const cfg of KIND_CFG) if (!STATE[cfg.key].lockedId) refreshPreview(cfg);
        };
      }

      // 状态
      for (const cfg of KIND_CFG) {
        const el = wrap.querySelector(`.ruic-card[data-kind="${cfg.key}"]`);
        STATE[cfg.key] = {
          lockedId: null,
          filters: {},
          cardEl: el,
          imgEl: el.querySelector("img"),
          phEl: el.querySelector(".ruic-ph"),
          tagEl: el.querySelector(".ruic-tag"),
          prevEl: el.querySelector(".ruic-prev"),
          fnameEl: el.querySelector(".ruic-fname"),
          pagerEl: el.querySelector(".ruic-pager"),
          nextBtn: el.querySelector(".ruic-next"),
          blockBtn: el.querySelector(".ruic-block"),
          pinBtn: el.querySelector(".ruic-pin"),
          depthBtn: el.querySelector(".ruic-depth"),
        };
      }

      // 加载数据并填充
      try {
        DATA = await loadAll();
        for (const cfg of KIND_CFG) fillCard(cfg, DATA);
        // 关键：先继承存档里的「选定ID」（后端优先按它出图），预览才不会和出图错位
        for (const cfg of KIND_CFG) adoptSavedId(cfg);
        for (const cfg of KIND_CFG) refreshPreview(cfg);
        ensureMinSize();
        bindResizeObserver();
        syncTop();
        requestAnimationFrame(() => syncSize(node.size));
        setTimeout(ensureMinSize, 250);
        setTimeout(ensureMinSize, 800);
        // 读档回调里要用，挂到节点上
        node._ruicAdoptAll = () => {
          for (const cfg of KIND_CFG) { adoptSavedId(cfg); rebuildFilters(cfg); refreshPreview(cfg); }
          syncTop();
        };
      } catch (e) {
        // 数据拉取失败：退回标准控件
        for (const w of node.widgets) w.hidden = false;
        wrap.innerHTML = `<div class="ruic-err">⚠️ 自定义界面加载失败（三条线路都取不到素材库数据）：<br>${e.message}
          <br><br>已自动切换为默认参数面板。可点右上角「打开素材库」确认网络，或开启代理后再试。</div>`;
        ensureMinSize();
      }

      // ---------------- 筛选 ----------------
      function rawValue(cfg, field) {
        const v = STATE[cfg.key].filters[field];
        return !v || v === "全部" ? null : (ZH_REV[v] || v);
      }

      // 该卡在「除 exclude 以外的全部条件」下还剩哪些素材
      function poolOf(cfg, exclude) {
        let pool = DATA.items.filter(it => it.kind === cfg.key);
        for (const f of cfg.filters) {
          if (f.field === exclude) continue;
          const want = rawValue(cfg, f.field);
          if (!want) continue;
          pool = pool.filter(it => _match(it.sub[f.field], want));
        }
        return pool;
      }

      // 级联：某维度的可选值 = 其它条件筛完后还剩的素材里出现过的值。
      // 这样"标准全身"下面就不会再冒出只有"性感全身"才有的分类（选中必然 0 张）。
      function rebuildFilters(cfg) {
        if (!DATA) return;
        const st = STATE[cfg.key];
        for (const f of cfg.filters) {
          const vals = new Set();
          for (const it of poolOf(cfg, f.field)) {
            const v = it.sub[f.field];
            if (Array.isArray(v)) v.forEach(x => x && vals.add(x));
            else if (v) vals.add(v);
          }
          const sorted = Array.from(vals).sort();
          const cur = st.filters[f.field];
          let next = cur && (cur === "全部" || sorted.includes(ZH_REV[cur] || cur)) ? cur : "全部";
          const opts = [`<option>全部</option>`]
            .concat(sorted.map(v => `<option>${zhOf(v)}</option>`)).join("");

          const sel = st.cardEl.querySelector(`select[data-field="${f.field}"]`);
          if (sel) {
            if (sel.innerHTML !== opts) sel.innerHTML = opts;
            if (sel.value !== next) sel.value = next;
          }
          if (PICKER && PICKER.cfg.key === cfg.key) {
            const psel = PICKER.el.querySelector(`select[data-field="${f.field}"]`);
            if (psel) {
              if (psel.innerHTML !== opts) psel.innerHTML = opts;
              if (psel.value !== next) psel.value = next;
            }
          }
          st.filters[f.field] = next;
          setWidget(W, f.wname, next);
        }
      }

      function applyFilter(cfg, field, value) {
        STATE[cfg.key].filters[field] = value;
        const fcfg = cfg.filters.find(f => f.field === field);
        if (fcfg) setWidget(W, fcfg.wname, value);
        // 改筛选 => 取消该卡锁定，回到种子确定性预览
        STATE[cfg.key].lockedId = null;
        setWidget(W, cfg.lockW, "");
        rebuildFilters(cfg);
        refreshPreview(cfg);
        if (PICKER && PICKER.cfg.key === cfg.key) { PICKER.page = 0; renderPicker(); }
        app.graph.setDirtyCanvas(true, true);
      }

      function fillCard(cfg, DATA) {
        const st = STATE[cfg.key];
        for (const f of cfg.filters) {
          const cur = W[f.wname] ? W[f.wname].value : "全部";
          st.filters[f.field] = cur || "全部";
        }
        rebuildFilters(cfg);
      }

      // 继承存档里已锁定的 ID（例如上次点过 🎲 保存的）
      function adoptSavedId(cfg) {
        const w = W[cfg.lockW];
        const v = w ? String(w.value == null ? "" : w.value).trim() : "";
        if (v && DATA.byId[cfg.key + "/" + v]) {
          STATE[cfg.key].lockedId = v;
        }
      }

      function currentPool(cfg) {
        let pool = DATA.items.filter(it => it.kind === cfg.key);
        for (const f of cfg.filters) {
          const want = rawValue(cfg, f.field);
          if (!want) continue;
          pool = pool.filter(it => _match(it.sub[f.field], want));
        }
        return pool;
      }

      // 预览地址：只有「当前这张被点了转深度图」的姿势才走后端转换；
      // 后端转不出来（或模型缺失回退失败）会返回 404，自动退回原线稿预览。
      // 卡片用原图转换（缩略图 300×400 线条太细，转出来糊成一团，看不清效果）；
      // 选择器里 30 张同时加载，仍用缩略图，省流量。
      function previewUrls(cfg, item, quality) {
        if (cfg.key === "pose" && item && depthId() === item.id) {
          const q = quality || "full";
          return [`${DEPTH_API}?kind=pose&id=${encodeURIComponent(item.id)}&q=${q}`]
            .concat(item.thumb_urls || []);
        }
        return item.thumb_urls || [];
      }

      function showImg(st, urls) {
        let i = 0;
        const fail = (msg) => {
          st.imgEl.style.display = "none";
          st.phEl.style.display = "flex";
          st.phEl.textContent = msg;
        };
        const next = () => {
          if (i >= urls.length) { fail("预览加载失败（仍可出图）"); return; }
          st.imgEl.src = urls[i++];
        };
        st.imgEl.onload = () => {
          st.imgEl.style.display = "block";
          st.phEl.style.display = "none";
        };
        st.imgEl.onerror = next;
        st.imgEl.style.display = "none";
        st.phEl.style.display = "flex";
        st.phEl.textContent = "加载中…";
        next();
      }

      function updatePager(st, pool, item) {
        const total = pool.length;
        const idx = item ? pool.findIndex(it => it.id === item.id) : -1;
        if (!total) st.pagerEl.textContent = "0 / 0";
        else if (idx < 0) st.pagerEl.textContent = `— / ${total}`;
        else st.pagerEl.textContent = `${idx + 1} / ${total}`;
        st.nextBtn.disabled = total <= 1;
      }

      function refreshPreview(cfg) {
        const st = STATE[cfg.key];
        if (!DATA) return;
        syncTop();
        const blocked = st.cardEl.classList.contains("blocked");
        st.blockBtn.classList.toggle("on", blocked);
        st.pinBtn.classList.toggle("on", !!st.lockedId);
        st.pinBtn.title = st.lockedId
          ? `已锁定：${st.lockedId}。点这里取消锁定，回到「按种子随机」`
          : "未锁定（按种子随机）。点卡片图片可挑指定素材";
        const pool = currentPool(cfg);

        const blank = (msg) => {
          st.imgEl.style.display = "none";
          st.phEl.style.display = "flex";
          st.phEl.textContent = msg;
          st.fnameEl.textContent = "";
          st.tagEl.style.display = "none";
        };

        if (blocked) {
          blank("已屏蔽 · 不参与输出");
          st.pagerEl.textContent = "—";
          st.nextBtn.disabled = true;
          if (st.depthBtn) { st.depthBtn.classList.remove("on"); st.depthBtn.textContent = "◐ 转深度图"; }
          return;
        }
        let item = st.lockedId ? DATA.byId[cfg.key + "/" + st.lockedId] : null;
        if (!item) {
          if (!pool.length) {
            blank("该子分类下暂无素材");
            updatePager(st, pool, null);
            return;
          }
          const seed = seedVal();
          item = pool[((seed + cfg.offset) % pool.length + pool.length) % pool.length];
          // 关键：把算出来的 ID 写回控件，后端就会输出同一张 —— 预览=出图
          setWidget(W, cfg.lockW, item.id);
        }
        st.pinBtn.classList.toggle("on", !!st.lockedId);
        updatePager(st, pool, item);

        // 深度标记只对「当初点的那一张」有效：换图后自动失效，恢复线稿
        if (cfg.key === "pose" && depthId() && depthId() !== item.id) setDepthId("");
        const isDepth = cfg.key === "pose" && depthId() === item.id;
        if (st.depthBtn) {
          st.depthBtn.classList.toggle("on", isDepth);
          st.depthBtn.textContent = isDepth ? "◑ 深度图（点此还原）" : "◐ 转深度图";
          st.depthBtn.title = isDepth
            ? "当前这张已换成深度图。再点一下还原线稿；换图后也会自动还原。"
            : "只把当前这一张姿势换成深度图再送给模型（不影响其它姿势）。换图后自动恢复线稿。";
        }
        st.tagEl.style.display = isDepth ? "block" : "none";
        st.tagEl.textContent = "深度图";

        const urls = previewUrls(cfg, item);
        if (!urls.length) {
          blank("无预览图");
          st.fnameEl.textContent = item.id;
          return;
        }
        showImg(st, urls);
        st.fnameEl.textContent = item.id;
      }

      function nextOne(cfg) {
        const st = STATE[cfg.key];
        if (st.cardEl.classList.contains("blocked")) return;
        const pool = currentPool(cfg);
        if (!pool.length) { refreshPreview(cfg); return; }
        const cur = st.lockedId ? pool.findIndex(it => it.id === st.lockedId) : -1;
        const item = pool[(cur + 1) % pool.length];
        lockItem(cfg, item);
      }

      function randomOne(cfg) {
        const pool = currentPool(cfg);
        if (!pool.length) { refreshPreview(cfg); return; }
        lockItem(cfg, pool[Math.floor(Math.random() * pool.length)]);
      }

      function lockItem(cfg, item) {
        STATE[cfg.key].lockedId = item.id;
        setWidget(W, cfg.lockW, item.id);
        refreshPreview(cfg);
        if (PICKER && PICKER.cfg.key === cfg.key) renderPicker();
        app.graph.setDirtyCanvas(true, true);
      }

      function unlock(cfg) {
        STATE[cfg.key].lockedId = null;
        setWidget(W, cfg.lockW, "");
        refreshPreview(cfg);
        if (PICKER && PICKER.cfg.key === cfg.key) renderPicker();
        app.graph.setDirtyCanvas(true, true);
      }

      function toggleBlock(cfg) {
        const st = STATE[cfg.key];
        const nowBlocked = !st.cardEl.classList.contains("blocked");
        st.cardEl.classList.toggle("blocked", nowBlocked);
        st.blockBtn.classList.toggle("on", nowBlocked);
        st.blockBtn.textContent = nowBlocked ? "取消屏蔽" : "屏蔽";
        setWidget(W, cfg.enableW, !nowBlocked);
        refreshPreview(cfg);
      }

      // ---------------- 姿势深度图（只影响当前这一张） ----------------
      const CFG_POSE = KIND_CFG.find(c => c.key === "pose");

      function currentPoseItem() {
        if (!DATA) return null;
        const st = STATE["pose"];
        if (st.lockedId) {
          const it = DATA.byId["pose/" + st.lockedId];
          if (it) return it;
        }
        const pool = currentPool(CFG_POSE);
        if (!pool.length) return null;
        const seed = seedVal();
        return pool[((seed + CFG_POSE.offset) % pool.length + pool.length) % pool.length];
      }

      function depthDialog(opt) {
        return new Promise((resolve) => {
          const mask = document.createElement("div");
          mask.className = "ruic-mask";
          const mb = opt.mb || 95;
          let body = "";
          if (opt.mode === "ask") {
            body = `<h3>需要先下载深度模型</h3>
              <p>把姿势线稿转成深度图，需要 <b>DepthAnything V2 Small</b> 模型（约 ${mb} MB）。</p>
              <p>从<b>魔搭 ModelScope</b>（国内可直连）下载，存进插件自己的 <code>.cache/models</code>，只需下这一次。</p>
              <p>不想下也行：取消后继续用内置的轻量体积图，效果略差但零依赖。</p>
              <div class="ruic-dlg-act"><button class="no">取消</button><button class="pri yes">下载并启用</button></div>`;
          } else if (opt.mode === "noaux") {
            body = `<h3>缺少依赖，暂时用不了深度模型</h3>
              <p>没检测到 <code>comfyui_controlnet_aux</code>，深度模型要靠它提供推理代码。</p>
              <p>两个选择：装上它；或者继续用内置体积图（零依赖，效果略差）。</p>
              <div class="ruic-dlg-act"><button class="pri no">知道了</button></div>`;
          } else {
            body = `<h3>正在下载深度模型</h3>
              <p>约 ${mb} MB，来自魔搭 ModelScope。下完自动启用，不用重启。</p>
              <div class="ruic-bar"><i></i></div>
              <div class="ruic-pct">0%</div>
              <div class="ruic-dlg-act"><button class="cancel">后台下载，先关掉</button></div>`;
          }
          mask.innerHTML = `<div class="ruic-dlg">${body}</div>`;
          document.body.appendChild(mask);

          const close = (v) => {
            try { clearInterval(timer); } catch (e) {}
            try { clearTimeout(timer); } catch (e) {}
            mask.remove();
            resolve(v);
          };
          let timer = null;

          const noBtn = mask.querySelector(".no");
          const yesBtn = mask.querySelector(".yes");
          const cancelBtn = mask.querySelector(".cancel");
          if (noBtn) noBtn.addEventListener("click", () => close(false));
          if (yesBtn) yesBtn.addEventListener("click", () => close(true));
          if (cancelBtn) cancelBtn.addEventListener("click", () => close(false));

          if (opt.mode === "progress") {
            const bar = mask.querySelector(".ruic-bar i");
            const pct = mask.querySelector(".ruic-pct");
            const tick = async () => {
              let s = null;
              try { s = await (await fetch("/ruic/depth/status")).json(); } catch (e) {}
              if (!s) return;
              const p = Math.max(0, Math.min(100, s.pct || 0));
              if (bar) bar.style.width = p + "%";
              if (pct) pct.textContent = p + "%";
              if (s.ready) { close(true); return; }
              if (!s.downloading && s.error) {
                if (pct) {
                  pct.textContent = "下载失败：" + String(s.error).slice(0, 90);
                  pct.style.color = "#ffb3b3";
                }
                if (cancelBtn) cancelBtn.textContent = "关闭";
                try { clearInterval(timer); } catch (e) {}
              }
            };
            timer = setInterval(tick, 800);
            tick();
          }
        });
      }

      async function ensureDepthModel() {
        let s = null;
        try { s = await (await fetch("/ruic/depth/status")).json(); } catch (e) { s = null; }
        if (s && s.ready) return true;
        if (s && s.aux === false) { await depthDialog({ mode: "noaux" }); return false; }
        const go = await depthDialog({ mode: "ask", mb: s && s.mb });
        if (!go) return false;
        try {
          await fetch("/ruic/depth/download", { method: "POST" });
        } catch (e) {
          await depthDialog({ mode: "noaux" });
          return false;
        }
        return await depthDialog({ mode: "progress", mb: s && s.mb });
      }

      let _depthBusy = false;
      async function toggleDepth() {
        if (_depthBusy) return;
        const st = STATE["pose"];
        if (!st || !hasDepth) return;
        if (st.cardEl.classList.contains("blocked")) return;
        const item = currentPoseItem();
        if (!item) return;

        if (depthId() === item.id) {          // 已开 -> 还原线稿
          setDepthId("");
          refreshPreview(CFG_POSE);
          app.graph.setDirtyCanvas(true, true);
          return;
        }
        _depthBusy = true;
        try {
          const ok = await ensureDepthModel();
          if (!ok) return;
          setDepthId(item.id);
          refreshPreview(CFG_POSE);
          app.graph.setDirtyCanvas(true, true);
        } finally {
          _depthBusy = false;
        }
      }

      // ---------------- 素材选择器（二级弹窗） ----------------
      const PAGE_SIZE = 30;

      function openPicker(cfg) {
        closePicker();
        const st = STATE[cfg.key];
        if (st.cardEl.classList.contains("blocked")) return;

        const mask = document.createElement("div");
        mask.className = "ruic-mask";
        mask.innerHTML = `
          <div class="ruic-picker">
            <div class="ruic-pk-head">
              <div class="ruic-pk-title"></div>
              <button class="ruic-pk-close" title="关闭（Esc）">✕</button>
            </div>
            <div class="ruic-pk-filters">
              ${cfg.filters.map(f => `<label>${f.zh}
                <select data-kind="${cfg.key}" data-field="${f.field}"><option>全部</option></select></label>`).join("")}
            </div>
            <div class="ruic-pk-grid"></div>
            <div class="ruic-pk-foot">
              <button class="ruic-pk-prev">‹ 上一页</button>
              <button class="ruic-pk-next">下一页 ›</button>
              <span class="ruic-pk-count"></span>
              <span class="ruic-pk-grow"></span>
              <button class="ruic-pk-rand">🎲 随机一张</button>
              <button class="ruic-pk-unlock">取消锁定</button>
            </div>
          </div>`;
        document.body.appendChild(mask);
        PICKER = { cfg, el: mask, page: 0, kind: cfg.key };

        mask.addEventListener("mousedown", (e) => {
          if (e.target === mask) closePicker();   // 点遮罩关闭
        });
        mask.querySelector(".ruic-pk-close").addEventListener("click", closePicker);
        mask.querySelector(".ruic-pk-prev").addEventListener("click", () => {
          PICKER.page = Math.max(0, PICKER.page - 1); renderPicker();
        });
        mask.querySelector(".ruic-pk-next").addEventListener("click", () => {
          PICKER.page += 1; renderPicker();
        });
        mask.querySelector(".ruic-pk-rand").addEventListener("click", () => {
          const pool = currentPool(cfg);
          if (pool.length) lockItem(cfg, pool[Math.floor(Math.random() * pool.length)]);
          closePicker();
        });
        mask.querySelector(".ruic-pk-unlock").addEventListener("click", () => {
          unlock(cfg); closePicker();
        });
        mask.querySelectorAll(".ruic-pk-filters select").forEach(sel => {
          sel.addEventListener("change", () => {
            applyFilter(cfg, sel.dataset.field, sel.value);
          });
        });
        // 点缩略图 = 选中并关闭
        mask.querySelector(".ruic-pk-grid").addEventListener("click", (e) => {
          const cell = e.target.closest(".ruic-pk-cell");
          if (!cell) return;
          const item = DATA.byId[cfg.key + "/" + cell.dataset.id];
          if (item) { lockItem(cfg, item); closePicker(); }
        });

        PICKER._onKey = (e) => { if (e.key === "Escape") closePicker(); };
        document.addEventListener("keydown", PICKER._onKey);

        // 先让筛选下拉与卡片一致，再渲染
        rebuildFilters(cfg);
        // 定位到当前选中那张所在的页
        const pool = currentPool(cfg);
        const idx = st.lockedId ? pool.findIndex(it => it.id === st.lockedId) : -1;
        PICKER.page = idx >= 0 ? Math.floor(idx / PAGE_SIZE) : 0;
        renderPicker();
      }

      function closePicker() {
        if (!PICKER) return;
        try { document.removeEventListener("keydown", PICKER._onKey); } catch (e) {}
        try { PICKER.el.remove(); } catch (e) {}
        PICKER = null;
      }

      function renderPicker() {
        if (!PICKER) return;
        const cfg = PICKER.cfg;
        const st = STATE[cfg.key];
        const pool = currentPool(cfg);
        const pages = Math.max(1, Math.ceil(pool.length / PAGE_SIZE));
        if (PICKER.page >= pages) PICKER.page = pages - 1;
        if (PICKER.page < 0) PICKER.page = 0;
        const start = PICKER.page * PAGE_SIZE;
        const slice = pool.slice(start, start + PAGE_SIZE);
        const isDepth = cfg.key === "pose" && !!depthId();

        const titleEl = PICKER.el.querySelector(".ruic-pk-title");
        const filterDesc = cfg.filters
          .map(f => (rawValue(cfg, f.field) ? zhOf(rawValue(cfg, f.field)) : null))
          .filter(Boolean).join(" · ");
        titleEl.innerHTML = `选择<b>${cfg.title}</b>${filterDesc ? " · " + filterDesc : ""}`
          + ` · 共 <b>${pool.length}</b> 张${isDepth ? " · <span style='color:#cbb6ff'>有 1 张已转深度图</span>" : ""}`;

        const grid = PICKER.el.querySelector(".ruic-pk-grid");
        if (!pool.length) {
          grid.innerHTML = `<div class="ruic-pk-empty">当前条件下没有素材，换个筛选试试</div>`;
        } else {
          grid.innerHTML = slice.map(it => {
            const sel = it.id === st.lockedId ? " sel" : "";
            const u = (previewUrls(cfg, it, "thumb") || [])[0] || "";
            return `<div class="ruic-pk-cell${sel}" data-id="${it.id}" title="${it.name}">
              ${u ? `<img src="${u}" alt="" loading="lazy">` : ``}
              ${sel ? `<div class="ruic-pk-ok">✓</div>` : ``}
              <div class="ruic-pk-id">${it.id}</div>
            </div>`;
          }).join("");
        }
        PICKER.el.querySelector(".ruic-pk-count").textContent =
          `第 ${PICKER.page + 1} / ${pages} 页` + (pool.length ? `　${start + 1}-${Math.min(start + PAGE_SIZE, pool.length)}` : "");
        PICKER.el.querySelector(".ruic-pk-prev").disabled = PICKER.page <= 0;
        PICKER.el.querySelector(".ruic-pk-next").disabled = PICKER.page >= pages - 1;
        PICKER.el.querySelector(".ruic-pk-unlock").disabled = !st.lockedId;
        // 缩略图加载失败就依次换线路
        grid.querySelectorAll("img").forEach(img => {
          const cell = img.closest(".ruic-pk-cell");
          const item = DATA.byId[cfg.key + "/" + cell.dataset.id];
          if (!item) return;
          const list = previewUrls(cfg, item, "thumb");
          let i = 0;
          img.onerror = () => {
            i += 1;
            if (i < list.length) img.src = list[i];
            else img.remove();
          };
        });
      }
    },
  });
}
