// publish.mjs — Deploy a generated static replica to a 1Panel server.
//
// 1Panel (newer builds) exposes an OpenAI-style REST API under /api/v2 that
// authenticates with a per-request HMAC signature rather than a login session:
//   token = md5("1panel" + apiKey + timestamp)
// sent as the 1Panel-Token / 1Panel-Timestamp headers. The contract below was
// reverse-checked against the working `1panel-cli` package (create body, upload
// multipart fields, sitePath→"index" root mapping), so it is not guessed.
//
// Flow: sign → probe API prefix (v2, fallback v1) → find the site by domain or
// create a static one → upload every deployable file (html/css/assets/fonts)
// into <sitePath>/index with overwrite. Build metadata (data/, manifest.json,
// overlay json) is deliberately excluded — it is build input, not served files.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep, basename } from "node:path";
import { join as posixJoin } from "node:path/posix";

const UPLOAD_CONCURRENCY = 4;

// Top-level output-dir entries that are build metadata, never deployed. Mirrors
// the WRITE_DENY list in ai.mjs — these are inputs/overlay sources, not files
// the static site serves.
const SKIP_NAMES = new Set(["data", "manifest.json", "edits.json", "nodeStyles.json", "overrides.json", "wordclouds.json", "file-locks.json"]);

// --- Auth --------------------------------------------------------------------

export function signHeaders(apiKey, timestamp) {
  const ts = timestamp ?? Math.floor(Date.now() / 1000).toString();
  const token = createHash("md5").update(`1panel${apiKey}${ts}`).digest("hex");
  return { "1Panel-Token": token, "1Panel-Timestamp": ts };
}

function authHeaders(apiKey) {
  return { ...signHeaders(apiKey), "Accept-Language": "zh" };
}

// --- Low-level request -------------------------------------------------------

// Send an authenticated request to <base><path>. `multipart` is a FormData body
// (its boundary/Content-Type is set by fetch); otherwise `body` is JSON-serialized.
export async function panelFetch(baseUrl, apiKey, path, { method = "GET", body, multipart, signal } = {}) {
  const headers = authHeaders(apiKey);
  let payload;
  if (multipart) {
    payload = multipart;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload, signal });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const label = { 401: "API Key 无效", 403: "无权限", 404: "接口不存在" }[res.status];
    throw new Error(`${label || `1Panel 错误 ${res.status}`} (${path})${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
  }
  const data = await res.json().catch(() => null);
  // The panel answers business failures with HTTP 200 + {code: 400, message} —
  // a non-200 code is still a failure and must surface, not be swallowed.
  if (data && typeof data === "object" && typeof data.code === "number" && data.code !== 200) {
    throw new Error(`1Panel 错误 (${path}) — ${data.message || `code ${data.code}`}`);
  }
  return data;
}

function unwrap(res) {
  if (Array.isArray(res)) return res;
  const d = res?.data;
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.items)) return d.items;
  if (Array.isArray(res?.items)) return res.items;
  return [];
}

// Pick /api/v2 unless the panel 404s that route (old panel) — any auth/server
// error means the route exists, so v2 stays. Returns the full base URL (origin
// + prefix) so callers can hand it straight to panelFetch.
export async function detectApiBase(baseUrl, apiKey, signal) {
  const origin = String(baseUrl).trim().replace(/\/+$/, "");
  const probe = await fetch(`${origin}/api/v2/websites/list`, {
    method: "GET",
    headers: authHeaders(apiKey),
    signal,
  });
  return `${origin}${probe.status === 404 ? "/api/v1" : "/api/v2"}`;
}

// --- Websites ----------------------------------------------------------------

async function searchWebsites(base, key, signal) {
  return panelFetch(base, key, "/websites/search", {
    method: "POST",
    body: { name: "", page: 1, pageSize: 999999, orderBy: "created_at", order: "null", websiteGroupId: 0, type: "" },
    signal,
  });
}

// The paginated search carries `sitePath` (which the flat /websites/list omits
// on newer panels) — sitePath is required to map a site to its on-disk root, so
// search is the primary source and list is only a fallback for panels without it.
async function listWebsites(base, key, signal) {
  try {
    return unwrap(await searchWebsites(base, key, signal));
  } catch {
    return unwrap(await panelFetch(base, key, "/websites/list", { signal }));
  }
}

function domainMatches(site, domain) {
  const names = [site?.primaryDomain, site?.domain, site?.alias, ...(Array.isArray(site?.domains) ? site.domains.map((d) => (typeof d === "string" ? d : d?.domain)) : [])].filter(Boolean);
  return names.includes(domain);
}

export async function findWebsite(base, key, domain, signal) {
  const list = await listWebsites(base, key, signal);
  return list.find((w) => domainMatches(w, domain)) || null;
}

export async function createStaticSite(base, key, { domain, alias, groupID }, signal) {
  await panelFetch(base, key, "/websites", {
    method: "POST",
    body: {
      type: "static",
      alias: alias || domain,
      webSiteGroupID: groupID || 1,
      IPV6: false,
      AppType: "new",
      domains: [{ domain, port: 80, ssl: false }],
      ftpUser: "",
      ftpPassword: "",
      siteDir: "",
    },
    signal,
  });
  const site = await findWebsite(base, key, domain, signal);
  if (!site) throw new Error("网站已创建但未能查询到,请稍后在 1Panel 中确认");
  return site;
}

// Find the static site by domain, creating it when missing. Returns its root
// directory (1Panel serves a static site from <sitePath>/index) plus the raw
// sitePath. Remote paths are joined with "/" (Linux), never the local separator.
export async function ensureSite(base, key, { domain, alias, groupID }, signal) {
  let site = await findWebsite(base, key, domain, signal);
  let created = false;
  if (!site) {
    site = await createStaticSite(base, key, { domain, alias, groupID }, signal);
    created = true;
  }
  if (!site?.sitePath) throw new Error("无法获取网站的物理路径(sitePath)");
  return { site, created, root: posixJoin(site.sitePath, "index") };
}

// --- Files -------------------------------------------------------------------

// List the deployable files under outDir: every file except top-level build
// metadata. relPath uses "/" so it slots directly into remote target dirs.
export function collectDeployFiles(outDir) {
  const files = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      if (!prefix && SKIP_NAMES.has(name)) continue;
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else files.push({ localPath: full, relPath: rel });
    }
  };
  walk(outDir, "");
  return files;
}

// Upload one file into the (server-side) targetDir, overwriting if present.
// `path` may not exist yet — 1Panel creates it on upload.
export async function uploadFile(base, key, localPath, targetDir, signal) {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(localPath)]), basename(localPath));
  form.append("path", targetDir);
  form.append("overwrite", "True");
  await panelFetch(base, key, "/files/upload", { method: "POST", multipart: form, signal });
}

// --- Orchestration -----------------------------------------------------------

export async function publishSite({ baseUrl, apiKey, outDir, domain, alias, groupID, onLog, signal }) {
  if (!baseUrl || !apiKey) throw new Error("请先在发布设置里填写服务器地址与 API Key");
  if (!domain) throw new Error("请填写要发布到的域名");
  const log = onLog || (() => {});
  const base = await detectApiBase(baseUrl, apiKey, signal);
  log(`已连接 ${baseUrl}(1Panel API ${base})`);
  const { site, created, root } = await ensureSite(base, apiKey, { domain, alias, groupID }, signal);
  log(created ? `已自动创建静态网站「${domain}」` : `已找到网站「${domain}」`);
  log(`站点根目录: ${root}`);
  const files = collectDeployFiles(outDir);
  if (!files.length) throw new Error("输出目录里没有可发布的文件");
  log(`待上传 ${files.length} 个文件…`);
  let uploaded = 0;
  const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, async () => {
    while (files.length) {
      const { localPath, relPath } = files.shift();
      const targetDir = posixJoin(root, relPath.split("/").slice(0, -1).join("/"));
      await uploadFile(base, apiKey, localPath, targetDir, signal);
      uploaded++;
      log(`↑ ${relPath}`);
    }
  });
  await Promise.all(workers);
  log(`✅ 发布完成,共上传 ${uploaded} 个文件`);
  return { uploaded, root, created };
}

// Lightweight check for the GUI "测试连接" button: verifies the API key and
// reports whether the site already exists.
export async function testPanel({ baseUrl, apiKey, domain, signal }) {
  const base = await detectApiBase(baseUrl, apiKey, signal);
  const site = domain ? await findWebsite(base, apiKey, domain, signal) : null;
  return { base, found: !!site, root: site?.sitePath ? posixJoin(site.sitePath, "index") : null };
}
