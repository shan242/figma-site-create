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

import { existsSync } from "node:fs";
import { join } from "node:path";

export function nodeStyle(node, canvas, fontStackFn, assetUrl) {
  const bb = node.absoluteBoundingBox;
  const left = Math.round(bb.x - canvas.x);
  const top = Math.round(bb.y - canvas.y);
  const w = Math.round(bb.width);
  const h = Math.round(bb.height);
  const st = { position: "absolute", left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` };
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
    const weight = s.fontStyle ? fontStyleToWeight(s.fontStyle) : 400;
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
    const fill = (node.fills || []).find((f) => f.visible && f.opacity !== 0);
    Object.assign(st, fillToCss(fill, assetUrl) ?? {});
    if (node.cornerRadius) st["border-radius"] = `${node.cornerRadius}px`;
    if (node.strokes?.length) {
      const strk = node.strokes[0];
      const color = fmtColor(strk.color, strk.opacity);
      st.border = `${node.strokeWeight || 1}px solid ${color}`;
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

// A text node becomes a clickable <a> only when the design has an ON_CLICK /
// NAVIGATE interaction — that is what Figma Sites turns into an anchor.
// pathToFile maps live paths ("/history--culture") to local files.
export function linkHref(node, pathToFile) {
  for (const it of node.interactions || []) {
    if (it.event?.interactionType !== "ON_CLICK") continue;
    for (const a of it.actions || []) {
      if (a.connectionType === "INTERNAL_NODE" && a.navigationType === "NAVIGATE" && a.connectionURL) {
        return pathToFile[a.connectionURL] || null;
      }
    }
  }
  return null;
}

export function renderNode(node, nodes, canvas, out, ctx) {
  const { assetDir, pathToFile, fontStack } = ctx;
  const assetUrl = makeAssetUrl(assetDir);
  const tag = node.type;
  const bb = node.absoluteBoundingBox;
  if (!bb) return;

  if (tag === "SVG" && node.isLine) {
    const st = nodeStyle(node, canvas, fontStack, assetUrl);
    st.height = `${node.strokeWeight || 1}px`;
    st.top = `${Math.round(bb.y - canvas.y - (node.strokeWeight || 1) / 2)}px`;
    const col = fmtColor(node.strokes?.[0]?.color);
    st.background = col;
    delete st["border-radius"];
    out.push(`  <div class="line" style="${cssText(st)}"></div>`);
    return;
  }

  // Vector icons are served as generated .svg assets referenced by node.hash.
  if (tag === "SVG") {
    if (node.hash) {
      const st = nodeStyle(node, canvas, fontStack, assetUrl);
      st.display = "block";
      out.push(`  <img src="${assetUrl(node.hash)}" alt="" style="${cssText(st)}" />`);
    }
    return;
  }

  if (tag === "TEXT") {
    const st = nodeStyle(node, canvas, fontStack, assetUrl);
    // The "active" nav item (current page) carries textDecoration UNDERLINE
    // plus Extra Bold in the design; items with a NAVIGATE interaction are
    // links. Both come from the Figma data, not from which page we are on.
    const href = linkHref(node, pathToFile);
    const isActive = node.style?.textDecoration === "UNDERLINE";
    const wrapOpen = href
      ? `  <a href="${href}" class="nav-link" style="${cssText(st)}">`
      : `  <div${isActive ? ' class="nav-active"' : ""} style="${cssText(st)}">`;
    const wrapClose = href ? "  </a>" : "  </div>";
    // The live site splits multi-paragraph text into stacked <p> blocks with
    // no inter-paragraph gap; blank lines are preserved as <p>&#8203;</p>.
    // characterStyleOverrides mark spans with a different weight/size — those
    // become inline <span> overrides.
    const { chars, runs } = textRuns(node);
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
    // Mask-group images carry their asset in node.hash, not in fills.
    if (tag === "IMAGE" && node.hash && !st["background-image"]) {
      st["background-image"] = `url(${assetUrl(node.hash)})`;
      st["background-size"] = "cover";
      st["background-position"] = "center";
    }
    out.push(`  <div style="${cssText(st)}"></div>`);
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
