// scrape.mjs — Download the content of a published Figma Sites site into a
// directory the build step can render from.
//
//   node scrape.mjs <url> [--out <dir>]
//
// <url> must be a published site like https://<name>.figma.site/ (optionally
// with a path). figma.com/site/... and figma.com/design/... are NOT
// supported: the former is not resolvable to the published host, the latter
// needs the Figma API (see the Framelink MCP repo).
//
// Output (default dir "replica-out"):
//   data/<slug>.json      one Figma Sites content file per page
//   assets/<hash>.<ext>   all images/SVGs referenced by the pages
//   manifest.json         page list + titles + site metadata for build.mjs
//
// How the published-site mechanism works (verified on isabella2026.figma.site):
//   - The home page HTML embeds the site build hash: /_json/<uuid>/_index.json.
//   - Every page shares that same hash; the content file for path /foo is at
//     /_json/<hash>/foo.json (home is _index.json).
//   - Each content file carries guidToUrl — a map of root node id -> site path
//     covering every page, so a single fetch yields full page discovery.
//   - Assets are served at /_assets/v11/<hash>.<ext>; some .png-named files
//     are actually JPEG bytes, so extensions are sniffed from magic bytes.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateDesignReport } from "./design-report.mjs";

const CONCURRENCY = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  // Throw instead of process.exit(1): the core path must be callable from the
  // Electron GUI, where exiting would kill the whole app. main() turns the
  // error back into an exit for the CLI.
  throw new Error(msg);
}

// --- URL handling -----------------------------------------------------------

function resolveSiteUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    fail(`Invalid URL: ${raw}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") fail(`URL must be http(s): ${raw}`);
  const host = u.hostname.toLowerCase();
  if (host === "figma.com" || host === "www.figma.com") {
    if (u.pathname.startsWith("/design/"))
      fail("figma.com/design/... files are not supported. Publish the site in Figma, then use the published *.figma.site URL.");
    if (u.pathname.startsWith("/site/"))
      fail("figma.com/site/... URLs are not resolvable to the published host. Open the published site and copy its *.figma.site URL instead.");
    fail("Unsupported figma.com URL. Use a published *.figma.site URL.");
  }
  if (!host.endsWith(".figma.site")) fail(`Not a Figma Sites host: ${host}`);
  return { origin: `${u.protocol}//${u.host}`, host };
}

async function get(url, { asText = true } = {}) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return asText ? res.text() : Buffer.from(await res.arrayBuffer());
}

// --- Magic-byte sniffing ----------------------------------------------------

function sniffExt(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 4 && buf[0] === 0x77 && buf[1] === 0x4f && buf[2] === 0x46 && buf[3] === 0x32) return "woff2";
  const head = buf.subarray(0, Math.min(buf.length, 64)).toString("latin1");
  if (head.startsWith("GIF8")) return "gif";
  if (head.startsWith("RIFF") && head.includes("WEBP")) return "webp";
  if (head.trimStart().startsWith("<svg") || head.trimStart().startsWith("<?xml")) return "svg";
  return null;
}

// --- Page discovery ---------------------------------------------------------

// Extract every site path from a content file's guidToUrl (root id -> path).
function pathsFromData(d) {
  const paths = new Set();
  for (const p of Object.values(d.guidToUrl || {})) if (typeof p === "string" && p.startsWith("/")) paths.add(p);
  return [...paths].sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)));
}

// Fallback when a site has no guidToUrl: BFS over nav interactions.
function crawlPaths(homeData) {
  const found = new Set(["/"]);
  const queue = [homeData];
  while (queue.length) {
    const d = queue.shift();
    for (const n of Object.values(d.nodeById || {})) {
      for (const it of n.interactions || []) {
        if (it.event?.interactionType !== "ON_CLICK") continue;
        for (const a of it.actions || []) {
          if (a.connectionType === "INTERNAL_NODE" && a.navigationType === "NAVIGATE" && a.connectionURL?.startsWith("/") && !found.has(a.connectionURL)) {
            found.add(a.connectionURL);
            queue.push(d);
          }
        }
      }
    }
  }
  return [...found].sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)));
}

const slugFor = (path) => (path === "/" ? "index" : path.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9_\-]/g, "-"));

// --- Asset download ---------------------------------------------------------

async function runPool(items, worker) {
  const out = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await worker(items[idx], idx);
      } catch (e) {
        out[idx] = { error: e.message };
      }
    }
  });
  await Promise.all(runners);
  return out;
}

// Core entry shared by the CLI (main) and the Electron GUI. Progress is
// reported through console.log/console.warn, which the GUI intercepts.
export async function scrapeSite(outDir, urlArg) {
  if (!urlArg) throw new Error("Usage: node scrape.mjs <url> [--out <dir>]");
  const { origin } = resolveSiteUrl(urlArg);
  console.log(`▸ Scraping ${origin}`);

  // 1. Home HTML -> site build hash -> home content file.
  let homeHtml;
  try {
    homeHtml = await get(`${origin}/`);
  } catch (e) {
    fail(`Could not fetch ${origin}/ — is the site published? (${e.message})`);
  }
  const hashMatch = homeHtml.match(/\/_json\/([a-f0-9-]{36})\//);
  if (!hashMatch) fail(`Could not find the site build hash in ${origin}/ (looked for /_json/<uuid>/).`);
  const siteHash = hashMatch[1];
  console.log(`▸ site hash ${siteHash}`);

  const getData = async (slug) => {
    const file = slug === "index" ? "_index.json" : `${slug}.json`;
    return JSON.parse(await get(`${origin}/_json/${siteHash}/${file}`));
  };

  const homeData = await getData("index");
  const siteTitle = homeData.siteSettings?.title || hostFromOrigin(origin);
  const paths = pathsFromData(homeData).length ? pathsFromData(homeData) : crawlPaths(homeData);

  // 2. Fetch every page's content file + HTML <title>.
  mkdirSync(join(outDir, "data"), { recursive: true });
  const pages = [];
  for (const p of paths) {
    const slug = slugFor(p);
    const file = `${slug}.html`;
    const json = `data/${slug}.json`;
    const href = p === "/" ? `${origin}/` : `${origin}${p}`;
    try {
      const html = await get(href);
      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : siteTitle;
      const data = await getData(slug);
      writeFileSync(join(outDir, json), JSON.stringify(data));
      pages.push({ path: p, slug, file, title, json });
      console.log(`  ✓ ${p} (${Object.keys(data.nodeById).length} nodes)`);
    } catch (e) {
      console.warn(`  ⚠ ${p} skipped: ${e.message}`);
    }
  }
  if (!pages.length) fail("No pages could be fetched.");

  // 3. Collect + download all assets referenced by the pages.
  const allHashes = new Map(); // hash -> preferred ext from assets map
  const assetInfo = new Map(); // hash -> { url, size } from assets map
  for (const p of pages) {
    const data = JSON.parse(readFileSync(join(outDir, p.json)));
    for (const [h, info] of Object.entries(data.assets || {})) {
      allHashes.set(h, info.url?.split(".").pop() || "png");
      assetInfo.set(h, info);
    }
    for (const n of Object.values(data.nodeById || {})) {
      if (n.hash) allHashes.set(n.hash, null);
      for (const f of n.fills || []) if (f.type === "IMAGE" && f.imageRef) allHashes.set(f.imageRef, null);
    }
  }
  mkdirSync(join(outDir, "assets"), { recursive: true });
  const entries = [...allHashes].map(([hash, ext]) => ({ hash, ext }));
  let downloaded = 0, failedAssets = 0;
  const results = await runPool(entries, async ({ hash, ext }) => {
    const guess = ext || "png";
    let buf;
    try {
      buf = await get(`${origin}/_assets/v11/${hash}.${guess}`, { asText: false });
    } catch {
      // Some assets only exist under a different extension.
      for (const alt of ["png", "jpg", "svg", "webp", "gif"]) {
        if (alt === guess) continue;
        try {
          buf = await get(`${origin}/_assets/v11/${hash}.${alt}`, { asText: false });
          break;
        } catch {
          /* try next */
        }
      }
      if (!buf) return { hash, error: "not found" };
    }
    const real = sniffExt(buf) || guess;
    writeFileSync(join(outDir, "assets", `${hash}.${real}`), buf);
    return { hash, real };
  });
  for (const r of results) {
    if (r.error) { failedAssets++; console.warn(`  ⚠ asset ${r.hash}: ${r.error}`); }
    else downloaded++;
  }
  console.log(`  ✓ assets: ${downloaded} downloaded${failedAssets ? `, ${failedAssets} failed` : ""}`);

  // 4. Manifest for the build step.
  const manifest = { liveBase: origin, siteHash, siteTitle, pages, generatedAt: new Date().toISOString() };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // 5. Design report: aggregate all page node data into design tokens + layout
  // patterns the AI agent reads before editing (see design-report.mjs).
  try {
    const pageData = pages.map((p) => JSON.parse(readFileSync(join(outDir, p.json), "utf8")));
    generateDesignReport(pageData, outDir);
    console.log("  ✓ design-report.md + design-report.json");
  } catch (e) {
    console.warn(`  ⚠ design report failed: ${e.message}`);
  }

  console.log(`\n✅ Scraped ${pages.length} pages into ${outDir}/`);
  console.log(`   Next: node build.mjs --out ${outDir}`);
}

export async function main() {
  // Parse argv here (not at module top level) so the packaged CLI can
  // normalize process.argv before delegating to this function.
  const args = process.argv.slice(2);
  const urlArg = args.find((a) => !a.startsWith("--"));
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : "replica-out";
  try {
    await scrapeSite(outDir, urlArg);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}

function hostFromOrigin(origin) {
  return origin.replace(/^https?:\/\//, "").replace(/\.figma\.site$/, "");
}

// Only auto-run when invoked directly (node scrape.mjs). When imported as a
// module by the packaged CLI (cli.mjs), the dispatcher calls main() itself.
// No top-level await: keeps the module bundleable to CommonJS for Node SEA.
if (process.argv[1]?.endsWith("scrape.mjs")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
