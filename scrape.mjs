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
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { httpFetch } from "./netfetch.mjs";
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

async function get(url, { asText = true, timeoutMs = 45000 } = {}) {
  // httpFetch,不是全局 fetch:在 GUI 里它是 Electron 的 net.fetch,走 Chromium
  // 网络栈,因此**遵循系统代理**;Node 自己的 fetch 不读注册表里的系统代理,
  // 于是开着 VPN(代理模式)时浏览器能打开 figma.site、抓取却超时。详见 netfetch.mjs。
  //
  // **必须带超时。** 之前这里是裸的 httpFetch,遇到"连上了但服务器不回"的连接
  // 就**永远挂住** —— 用户看到的就是"抓取到某一步之后很久没动静"。
  // 45 秒对 HTML/JSON 足够;资源文件走下面的分块下载,各有自己的计时。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await httpFetch(url, { redirect: "follow", signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error(`${Math.round(timeoutMs / 1000)} 秒没有响应 for ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // Attach the status so callers can tell a definitive 4xx (missing file,
    // no point retrying) from a transient 5xx/network error (retry helps).
    const err = new Error(`${res.status} ${res.statusText} for ${url}`);
    err.status = res.status;
    throw err;
  }
  return asText ? res.text() : Buffer.from(await res.arrayBuffer());
}

// 资源扩展名。站点的 url 字段**有时没有扩展名**(VIDEO_ASSET 就是这样),那时
// `url.split(".").pop()` 会把整个 hash 当成扩展名,拼出一个必然 404 的 URL。
// 所以先看 url,再退回 format / type。
const KNOWN_EXT = new Set(["png", "jpg", "jpeg", "svg", "webp", "gif", "mp4", "webm", "woff2"]);
export function extOfAsset(info) {
  const raw = String(info?.url || "");
  const dot = raw.lastIndexOf(".");
  const ext = dot > 0 ? raw.slice(dot + 1).toLowerCase() : "";
  if (KNOWN_EXT.has(ext)) return ext;
  const fmt = String(info?.format || "").toUpperCase();
  if (fmt === "SVG") return "svg";
  if (fmt === "PNG") return "png";
  if (fmt === "JPG" || fmt === "JPEG") return "jpg";
  if (fmt === "WEBP") return "webp";
  if (String(info?.type || "").toUpperCase().includes("VIDEO")) return "mp4";
  return "png";
}

// 逐个尝试的候选扩展名 —— 视频也要试,站点里确实会出现 VIDEO_ASSET。
const ALT_EXTS = ["png", "jpg", "svg", "webp", "gif", "mp4", "webm", "jpeg"];

// 取一个资源,带重试 + 超时。
// 实测(lily2026new):同一个 URL 会时而 200、时而 `fetch failed`(连接被重置),
// 所以**连接级错误必须重试**;明确的 4xx 直接放弃,别浪费时间。
async function fetchAsset(url, attempts = 3, timeoutMs = 60000) {
  for (let t = 1; t <= attempts; t++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await httpFetch(url, { redirect: "follow", signal: ctrl.signal });
      if (res.status >= 400 && res.status < 500) return null; // 确实不在服务器上
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch {
      if (t === attempts) return null;
      // 退避 + 抖动:避免并发任务同时重试又一起打回去
      await sleep(400 * t + Math.floor(Math.random() * 300));
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
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

  // **远端 JSON 的路径必须用页面的真实路径,不能用本地文件名。**
  // slugFor() 会把非字母数字换成 "-",这是给**本地文件**用的(中文文件名在
  // Windows/CI 上很容易出问题);但远端的 JSON 就存在真实路径下 ——
  // 实测 thomas2026: /疍家人的生活和故事 → _json/<hash>/疍家人的生活和故事.json 是 200,
  // 而 /---------.json 是 404。两者混用会静默丢掉所有中文路径的页面。
  const getData = async (pagePath) => {
    const p = String(pagePath || "/");
    const rel = p === "/" ? "_index.json" : `${p.replace(/^\/+/, "")}.json`;
    return JSON.parse(await get(`${origin}/_json/${siteHash}/${rel}`));
  };

  const homeData = await getData("/");
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
      const data = await getData(p);
      writeFileSync(join(outDir, json), JSON.stringify(data));
      pages.push({ path: p, slug, file, title, json });
      console.log(`  ✓ ${p} (${Object.keys(data.nodeById).length} nodes)`);
    } catch (e) {
      console.warn(`  ⚠ ${p} skipped: ${e.message}`);
    }
  }
  if (!pages.length) fail("No pages could be fetched.");

  // 3. Collect + download all assets referenced by the pages.
  //
  // 两张表回答不同的问题,别混用:
  //   hinted : hash -> 站点 assets 表声明的扩展名/信息
  //   needed : **节点真正引用**的 hash(node.hash 或 IMAGE 填充的 imageRef)
  // assets 表会把站点里所有资源都列出来,包括没有任何节点用的;下载它们既浪费
  // 带宽,又会让"失败计数"里混进永远不可能出现在页面上的资源。
  const hinted = new Map();
  const needed = new Set();
  // VIDEO 填充的视频在**另一条 URL 路径**上(/_videos/v1/<videoRef>),不在
  // /_assets/v11/ —— 只顺着 imageRef 走的话视频永远不会被下载,页面上只剩一个空框
  // (实测 germanschoolhistories 的 2:1915:线上 760x427 的 <video>,本地什么都没有)。
  const neededVideos = new Set();
  for (const p of pages) {
    const data = JSON.parse(readFileSync(join(outDir, p.json)));
    for (const [h, info] of Object.entries(data.assets || {})) hinted.set(h, { ext: extOfAsset(info), info });
    for (const n of Object.values(data.nodeById || {})) {
      if (n.hash) needed.add(n.hash);
      for (const f of n.fills || []) {
        if (f.type === "IMAGE" && f.imageRef) needed.add(f.imageRef);
        if (f.type === "VIDEO" && f.videoRef) neededVideos.add(f.videoRef);
      }
    }
  }
  mkdirSync(join(outDir, "assets"), { recursive: true });
  // 旧代码用 `allHashes.set(n.hash, null)` 覆盖了 assets 表里已经知道的扩展名,
  // 于是**每个被引用的资源都先按 .png 去猜**,svg/video 全靠 alt 探测兜。
  const entries = [...new Set([...needed, ...hinted.keys()])].map((hash) => ({
    hash,
    ext: hinted.get(hash)?.ext || "png",
    referenced: needed.has(hash),
  }));
  let downloaded = 0, unusedMissing = 0;
  const failedAssets = [];
  const results = await runPool(entries, async ({ hash, ext, referenced }) => {
    // 实测:同一个 URL 会时而成功、时而 `fetch failed`(连接被重置)。所以
    // **主扩展和 alt 探测都要重试** —— 旧代码只在主扩展上重试,alt 探测是一次性的,
    // 一次连接重置就把资源永久判死,而磁盘上可能连旧文件都没有。
    // 明确的 4xx 才立即放弃(那是真的不在服务器上)。
    for (const e of [ext, ...ALT_EXTS.filter((x) => x !== ext)]) {
      const buf = await fetchAsset(`${origin}/_assets/v11/${hash}.${e}`);
      if (!buf) continue;
      const real = sniffExt(buf) || e;
      writeFileSync(join(outDir, "assets", `${hash}.${real}`), buf);
      return { hash, real, referenced };
    }
    return { hash, error: "download failed", referenced };
  });
  // 磁盘上可能已经有上一次抓取留下的文件:本次下载失败但文件在,页面照样正常。
  // 把它和"真的缺了"分开报,否则重跑一次抓取就会刷出一堆假告警。
  const onDisk = new Set();
  for (const f of readdirSync(join(outDir, "assets"))) onDisk.add(f.split(".")[0]);
  let reused = 0;
  for (const r of results) {
    if (!r.error) {
      downloaded++;
    } else if (!r.referenced) {
      // 站点 assets 表里有、但没有页面引用 —— 不下也不影响页面
      unusedMissing++;
    } else if (onDisk.has(r.hash)) {
      reused++;
    } else {
      failedAssets.push(r.hash);
    }
  }
  for (const h of failedAssets) console.warn(`  ⚠ 资源 ${h} 下载失败(页面在用;重跑一次抓取通常即可)`);
  const tail = [
    failedAssets.length ? `${failedAssets.length} 失败` : "",
    reused ? `${reused} 沿用已有文件` : "",
    unusedMissing ? `${unusedMissing} 未使用(无页面引用)` : "",
  ].filter(Boolean);
  console.log(`  ✓ assets: ${downloaded} downloaded${tail.length ? `, ${tail.join(", ")}` : ""}`);

  // 视频:走 /_videos/v1/<ref>,落地成 assets/<ref>.mp4(带扩展名,浏览器才能从
  // 名字/内容判定 MIME;原来的 assets 表 url 是**没有扩展名**的)。
  let videoOk = 0;
  const failedVideos = [];
  for (const ref of neededVideos) {
    const dest = join(outDir, "assets", `${ref}.mp4`);
    if (existsSync(dest)) { videoOk++; continue; }
    const buf = await fetchAsset(`${origin}/_videos/v1/${ref}`);
    if (buf) { writeFileSync(dest, buf); videoOk++; } else failedVideos.push(ref);
  }
  if (neededVideos.size) {
    console.log(`  ✓ videos: ${videoOk}/${neededVideos.size} downloaded${failedVideos.length ? `, ${failedVideos.length} 失败` : ""}`);
    for (const r of failedVideos) console.warn(`  ⚠ 视频 ${r} 下载失败(页面在用;重跑一次抓取通常即可)`);
  }

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
