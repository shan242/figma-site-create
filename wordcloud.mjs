// wordcloud.mjs — Deterministic interactive word-cloud layout + browser renderer.
//
// Split into two halves so the same spec renders identically everywhere:
//   - layoutWordCloud()   pure Node layout: words placed on a spiral inside a
//                         rectangle, sized by weight. No Math.random, so a
//                         rebuild of the same spec is byte-identical.
//   - clientScript        a browser IIFE that draws the layout on a <canvas>
//                         with hover highlight + tooltip. Inlined into the
//                         generated pages by build.mjs; also usable from the
//                         GUI preview.
//
// The AI never touches this module's internals — it only emits a spec
// ({words, colors, ...}); the placement math stays here so the result is
// guaranteed to fit and to stay deterministic.

const DEFAULT_COLORS = ["#333333", "#2563eb", "#16a34a", "#9333ea", "#d97706"];
const MAX_TRIES = 500;
const GAP = 4; // px padding around every placed word

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Rough glyph width so Node can place words without a canvas: CJK is
// square-ish, latin/digits are narrower. 5% extra so neighbor boxes rarely
// collide once the real font renders.
export function measureText(text, size) {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x2e80) w += size; // CJK + wide glyphs
    else if (/[0-9a-zA-Z'’&%@#]/.test(ch)) w += size * 0.55;
    else w += size * 0.3; // punctuation/space
  }
  return w * 1.05;
}

const PUNCT_ONLY = /^[^\p{L}\p{N}]+$/u;

// Layout words inside a rectangle. Deterministic given the same input.
export function layoutWordCloud(words, opts = {}) {
  const width = opts.width || 400;
  const height = opts.height || 300;
  const colors = opts.colors?.length ? opts.colors : DEFAULT_COLORS;
  const minFont = opts.minFont || 12;
  const maxFont = opts.maxFont || 48;
  const maxWords = opts.maxWords || 60;
  const fontFamily = opts.fontFamily || "'Inter', system-ui, sans-serif";

  // Normalize + filter, largest weight first.
  const ranked = (words || [])
    .filter((w) => w && typeof w.text === "string" && w.text.trim() && Number.isFinite(w.weight) && w.weight > 0 && !PUNCT_ONLY.test(w.text.trim()))
    .map((w) => ({ text: w.text.trim(), weight: w.weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, maxWords);

  const maxWeight = ranked.length ? ranked[0].weight : 1;
  const placed = [];

  const tryPlace = (item, cx, cy) => {
    const x = cx - item.w / 2;
    const y = cy - item.h / 2;
    if (x < 0 || y < 0 || x + item.w > width || y + item.h > height) return null;
    for (const p of placed) {
      if (x < p.x + p.w && p.x < x + item.w && y < p.y + p.h && p.y < y + item.h) return null;
    }
    return { x: Math.round(x), y: Math.round(y) };
  };

  const items = [];
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const size = Math.round(clamp(maxFont * Math.sqrt(r.weight / maxWeight), minFont, maxFont));
    const w = measureText(r.text, size);
    const h = size + GAP;
    const box = { w: w + GAP, h };
    const color = colors[i % colors.length];

    // Center the biggest word, spiral outward for the rest.
    const cx = width / 2;
    const cy = height / 2;
    let pos = null;
    if (i === 0) {
      pos = tryPlace(box, cx, cy);
    } else {
      for (let t = 0; t < MAX_TRIES && !pos; t++) {
        const angle = t * 0.35;
        const radius = 1.8 * angle;
        pos = tryPlace(box, cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
      }
    }
    if (!pos) continue; // too big / no room — skip rather than overlap
    placed.push({ x: pos.x, y: pos.y, w: box.w, h: box.h });
    items.push({ text: r.text, weight: r.weight, x: pos.x, y: pos.y, size, color, w: Math.round(w) });
  }

  return { items, width, height, fontFamily };
}

// Local fallback keyword extraction — used when there is no API key or the
// model returns no words. Latin: word frequency. CJK: character bigrams
// (naive segmentation). Stopword-filtered, top 40, weights scaled to 1..100.
const STOPWORDS = new Set(
  ("the a an and or but if in on at to of for with by from up down over under again further then once here there when where why how all any both each few more most other some such no nor not only own same so than too very can will just should now also get like one two three four five six seven eight nine ten this that these those").split(" "),
);

export function extractKeywordsLocal(text) {
  const counts = new Map();
  const bump = (k, n = 1) => counts.set(k, (counts.get(k) || 0) + n);

  const lower = (text || "").toLowerCase();
  const latin = lower.match(/[a-z][a-z']{1,}/g) || [];
  for (const w of latin) if (w.length > 2 && !STOPWORDS.has(w)) bump(w);

  // Contiguous CJK runs → sliding bigrams.
  const cjkRuns = (lower || "").match(/[一-鿿]+/g) || [];
  for (const run of cjkRuns) {
    for (let i = 0; i + 1 < run.length; i++) bump(run.slice(i, i + 2));
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
  if (!ranked.length) return [];
  const max = ranked[0][1];
  return ranked.map(([text, count]) => ({ text, weight: Math.round(20 + (count / max) * 80) }));
}

// Escape a value for embedding inside an inline <script>: JSON.stringify then
// neutralize "<" so a word can never close the script tag (e.g. "</script>").
const safeJson = (v) => JSON.stringify(v).replace(/</g, "\\u003c");

// Browser-side renderer. Exposed as window.renderWordCloud(canvas, layout);
// draws with devicePixelRatio scaling, dims non-hovered words, shows a tooltip
// with the word + weight. Deliberately plain ES5-ish so it needs no build.
// Must not contain backticks or "${" — it is embedded as a raw string.
export const clientScript = `window.renderWordCloud = function (canvas, layout) {
  var items = layout.items || [];
  var width = layout.width, height = layout.height;
  var fontFamily = layout.fontFamily || "sans-serif";
  var dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  var ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  var tooltip = document.createElement("div");
  tooltip.style.cssText = "position:fixed;pointer-events:none;z-index:9999;background:rgba(0,0,0,.82);color:#fff;padding:4px 8px;border-radius:4px;font:12px/1.4 sans-serif;display:none";
  document.body.appendChild(tooltip);
  var boxes = [];
  function measure(text, size) {
    ctx.font = size + "px " + fontFamily;
    return ctx.measureText(text).width;
  }
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    boxes.push({ x: it.x, y: it.y, w: measure(it.text, it.size), h: it.size });
  }
  function draw(hover) {
    ctx.clearRect(0, 0, width, height);
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      ctx.save();
      ctx.globalAlpha = hover === null || hover === i ? 1 : 0.4;
      ctx.fillStyle = it.color;
      ctx.font = it.size + "px " + fontFamily;
      ctx.textBaseline = "top";
      if (hover === i) { ctx.shadowColor = it.color; ctx.shadowBlur = 8; }
      ctx.fillText(it.text, it.x, it.y);
      ctx.restore();
    }
  }
  function hit(x, y) {
    for (var i = boxes.length - 1; i >= 0; i--) {
      var b = boxes[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return i;
    }
    return null;
  }
  function showTip(i, x, y) {
    if (i === null) { tooltip.style.display = "none"; return; }
    tooltip.textContent = items[i].text + " (" + items[i].weight + ")";
    tooltip.style.display = "block";
    tooltip.style.left = (x + 12) + "px";
    tooltip.style.top = (y + 12) + "px";
  }
  canvas.addEventListener("mousemove", function (e) {
    var rect = canvas.getBoundingClientRect();
    var x = (e.clientX - rect.left) * (width / rect.width);
    var y = (e.clientY - rect.top) * (height / rect.height);
    var i = hit(x, y);
    draw(i);
    showTip(i, e.clientX, e.clientY);
  });
  canvas.addEventListener("mouseleave", function () { draw(null); showTip(null); });
  draw(null);
};`;

// Build the HTML chunk build.mjs inlines into a page: an absolutely-positioned
// <div> holding a <canvas> plus the renderer + layout data. rect is the
// canvas-coordinate box {left, top, width, height}; fontFamily is the page
// stack (with CJK fallbacks) so the words inherit the site's look. canvasWidth
// (the design canvas width, from build.mjs) lets clouds ride the fluid canvas:
// a cloud as wide as the design stretches to 100%, and a cloud centered in the
// design stays centered, mirroring how CENTER-constrained nodes render.
export function cloudInjection(item, { width, height, fontFamily, canvasWidth }) {
  const spec = item.spec || {};
  const layout = layoutWordCloud(spec.words || [], {
    width,
    height,
    colors: spec.colors,
    fontFamily: spec.fontFamily || fontFamily,
    maxFont: spec.maxFont,
    minFont: spec.minFont,
  });
  const json = safeJson({ items: layout.items, width: layout.width, height: layout.height, fontFamily: spec.fontFamily || fontFamily });
  const r = item.rect;
  const left = Math.round(r.left);
  const top = Math.round(r.top);
  const w = Math.round(r.width);
  const h = Math.round(r.height);
  let leftCss = `${left}px`;
  let wCss = `${w}px`;
  if (canvasWidth != null && w >= canvasWidth) {
    leftCss = "0";
    wCss = "100%";
  } else if (canvasWidth != null && Math.abs(left + w / 2 - canvasWidth / 2) <= 1) {
    leftCss = `calc(50% - ${w / 2}px)`;
  }
  return `  <div class="wordcloud" style="position:absolute;left:${leftCss};top:${top}px;width:${wCss};height:${h}px">
    <canvas></canvas>
    <script>${clientScript}
(function () {
  var div = document.currentScript.parentElement;
  var canvas = div.querySelector("canvas");
  window.renderWordCloud(canvas, ${json});
})();</script>
  </div>`;
}
