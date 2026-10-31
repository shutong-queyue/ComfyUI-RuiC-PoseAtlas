// RuiC PoseAtlas 三图组合节点 —— 自定义前端 UI
// 适配：本机秋叶版 ComfyUI 的核心 app 实例挂在 window.comfyAPI.app.app
//       （外层是命名空间容器，内层才是真 app；官方 scripts/app.js 只是把它再导出一遍）。
// 做法：隐藏全部标准控件，用 addDOMWidget 注入三卡片布局（人像/衣装/姿势），
//       卡片内可切换子分类、🎲 单类随机、屏蔽，并实时预览。
// 同步：预览选中的条目会写回隐藏的「选定ID」控件，后端优先按 ID 出图 => 预览恒等于出图。
// 布局：卡片区铺满节点宽度，预览图高度随节点高度伸缩（getMinHeight/getMaxHeight + 显式尺寸同步）。
// 数据/图片三条线路兜底：GitHub Pages 主站 + jsDelivr（fastly/cdn），避免国内直连失败。

const app = (window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app) || window.app;

console.log("[RuiC PoseAtlas] 前端扩展脚本已加载 v4.3（顶栏新增 质量 / 种子），app =", app ? "ok" : "MISSING");

// 三条线路（站点根 = 仓库根，路径一致，可互为镜像）
const SITE_BASES = [
  "https://hruiccc.github.io/RuiC-PoseAtlas/",
  "https://fastly.jsdelivr.net/gh/HRuiCcc/RuiC-PoseAtlas@main/",
  "https://cdn.jsdelivr.net/gh/HRuiCcc/RuiC-PoseAtlas@main/",
];
const GH_PAGES = SITE_BASES[0];
const LIBRARY_URL = GH_PAGES;   // 「打开素材库」跳这里

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

// 节点尺寸约束（图单位）
const MIN_W = 620;
const MIN_H = 490;   // 加了「进度 + 下一张」行，最小高度相应提高，避免卡片被压扁

const STYLE = `
.ruic-wrap{width:100%;height:100%;max-height:100%;box-sizing:border-box;
  min-width:0;min-height:0;display:flex;flex-direction:column;gap:8px;
  padding:0 0 8px 0;   /* 底部留白，卡片不贴节点底边 */
  font-family:system-ui,"Microsoft YaHei",sans-serif;color:#e6e6e6;overflow:hidden;}
.ruic-wrap *{box-sizing:border-box;}
.ruic-top{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap;row-gap:6px;}
.ruic-top button{background:#2b2b3a;color:#fff;border:1px solid #444;border-radius:6px;padding:5px 10px;cursor:pointer;
  font-size:12px;white-space:nowrap;flex:none;}
.ruic-top button:hover{border-color:#7c5cff;background:#34344a;}
.ruic-top .ruic-open{margin-left:auto;background:#22304a;border-color:#3a5a8a;color:#bcd8ff;}
.ruic-top .ruic-open:hover{border-color:#5b8fd6;background:#2a3d5c;}
/* 原生控件被隐藏，质量 / 种子在顶栏给出等价入口 */
.ruic-ctl{display:flex;align-items:center;gap:5px;flex:none;font-size:12px;color:#cfcfe0;}
.ruic-ctl .ruic-lbl{opacity:.72;white-space:nowrap;}
.ruic-top .ruic-quality,.ruic-top .ruic-seed{background:#2b2b3a;color:#fff;border:1px solid #444;border-radius:6px;
  padding:4px 6px;font-size:12px;height:28px;box-sizing:border-box;outline:none;}
.ruic-top .ruic-quality:hover,.ruic-top .ruic-seed:hover{border-color:#7c5cff;}
.ruic-top .ruic-quality:focus,.ruic-top .ruic-seed:focus{border-color:#7c5cff;}
.ruic-top .ruic-seed{width:110px;}
.ruic-top .ruic-seed::-webkit-outer-spin-button,
.ruic-top .ruic-seed::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}
.ruic-cards{flex:1 1 auto;min-height:0;min-width:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));
  gap:8px;overflow:hidden;}
.ruic-card{min-width:0;min-height:0;background:#1c1c28;border:1px solid #333;border-radius:10px;padding:8px;
  display:flex;flex-direction:column;gap:6px;overflow:hidden;}
.ruic-card.blocked{opacity:.5;filter:grayscale(.6);}
.ruic-head{display:flex;align-items:center;gap:6px;min-width:0;flex:none;}
.ruic-badge{width:18px;height:18px;border-radius:50%;color:#fff;display:flex;align-items:center;justify-content:center;
  font-size:11px;font-weight:700;flex:none;}
.ruic-title{font-size:12px;font-weight:600;flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ruic-title small{color:#9aa0b4;font-weight:400;font-size:10px;margin-left:4px;}
.ruic-block{background:#3a2030;color:#ff9bb0;border:1px solid #5a3040;border-radius:6px;padding:2px 6px;
  font-size:11px;cursor:pointer;flex:none;white-space:nowrap;}
.ruic-block.on{background:#5a3040;color:#fff;border-color:#8a4a60;}
.ruic-prev{position:relative;flex:1 1 0;min-height:56px;min-width:0;background:#0e0e16;border-radius:8px;
  overflow:hidden;display:flex;align-items:center;justify-content:center;}
.ruic-prev img{width:100%;height:100%;object-fit:contain;display:none;}
.ruic-ph{position:absolute;left:0;right:0;top:0;bottom:0;display:flex;align-items:center;justify-content:center;
  font-size:11px;color:#7a8094;text-align:center;padding:6px;line-height:1.5;}
.ruic-filters{display:flex;flex-direction:column;gap:4px;flex:none;}
.ruic-filters label{font-size:11px;color:#9aa0b4;display:flex;align-items:center;gap:6px;min-width:0;}
.ruic-filters label span{flex:none;width:26px;}
.ruic-filters select{flex:1 1 auto;min-width:0;background:#2b2b3a;color:#e6e6e6;border:1px solid #444;
  border-radius:5px;padding:2px 4px;font-size:11px;cursor:pointer;}
.ruic-filters select:hover{border-color:#7c5cff;}
.ruic-foot{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 6px;flex:none;min-width:0;}
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
`;

function cardHTML(cfg) {
  const filters = cfg.filters.map(f =>
    `<label><span>${f.zh}</span><select data-kind="${cfg.key}" data-field="${f.field}"><option>全部</option></select></label>`
  ).join("");
  return `<div class="ruic-card" data-kind="${cfg.key}">
    <div class="ruic-head">
      <div class="ruic-badge" style="background:${cfg.color}">${cfg.num}</div>
      <div class="ruic-title">${cfg.title}<small>${cfg.en}</small></div>
      <button class="ruic-block" data-kind="${cfg.key}">屏蔽</button>
    </div>
    <div class="ruic-prev"><img alt="预览"><div class="ruic-ph">加载中…</div></div>
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
      console.log("[RuiC PoseAtlas] 自定义 UI 注入 v4.2 开始，cls =", cls);

      // 收集并隐藏全部标准控件
      const W = {};
      for (const w of node.widgets || []) { w.hidden = true; W[w.name] = w; }
      const STATE = {};
      let DATA = null;

      // 注入样式（只注入一次）
      if (!document.getElementById("ruic-style")) {
        const st = document.createElement("style");
        st.id = "ruic-style"; st.textContent = STYLE;
        document.head.appendChild(st);
      }

      const wrap = document.createElement("div");
      wrap.className = "ruic-wrap";
      wrap.innerHTML = `
        <div class="ruic-top">
          <button class="ruic-combo" title="${HINT_COMBO}">🎲 随机组合</button>
          <button class="ruic-update" title="${HINT_SEED}">↻ 按种子刷新</button>
          <span class="ruic-ctl" title="取图质量：原图 = 素材真实分辨率；缩略图约 400×500，仅适合快速试参">
            <span class="ruic-lbl">质量</span>
            <select class="ruic-quality"><option value="原图">原图</option><option value="缩略图">缩略图</option></select>
          </span>
          <span class="ruic-ctl" title="按种子选图时的数值：改这里可复现或切换组合，等价于原生「随机种子」">
            <span class="ruic-lbl">种子</span>
            <input class="ruic-seed" type="number" min="0" max="2147483647" step="1">
          </span>
          <button class="ruic-open" title="在浏览器打开 RuiC 图鉴素材库">🔗 打开素材库</button>
        </div>
        <div class="ruic-cards">${KIND_CFG.map(cardHTML).join("")}</div>`;

      // 质量 / 种子：原生控件已被整体隐藏，这里给出等价入口并双向同步，
      // 否则用户只能靠"按种子刷新"盲改，无法选择原图分辨率。
      const qSel = wrap.querySelector(".ruic-quality");
      const sInp = wrap.querySelector(".ruic-seed");
      if (qSel) {
        const curQ = W["质量"] ? String(W["质量"].value) : "原图";
        qSel.value = curQ.indexOf("缩略") >= 0 ? "缩略图" : "原图";
        qSel.addEventListener("change", () => {
          setWidget(W, "质量", qSel.value);
          app.graph.setDirtyCanvas(true, true);
        });
      }
      if (sInp) {
        const readSeed = () => {
          const v = parseInt((W["随机种子"] && W["随机种子"].value) || 0, 10);
          return Number.isFinite(v) ? v : 0;
        };
        sInp.value = String(readSeed());
        const commitSeed = () => {
          let v = parseInt(sInp.value, 10);
          if (!Number.isFinite(v) || v < 0) v = 0;
          if (v > 2147483647) v = 2147483647;
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
      // 前端把 DOM 控件放在一个按节点尺寸定位的容器里；容器尺寸由 litegraph 的
      // getMinHeight/getMaxHeight 分配。这里再按「节点尺寸」和「容器实际尺寸」取较大值，
      // 保证无论容器是否滞后，卡片区都铺满。
      const EST_TOP = 78;   // 仅当容器还没测量出来时，用节点高度估算可用的控件高度
      const W_MARGIN = 10;  // 必须与前端 DomWidgets.vue 里的 widget.margin 默认值一致
      function syncSize(size) {
        const s = size || node.size || [MIN_W, MIN_H];
        const p = wrap.parentElement;
        const pw = p ? p.clientWidth : 0;
        const ph = p ? p.clientHeight : 0;
        // 宽度：前端给容器算的是 (widget.width ?? node.width) - margin*2（图单位），
        // 这里用同一个公式；再和实测值取大值兜底（实测 clientWidth 有时偏小，
        // 会导致卡片缩成节点宽的 ~70%、右边留一大片空边）。
        const estW = Math.max(160, Math.round(s[0] - W_MARGIN * 2));
        const w = Math.max(estW, pw);
        // 高度：跟随容器（不能取 max，否则会算大 → 卡片溢出节点底边）；
        // 上限不超过节点高度，防止容器报出异常大值。
        const h = ph > 0
          ? Math.min(ph, Math.round(s[1]))
          : Math.max(110, Math.round(s[1] - EST_TOP));
        const ws = w + "px", hs = h + "px";
        if (wrap.style.width !== ws) wrap.style.width = ws;
        if (wrap.style.height !== hs) wrap.style.height = hs;
        try {
          // 让前端按节点宽度来算容器宽度（不设的话会用默认值）
          if (domWidget) domWidget.width = s[0];
        } catch (e) {}
      }

      // 容器尺寸变化（节点被拖动/布局重算）时再同步一次
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

      // 读取旧工作流时 graph.configure 会把尺寸覆盖回存档值，这里再校正一次
      const prevOnConfigure = node.onConfigure;
      node.onConfigure = function () {
        if (typeof prevOnConfigure === "function") {
          try { prevOnConfigure.apply(this, arguments); } catch (e) {}
        }
        setTimeout(ensureMinSize, 60);
        setTimeout(ensureMinSize, 400);
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
      wrap.querySelectorAll(".ruic-filters select").forEach(sel => {
        sel.addEventListener("change", () => {
          const cfg = KIND_CFG.find(c => c.key === sel.dataset.kind);
          const field = sel.dataset.field;
          STATE[cfg.key].filters[field] = sel.value;
          const fcfg = cfg.filters.find(f => f.field === field);
          setWidget(W, fcfg.wname, sel.value);
          // 改筛选 => 取消该卡锁定，回到种子确定性预览
          STATE[cfg.key].lockedId = null;
          setWidget(W, cfg.lockW, "");
          refreshPreview(cfg);
        });
      });

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
          fnameEl: el.querySelector(".ruic-fname"),
          pagerEl: el.querySelector(".ruic-pager"),
          nextBtn: el.querySelector(".ruic-next"),
          blockBtn: el.querySelector(".ruic-block"),
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
        requestAnimationFrame(() => syncSize(node.size));
        setTimeout(ensureMinSize, 250);
        setTimeout(ensureMinSize, 800);
      } catch (e) {
        // 数据拉取失败：退回标准控件
        for (const w of node.widgets) w.hidden = false;
        wrap.innerHTML = `<div class="ruic-err">⚠️ 自定义界面加载失败（三条线路都取不到素材库数据）：<br>${e.message}
          <br><br>已自动切换为默认参数面板。可点右上角「打开素材库」确认网络，或开启代理后再试。</div>`;
        ensureMinSize();
      }

      function fillCard(cfg, DATA) {
        const st = STATE[cfg.key];
        for (const f of cfg.filters) {
          const sel = st.cardEl.querySelector(`select[data-field="${f.field}"]`);
          const vals = new Set();
          for (const it of DATA.items) {
            if (it.kind !== cfg.key) continue;
            const v = it.sub[f.field];
            if (Array.isArray(v)) v.forEach(x => x && vals.add(x));
            else if (v) vals.add(v);
          }
          const sorted = Array.from(vals).sort();
          sel.innerHTML = `<option>全部</option>` + sorted.map(v => `<option>${zhOf(v)}</option>`).join("");
          const cur = W[f.wname] ? W[f.wname].value : "全部";
          if (cur && cur !== "全部") sel.value = cur;
          st.filters[f.field] = sel.value;
        }
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
          const v = STATE[cfg.key].filters[f.field];
          if (!v || v === "全部") continue;
          const en = ZH_REV[v] || v;
          pool = pool.filter(it => _match(it.sub[f.field], en));
        }
        return pool;
      }

      // 逐条线路尝试显示预览图
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

      // 刷新卡片底部「第几张 / 共几张」，并决定「下一张」是否可用
      function updatePager(st, pool, item) {
        const total = pool.length;
        const idx = item ? pool.findIndex(it => it.id === item.id) : -1;
        if (!total) st.pagerEl.textContent = "0 / 0";
        else if (idx < 0) st.pagerEl.textContent = `— / ${total}`;  // 当前张不在筛选范围内
        else st.pagerEl.textContent = `${idx + 1} / ${total}`;
        st.nextBtn.disabled = total <= 1;
      }

      function refreshPreview(cfg) {
        const st = STATE[cfg.key];
        const blocked = st.cardEl.classList.contains("blocked");
        st.blockBtn.classList.toggle("on", blocked);
        const pool = currentPool(cfg);

        const blank = (msg) => {
          st.imgEl.style.display = "none";
          st.phEl.style.display = "flex";
          st.phEl.textContent = msg;
          st.fnameEl.textContent = "";
        };

        if (blocked) {
          blank("已屏蔽 · 不参与输出");
          st.pagerEl.textContent = "—";
          st.nextBtn.disabled = true;
          return;
        }
        let item = st.lockedId ? DATA.byId[cfg.key + "/" + st.lockedId] : null;
        if (!item) {
          if (!pool.length) {
            blank("该子分类下暂无素材");
            updatePager(st, pool, null);
            return;
          }
          const seed = parseInt((W["随机种子"] && W["随机种子"].value) || 0, 10) || 0;
          item = pool[((seed + cfg.offset) % pool.length + pool.length) % pool.length];
          // 关键：把算出来的 ID 写回控件，后端就会输出同一张 —— 预览=出图
          setWidget(W, cfg.lockW, item.id);
        }
        updatePager(st, pool, item);
        if (!item.thumb_urls || !item.thumb_urls.length) {
          blank("无预览图");
          st.fnameEl.textContent = item.id;
          return;
        }
        showImg(st, item.thumb_urls);
        st.fnameEl.textContent = item.id;
      }

      // 跳到当前筛选范围内的下一张（到底后回到第一张）
      function nextOne(cfg) {
        const st = STATE[cfg.key];
        if (st.cardEl.classList.contains("blocked")) return;
        const pool = currentPool(cfg);
        if (!pool.length) { refreshPreview(cfg); return; }
        const cur = st.lockedId ? pool.findIndex(it => it.id === st.lockedId) : -1;
        const item = pool[(cur + 1) % pool.length];
        st.lockedId = item.id;
        setWidget(W, cfg.lockW, item.id);
        refreshPreview(cfg);
      }

      function randomOne(cfg) {
        const pool = currentPool(cfg);
        if (!pool.length) { refreshPreview(cfg); return; }
        const item = pool[Math.floor(Math.random() * pool.length)];
        STATE[cfg.key].lockedId = item.id;
        setWidget(W, cfg.lockW, item.id);
        refreshPreview(cfg);
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
    },
  });
}
