// build.mjs — Render scraped Figma Sites content into a static HTML/CSS site.
//
//   node build.mjs [--out <dir>]
//
// Reads manifest.json + data/<slug>.json (produced by scrape.mjs) and writes
// <slug>.html + styles.css into the same directory. Rendering rules live in
// lib.mjs; this file decides fonts + page wiring.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, basename, resolve, sep } from "node:path";
import { fillToCss, cssText, renderNode, collectAll, escapeHtml, makeAssetUrl, expandInstances, swapRuntime, videoElement } from "./lib.mjs";
import { cloudInjection } from "./wordcloud.mjs";
import { databindInjection, databindHead } from "./databind.mjs";
import { httpFetch } from "./netfetch.mjs";

// Populated inside main() so the packaged CLI can normalize argv first.
let outDir, manifest, assetDir, fontDir, HAS_CJK;
// Word-cloud placements persisted by the AI chat tool (apply_wordcloud). The
// build only reads this file — writing it happens in ai.mjs — so a rebuild of
// the same spec reproduces the same pages byte-for-byte.
let WORDCLOUDS = [];
// Data bindings persisted by the AI chat tool (bind_data): 把页面元素接到数据
// 后端。同样只读;后端地址来自 --data-api 或 REPLICA_DATA_API,空则不注入。
let DATABINDS = [];
let DATA_API = "";
// AI 插入的视频(insert_video):每条记录把某个节点换成 <video>。同样只读。
let VIDEOS = [];
// Text/style edits persisted by the AI chat tool (edit_text). Same read-only
// contract: ai.mjs owns the write, the build just applies the overlay.
let EDITS = [];
// Per-node CSS-style overlays persisted by edit_node, applied on any node type.
let NODE_STYLES = [];

function readItems(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(data?.items) ? data.items : [];
  } catch {
    return [];
  }
}

const readWordClouds = (dir) => readItems(join(dir, "wordclouds.json"));
const readEdits = (dir) => readItems(join(dir, "edits.json"));
const readNodeStyles = (dir) => readItems(join(dir, "nodeStyles.json"));
const readOverrides = (dir) => readItems(join(dir, "overrides.json"));
const readDatabinds = (dir) => readItems(join(dir, "databinds.json"));
// AI 插入的视频(insert_video):一条记录 = 把某个节点换成 <video>。
const readVideos = (dir) => readItems(join(dir, "videos.json"));

// Files the AI locked via write_file survive a rebuild by being re-applied
// after the build regenerates them. file-locks.json is owned by ai.mjs; the
// build only reads it. Keys are normalized relative paths; anything that would
// resolve outside the out dir is skipped.
function applyFileLocks(dir) {
  let locks;
  try {
    locks = JSON.parse(readFileSync(join(dir, "file-locks.json"), "utf8"));
  } catch {
    return;
  }
  const files = locks?.files;
  if (!files || typeof files !== "object") return;
  const dirNorm = dir.endsWith(sep) ? dir : dir + sep;
  for (const [rel, content] of Object.entries(files)) {
    const dest = resolve(dir, rel);
    if (!dest.startsWith(dirNorm) || typeof content !== "string") {
      console.warn(`  ⚠ skipping unsafe locked path: ${rel}`);
      continue;
    }
    try {
      writeFileSync(dest, content);
      console.log(`  ✓ re-applied locked file ${rel}`);
    } catch (e) {
      console.warn(`  ⚠ could not re-apply locked file ${rel}: ${e.message}`);
    }
  }
}

// Figma font families that Google Fonts serves; anything else is self-hosted
// from the site's own /_woff files during the build.
const GOOGLE_FONTS = new Set([
  "Inter", "Inria Sans", "Noto Sans", "Noto Sans SC", "Noto Sans JP", "Roboto",
  "Open Sans", "Lato", "Montserrat", "Poppins", "Raleway", "Playfair Display",
  "Merriweather", "Source Sans 3", "Work Sans", "Nunito", "Oswald", "PTSans",
  "PTSerif", "Space Grotesk", "DM Sans", "Manrope", "Sora", "Epilogue", "Bebas Neue",
]);

const loadData = (json) => JSON.parse(readFileSync(join(outDir, json), "utf8"));

// --- Font discovery ---------------------------------------------------------
// Collect every (family, weight) the design uses, from each page's fonts map
// (which lists exact weights) plus a text-node scan as a safety net.

function fontUsages() {
  const famWeight = new Map(); // family -> Set(weight)
  const add = (fam, w) => {
    if (!fam || !w) return;
    if (!famWeight.has(fam)) famWeight.set(fam, new Set());
    famWeight.get(fam).add(w);
  };
  const namedFonts = new Map(); // "Family:Style" -> fonts-map entry (for self-hosting)
  for (const p of manifest.pages) {
    const data = loadData(p.json);
    for (const [name, info] of Object.entries(data.fonts || {})) {
      const fam = name.split(":")[0];
      add(fam, info.weight);
      namedFonts.set(name, info);
    }
    for (const n of Object.values(data.nodeById || {})) {
      if (n.type !== "TEXT") continue;
      const base = n.style || {};
      add(base.fontFamily, base.fontStyle ? weightOf(base.fontStyle) : 400);
      for (const o of Object.values(n.styleOverrideTable || {})) add(o.fontFamily, weightOf(o.fontStyle));
    }
  }
  return { famWeight, namedFonts };
}

const weightOf = (s) => {
  const str = (s || "").toLowerCase();
  if (str.includes("extra bold")) return 800;
  if (str.includes("black")) return 900;
  if (str.includes("semibold") || str.includes("semi bold")) return 600;
  if (str.includes("bold")) return 700;
  if (str.includes("medium")) return 500;
  if (str.includes("light")) return 300;
  return 400;
};

// Build the Google Fonts <link> for known families, and collect unknown
// families to self-host below.
function planFonts() {
  const { famWeight, namedFonts } = fontUsages();
  const google = new Map(); // family -> sorted weights
  const selfHost = new Map(); // "Family:Style" -> fonts-map entry
  for (const [fam, weights] of famWeight) {
    const sorted = [...weights].sort((a, b) => a - b);
    if (GOOGLE_FONTS.has(fam)) google.set(fam, sorted);
  }
  if (HAS_CJK) {
    for (const fam of ["Noto Sans SC", "Noto Sans JP"]) {
      if (!google.has(fam)) google.set(fam, [400, 500]);
      else google.set(fam, [...new Set([...google.get(fam), 400, 500])].sort((a, b) => a - b));
    }
  }
  for (const [name, info] of namedFonts) {
    // Self-host every family the site ships its own woff2 for — even when the
    // family also exists on Google Fonts (e.g. this site's "Inter:Bold"). The
    // site's subset has Figma-exact metrics; Google's full face is a hair wider
    // and wrapped single-line labels like "Horizontal" a character early.
    selfHost.set(name, info);
  }
  return { google, selfHost, hasCJK: HAS_CJK };
}

function googleFontsLink(google) {
  const families = [...google.entries()]
    .map(([fam, w]) => `${fam.replace(/ /g, "+")}:wght@${w.join(";")}`)
    .sort();
  return `https://fonts.googleapis.com/css2?${families.map((f) => `family=${f}`).join("&")}&display=swap`;
}

// Download the site's own woff2 for fonts Google Fonts can't serve, and emit
// the @font-face rules into styles.css.
//
// Retries and loud diagnostics, because the failure mode here is a TRANSIENT
// network drop on a multi-megabyte download (Noto Sans SC/JP are 4–7 MB each),
// not a missing file: the same URL succeeds on the next attempt. The old
// `catch {}` printed "could not fetch" with no reason and emitted a @font-face
// pointing at a file that was never written, so the page silently 404'd its
// font. Now the reason is surfaced, the rule is only emitted for a file that
// really landed, and a failure is summarised with what to do about it.
async function selfHostedCss(selfHost) {
  if (!selfHost.size) return "";
  mkdirSync(fontDir, { recursive: true });
  const rules = [];
  let failed = 0;
  for (const [name, info] of selfHost) {
    const url = info.url;
    if (!url) continue;
    const file = basename(url);
    const dest = join(fontDir, file);
    // Skip the re-download when the file already exists — the chat agent
    // rebuilds after every edit, and re-fetching fonts on each rebuild is
    // wasted network for an unchanged site.
    const have = existsSync(dest) && statSync(dest).size > 0;
    let lastErr = "";
    if (!have) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          // httpFetch: 在 GUI 里走 Electron 的 net.fetch,才会遵循系统代理
          // (字体也是从 figma.site 下的,同样受 VPN 影响)。
          const res = await httpFetch(`${manifest.liveBase}${url}`);
          if (!res.ok) {
            // Drain the body: an unconsumed response keeps the connection out of
            // undici's pool and can wedge later requests to the same origin.
            try {
              await res.body?.cancel();
            } catch {}
            throw new Error(`HTTP ${res.status}`);
          }
          writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
          lastErr = "";
          break;
        } catch (e) {
          lastErr = e?.message || String(e);
          if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
    }
    if (lastErr) {
      failed++;
      console.warn(`  ⚠ 字体 ${name} 下载失败(${url}):${lastErr}`);
      continue; // 不写出指向不存在文件的 @font-face;浏览器会退到字体栈的下一项
    }
    rules.push(`@font-face {
  font-family: '${name.split(":")[0]}';
  font-weight: ${info.weight || 400};
  font-style: ${info.italic ? "italic" : "normal"};
  src: url(fonts/${file}) format('woff2');
}`);
    console.log(`  ✓ self-hosted font ${name} (${file})`);
  }
  if (failed) {
    console.warn(`  ⚠ 有 ${failed} 个字体未能自托管,相关页面会退回系统字体;重新生成一次通常即可(网络抖动)`);
  }
  return rules.join("\n\n");
}

// --- Page rendering ---------------------------------------------------------

const fontStack = (family) =>
  HAS_CJK
    ? `'${family}', 'Noto Sans SC', 'Noto Sans JP', system-ui, sans-serif`
    : `'${family}', system-ui, sans-serif`;

function buildPage(page, pathToFile, googleLink, hasCjk) {
  const d = loadData(page.json);
  // INSTANCE 的子树在发布数据里是复合 id,nodeById 中没有对应项 ——
  // 不展开的话实例内容整块不渲染(画廊轮播只剩卡片底色)。幂等。
  expandInstances(d);
  const nodes = d.nodeById;
  const all = collectAll(d);

  const canvas = all.find((n) => n.type === "FRAME") || all.find((n) => n.type === "WEBPAGE");
  if (!canvas) throw new Error(`No canvas frame in ${page.path}`);

  const cb = canvas.absoluteBoundingBox;
  const out = [];
  // childId -> parent node, so a child of a clickable GROUP inherits the
  // group's NAVIGATE interaction (buttons keep their interaction on the group).
  const parentOf = new Map();
  for (const n of all) for (const c of n.children || []) parentOf.set(c, n);
  const ctx = {
    assetDir,
    pathToFile,
    fontStack,
    parentOf,
    edits: new Map(EDITS.filter((e) => e.slug === page.slug).map((e) => [e.nodeId, e])),
    nodeStyles: new Map(NODE_STYLES.filter((s) => s.slug === page.slug).map((s) => [s.nodeId, s.style])),
    // insert_video:nodeId -> 视频记录。命中的节点由 videoElement 接管,
    // 不再走普通渲染(否则底色会画在视频后面)。
    videos: new Map(VIDEOS.filter((v) => v.slug === page.slug).map((v) => [v.nodeId, v])),
    // Scroll frames render their subtree themselves; the flat loop must not
    // render those children a second time at canvas level.
    handled: new Set(),
  };
  for (const n of all) {
    if (n === canvas || ctx.handled.has(n.id)) continue;
    // 插了视频的节点:交给 videoElement,不再普通渲染。先于 renderNode 判断,
    // 因为 renderNode 会接管 ctx.handled 之外的一切。
    const vid = ctx.videos.get(n.id);
    if (vid) {
      out.push(videoElement(n, cb, ctx, vid));
      continue;
    }
    renderNode(n, nodes, cb, out, ctx);
  }

  // Word clouds the AI placed on this page. fontFamily falls back to the
  // page's own text font so the words inherit the site's look (with the CJK
  // stack when the site is mixed Chinese/English).
  const clouds = WORDCLOUDS.filter((c) => c.slug === page.slug);
  if (clouds.length) {
    const firstText = all.find((n) => n.type === "TEXT" && n.style?.fontFamily);
    const pageFont = fontStack(firstText?.style?.fontFamily || "Inter");
    for (const c of clouds) {
      out.push(cloudInjection(c, { width: c.rect.width, height: c.rect.height, fontFamily: pageFont, canvasWidth: Math.round(cb.width) }));
    }
  }

  // Data bindings the AI wired up (bind_data): 页面元素 ↔ 数据后端。
  // 未配置 --data-api 时 databindHead 返回空串,页面里只剩 fallback 静态内容。
  const binds = DATABINDS.filter((b) => b.slug === page.slug);
  for (const b of binds) {
    out.push(databindInjection(b, { canvasWidth: Math.round(cb.width) }));
  }

  // 组件变体轮播:只有真的展开了多个变体才需要这段运行时。
  if (all.some((n) => n.__swap)) out.push(`<script>${swapRuntime}</script>`);

  // A word cloud may sit below the design canvas bottom (the AI places it in
  // canvas coordinates with top > canvas height); grow the canvas to cover it
  // so the page background reaches the cloud instead of clipping it. Matched
  // to the same rounded rect cloudInjection emits.
  const cloudBottom = clouds.length ? Math.max(...clouds.map((c) => Math.round(c.rect.top) + Math.round(c.rect.height))) : 0;
  const bindBottom = binds.length ? Math.max(...binds.map((b) => Math.round(b.rect.top) + Math.round(b.rect.height))) : 0;
  const canvasHeight = Math.max(Math.round(cb.height), cloudBottom, bindBottom);
  const dataHead = databindHead(DATA_API, { hasBindings: binds.length > 0 });

  const bg = fillToCss((canvas.fills || []).find((f) => f.visible), makeAssetUrl(assetDir)) ?? {};
  // Fluid canvas: the live site renders width:100% with a min-width equal to
  // the design width, so the page fills the viewport and only shrinks below
  // the design width when the viewport is narrower. The body background follows
  // the canvas color (live does this via body:has([data-breakpoint-id])) and
  // overflow-x:hidden clips the min-width overflow instead of showing a scrollbar.
  const canvasW = Math.round(cb.width);
  const bodyBg = bg["background-color"] || "#ffffff";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(page.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="${googleLink}" rel="stylesheet" />
  <link rel="stylesheet" href="styles.css" />
  <style>body { background-color: ${bodyBg}; overflow-x: hidden; }</style>
${dataHead}
</head>
<body>
  <div class="canvas" style="width:100%;min-width:${canvasW}px;min-height:${canvasHeight}px;${cssText(bg)}">
${out.join("\n")}
  </div>
</body>
</html>
`;
  writeFileSync(join(outDir, page.file), html);
  console.log(`✓ ${page.file} (${all.length} nodes → ${out.length} elements)`);
}

// Core entry shared by the CLI (main) and the Electron GUI. Progress is
// reported through console.log/console.warn, which the GUI intercepts.
export async function buildSite(outDirParam, opts = {}) {
  outDir = outDirParam;
  manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
  assetDir = join(outDir, "assets");
  fontDir = join(outDir, "fonts");
  WORDCLOUDS = readWordClouds(outDir);
  DATABINDS = readDatabinds(outDir);
  VIDEOS = readVideos(outDir);
  // 后端地址:显式参数优先,其次环境变量。空 = 数据功能关闭(纯静态,与以前一致)。
  DATA_API = String(opts.dataApi ?? process.env.REPLICA_DATA_API ?? "").trim().replace(/\/+$/, "");
  EDITS = readEdits(outDir);
  NODE_STYLES = readNodeStyles(outDir);
  HAS_CJK = manifest.pages.some((p) => /[一-鿿]/.test(JSON.stringify(loadData(p.json).nodeById)));
  const { google, selfHost, hasCJK } = planFonts();
  const googleLink = googleFontsLink(google);
  const pathToFile = Object.fromEntries(manifest.pages.map((p) => [p.path, p.file]));

  const sharedCss = `/* Generated replica of ${manifest.liveBase} */
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #fff; font-family: "Inter", system-ui, sans-serif; }
.canvas { position: relative; margin: 0 auto; }
.nav-link { text-decoration: none; }
.nav-active { cursor: default; }
.line { position: absolute; }
.wordcloud { position: absolute; }
.wordcloud canvas { width: 100%; height: 100%; display: block; }
/* 数据绑定(databind.mjs):结果面板 + 采集表单 */
.databind { position: absolute; font-family: "Inter", system-ui, sans-serif; }
.databind .db-body { width: 100%; height: 100%; }
.databind .db-body canvas { width: 100%; height: 100%; display: block; }
.databind .db-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 13px; line-height: 1.4; }
.databind .db-label { flex: 0 0 auto; min-width: 4em; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.databind .db-track { flex: 1 1 auto; height: 8px; background: rgba(0,0,0,.08); border-radius: 4px; overflow: hidden; }
.databind .db-fill { height: 100%; background: #2563eb; border-radius: 4px; transition: width .3s ease; }
.databind .db-count { flex: 0 0 auto; min-width: 2.5em; text-align: right; color: #475569; font-variant-numeric: tabular-nums; }
.databind .db-num { font-size: 42px; font-weight: 700; line-height: 1.1; color: #0f172a; }
.databind .db-unit { font-size: 14px; font-weight: 400; margin-left: 4px; color: #64748b; }
.databind .db-item { font-size: 13px; line-height: 1.6; padding: 2px 0; border-bottom: 1px solid rgba(0,0,0,.06); }
.databind .db-empty { font-size: 13px; color: #94a3b8; }
.databind .db-note { font-size: 12px; margin-top: 4px; color: #64748b; }
.databind .db-note.db-ok { color: #16a34a; }
.databind .db-note.db-err { color: #b91c1c; }
.databind .db-note.db-off { color: #94a3b8; }
/* 离线(没配后端,或 file:// 本地预览):给一个统一的外观,别再让 AI 自己写
   content:'...the voting script only runs there' 去代偿。 */
.databind.db-offline { cursor: default; }
.databind.db-offline [style*="cursor"] { cursor: default !important; }
/* 只写入不渲染(action):容器不该占位,也不该挡到下面的 Figma 元素 */
.databind[data-spec*='"kind":"action"'] { width: 0 !important; height: 0 !important; overflow: visible; pointer-events: none; }
.databind .db-form { display: flex; gap: 6px; margin-top: 8px; pointer-events: auto; }
.databind .db-input { flex: 1 1 auto; min-width: 0; padding: 6px 8px; font-size: 13px; border: 1px solid #cbd5e1; border-radius: 6px; font-family: inherit; }
.databind .db-btn { flex: 0 0 auto; padding: 6px 12px; font-size: 13px; border: 0; border-radius: 6px; background: #2563eb; color: #fff; cursor: pointer; font-family: inherit; }
.databind .db-btn:hover { background: #1d4ed8; }
/* 组件变体轮播(SWAP_STATE):非当前变体隐藏。用属性选择器而不是内联 display ——
   文本节点靠内联 display:flex 排版,直接改 style.display 会把排版弄散。 */
[data-swap-off] { display: none !important; }
[data-swap-to] { cursor: pointer; }
/* AI 插入的视频。定位与尺寸走内联样式(和节点一致),这里只兜底外观。 */
.replica-video { background: #000; }
`;
  const extraCss = await selfHostedCss(selfHost);
  // AI global CSS (append_css) goes last so its rules take precedence over the
  // shared stylesheet (still below per-element inline styles, by CSS rules).
  const overrideCss = readOverrides(outDir).map((i) => i.css).join("\n");
  writeFileSync(join(outDir, "styles.css"), `${sharedCss}${extraCss ? `\n${extraCss}\n` : ""}${overrideCss ? `\n${overrideCss}\n` : ""}`);

  for (const p of manifest.pages) buildPage(p, pathToFile, googleLink, hasCJK);
  applyFileLocks(outDir);
  console.log("✅ Build complete.");
}

export async function main() {
  // Parse argv here (not at module top level) so the packaged CLI can
  // normalize process.argv before delegating to this function.
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const outDirArg = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : "replica-out";
  const apiIdx = args.indexOf("--data-api");
  const dataApi = apiIdx >= 0 && args[apiIdx + 1] ? args[apiIdx + 1] : undefined;
  try {
    await buildSite(outDirArg, { dataApi });
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}

// Only auto-run when invoked directly (node build.mjs); the packaged CLI
// (cli.mjs) calls main() itself after normalizing argv.
if (process.argv[1]?.endsWith("build.mjs")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
