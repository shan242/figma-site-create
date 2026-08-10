// design-report.mjs — Infer a design-system report from scraped page data so the
// AI agent can edit precisely instead of re-deriving tokens from a noisy node
// dump. Generated at scrape time (design-report.md + .json); the agent reads it
// before touching colors/type/spacing/radius and treats it as the source of
// truth. Pure analysis functions here, thin IO shell at the bottom.
//
// The report is statistical inference from rendered node data, NOT an authored
// design spec — e.g. "primary" is just the most frequent non-background fill.
// That is the honest ceiling of what scraping can produce.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectAll, findCanvas, fontStyleToWeight } from "./lib.mjs";

const hex = (c) => {
  if (!c) return null;
  return `#${[c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
};

const rgbOf = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// Perceived lightness 0-1; >0.75 reads as white-ish.
const luma = (h) => {
  const [r, g, b] = rgbOf(h);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
};

// Gray/white/black fills (surfaces, lines) carry no brand signal.
const isNeutral = (h) => {
  const [r, g, b] = rgbOf(h);
  return Math.max(r, g, b) - Math.min(r, g, b) < 40;
};

const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

const sortedEntries = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);

const mode = (m) => {
  let best = null;
  let bestN = 0;
  for (const [k, n] of m) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
};

const visibleSolid = (node) => (node.fills || []).find((f) => f.visible && f.opacity !== 0 && f.type === "SOLID");

const describeEffect = (ef) => {
  const o = ef.offset || {};
  const round1 = (v) => Math.round(v * 10) / 10;
  return {
    type: ef.type === "INNER_SHADOW" ? "inner" : ef.type === "DROP_SHADOW" ? "drop" : ef.type,
    x: round1(o.x || 0),
    y: round1(o.y || 0),
    blur: round1(ef.radius || 0),
    spread: ef.spread != null ? round1(ef.spread) : null,
    color: hex(ef.color),
  };
};

// Heuristic component classification. Deliberately conservative: the goal is a
// "typical button/card/input" for the agent, not an exhaustive catalog. Buttons
// win over inputs over cards so a rounded stroked rect doesn't double-count.
function collectComponents(all, nodes) {
  const buttons = { total: 0, height: new Map(), radius: new Map(), bordered: 0, fill: new Map(), stroke: new Map() };
  const cards = { total: 0, width: new Map(), height: new Map(), radius: new Map(), bordered: 0 };
  const inputs = { total: 0, height: new Map(), radius: new Map(), filled: 0 };
  for (const n of all) {
    const bb = n.absoluteBoundingBox;
    if (!bb || (n.type !== "RECTANGLE" && n.type !== "FRAME")) continue;
    const h = Math.round(bb.height);
    const r = n.cornerRadius || 0;
    const kids = (n.children || []).map((id) => nodes.get(id)).filter(Boolean);
    const hasTextChild = kids.some((k) => k.type === "TEXT");
    const clickable = (n.interactions || []).some((it) => it.event?.interactionType === "ON_CLICK");
    const hasStroke = !!(n.strokes?.length);
    const solid = visibleSolid(n);

    if (h >= 24 && h <= 80 && (hasTextChild || clickable) && (n.children?.length || 0) <= 3) {
      buttons.total++;
      bump(buttons.height, h);
      bump(buttons.radius, r);
      if (hasStroke) buttons.bordered++;
      if (solid) bump(buttons.fill, hex(solid.color));
      if (hasStroke) bump(buttons.stroke, hex(n.strokes[0].color));
    } else if (n.type === "RECTANGLE" && h >= 28 && h <= 56 && hasStroke && !kids.length) {
      inputs.total++;
      bump(inputs.height, h);
      bump(inputs.radius, r);
      if (solid) inputs.filled++;
    } else if (r >= 8 && (kids.length >= 2 || (n.type === "RECTANGLE" && bb.width >= 100 && h >= 60))) {
      cards.total++;
      bump(cards.width, Math.round(bb.width));
      bump(cards.height, h);
      bump(cards.radius, r);
      if (hasStroke) cards.bordered++;
    }
  }
  return { buttons, cards, inputs };
}

function aggComponent(c) {
  return {
    count: c.total,
    typicalHeight: mode(c.height),
    typicalRadius: mode(c.radius),
    borderedPct: c.total ? Math.round((c.bordered / c.total) * 100) : 0,
    fills: (c.fill ? sortedEntries(c.fill) : []).slice(0, 3).map(([hexv, count]) => ({ hex: hexv, count })),
    strokes: (c.stroke ? sortedEntries(c.stroke) : []).slice(0, 3).map(([hexv, count]) => ({ hex: hexv, count })),
  };
}

// Aggregate one site (an array of page data objects) into a report. Pure — no IO.
export function analyzeDesign(pages) {
  const solidFreq = new Map();
  const textFreq = new Map();
  const strokeFreq = new Map();
  const fontSizes = new Map();
  const fontWeights = new Map();
  const fontFamilies = new Map();
  const radii = new Map();
  const spacing = { paddingX: new Map(), paddingY: new Map(), itemSpacing: new Map() };
  const shadows = new Map();
  const layout = { containers: { vertical: 0, horizontal: 0 }, primaryAlign: new Map(), counterAlign: new Map(), columns: new Map(), cardWidths: new Map() };

  let background = null;
  let bgByArea = null;
  let bgArea = -1;
  let comps = null;

  for (const data of pages) {
    const all = collectAll(data);
    const nodes = new Map(all.map((n) => [n.id, n]));
    const canvas = findCanvas(data);
    const canvasFill = canvas && visibleSolid(canvas);
    if (canvasFill && !background) background = hex(canvasFill.color);

    for (const n of all) {
      const bb = n.absoluteBoundingBox;
      const area = bb ? bb.width * bb.height : 0;
      const solid = visibleSolid(n);

      if (n.type === "TEXT") {
        if (solid) bump(textFreq, hex(solid.color));
        const s = n.style || {};
        if (s.fontSize) bump(fontSizes, s.fontSize);
        const w = s.fontWeight != null ? s.fontWeight : s.fontStyle ? fontStyleToWeight(s.fontStyle) : 400;
        bump(fontWeights, w);
        if (s.fontFamily) bump(fontFamilies, s.fontFamily);
        for (const o of Object.values(n.styleOverrideTable || {})) {
          if (o.fontSize) bump(fontSizes, o.fontSize);
          if (o.fontFamily) bump(fontFamilies, o.fontFamily);
          bump(fontWeights, fontStyleToWeight(o.fontStyle));
        }
      } else if (solid) {
        bump(solidFreq, hex(solid.color));
        if (n !== canvas && area > bgArea) {
          bgArea = area;
          bgByArea = hex(solid.color);
        }
      }

      if (n.cornerRadius) bump(radii, Math.round(n.cornerRadius));
      if (n.strokes?.length) bump(strokeFreq, hex(n.strokes[0].color));
      for (const ef of n.effects || []) {
        const key = JSON.stringify(describeEffect(ef));
        bump(shadows, key);
      }

      if (n.layoutMode) {
        layout.containers[n.layoutMode === "VERTICAL" ? "vertical" : "horizontal"]++;
        if (n.primaryAxisAlignItems) bump(layout.primaryAlign, n.primaryAxisAlignItems);
        if (n.counterAxisAlignItems) bump(layout.counterAlign, n.counterAxisAlignItems);
        if (n.paddingX) bump(spacing.paddingX, Math.round(n.paddingX));
        if (n.paddingY) bump(spacing.paddingY, Math.round(n.paddingY));
        if (n.itemSpacing) bump(spacing.itemSpacing, Math.round(n.itemSpacing));
        if (n.layoutMode === "HORIZONTAL") {
          const cardKids = (n.children || [])
            .map((id) => nodes.get(id))
            .filter((k) => k && k.type !== "TEXT" && k.absoluteBoundingBox);
          if (cardKids.length > 1) bump(layout.columns, cardKids.length);
          for (const k of cardKids) bump(layout.cardWidths, Math.round(k.absoluteBoundingBox.width));
        }
      }
    }

    if (!comps) comps = collectComponents(all, nodes);
  }

  if (!background) background = bgByArea;

  const solidSorted = sortedEntries(solidFreq).filter(([c]) => c !== background);
  const textSorted = sortedEntries(textFreq);
  const toList = (arr) => arr.map(([hexv, count]) => ({ hex: hexv, count }));
  const toNList = (arr, key) => arr.map(([v, count]) => ({ [key]: v, count }));

  // White/black/gray fills (cards, lines) dominate raw frequency; a brand's
  // primary/secondary are the most frequent *chromatic* fills, so skip neutrals
  // unless there is nothing chromatic left.
  const chromatic = solidSorted.filter(([c]) => !isNeutral(c));
  let primary = null;
  let secondary = null;
  if (chromatic.length) {
    primary = chromatic[0];
    secondary = chromatic[1] ? chromatic[1] : solidSorted.find(([c]) => c !== chromatic[0][0]);
  } else {
    primary = solidSorted[0];
    secondary = solidSorted[1];
  }
  // "文字色" is body copy, so prefer the most frequent non-white text fill;
  // white text (labels over images/buttons) only wins when nothing else exists.
  const bodyText = textSorted.filter(([c]) => luma(c) <= 0.75);
  const text = bodyText[0] ?? textSorted[0];

  return {
    colors: {
      background,
      primary: primary ? { hex: primary[0], count: primary[1] } : null,
      secondary: secondary ? { hex: secondary[0], count: secondary[1] } : null,
      text: text ? { hex: text[0], count: text[1] } : null,
      solidTop: toList(solidSorted.slice(0, 6)),
      textTop: toList(textSorted.slice(0, 6)),
      strokeTop: toList(sortedEntries(strokeFreq).slice(0, 5)),
    },
    typography: {
      families: sortedEntries(fontFamilies).slice(0, 6).map(([name, count]) => ({ name, count })),
      sizes: toNList(sortedEntries(fontSizes).sort((a, b) => a[0] - b[0]), "px"),
      weights: toNList(sortedEntries(fontWeights).sort((a, b) => a[0] - b[0]), "weight"),
      // The renderer hardcodes line-height: normal (lib.mjs) — never emit a
      // fabricated line-height value.
      lineHeight: "normal (renderer convention)",
    },
    spacing: {
      paddingX: toNList(sortedEntries(spacing.paddingX), "px"),
      paddingY: toNList(sortedEntries(spacing.paddingY), "px"),
      itemSpacing: toNList(sortedEntries(spacing.itemSpacing), "px"),
    },
    radius: toNList(sortedEntries(radii), "px"),
    shadows: sortedEntries(shadows).slice(0, 5).map(([key, count]) => ({ ...JSON.parse(key), count })),
    layout: {
      containers: layout.containers,
      primaryAlign: sortedEntries(layout.primaryAlign).map(([v, count]) => ({ value: v, count })),
      counterAlign: sortedEntries(layout.counterAlign).map(([v, count]) => ({ value: v, count })),
      columns: toNList(sortedEntries(layout.columns), "columns"),
      cardWidths: toNList(sortedEntries(layout.cardWidths), "px"),
    },
    components: comps
      ? {
          buttons: aggComponent(comps.buttons),
          cards: { ...aggComponent(comps.cards), typicalWidth: mode(comps.cards.width) },
          inputs: { ...aggComponent(comps.inputs), filledPct: comps.inputs.total ? Math.round((comps.inputs.filled / comps.inputs.total) * 100) : 0 },
        }
      : null,
  };
}

const fmtCounts = (arr, key) =>
  arr.length
    ? arr.map((x) => (key ? `${x[key]}(${x.count} 次)` : `${x.px}(${x.count} 次)`)).join(", ")
    : "无";

export function renderMarkdown(r) {
  const L = [];
  L.push("# 设计报告(抓取时自动生成)");
  L.push("");
  L.push("> 统计推断,非设计规范。AI 修改颜色/字号/间距/圆角时以本报告为准,不要发明与报告不符的值。颜色为 #RRGGBB。");
  L.push("");
  L.push("## 原子变量");
  L.push("");
  L.push("### 颜色");
  const c = r.colors;
  if (c.background) L.push(`- 背景色: ${c.background}`);
  if (c.primary) L.push(`- 主色: ${c.primary.hex}(出现 ${c.primary.count} 次)`);
  if (c.secondary) L.push(`- 辅色: ${c.secondary.hex}(出现 ${c.secondary.count} 次)`);
  if (c.text) L.push(`- 文字色: ${c.text.hex}(出现 ${c.text.count} 次)`);
  L.push(`- 常用实色: ${c.solidTop.length ? c.solidTop.map((x) => x.hex).join(", ") : "无"}`);
  L.push(`- 常用边框色: ${c.strokeTop.length ? c.strokeTop.map((x) => x.hex).join(", ") : "无"}`);
  L.push("");
  L.push("### 字号阶梯(px)");
  L.push(fmtCounts(r.typography.sizes));
  L.push("");
  L.push("### 字重");
  L.push(fmtCounts(r.typography.weights, "weight"));
  L.push("");
  L.push("### 字体家族");
  L.push(r.typography.families.length ? r.typography.families.map((f) => `${f.name}(${f.count} 次)`).join(", ") : "无");
  L.push("");
  L.push("### 行高");
  L.push(r.typography.lineHeight + " — 不要自行设置行高值。");
  L.push("");
  L.push("### 间距(px)");
  L.push(`- paddingX 常用: ${fmtCounts(r.spacing.paddingX)}`);
  L.push(`- paddingY 常用: ${fmtCounts(r.spacing.paddingY)}`);
  L.push(`- itemSpacing 常用: ${fmtCounts(r.spacing.itemSpacing)}`);
  L.push("");
  L.push("### 圆角(px)");
  L.push(fmtCounts(r.radius));
  L.push("");
  L.push("### 阴影(设计稿参数;注意副本不渲染阴影)");
  if (r.shadows.length) {
    for (const s of r.shadows) {
      L.push(`- ${s.type} x${s.x} y${s.y} blur${s.blur}${s.spread != null ? ` spread${s.spread}` : ""} ${s.color || "透明"}(${s.count} 次)`);
    }
  } else {
    L.push("无");
  }
  L.push("");
  L.push("## 布局模式");
  L.push(`- 弹性容器: 纵向 ${r.layout.containers.vertical} 个 / 横向 ${r.layout.containers.horizontal} 个`);
  if (r.layout.primaryAlign.length) L.push(`- 主轴对齐: ${r.layout.primaryAlign.map((x) => `${x.value}(${x.count} 次)`).join(", ")}`);
  if (r.layout.counterAlign.length) L.push(`- 交叉轴对齐: ${r.layout.counterAlign.map((x) => `${x.value}(${x.count} 次)`).join(", ")}`);
  L.push(`- 典型列数: ${r.layout.columns.length ? fmtCounts(r.layout.columns, "columns") : "无(未见横向多列容器)"}`);
  L.push(`- 典型卡片宽(px): ${r.layout.cardWidths.length ? fmtCounts(r.layout.cardWidths) : "无"}`);
  L.push("- 定位方式: 绝对定位像素网格(.canvas 内 left/top/width/height);真正重排需改写为流式 flex/grid。");
  L.push("");
  L.push("## 组件规律(统计推断)");
  L.push("");
  const fmtComp = (x) =>
    `- 数量 ${x.count};典型高度 ${x.typicalHeight ?? "?"}px;典型圆角 ${x.typicalRadius ?? "?"}px;带边框 ${x.borderedPct}%`;
  const comp = r.components;
  if (comp) {
    L.push("### 按钮");
    L.push(fmtComp(comp.buttons));
    L.push(`- 常用填充色: ${comp.buttons.fills.length ? comp.buttons.fills.map((f) => f.hex).join(", ") : "无"}`);
    L.push(`- 常用边框色: ${comp.buttons.strokes.length ? comp.buttons.strokes.map((f) => f.hex).join(", ") : "无"}`);
    L.push("");
    L.push("### 卡片");
    L.push(`- 数量 ${comp.cards.count};典型宽 ${comp.cards.typicalWidth ?? "?"}px;典型高 ${comp.cards.typicalHeight ?? "?"}px;典型圆角 ${comp.cards.typicalRadius ?? "?"}px;带边框 ${comp.cards.borderedPct}%`);
    L.push("");
    L.push("### 输入框");
    L.push(`- 数量 ${comp.inputs.count};典型高度 ${comp.inputs.typicalHeight ?? "?"}px;典型圆角 ${comp.inputs.typicalRadius ?? "?"}px;有填充 ${comp.inputs.filledPct}%`);
  } else {
    L.push("无");
  }
  L.push("");
  L.push("### hover 说明");
  L.push("设计数据里没有 CSS hover;原型 interactions 只覆盖点击跳转。需要 hover 时按主色/辅色生成轻微加深或变色,并在回复中告知用户这是推断的。");
  L.push("");
  L.push("> 报告与页面数据同源,重新抓取会刷新。");
  return L.join("\n");
}

// IO shell: analyze all pages and write the two report files into the out dir.
export function generateDesignReport(pages, outDir) {
  const report = analyzeDesign(pages);
  writeFileSync(join(outDir, "design-report.md"), renderMarkdown(report));
  writeFileSync(join(outDir, "design-report.json"), JSON.stringify(report, null, 2));
}
