// build.mjs — Render scraped Figma Sites content into a static HTML/CSS site.
//
//   node build.mjs [--out <dir>]
//
// Reads manifest.json + data/<slug>.json (produced by scrape.mjs) and writes
// <slug>.html + styles.css into the same directory. Rendering rules live in
// lib.mjs; this file decides fonts + page wiring.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { fillToCss, cssText, renderNode, collectNodes, escapeHtml } from "./lib.mjs";

// Populated inside main() so the packaged CLI can normalize argv first.
let outDir, manifest, assetDir, fontDir, HAS_CJK;

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
      const res = await fetch(`${manifest.liveBase}${url}`);
      if (res.ok) writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
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
  const all = [];
  for (const r of d.roots) collectNodes(r, nodes, all);

  const canvas = all.find((n) => n.type === "FRAME") || all.find((n) => n.type === "WEBPAGE");
  if (!canvas) throw new Error(`No canvas frame in ${page.path}`);

  const cb = canvas.absoluteBoundingBox;
  const out = [];
  const ctx = { assetDir, pathToFile, fontStack };
  for (const n of all) {
    if (n === canvas) continue;
    renderNode(n, nodes, cb, out, ctx);
  }

  const bg = fillToCss((canvas.fills || []).find((f) => f.visible)) ?? {};
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
</head>
<body>
  <div class="canvas" style="width:${Math.round(cb.width)}px;height:${Math.round(cb.height)}px;${cssText(bg)}">
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
  HAS_CJK = manifest.pages.some((p) => /[一-鿿]/.test(JSON.stringify(loadData(p.json).nodeById)));
  const { google, selfHost, hasCJK } = planFonts();
  const googleLink = googleFontsLink(google);
  const pathToFile = Object.fromEntries(manifest.pages.map((p) => [p.path, p.file]));

  const sharedCss = `/* Generated replica of ${manifest.liveBase} */
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #fff; font-family: "Inter", system-ui, sans-serif; }
.canvas { position: relative; margin: 0 auto; box-shadow: 0 0 40px rgba(0,0,0,.08); }
.nav-link { text-decoration: none; }
.nav-link:not(.nav-active):hover { text-decoration-line: underline; text-underline-position: from-font; }
.nav-active { cursor: default; }
.line { position: absolute; }
`;
  const extraCss = await selfHostedCss(selfHost);
  writeFileSync(join(outDir, "styles.css"), `${sharedCss}${extraCss ? `\n${extraCss}\n` : ""}`);

  for (const p of manifest.pages) buildPage(p, pathToFile, googleLink, hasCJK);
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
