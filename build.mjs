// build.mjs — Render scraped Figma Sites content into a static HTML/CSS site.
//
//   node build.mjs [--out <dir>]
//
// Reads manifest.json + data/<slug>.json (produced by scrape.mjs) and writes
// <slug>.html + styles.css into the same directory. Rendering rules live in
// lib.mjs; this file decides fonts + page wiring.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, basename, resolve, sep } from "node:path";
import { fillToCss, cssText, renderNode, collectAll, escapeHtml } from "./lib.mjs";
import { cloudInjection } from "./wordcloud.mjs";

// Populated inside main() so the packaged CLI can normalize argv first.
let outDir, manifest, assetDir, fontDir, HAS_CJK;
// Word-cloud placements persisted by the AI chat tool (apply_wordcloud). The
// build only reads this file — writing it happens in ai.mjs — so a rebuild of
// the same spec reproduces the same pages byte-for-byte.
let WORDCLOUDS = [];
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
    const fam = name.split(":")[0];
    if (!GOOGLE_FONTS.has(fam)) selfHost.set(name, info);
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
async function selfHostedCss(selfHost) {
  if (!selfHost.size) return "";
  mkdirSync(fontDir, { recursive: true });
  const rules = [];
  for (const [name, info] of selfHost) {
    const url = info.url;
    if (!url) continue;
    const file = basename(url);
    const dest = join(fontDir, file);
    try {
      // Skip the re-download when the file already exists — the chat agent
      // rebuilds after every edit, and re-fetching fonts on each rebuild is
      // wasted network for an unchanged site.
      if (!existsSync(dest) || statSync(dest).size === 0) {
        const res = await fetch(`${manifest.liveBase}${url}`);
        if (res.ok) writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      }
      rules.push(`@font-face {
  font-family: '${name.split(":")[0]}';
  font-weight: ${info.weight || 400};
  font-style: ${info.italic ? "italic" : "normal"};
  src: url(fonts/${file}) format('woff2');
}`);
      console.log(`  ✓ self-hosted font ${name} (${file})`);
    } catch {
      console.warn(`  ⚠ could not fetch font ${name} from ${url}`);
    }
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
  };
  for (const n of all) {
    if (n === canvas) continue;
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

  // A word cloud may sit below the design canvas bottom (the AI places it in
  // canvas coordinates with top > canvas height); grow the canvas to cover it
  // so the page background reaches the cloud instead of clipping it. Matched
  // to the same rounded rect cloudInjection emits.
  const cloudBottom = clouds.length ? Math.max(...clouds.map((c) => Math.round(c.rect.top) + Math.round(c.rect.height))) : 0;
  const canvasHeight = Math.max(Math.round(cb.height), cloudBottom);

  const bg = fillToCss((canvas.fills || []).find((f) => f.visible)) ?? {};
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
export async function buildSite(outDirParam) {
  outDir = outDirParam;
  manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
  assetDir = join(outDir, "assets");
  fontDir = join(outDir, "fonts");
  WORDCLOUDS = readWordClouds(outDir);
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
  try {
    await buildSite(outDirArg);
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
