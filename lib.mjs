// lib.mjs — Render engine for turning published Figma Sites node JSON into
// static HTML/CSS. Extracted from the isabella-site replica builder, which
// was verified pixel-faithful against the live published site via CDP.
//
// The generic pieces (positioning, text styling, rich text, images, links)
// are here; the site-specific bits (which fonts to load, page filenames)
// live in build.mjs and are passed in through `ctx`.

export const fmtColor = (c, a) => {
  if (!c) return null;
  const r = Math.round(c.r * 255), g = Math.round(c.g * 255), b = Math.round(c.b * 255);
  const alpha = a ?? c.a;
  if (alpha !== undefined && alpha < 1) return `rgba(${r},${g},${b},${+alpha.toFixed(3)})`;
  return `rgb(${r},${g},${b})`;
};

// Parse a CSS color into Figma's 0-1 component form, or null for anything that
// isn't a 3/6-digit hex. Used by the AI edit overlay and validated there too.
export function hexToColor(hex) {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255, a: 1 };
}

export const gradientAngle = (h) => {
  if (!h || h.length < 3) return null;
  const [p0, p1] = h;
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  return (Math.atan2(-dy, dx) * 180) / Math.PI;
};

// IMAGE 填充的呈现方式。
//
// Figma 的 fill.imageTransform 是 [[a,0,tx],[0,d,ty]],把**归一化填充框坐标**映射到
// **归一化图像坐标**:imgNorm = T · boxNorm。方向很容易搞反 —— 用线上 DOM 验证过:
// 一张 d=0.3056 的图,线上渲染成 1705px 高(框只有 521px),即 100/0.3056 = 327.2%,
// 证实是「框 → 图」而不是「图 → 框」。
//
// 于是把图像铺进框里:
//   background-size: 100/a % × 100/d %    (图比框大时就是放大后裁切)
//   background-position 的百分比语义是相对 (框 − 图) 的:
//       X = tx/(1−a),Y = ty/(1−d)        (a=1 时该轴没有余量,取 0)
//
// 之前 a、d 写反,把"放大裁切"当成了"缩成一小条再用留白居中" —— 图片比例全不对。
const imageFillCss = (fill) => {
  const t = fill.imageTransform;
  if (Array.isArray(t) && t.length === 2 && t[0]?.length === 3 && t[1]?.length === 3) {
    const [a, b, tx] = t[0];
    const [c, d, ty] = t[1];
    // 纯缩放 + 平移才用这套;带旋转/斜切的退回 cover(图像填充极少出现)
    if (Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6 && a > 0 && d > 0) {
      const pct = (v) => `${+(v * 100).toFixed(4)}%`;
      // 把框铺满需要 1/a 倍的图
      const scale = (v) => pct(1 / v);
      const pos = (off, s) => (Math.abs(s - 1) < 1e-9 ? "0%" : pct(off / (1 - s)));
      return {
        "background-size": `${scale(a)} ${scale(d)}`,
        "background-position": `${pos(tx, a)} ${pos(ty, d)}`,
        // 关键:默认是 repeat,尺寸小于 100% 时会平铺成一堆小图
        "background-repeat": "no-repeat",
      };
    }
  }
  const mode = String(fill.scaleMode || "FILL").toUpperCase();
  if (mode === "FIT") return { "background-size": "contain", "background-position": "center", "background-repeat": "no-repeat" };
  if (mode === "STRETCH") return { "background-size": "100% 100%", "background-position": "center", "background-repeat": "no-repeat" };
  return { "background-size": "cover", "background-position": "center" };
};

export const fillToCss = (fill, assetUrl) => {
  if (!fill || !fill.visible || fill.opacity === 0) return null;
  // Figma 的填充可以整体带一个透明度。SOLID 能直接烘进 rgba(),但图像和渐变
  // 不行 —— CSS 没有 background-opacity,只能靠元素 opacity 表达。这里把值交给
  // 调用方,由它和节点自身的 opacity **相乘**(见 nodeStyle)。
  // 实测踩坑:lily2026new 那段大背景图是 opacity 0.06,漏掉后整张图以全不透明
  // 渲染,把整节内容压得看不见。取值和 rgba() 一样保留 3 位小数,免得 HTML 里
  // 出现 0.0599999986588955 这种浮点噪声。
  const alpha = fill.opacity !== undefined && fill.opacity < 1 ? +fill.opacity.toFixed(3) : undefined;
  if (fill.type === "SOLID") {
    const bg = fmtColor(fill.color, alpha);
    return bg ? { "background-color": bg } : null;
  }
  if (fill.type === "IMAGE" && fill.imageRef) {
    const css = { "background-image": `url(${assetUrl(fill.imageRef)})`, ...imageFillCss(fill) };
    if (alpha !== undefined) css.opacity = alpha;
    return css;
  }
  if (fill.type === "GRADIENT_LINEAR" && fill.gradientStops?.length) {
    const angle = gradientAngle(fill.gradientHandlePositions) ?? 90;
    const stops = fill.gradientStops.map((s) => `${fmtColor(s.color)} ${Math.round(s.position * 100)}%`).join(", ");
    const css = { "background-image": `linear-gradient(${angle}deg, ${stops})` };
    if (alpha !== undefined) css.opacity = alpha;
    return css;
  }
  return null;
};

export const fontStyleToWeight = (s) => {
  const str = (s || "").toLowerCase();
  if (str.includes("extra bold")) return 800;
  if (str.includes("black")) return 900;
  if (str.includes("semibold") || str.includes("semi bold")) return 600;
  if (str.includes("bold")) return 700;
  if (str.includes("medium")) return 500;
  if (str.includes("light")) return 300;
  return 400;
};

// Figma's TEXT_ALIGN_JUSTIFIED becomes CSS "justify" (lowercasing alone would
// produce the invalid "justified").
export const alignToCss = (a) => (a === "JUSTIFIED" ? "justify" : (a || "LEFT").toLowerCase());

// makeAssetUrl(assetDir) resolves a node image reference to the local asset
// file. The server serves some hashes as JPEG despite a .png asset URL, and
// generated vector assets are .svg — check what actually landed on disk.
// Generated HTML sits next to assets/, so files are referenced as "assets/<hash>.<ext>".
export function makeAssetUrl(assetDir) {
  return (hash) => {
    for (const ext of ["jpg", "png", "svg", "webp", "gif"]) {
      if (existsSync(join(assetDir, `${hash}.${ext}`))) return `assets/${hash}.${ext}`;
    }
    return `assets/${hash}.png`;
  };
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// True when the node moves with the canvas centre: it is CENTER-constrained
// itself, or sits inside an ancestor frame that is. The live site NESTS content
// inside its centred frame (`left:50% + translateX(-50%)`), so the whole subtree
// shifts with the viewport — a heading whose own constraints are unset (an
// auto-layout child) still moves because its frame does.
export function hasCenteredAncestor(node, parentOf) {
  let cur = node;
  while (cur) {
    if (cur.constraints?.horizontal === "CENTER") return true;
    cur = parentOf?.get(cur.id);
  }
  return false;
}

export function nodeStyle(node, canvas, fontStackFn, assetUrl, centered) {
  const bb = node.absoluteBoundingBox;
  const left = Math.round(bb.x - canvas.x);
  const top = Math.round(bb.y - canvas.y);
  const w = Math.round(bb.width);
  const h = Math.round(bb.height);
  const st = { position: "absolute", top: `${top}px`, width: `${w}px`, height: `${h}px` };
  // The build renders the canvas fluid (width:100%; min-width:W) to match the
  // live site. A node that moves with the canvas centre keeps its distance from
  // that centre as the viewport stretches, so its left is a calc: at canvas
  // width W it sits at design px `left`; at any wider viewport it must land at
  // 50% + (left - W/2). `centered` is the caller's decision (own constraint or
  // an ancestor's); nodes that don't move with the centre keep their fixed px.
  const useCenter = centered ?? node.constraints?.horizontal === "CENTER";
  if (useCenter) {
    const off = left - Math.round(canvas.width) / 2;
    st.left = `calc(50% ${off < 0 ? "-" : "+"} ${Math.abs(Math.round(off))}px)`;
  } else {
    st.left = `${left}px`;
  }
  const opacity = node.opacity !== undefined && node.opacity < 1 ? node.opacity : 1;

  if (node.type === "TEXT") {
    const s = node.style ?? {};
    st.width = `${w}px`;
    // textAutoResize NONE = fixed box: the live site gives it the bbox height
    // and vertically centers the text inside via justify-content. height:auto
    // collapsed the box and dropped the centering of the stat numbers.
    st.height = s.textAutoResize === "NONE" ? `${h}px` : "auto";
    // Inter text also falls back to Noto Sans SC/JP so CJK glyphs (e.g. 消炎药)
    // render in the same font the published site uses rather than a system font.
    // Single quotes: the whole style attribute is double-quoted, so double
    // quotes inside font-family would break it and drop every inline style.
    st["font-family"] = fontStackFn ? fontStackFn(s.fontFamily || "Inter") : `'${s.fontFamily || "Inter"}', system-ui, sans-serif`;
    if (s.fontSize) st["font-size"] = `${s.fontSize}px`;
    // An explicit numeric fontWeight (set by the AI text-edit overlay) wins
    // over the fontStyle-string heuristic; real scraped data has no fontWeight.
    const weight = s.fontWeight != null ? s.fontWeight : s.fontStyle ? fontStyleToWeight(s.fontStyle) : 400;
    st["font-weight"] = weight;
    if (s.italic) st["font-style"] = "italic";
    // A FIXED pixel line-height is honored (the live site renders
    // `line-height: <lineHeightPx>px`). Intrinsic/percentage heights fall back
    // to the font's natural line-height.
    st["line-height"] = s.lineHeightUnit === "PIXELS" && s.lineHeightPx ? `${s.lineHeightPx}px` : "normal";
    if (s.letterSpacing !== 0 && s.fontSize) {
      if (s.letterSpacingUnit === "PIXELS") st["letter-spacing"] = `${s.letterSpacing}px`;
      else st["letter-spacing"] = `${(s.fontSize * s.letterSpacing) / 100}px`;
    }
    st["text-align"] = alignToCss(s.textAlignHorizontal);
    if (s.textAlignVertical === "CENTER") st["align-content"] = "center";
    if (s.textCase === "UPPER") st["text-transform"] = "uppercase";
    // The current page's nav item is marked with an underline in the design.
    if (s.textDecoration === "UNDERLINE") {
      st["text-decoration-line"] = "underline";
      st["text-underline-position"] = "from-font";
    }
    st["white-space"] = "pre-wrap";
    st["overflow-wrap"] = "break-word";
    st["word-break"] = "break-word";
    st["overflow"] = "visible";
    const fill = (node.fills || []).find((f) => f.visible);
    const color = fill ? fmtColor(fill.color, fill.opacity) : null;
    if (color) st.color = color;
    st.display = "flex";
    st["flex-direction"] = "column";
    st["justify-content"] = s.textAlignVertical === "CENTER" ? "center" : s.textAlignVertical === "BOTTOM" ? "flex-end" : "flex-start";
  } else {
    if (opacity < 1) st.opacity = opacity;
    // IMAGE and SVG nodes are raster/vector assets whose fill and stroke are
    // baked into the asset bytes by the exporter; the live site renders them as
    // a bare <img>/background with no CSS fill or border. Painting a fill or
    // stroke on top added a solid rectangle behind circles/curves/dots.
    const isAsset = node.type === "IMAGE" || node.type === "SVG";
    if (!isAsset) {
      const fill = (node.fills || []).find((f) => f.visible && f.opacity !== 0);
      const fillCss = fillToCss(fill, assetUrl) ?? {};
      // 图像/渐变填充的透明度是作为 opacity 返回的,必须和节点自身的 opacity
      // **相乘** —— 直接 Object.assign 会把节点 opacity 覆盖掉。
      // (代价:元素上若还有边框,边框会跟着一起变淡;带描边的半透明图像极罕见。)
      const fillAlpha = fillCss.opacity;
      delete fillCss.opacity;
      Object.assign(st, fillCss);
      const alpha = opacity * (fillAlpha ?? 1);
      if (alpha < 1) st.opacity = alpha;
      else delete st.opacity;
      if (node.cornerRadius) st["border-radius"] = `${node.cornerRadius}px`;
      if (node.strokes?.length) {
        const strk = node.strokes[0];
        const color = fmtColor(strk.color, strk.opacity);
        const style = node.strokeDashes?.length ? "dashed" : "solid";
        st.border = `${node.strokeWeight || 1}px ${style} ${color}`;
      }
    }
  }
  return st;
}

// Split a text node into style runs based on characterStyleOverrides (rich
// text). Each run is a contiguous char range sharing the same override
// weight/size; null weight/size means "inherit the node's base style".
export function textRuns(node) {
  const chars = node.characters || "";
  const overrides = node.characterStyleOverrides || [];
  const table = node.styleOverrideTable || {};
  const runs = [];
  let i = 0;
  while (i < chars.length) {
    const oid = overrides[i] || 0;
    const o = oid ? table[String(oid)] : null;
    const weight = o ? fontStyleToWeight(o.fontStyle) : null;
    const size = o && o.fontSize ? o.fontSize : null;
    let j = i + 1;
    while (j < chars.length) {
      const oid2 = overrides[j] || 0;
      const o2 = oid2 ? table[String(oid2)] : null;
      const w2 = o2 ? fontStyleToWeight(o2.fontStyle) : null;
      const s2 = o2 && o2.fontSize ? o2.fontSize : null;
      if (w2 !== weight || s2 !== size) break;
      j++;
    }
    runs.push({ start: i, end: j, weight, size });
    i = j;
  }
  return { chars, runs };
}

// A node becomes a clickable <a> when it — or a GROUP wrapping it — carries an
// ON_CLICK / NAVIGATE interaction; that is what Figma Sites turns into an anchor.
// Figma frequently puts the interaction on the group that wraps a button's
// background + label rather than on the label itself, so the lookup walks up
// the ancestor chain. A node that has interactions of its own owns its click:
// even if none navigate, we don't fall through to an ancestor's.
// parentOf maps childId -> parent node; pathToFile maps live paths to local files.
export function linkHref(node, pathToFile, parentOf) {
  let cur = node;
  while (cur) {
    for (const it of cur.interactions || []) {
      if (it.event?.interactionType !== "ON_CLICK") continue;
      for (const a of it.actions || []) {
        if (a.connectionType === "INTERNAL_NODE" && a.navigationType === "NAVIGATE" && a.connectionURL) {
          return pathToFile[a.connectionURL] || null;
        }
      }
    }
    if (cur.interactions?.length) break;
    cur = parentOf ? parentOf.get(cur.id) : null;
  }
  return null;
}

// Apply a persisted text edit ({text, fontSize, fontWeight, color}) onto a
// TEXT node before rendering. Returns a shallow clone — never mutates the
// source node — so the same data can render both edited and unedited. Replacing
// text drops the rich-text override tables, whose char indices would no longer
// line up with the new string.
export function applyTextEdit(node, edit) {
  if (!edit) return node;
  const eff = { ...node, style: { ...(node.style || {}) } };
  if (edit.text != null) {
    eff.characters = edit.text;
    eff.characterStyleOverrides = undefined;
    eff.styleOverrideTable = undefined;
  }
  if (edit.fontSize != null) eff.style.fontSize = edit.fontSize;
  if (edit.fontWeight != null) eff.style.fontWeight = edit.fontWeight;
  if (edit.color != null) {
    eff.fills = [{ type: "SOLID", visible: true, opacity: 1, color: hexToColor(edit.color) }];
  }
  return eff;
}

// --- SVG natural-size rendering ---------------------------------------------
// Figma Sites exports a vector node as an .svg asset. When the node has an
// effect (drop shadow, glow), the exporter bakes the effect gutter into the
// asset, so the SVG's natural size exceeds the node's design box — the card
// frame on alias-grid is a 256x376 box shipped as a 276x396 SVG (white card +
// ~20px shadow gutter). The live site renders such assets at natural size,
// positioned so the SVG's content (which starts at offX/offY inside the
// viewBox) lands exactly on the design box. Rendering at the design box clips
// the gutter — the cards lost their shadows that way.

const svgGeoCache = new Map();

function assetSvgPath(assetDir, hash) {
  const p = join(assetDir, `${hash}.svg`);
  return existsSync(p) ? p : null;
}

function svgGeometry(assetDir, hash) {
  if (svgGeoCache.has(hash)) return svgGeoCache.get(hash);
  let geo = null;
  const p = assetSvgPath(assetDir, hash);
  if (p) {
    try {
      geo = parseSvgGeometry(readFileSync(p, "utf8"));
    } catch {}
  }
  svgGeoCache.set(hash, geo);
  return geo;
}

function parseSvgGeometry(svg) {
  const wm = /<svg[^>]*\swidth\s*=\s*"(-?[\d.]+)"/.exec(svg);
  const hm = /<svg[^>]*\sheight\s*=\s*"(-?[\d.]+)"/.exec(svg);
  const vb = /viewBox\s*=\s*"(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)"/.exec(svg);
  const w = wm ? parseFloat(wm[1]) : vb ? parseFloat(vb[3]) : null;
  const h = hm ? parseFloat(hm[1]) : vb ? parseFloat(vb[4]) : null;
  if (w == null || h == null) return null;
  const c = svgContentMin(svg);
  return c ? { w, h, offX: c.x, offY: c.y } : { w, h, offX: 0, offY: 0 };
}

// Minimum x/y of the SVG's drawing content. <defs> content (filters, gradients)
// is metadata, not geometry — the gutter it describes shows up in the paths.
function svgContentMin(svg) {
  let minX = Infinity, minY = Infinity;
  const consider = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
  };
  for (const m of svg.matchAll(/<path\b[^>]*\bd="([^"]*)"/g)) {
    const p = pathMin(m[1]);
    if (p) consider(p.x, p.y);
  }
  for (const m of svg.matchAll(/<rect\b[^>]*\bx="(-?[\d.]+)"[^>]*\by="(-?[\d.]+)"/g)) {
    consider(parseFloat(m[1]), parseFloat(m[2]));
  }
  for (const m of svg.matchAll(/<circle\b[^>]*\bcx="(-?[\d.]+)"[^>]*\bcy="(-?[\d.]+)"[^>]*\br="(-?[\d.]+)"/g)) {
    consider(parseFloat(m[1]) - parseFloat(m[3]), parseFloat(m[2]) - parseFloat(m[3]));
  }
  for (const m of svg.matchAll(/<ellipse\b[^>]*\bcx="(-?[\d.]+)"[^>]*\bcy="(-?[\d.]+)"[^>]*\brx="(-?[\d.]+)"[^>]*\bry="(-?[\d.]+)"/g)) {
    consider(parseFloat(m[1]) - parseFloat(m[3]), parseFloat(m[2]) - parseFloat(m[4]));
  }
  for (const m of svg.matchAll(/<line\b[^>]*\bx1="(-?[\d.]+)"[^>]*\by1="(-?[\d.]+)"[^>]*\bx2="(-?[\d.]+)"[^>]*\by2="(-?[\d.]+)"/g)) {
    consider(Math.min(parseFloat(m[1]), parseFloat(m[3])), Math.min(parseFloat(m[2]), parseFloat(m[4])));
  }
  for (const m of svg.matchAll(/<polygon\b[^>]*\bpoints="([^"]+)"/g)) {
    const p = pointsMin(m[1]);
    if (p) consider(p.x, p.y);
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY };
}

function pointsMin(pts) {
  const nums = pts.split(/[\s,]+/).map(parseFloat).filter((n) => !isNaN(n));
  if (nums.length < 2) return null;
  let minX = Infinity, minY = Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    if (nums[i] < minX) minX = nums[i];
    if (nums[i + 1] < minY) minY = nums[i + 1];
  }
  return { x: minX, y: minY };
}

// Lowest x/y a path reaches. Curve control points are included as candidates —
// they bound the curve's hull, and for the gutter offset only the top-left
// matters, so over-inclusion of control points is harmless for the min.
function pathMin(d) {
  const toks = [];
  const re = /([MLHVCSQTAZmlhvcsqtaz]|-?[\d.]+)/g;
  let m;
  while ((m = re.exec(d))) toks.push(m[1]);
  const isCmd = (t) => /[MLHVCSQTAZmlhvcsqtaz]/.test(t);
  let x = 0, y = 0, startX = 0, startY = 0;
  let minX = Infinity, minY = Infinity;
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (!isCmd(t)) { i++; continue; }
    const abs = t === t.toUpperCase();
    const c = t.toUpperCase();
    i++;
    if (c === "Z") { x = startX; y = startY; continue; }
    if (c === "M" || c === "L") {
      let first = true;
      while (i < toks.length && !isCmd(toks[i])) {
        const nx = parseFloat(toks[i]), ny = parseFloat(toks[i + 1]);
        if (isNaN(nx) || isNaN(ny)) { i++; continue; }
        x = abs ? nx : x + nx;
        y = abs ? ny : y + ny;
        if (first) { startX = x; startY = y; first = false; }
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        i += 2;
      }
    } else if (c === "H") {
      while (i < toks.length && !isCmd(toks[i])) {
        const nx = parseFloat(toks[i]);
        if (!isNaN(nx)) { x = abs ? nx : x + nx; if (x < minX) minX = x; }
        i++;
      }
    } else if (c === "V") {
      while (i < toks.length && !isCmd(toks[i])) {
        const ny = parseFloat(toks[i]);
        if (!isNaN(ny)) { y = abs ? ny : y + ny; if (y < minY) minY = y; }
        i++;
      }
    } else if (c === "A") {
      while (i < toks.length && !isCmd(toks[i])) {
        const vals = [];
        for (let k = 0; k < 7 && i < toks.length && !isCmd(toks[i]); k++) vals.push(parseFloat(toks[i++]));
        if (vals.length >= 2) {
          x = abs ? vals[vals.length - 2] : x + vals[vals.length - 2];
          y = abs ? vals[vals.length - 1] : y + vals[vals.length - 1];
          if (x < minX) minX = x;
          if (y < minY) minY = y;
        }
      }
    } else {
      const per = c === "C" ? 6 : c === "S" ? 4 : c === "Q" ? 4 : 2;
      while (i < toks.length && !isCmd(toks[i])) {
        const vals = [];
        for (let k = 0; k < per && i < toks.length && !isCmd(toks[i]); k++) vals.push(parseFloat(toks[i++]));
        for (let k = 0; k + 1 < vals.length; k += 2) {
          if (isNaN(vals[k]) || isNaN(vals[k + 1])) continue;
          const cx = abs ? vals[k] : x + vals[k];
          const cy = abs ? vals[k + 1] : y + vals[k + 1];
          if (cx < minX) minX = cx;
          if (cy < minY) minY = cy;
        }
        if (vals.length >= 2) {
          x = abs ? vals[vals.length - 2] : x + vals[vals.length - 2];
          y = abs ? vals[vals.length - 1] : y + vals[vals.length - 1];
          if (x < minX) minX = x;
          if (y < minY) minY = y;
        }
      }
    }
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY };
}

// Shift a CSS left value (plain px, or the CENTER-constraint calc) left by dx.
function shiftLeft(leftCss, dx) {
  if (!dx) return leftCss;
  if (typeof leftCss === "string" && leftCss.endsWith("px")) {
    const v = parseFloat(leftCss) - dx;
    return `${Math.round(v * 1000) / 1000}px`;
  }
  const m = /^calc\(50% ([+-]) ([\d.]+)px\)$/.exec(leftCss);
  if (m) {
    const sign = m[1] === "+" ? 1 : -1;
    const n = sign * parseFloat(m[2]) - dx;
    return n >= 0 ? `calc(50% + ${n}px)` : `calc(50% - ${-n}px)`;
  }
  return leftCss;
}

// True when the node's relativeTransform 2x2 carries anything but a pure
// translation (rotation, flip, scale). The live site renders such vectors with
// a CSS transform inside the design box, which this static renderer doesn't
// replicate — used to keep them on the SVG-parse sizing path instead of the
// renderBounds one.
function isNodeRotated(node) {
  const t = node.relativeTransform;
  if (!t?.[0] || !t?.[1]) return false;
  const [a, b] = t[0];
  const [c, d] = t[1];
  const eps = 1e-6;
  return Math.abs(a - 1) > eps || Math.abs(b) > eps || Math.abs(c) > eps || Math.abs(d - 1) > eps;
}

// SCALE 约束的含义是「**随父级一起**缩放」,不是「无条件按画布宽度缩放」。
// 所以判定要看整条父链:
//   - 父级是画布本身 → 可以缩放(画布是 fluid 的,它确实变宽了);
//   - 父级也是(处在可缩放上下文里的)SCALE → 继续往上;
//   - 父级不缩放(比如 CENTER 的容器,它自己保持设计尺寸)→ 这棵子树都不缩放。
// 实测(creme-zipper index):一个 SCALE 矩形被 CENTER 约束的 COMPONENT 包着,
// 线上渲染 384px(设计尺寸),而旧逻辑按 1403/1280 放大成 421px —— 所有图片
// 都宽了 9.6%,看起来就是"图片被拉伸"。
function inScaledContext(node, ctx) {
  if (!ctx) return true; // 没有上下文信息时保持旧行为,不制造静默回归
  const cache = (ctx.scaledCache ||= new Map());
  if (cache.has(node.id)) return cache.get(node.id);
  let out = false;
  let cur = node;
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const p = ctx.parentOf?.get(cur.id);
    if (!p) break; // 孤立的(不可达)—— 本来就不会渲染
    if (!ctx.parentOf.get(p.id)) { out = true; break; } // 父级就是画布(它没有上级)
    if (seen.has(p.id)) break;
    seen.add(p.id);
    if (p.constraints?.horizontal !== "SCALE") break;
    cur = p;
  }
  cache.set(node.id, out);
  return out;
}

// Reflow a node whose Figma horizontal constraint is SCALE: the published site
// positions it as a percentage of the design width, so it stretches with the
// fluid canvas (width:100%; min-width:designW). Vertical stays at design px —
// the live container keeps its design height, so a SCALE/SCALE node only widens.
// Must run after every px adjustment (SVG natural-size offsets) — it reads the
// final left/width and re-expresses them as %.
function applyScaleH(node, st, canvas, ctx) {
  if (node.constraints?.horizontal !== "SCALE") return st;
  if (!inScaledContext(node, ctx)) return st;
  const designW = canvas.width;
  if (typeof st.width === "string" && /^-?[\d.]+px$/.test(st.width)) {
    st.width = `${((parseFloat(st.width) / designW) * 100).toFixed(4)}%`;
  }
  if (typeof st.left === "string" && /^-?[\d.]+px$/.test(st.left)) {
    st.left = `${((parseFloat(st.left) / designW) * 100).toFixed(4)}%`;
  }
  return st;
}

// 每个渲染出的元素都带上 Figma 节点 id。这是 AI 的 bind_data 能"指向某个节点"
// 的前提 —— 例如"点这个按钮就是投票"需要能定位到它。
// 放在 style **之后**,既有 HTML 断言的前缀不受影响。
// 每个渲染出的元素都要带的定位/切换属性。
//   data-node-id      : Figma 节点 id(bind_data 的 target / edit 覆盖靠它定位)
//   data-swap-group   : 属于哪个实例的变体组
//   data-swap-variant : 属于哪个变体
//   data-swap-off     : 非当前变体,CSS 隐藏(用属性而不是内联 display,
//                       因为文本节点靠内联 display:flex 布局,覆盖就散了)
//   data-swap-to      : 点了要切到哪个变体(只出现在 SWAP_STATE 箭头上)
const nodeAttr = (node) => {
  if (!node?.id) return "";
  let s = ` data-node-id="${node.id}"`;
  const sw = node.__swap;
  if (sw) {
    s += ` data-swap-group="${sw.group}" data-swap-variant="${sw.variant}"`;
    if (!sw.on) s += " data-swap-off";
  }
  const to = swapTargetOf(node);
  if (to) s += ` data-swap-to="${to}"`;
  return s;
};

export function renderNode(node, nodes, canvas, out, ctx) {
  const { assetDir, pathToFile, fontStack } = ctx;
  const assetUrl = makeAssetUrl(assetDir);
  const tag = node.type;
  const bb = node.absoluteBoundingBox;
  if (!bb) return;

  // AI node-style overlay (edit_node): raw CSS props merged after the computed
  // style so they override whatever the renderer derived, for any node type.
  const overlay = ctx.nodeStyles?.get(node.id);
  // Click target for this node: its own NAVIGATE interaction, or the nearest
  // ancestor GROUP's (buttons are groups whose interaction lives on the group).
  const href = linkHref(node, pathToFile, ctx.parentOf);
  // Inherit canvas-centre tracking from a CENTER-constrained ancestor frame
  // (see hasCenteredAncestor). SCALE nodes keep their own percentage path.
  const centered =
    node.constraints?.horizontal === "SCALE" ? false : hasCenteredAncestor(node, ctx.parentOf);

  if (tag === "SVG" && node.isLine) {
    const st = nodeStyle(node, canvas, fontStack, assetUrl, centered);
    if (overlay) Object.assign(st, overlay);
    const col = fmtColor(node.strokes?.[0]?.color);
    st.background = col;
    delete st["border-radius"];
    const thick = node.strokeWeight || 1;
    // The line's length lives in `size.x`; a rotated line (e.g. a vertical
    // separator between "Male" and "Female") has bbox.width≈0, so using the
    // bbox width dropped the whole line to 0×1px and it vanished.
    const len = node.size?.x || bb.width || bb.height;
    if (isNodeRotated(node)) {
      // Render at the unrotated length×thickness, centered on the bbox, then
      // rotate into place (same matrix convention as the SVG branch).
      st.width = `${len}px`;
      st.height = `${thick}px`;
      const leftPx = Math.round((bb.x - canvas.x + bb.width / 2 - len / 2) * 1000) / 1000;
      st.top = `${Math.round(bb.y - canvas.y + bb.height / 2 - thick / 2)}px`;
      if (node.constraints?.horizontal === "CENTER") {
        const off = leftPx - Math.round(canvas.width) / 2;
        st.left = `calc(50% ${off < 0 ? "-" : "+"} ${Math.abs(Math.round(off * 1000) / 1000)}px)`;
      } else {
        st.left = `${leftPx}px`;
      }
      const t = node.relativeTransform;
      st.transform = `matrix(${t[0][0]}, ${t[1][0]}, ${t[0][1]}, ${t[1][1]}, 0, 0)`;
      st["transform-origin"] = "center";
    } else {
      st.width = `${len}px`;
      st.height = `${thick}px`;
      st.top = `${Math.round(bb.y - canvas.y - thick / 2)}px`;
    }
    applyScaleH(node, st, canvas, ctx);
    const line = `  <div class="line" style="${cssText(st)}"${nodeAttr(node)}></div>`;
    out.push(href ? `  <a href="${href}"${nodeAttr(node)}>${line}</a>` : line);
    return;
  }

  // Vector icons are served as generated .svg assets referenced by node.hash.
  if (tag === "SVG") {
    if (node.hash) {
      const st = nodeStyle(node, canvas, fontStack, assetUrl, centered);
      if (overlay) Object.assign(st, overlay);
      st.display = "block";
      // The live site places vector assets at Figma's own isolated render
      // bounds, which account for both baked-in effects (asset larger than the
      // design box) and cropped content (asset smaller, e.g. the page-5
      // triangle polygon whose SVG is trimmed to the drawing). Prefer that
      // authoritative box; fall back to parsing the SVG file for old data.
      const rb = node.isolatedAbsoluteRenderBounds;
      const rotated = isNodeRotated(node);
      if (href && !rotated) {
        // An interactive SVG renders as an <a> covering the node's FULL
        // absoluteBoundingBox with the asset stretched inside it. The nav
        // hotspots ship as empty 32×32 SVGs inside huge (1253×933) hit areas;
        // sizing the <a> to the natural asset shrank the click target to a
        // tiny corner and dropped the navigation.
        delete st["background-color"];
        delete st["background-image"];
        applyScaleH(node, st, canvas, ctx);
        const fill = `<img src="${assetUrl(node.hash)}" alt="" style="width: 100%; height: 100%; display: block" />`;
        out.push(`  <a href="${href}" style="${cssText(st)}"${nodeAttr(node)}>${fill}</a>`);
        return;
      }
      if (rotated) {
        // Rotated vectors (e.g. the 90° Horizontal/Vertical toggle) are drawn
        // by the live site with a CSS transform matrix inside the design box.
        // Replicate it: position the unrotated asset on the isolated render
        // bounds (which cover the baked shadow/overflow), then apply Figma's
        // rotation matrix around the design-box (bbox) center. Figma's
        // [[a,b],[c,d]] maps to CSS matrix(a, c, b, d).
        const t = node.relativeTransform;
        const geo = svgGeometry(assetDir, node.hash);
        const w = geo ? geo.w : bb.width;
        const h = geo ? geo.h : bb.height;
        const box = rb || bb;
        const cx = box.x + box.width / 2 - canvas.x;
        const cy = box.y + box.height / 2 - canvas.y;
        const leftPx = Math.round((cx - w / 2) * 1000) / 1000;
        const topPx = Math.round((cy - h / 2) * 1000) / 1000;
        st.top = `${topPx}px`;
        st.width = `${w}px`;
        st.height = `${h}px`;
        if (node.constraints?.horizontal === "CENTER") {
          const off = leftPx - Math.round(canvas.width) / 2;
          st.left = `calc(50% ${off < 0 ? "-" : "+"} ${Math.abs(Math.round(off * 1000) / 1000)}px)`;
        } else {
          st.left = `${leftPx}px`;
        }
        st.transform = `matrix(${t[0][0]}, ${t[1][0]}, ${t[0][1]}, ${t[1][1]}, 0, 0)`;
        // Rotate around the DESIGN box (bbox) center, not the asset's own
        // center. The asset carries a baked shadow gutter, so its center is
        // offset from the bbox center; rotating around "center" (the asset's
        // center) shifted the pill off by that gutter (9,13px on the toggle).
        const originX = Math.round((bb.x + bb.width / 2 - canvas.x - leftPx) * 1000) / 1000;
        const originY = Math.round((bb.y + bb.height / 2 - canvas.y - topPx) * 1000) / 1000;
        st["transform-origin"] = `${originX}px ${originY}px`;
      } else if (rb && (Math.abs(rb.width - bb.width) > 0.5 || Math.abs(rb.height - bb.height) > 0.5)) {
        const rLeft = Math.round((rb.x - canvas.x) * 1000) / 1000;
        const rTop = Math.round((rb.y - canvas.y) * 1000) / 1000;
        st.top = `${rTop}px`;
        st.width = `${Math.round(rb.width * 1000) / 1000}px`;
        st.height = `${Math.round(rb.height * 1000) / 1000}px`;
        if (node.constraints?.horizontal === "CENTER") {
          const off = rLeft - Math.round(canvas.width) / 2;
          st.left = `calc(50% ${off < 0 ? "-" : "+"} ${Math.abs(Math.round(off * 1000) / 1000)}px)`;
        } else {
          st.left = `${rLeft}px`;
        }
      } else {
        const geo = svgGeometry(assetDir, node.hash);
        if (geo && (Math.abs(geo.w - bb.width) > 0.5 || Math.abs(geo.h - bb.height) > 0.5)) {
          st.left = shiftLeft(st.left, geo.offX);
          st.top = `${Math.round(bb.y - canvas.y) - geo.offY}px`;
          st.width = `${geo.w}px`;
          st.height = `${geo.h}px`;
        }
      }
      // The vector's fill (and any node-level opacity) is baked into the SVG
      // asset itself; nodeStyle derives a background-color from the node's
      // fills, which would paint a solid rectangle behind a transparent
      // polygon (the page-5 triangle looked like a square).
      delete st["background-color"];
      delete st["background-image"];
      applyScaleH(node, st, canvas, ctx);
      const img = `<img src="${assetUrl(node.hash)}" alt="" style="${cssText(st)}"${nodeAttr(node)} />`;
      out.push(href ? `  <a href="${href}"${nodeAttr(node)}>${img}</a>` : img);
    }
    return;
  }

  // A FRAME draws only when it paints something:
  //  - overflowDirection makes it a scroll container (the live site renders
  //    overflow-x/overflow-y: auto) whose children live inside the scroll box
  //    and are positioned relative to the frame — e.g. the timeline's 2288px
  //    image panning inside a 1228px frame;
  //  - otherwise, a fill (e.g. "hero-right-image-container", a FRAME carrying
  //    an IMAGE fill) paints the frame background — the live site renders it as
  //    a div with the image. Plain layout frames contribute nothing.
  if (tag === "FRAME") {
    const scroll = node.overflowDirection;
    const hasFill = (node.fills || []).some((f) => f.visible);
    if (!scroll && !hasFill) return;
    const st = nodeStyle(node, canvas, fontStack, assetUrl, centered);
    if (overlay) Object.assign(st, overlay);
    if (scroll === "HORIZONTAL_SCROLLING") {
      st["overflow-x"] = "auto";
      st["overflow-y"] = "clip";
    } else if (scroll === "VERTICAL_SCROLLING") {
      st["overflow-y"] = "auto";
      st["overflow-x"] = "clip";
    } else if (scroll) {
      st.overflow = "auto";
    }
    applyScaleH(node, st, canvas, ctx);
    const isLink = !!href;
    out.push(isLink ? `  <a href="${href}" style="${cssText(st)}"${nodeAttr(node)}>` : `  <div style="${cssText(st)}"${nodeAttr(node)}>`);
    if (scroll) {
      // Scroll containers own their subtree: children sit inside the scroll box.
      for (const childId of node.children || []) {
        const child = nodes[childId];
        if (!child) continue;
        ctx.handled?.add(childId);
        renderNode(child, nodes, node.absoluteBoundingBox, out, ctx);
      }
    }
    out.push(isLink ? "</a>" : "</div>");
    return;
  }

  if (tag === "TEXT") {
    const eff = applyTextEdit(node, ctx.edits?.get(node.id));
    const st = nodeStyle(eff, canvas, fontStack, assetUrl, centered);
    if (overlay) Object.assign(st, overlay);
    applyScaleH(node, st, canvas, ctx);
    // The "active" nav item (current page) carries textDecoration UNDERLINE
    // plus Extra Bold in the design; items with a NAVIGATE interaction (on the
    // node or its wrapping group) are links. Both come from the Figma data,
    // not from which page we are on.
    const isActive = node.style?.textDecoration === "UNDERLINE";
    const wrapOpen = href
      ? `  <a href="${href}" class="nav-link" style="${cssText(st)}"${nodeAttr(node)}>`
      : `  <div${isActive ? ' class="nav-active"' : ""} style="${cssText(st)}"${nodeAttr(node)}>`;
    // No leading whitespace on the closing tag: single-line text is emitted
    // directly between open and close, and with white-space:pre-wrap those two
    // indentation spaces became trailing spaces in the text, shifting centered
    // stats like "71.9" a couple of pixels left.
    const wrapClose = href ? "</a>" : "</div>";
    // The live site splits multi-paragraph text into stacked <p> blocks with
    // no inter-paragraph gap; blank lines are preserved as <p>&#8203;</p>.
    // characterStyleOverrides mark spans with a different weight/size — those
    // become inline <span> overrides.
    const { chars, runs } = textRuns(eff);
    if (!chars.includes("\n") && !runs.some((r) => r.weight || r.size)) {
      out.push(`${wrapOpen}${escapeHtml(chars)}${wrapClose}`);
      return;
    }
    const lines = chars.split("\n");
    let offset = 0;
    const paras = lines.map((line) => {
      const lineStart = offset;
      offset += line.length + 1;
      const base = `<p style="display: block; white-space: pre-wrap; line-height: normal; margin: 0">`;
      if (line.trim().length === 0) return `${base}&#8203;</p>`;
      const overlap = runs.filter((r) => r.end > lineStart && r.start < lineStart + line.length);
      if (!overlap.some((r) => r.weight || r.size)) return `${base}${escapeHtml(line)}</p>`;
      let body = "";
      for (const r of overlap) {
        const s = Math.max(r.start, lineStart);
        const e = Math.min(r.end, lineStart + line.length);
        if (e <= s) continue;
        const txt = escapeHtml(line.slice(s - lineStart, e - lineStart));
        const style = [];
        if (r.weight) style.push(`font-weight: ${r.weight}`);
        if (r.size) style.push(`font-size: ${r.size}px`);
        body += style.length ? `<span style="${style.join("; ")}">${txt}</span>` : txt;
      }
      return `${base}${body}</p>`;
    });
    out.push(`${wrapOpen}\n${paras.map((p) => `  ${p}`).join("\n")}\n${wrapClose}`);
    return;
  }

  if (tag === "RECTANGLE" || tag === "IMAGE") {
    const st = nodeStyle(node, canvas, fontStack, assetUrl, centered);
    if (overlay) Object.assign(st, overlay);
    // Mask-group images carry their asset in node.hash, not in fills.
    if (tag === "IMAGE" && node.hash && !st["background-image"]) {
      st["background-image"] = `url(${assetUrl(node.hash)})`;
      st["background-size"] = "cover";
      st["background-position"] = "center";
    }
    applyScaleH(node, st, canvas, ctx);
    // The live site renders each interactive node (rect button, hotspot
    // marker, …) as an <a>; an interactive group's children link to its target.
    if (href) {
      out.push(`  <a href="${href}" style="${cssText(st)}"${nodeAttr(node)}></a>`);
    } else {
      out.push(`  <div style="${cssText(st)}"${nodeAttr(node)}></div>`);
    }
    return;
  }
}

export function cssText(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
}

// AI 插入的视频(insert_video):把 <video> 摆在节点原本的位置与尺寸上,替换掉该
// 节点原本的渲染。视频文件放进输出目录即可 —— 发布时 collectDeployFiles 会把整个
// 目录递归传上去,所以不需要额外的上传通道。
//
// 为什么要有这个:工具集原本只有「改文字 / 改样式 / 词云 / 数据绑定」,想让 AI 塞进
// 一个 <video> 只能让 it 用 write_file 整体改写 HTML —— 而首页动辄 600+ 节点、
// read_file 会截断,凭半份内容写回会把后半页整段弄丢。所以正确做法是加一个声明式
// 工具,把「插视频」变成一条覆盖层记录,由构建来落笔。
export function videoElement(node, canvas, ctx, spec) {
  const assetUrl = makeAssetUrl(ctx.assetDir);
  // 与 renderNode 同样的定位规则(CENTER 约束或居中祖先 → calc(50% ± off))
  const centered = node.constraints?.horizontal === "SCALE" ? false : hasCenteredAncestor(node, ctx.parentOf);
  const st = nodeStyle(node, canvas, ctx.fontStack, assetUrl, centered);
  const overlay = ctx.nodeStyles?.get(node.id);
  if (overlay) Object.assign(st, overlay);
  // 节点原本的填充/描边不该画在视频后面 —— 视频自己就是内容
  for (const k of ["background-image", "background-size", "background-position", "background-repeat", "background-color", "border"]) {
    delete st[k];
  }
  // 节点自身的 opacity 保留(那是设计意图);但 fill 的透明度是 nodeStyle 为了
  // 图像填充才塞进 opacity 的,这里要还原成节点自己的值。
  if (node.opacity !== undefined && node.opacity < 1) st.opacity = node.opacity;
  else delete st.opacity;
  if (!st["border-radius"] && node.cornerRadius) st["border-radius"] = `${node.cornerRadius}px`;
  st["object-fit"] = spec.fit === "contain" ? "contain" : spec.fit === "fill" ? "fill" : "cover";
  st["display"] = "block";

  const flag = (k) => (spec[k] ? ` ${k}` : "");
  // autoplay 必须配 muted:浏览器一律拦截带声音的自动播放。
  const autoplay = !!spec.autoplay;
  const muted = autoplay || spec.muted !== false ? " muted" : "";
  const attrs =
    // controls 默认开:一个没法播放的视频不是好默认值。insert_video 也会显式存这个值。
    `${spec.controls === false ? "" : " controls"}${autoplay ? " autoplay" : ""}${muted}${flag("loop")} playsinline preload="metadata"` +
    (spec.poster ? ` poster="${escapeHtml(String(spec.poster))}"` : "");
  return `  <video class="replica-video" src="${escapeHtml(String(spec.src))}"${attrs} style="${cssText(st)}" data-node-id="${node.id}" data-video-id="${escapeHtml(String(spec.id || ""))}"></video>`;
}

export function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");}

export function collectNodes(id, nodes, acc) {
  const n = nodes[id];
  if (!n) return;
  acc.push(n);
  for (const c of n.children || []) collectNodes(c, nodes, acc);
}

// All nodes of a page, flattened, root-first.
export function collectAll(data) {
  const all = [];
  for (const r of data.roots) collectNodes(r, data.nodeById, all);
  return all;
}

// 已发布的 Figma Sites 数据里,INSTANCE 的 children 是**复合 id**:
//   "I18:1039;18:990"  =  I<实例id>;<组件内的原始id>
// 而 nodeById 里**没有**这些键 —— 直接照 children 走,一个子节点都取不到,
// 整个实例的内容就消失了。lily2026new 的画廊轮播正是如此:卡片底色渲染出来了,
// 里面的图片、文字、左右箭头全部空白。
//
// 复合 id 的后半段就是主组件里的原始节点,所以按「实例原点 − 主组件原点」整棵
// 子树平移过去就能还原(实测 12 个子节点全部精确落在各自实例框内)。
// 还原出的节点登记为合成 id `<实例id>~<原始id>` 并挂回实例的 children,
// 于是 collectAll / renderNode / parentOf / linkHref 全都不用改。
//
// 合成 id 是确定性的,所以 AI 用 edit_node 针对它写的覆盖,重建之后依然命中。
//
// 顺带处理**组件变体轮播**(Figma 的 SWAP_STATE 交互):把组件集里其它变体也按
// 各自的位置差平移过来渲染,默认隐藏,只让主变体可见;箭头节点带上
// `data-swap-to="<目标变体id>"`,运行时据此切显隐(见 swapRuntime)。
// 只有当默认变体的子树里真的存在 SWAP_STATE 箭头时才展开其它变体 ——
// 否则只是白白多渲染一堆永远不会显示的节点。
export function expandInstances(data) {
  const nodes = data?.nodeById;
  if (!nodes) return 0;
  const originalOf = (id) => {
    const s = String(id);
    const i = s.indexOf(";");
    return i >= 0 ? s.slice(i + 1) : s;
  };
  const SHIFTABLE = ["absoluteBoundingBox", "absoluteRenderBounds", "isolatedAbsoluteRenderBounds"];
  let added = 0;

  const clone = (origId, dx, dy, prefix, swap, depth) => {
    const src = nodes[origId];
    if (!src || depth > 12) return null;
    const sid = `${prefix}${origId}`;
    if (nodes[sid]) return sid; // 同一实例/变体内被引用两次
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = sid;
    for (const k of SHIFTABLE) {
      if (copy[k]) copy[k] = { ...copy[k], x: copy[k].x + dx, y: copy[k].y + dy };
    }
    if (swap) copy.__swap = swap;
    // 先登记再递归,自引用/环才不至于无限展开。
    nodes[sid] = copy;
    added++;
    copy.children = (src.children || []).map((c) => clone(originalOf(c), dx, dy, prefix, swap, depth + 1)).filter(Boolean);
    return sid;
  };

  // 迭代 Object.values 的快照,新登记的合成节点不会被本轮二次处理。
  for (const inst of Object.values(nodes)) {
    if (inst?.type !== "INSTANCE") continue;
    const ib = inst.absoluteBoundingBox;
    if (!ib) continue;
    const comp = nodes[inst.mainComponentId] || nodes[inst.componentSetId];
    const cb = comp?.absoluteBoundingBox;
    if (!cb) continue;

    // 1) 实例自己的 children(复合 id)→ 按「实例原点 − 主组件原点」还原。
    const kids = inst.children || [];
    if (kids.some((c) => !nodes[c])) {
      const prefix = `${inst.id}~`;
      const dx = ib.x - cb.x;
      const dy = ib.y - cb.y;
      const swap = { group: inst.id, variant: inst.mainComponentId, on: true };
      inst.children = kids.map((c) => (nodes[c] ? c : clone(originalOf(c), dx, dy, prefix, swap, 0))).filter(Boolean);
      // 本来就存在的子节点(数据正常的实例)也要打上分组标记,否则切换时管不到它们。
      for (const c of inst.children) if (!nodes[c]?.__swap) markSwap(nodes, c, swap);
    }

    // 2) 变体轮播:其它变体也渲染出来(默认隐藏)。
    const variants = (nodes[inst.componentSetId]?.children || []).map((c) => nodes[c]).filter((v) => v?.type === "COMPONENT");
    if (variants.length < 2) continue;
    if (!subtreeHasSwap(nodes, inst.children || [], inst.componentSetId)) continue;
    for (const v of variants) {
      if (v.id === inst.mainComponentId) continue;
      const vb = v.absoluteBoundingBox;
      if (!vb) continue;
      const prefix = `${inst.id}~${v.id}~`;
      const dx = ib.x - vb.x;
      const dy = ib.y - vb.y;
      const swap = { group: inst.id, variant: v.id, on: false };
      for (const c of v.children || []) {
        const sid = clone(originalOf(c), dx, dy, prefix, swap, 0);
        if (sid) inst.children.push(sid);
      }
    }
  }
  return added;
}

// 给一棵已有子树补上分组标记(用于子节点本来就存在的实例)。
function markSwap(nodes, id, swap) {
  const n = nodes[id];
  if (!n) return;
  if (!n.__swap) n.__swap = swap;
  for (const c of n.children || []) markSwap(nodes, c, swap);
}

// 子树里是否存在指向该组件集的 SWAP_STATE 交互(有才值得展开其它变体)。
function subtreeHasSwap(nodes, ids, setId) {
  const seen = new Set();
  const walk = (id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    const n = nodes[id];
    if (!n) return false;
    for (const i of n.interactions || []) {
      for (const a of i.actions || []) {
        if (a?.navigationType !== "SWAP_STATE") continue;
        if (!setId || !a.stateGroupContext || a.stateGroupContext === setId) return true;
      }
    }
    return (n.children || []).some(walk);
  };
  return ids.some(walk);
}

// 节点上挂的 SWAP_STATE 目标变体 id(没有则 null)。
export function swapTargetOf(node) {
  for (const i of node?.interactions || []) {
    for (const a of i.actions || []) {
      if (a?.navigationType !== "SWAP_STATE" || !a.transitionNodeID) continue;
      return `${a.transitionNodeID.sessionID}:${a.transitionNodeID.localID}`;
    }
  }
  return null;
}

// 变体切换的浏览器运行时。用 data 属性切显隐而不是直接写 style.display ——
// 文本节点靠内联 display:flex 布局,覆盖掉就散了。
export const swapRuntime = `(function () {
  function apply(group, variant) {
    var list = document.querySelectorAll('[data-swap-group="' + group + '"]');
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('data-swap-variant') === variant) list[i].removeAttribute('data-swap-off');
      else list[i].setAttribute('data-swap-off', '');
    }
  }
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-swap-to]') : null;
    if (!el) return;
    var group = el.getAttribute('data-swap-group');
    var to = el.getAttribute('data-swap-to');
    if (!group || !to) return;
    e.preventDefault();
    apply(group, to);
  });
})();`;

// The page's canvas frame (FRAME, falling back to WEBPAGE). Shared by the
// build pipeline and the AI's apply_wordcloud (which clamps placement rects
// to it).
export function findCanvas(data) {
  const all = collectAll(data);
  return all.find((n) => n.type === "FRAME") || all.find((n) => n.type === "WEBPAGE") || null;
}
