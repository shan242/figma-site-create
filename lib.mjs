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

export const fillToCss = (fill, assetUrl) => {
  if (!fill || !fill.visible || fill.opacity === 0) return null;
  if (fill.type === "SOLID") {
    const bg = fmtColor(fill.color, fill.opacity !== undefined && fill.opacity < 1 ? fill.opacity : undefined);
    return bg ? { "background-color": bg } : null;
  }
  if (fill.type === "IMAGE" && fill.imageRef) {
    return { "background-image": `url(${assetUrl(fill.imageRef)})`, "background-size": "cover", "background-position": "center" };
  }
  if (fill.type === "GRADIENT_LINEAR" && fill.gradientStops?.length) {
    const angle = gradientAngle(fill.gradientHandlePositions) ?? 90;
    const stops = fill.gradientStops.map((s) => `${fmtColor(s.color)} ${Math.round(s.position * 100)}%`).join(", ");
    return { "background-image": `linear-gradient(${angle}deg, ${stops})` };
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

export function nodeStyle(node, canvas, fontStackFn, assetUrl) {
  const bb = node.absoluteBoundingBox;
  const left = Math.round(bb.x - canvas.x);
  const top = Math.round(bb.y - canvas.y);
  const w = Math.round(bb.width);
  const h = Math.round(bb.height);
  const st = { position: "absolute", top: `${top}px`, width: `${w}px`, height: `${h}px` };
  // The build renders the canvas fluid (width:100%; min-width:W) to match the
  // live site. A node Figma constrained horizontal=CENTER keeps its distance
  // from the canvas center as the viewport stretches, so its left is a calc:
  // at canvas width W it sits at design px `left`; at any wider viewport it
  // must land at 50% + (left - W/2). calc(50% + (left - W/2))px is exactly
  // that. Nodes without CENTER keep their fixed design px.
  if (node.constraints?.horizontal === "CENTER") {
    const off = left - Math.round(canvas.width) / 2;
    st.left = `calc(50% ${off < 0 ? "-" : "+"} ${Math.abs(Math.round(off))}px)`;
  } else {
    st.left = `${left}px`;
  }
  const opacity = node.opacity !== undefined && node.opacity < 1 ? node.opacity : 1;

  if (node.type === "TEXT") {
    const s = node.style ?? {};
    st.width = `${w}px`;
    st.height = "auto";
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
    // The published site renders every text block with the font's natural
    // line-height; Figma's lineHeightPx makes lines cramped and was dropped.
    st["line-height"] = "normal";
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
      Object.assign(st, fillToCss(fill, assetUrl) ?? {});
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

// Reflow a node whose Figma horizontal constraint is SCALE: the published site
// positions it as a percentage of the design width, so it stretches with the
// fluid canvas (width:100%; min-width:designW). Vertical stays at design px —
// the live container keeps its design height, so a SCALE/SCALE node only widens.
// Must run after every px adjustment (SVG natural-size offsets) — it reads the
// final left/width and re-expresses them as %.
function applyScaleH(node, st, canvas) {
  if (node.constraints?.horizontal !== "SCALE") return st;
  const designW = canvas.width;
  if (typeof st.width === "string" && /^-?[\d.]+px$/.test(st.width)) {
    st.width = `${((parseFloat(st.width) / designW) * 100).toFixed(4)}%`;
  }
  if (typeof st.left === "string" && /^-?[\d.]+px$/.test(st.left)) {
    st.left = `${((parseFloat(st.left) / designW) * 100).toFixed(4)}%`;
  }
  return st;
}

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

  if (tag === "SVG" && node.isLine) {
    const st = nodeStyle(node, canvas, fontStack, assetUrl);
    if (overlay) Object.assign(st, overlay);
    st.height = `${node.strokeWeight || 1}px`;
    st.top = `${Math.round(bb.y - canvas.y - (node.strokeWeight || 1) / 2)}px`;
    const col = fmtColor(node.strokes?.[0]?.color);
    st.background = col;
    delete st["border-radius"];
    applyScaleH(node, st, canvas);
    const line = `  <div class="line" style="${cssText(st)}"></div>`;
    out.push(href ? `  <a href="${href}">${line}</a>` : line);
    return;
  }

  // Vector icons are served as generated .svg assets referenced by node.hash.
  if (tag === "SVG") {
    if (node.hash) {
      const st = nodeStyle(node, canvas, fontStack, assetUrl);
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
        applyScaleH(node, st, canvas);
        const fill = `<img src="${assetUrl(node.hash)}" alt="" style="width: 100%; height: 100%; display: block" />`;
        out.push(`  <a href="${href}" style="${cssText(st)}">${fill}</a>`);
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
      applyScaleH(node, st, canvas);
      const img = `<img src="${assetUrl(node.hash)}" alt="" style="${cssText(st)}" />`;
      out.push(href ? `  <a href="${href}">${img}</a>` : img);
    }
    return;
  }

  if (tag === "TEXT") {
    const eff = applyTextEdit(node, ctx.edits?.get(node.id));
    const st = nodeStyle(eff, canvas, fontStack, assetUrl);
    if (overlay) Object.assign(st, overlay);
    applyScaleH(node, st, canvas);
    // The "active" nav item (current page) carries textDecoration UNDERLINE
    // plus Extra Bold in the design; items with a NAVIGATE interaction (on the
    // node or its wrapping group) are links. Both come from the Figma data,
    // not from which page we are on.
    const isActive = node.style?.textDecoration === "UNDERLINE";
    const wrapOpen = href
      ? `  <a href="${href}" class="nav-link" style="${cssText(st)}">`
      : `  <div${isActive ? ' class="nav-active"' : ""} style="${cssText(st)}">`;
    const wrapClose = href ? "  </a>" : "  </div>";
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
    const st = nodeStyle(node, canvas, fontStack, assetUrl);
    if (overlay) Object.assign(st, overlay);
    // Mask-group images carry their asset in node.hash, not in fills.
    if (tag === "IMAGE" && node.hash && !st["background-image"]) {
      st["background-image"] = `url(${assetUrl(node.hash)})`;
      st["background-size"] = "cover";
      st["background-position"] = "center";
    }
    applyScaleH(node, st, canvas);
    // The live site renders each interactive node (rect button, hotspot
    // marker, …) as an <a>; an interactive group's children link to its target.
    if (href) {
      out.push(`  <a href="${href}" style="${cssText(st)}"></a>`);
    } else {
      out.push(`  <div style="${cssText(st)}"></div>`);
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

export function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

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

// The page's canvas frame (FRAME, falling back to WEBPAGE). Shared by the
// build pipeline and the AI's apply_wordcloud (which clamps placement rects
// to it).
export function findCanvas(data) {
  const all = collectAll(data);
  return all.find((n) => n.type === "FRAME") || all.find((n) => n.type === "WEBPAGE") || null;
}
