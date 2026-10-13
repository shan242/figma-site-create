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
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, sep, basename } from "node:path";
import { join as posixJoin } from "node:path/posix";
import { httpFetch } from "./netfetch.mjs";

const UPLOAD_CONCURRENCY = 4;

// Top-level output-dir entries that are build metadata, never deployed. Mirrors
// the WRITE_DENY list in ai.mjs — these are inputs/overlay sources, not files
// the static site serves.
const SKIP_NAMES = new Set(["data", "manifest.json", "edits.json", "nodeStyles.json", "overrides.json", "wordclouds.json", "file-locks.json", "videos.json", "databinds.json", "chat-history.json", ".history"]);

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

export async function publishSite({ baseUrl, apiKey, outDir, domain, alias, groupID, https, dataApi, dataToken, onLog, signal }) {
  if (!baseUrl || !apiKey) throw new Error("请先在发布设置里填写服务器地址与 API Key");
  if (!domain) throw new Error("请填写要发布到的域名");
  const log = onLog || (() => {});
  // **前置提醒**:页面用了数据后端却没配后端地址。必须在**上传之前**说,
  // 否则一旦静态上传先失败,这条提示根本跑不到,用户什么也看不到。
  // 后端对没注册过的站点一律回 SITE_NOT_FOUND("站点未注册,请先在软件中发布一次"),
  // 而页面上只表现为"投票点了没反应" —— 实测用户就是这么卡住的。
  if (!dataApi && outDir && Object.keys(collectionsFromDatabinds(outDir)).length) {
    log("⚠ 这个页面对接了数据后端(bind_data),但发布设置里没填「数据后端地址」——");
    log("   站点不会注册到后端,投票/词云/留言会全部失败(后端返回 SITE_NOT_FOUND)。");
    log("   请到「发布设置 → 数据后端」填地址与 Admin Token 后重新发布。");
  }
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

  // **发布后验证**:文件传上去了 ≠ 访客看到的是新的。
  // 这一轮踩过两次同类问题 —— 静态托管的 max-age 很长,CDN 还按 Accept-Encoding
  // 分开缓存,于是"服务器上是新文件、浏览器拿到的是旧的"。所以传完立刻回读一次,
  // 核对版本串是否与刚构建的一致。不一致不要当成失败(缓存要时间),但要**说出来**,
  // 否则用户只会看到"改了没生效"而不知道该等或该清缓存。
  let verify = null;
  try {
    const localIdx = join(outDir, "index.html");
    if (existsSync(localIdx)) {
      const localHtml = readFileSync(localIdx, "utf8");
      const wantVer = (/styles\.css\?v=([a-f0-9]+)/.exec(localHtml) || [])[1] || null;
      const origin = `https://${domain}`;
      const res = await httpFetch(`${origin}/?t=${Date.now()}`, { redirect: "follow" });
      if (!res.ok) {
        verify = { ok: false, reason: `线上返回 HTTP ${res.status}` };
      } else {
        const live = await res.text();
        const gotVer = (/styles\.css\?v=([a-f0-9]+)/.exec(live) || [])[1] || null;
        if (wantVer && gotVer && wantVer !== gotVer) {
          verify = { ok: false, want: wantVer, got: gotVer, reason: "线上还是旧版本" };
        } else {
          // 再确认样式表本身真的取得到(曾经出现 HTML 是新的、CSS 命中旧缓存)
          const cssRes = await httpFetch(`${origin}/styles.css?v=${gotVer || ""}&t=${Date.now()}`, { redirect: "follow" });
          verify = cssRes.ok ? { ok: true, version: gotVer } : { ok: false, reason: `styles.css 返回 HTTP ${cssRes.status}` };
        }
      }
    }
  } catch (e) {
    verify = { ok: false, reason: e.message };
  }
  if (verify) {
    if (verify.ok) log(`✅ 线上验证通过(index.html 与 styles.css 都是刚发布的那份,版本 ${verify.version || "(无版本串)"})`);
    else if (verify.want && verify.got) log(`⚠ 线上还是旧版本(线上 ${verify.got},刚发布的是 ${verify.want})——多半是 CDN 缓存,清一次缓存或等几分钟。`);
    else log(`⚠ 发布后验证没通过: ${verify.reason}。静态文件已经传上去了,如果浏览器看着不对,先强刷(Ctrl+Shift+R)或清一次 CDN 缓存。`);
  }
  // Optional second phase: make https://<domain> work. Reuses the certificate
  // and accounts already configured in the panel (see ensureHttps).
  let httpsResult = null;
  if (https?.enabled) {
    log("— 配置 HTTPS —");
    httpsResult = await ensureHttps({ ...https, base, baseUrl, apiKey, domain, onLog: log, signal });
  }
  // 数据后端:把域名白名单 + 集合声明同步过去,页面里的绑定才能读写。
  // 只动数据后端,不碰 1Panel 上的任何站点文件。
  let dataResult = null;
  if (dataApi) {
    log("— 注册数据后端 —");
    try {
      dataResult = await registerSite({ dataApi, adminToken: dataToken, domain, outDir, signal });
      if (dataResult) {
        const cols = Object.keys(dataResult.collections);
        log(`✅ 数据站点 ${dataResult.site}(来源 ${dataResult.origins.join(", ")}${cols.length ? `;集合 ${cols.join(", ")}` : ""})`);
      }
    } catch (e) {
      // 静态站点已经发布成功,数据注册失败不该让整次发布算失败。
      dataResult = { error: e.message };
      log(`⚠ 数据后端注册失败: ${e.message}(静态站点已发布,可稍后重试)`);
    }
  } else if (outDir && Object.keys(collectionsFromDatabinds(outDir)).length) {
    // **页面用了 bind_data,但没配数据后端** —— 这时候必须说话。
    // 后端对没注册过的站点一律回 SITE_NOT_FOUND("站点未注册,请先在软件中发布一次"),
    // 而页面上只会看到投票点了没反应。实测用户就是这么卡住的:站点没注册,
    // 他以为是词云坏了,查了很久才发现要在发布流程里带上后端配置。
    dataResult = { error: "未配置数据后端" };
    log("⚠ 这个页面对接了数据后端(bind_data),但发布设置里没填「数据后端地址」——");
    log("   站点不会注册到后端,页面上的投票/词云/留言会全部失败(后端返回 SITE_NOT_FOUND)。");
    log("   请在「发布设置 → 数据后端」填写地址与 Admin Token 后重新发布。");
  }
  return { uploaded, root, created, https: httpsResult, data: dataResult };
}

// Lightweight check for the GUI "测试连接" button: verifies the API key and
// reports whether the site already exists.
export async function testPanel({ baseUrl, apiKey, domain, signal }) {
  const base = await detectApiBase(baseUrl, apiKey, signal);
  const site = domain ? await findWebsite(base, apiKey, domain, signal) : null;
  return { base, found: !!site, root: site?.sitePath ? posixJoin(site.sitePath, "index") : null };
}

// --- ACME / DNS accounts -----------------------------------------------------
// Read-only. The panel owns these credentials (DNS provider keys, CA accounts);
// the app only lists them so the user can pick one — it never stores or sends
// provider secrets itself.

export async function listAcmeAccounts(base, key, signal) {
  return unwrap(
    await panelFetch(base, key, "/websites/acme/search", {
      method: "POST",
      body: { page: 1, pageSize: 999999 },
      signal,
    }),
  );
}

export async function listDnsAccounts(base, key, signal) {
  return unwrap(
    await panelFetch(base, key, "/websites/dns/search", {
      method: "POST",
      body: { page: 1, pageSize: 999999 },
      signal,
    }),
  );
}

// --- Certificates ------------------------------------------------------------

export async function listSsls(base, key, signal) {
  return unwrap(
    await panelFetch(base, key, "/websites/ssl/search", {
      method: "POST",
      body: { page: 1, pageSize: 999999 },
      signal,
    }),
  );
}

// A certificate covers a primary domain plus comma-separated `domains`.
export function sslDomainMatches(ssl, domain) {
  const names = [ssl?.primaryDomain, ...String(ssl?.domains || "").split(",")]
    .map((d) => String(d || "").trim())
    .filter(Boolean);
  return names.includes(domain);
}

export async function findSslByDomain(base, key, domain, signal) {
  const list = await listSsls(base, key, signal);
  return list.find((s) => sslDomainMatches(s, domain)) || null;
}

// Some endpoints answer with the record directly, others wrap it in { data }.
const record = (res) => (res && typeof res === "object" && "data" in res ? res.data : res);

export async function getSsl(base, key, id, signal) {
  return record(await panelFetch(base, key, `/websites/ssl/${id}`, { signal }));
}

// Create the certificate RECORD for `primaryDomain` using the ACME account and
// (for DNS validation) the DNS account already configured in the panel.
// provider selects how the domain is validated:
//   dnsAccount — the panel writes the _acme-challenge TXT through the DNS
//                account's API (fully automatic, no inbound port needed)
//   dnsManual  — the panel prints the TXT record for the user to add by hand
//   http       — the CA fetches http://<domain>/.well-known/acme-challenge/…
export async function createSsl(
  base,
  key,
  { acmeAccountId, primaryDomain, otherDomains, provider = "dnsAccount", dnsAccountId, keyType = "P256", autoRenew = true, apply = false, skipDNS = false, nameserver1, nameserver2, description },
  signal,
) {
  await panelFetch(base, key, "/websites/ssl", {
    method: "POST",
    body: {
      acmeAccountId,
      primaryDomain,
      otherDomains: otherDomains || "",
      provider,
      dnsAccountId: provider === "dnsAccount" ? dnsAccountId : 0,
      keyType,
      autoRenew,
      apply,
      skipDNS,
      nameserver1: nameserver1 || "",
      nameserver2: nameserver2 || "",
      description: description || "",
      pushDir: false,
      execShell: false,
      disableCNAME: false,
    },
    signal,
  });
  const ssl = await findSslByDomain(base, key, primaryDomain, signal);
  if (!ssl) throw new Error("证书已创建但未能查询到,请稍后在 1Panel 中确认");
  return ssl;
}

// Kick off the ACME challenge for a certificate record. For dnsAccount/http the
// create call can pass `apply: true` instead; dnsManual must create first, let
// the user add the TXT record, then call this.
export async function applySsl(base, key, id, { skipDNSCheck = false, nameservers } = {}, signal) {
  await panelFetch(base, key, "/websites/ssl/obtain", {
    method: "POST",
    body: { ID: Number(id), skipDNSCheck, ...(nameservers?.length ? { nameservers } : {}) },
    signal,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Does this record prove the certificate exists?
//
// `status` is authoritative (the backend runs init → applying → ready, and
// applyError on failure). Older panels omit it, and there the only signal is
// `expireDate` — which the backend SEEDS TO time.Now() at creation and only
// overwrites with the real cert.NotAfter once issuance succeeds. So a value
// merely near "now" must never count as issued: doing that made the app enable
// HTTPS a second after applying, and the panel answered
// "证书文件异常，请检查证书状态！". A real certificate is ~90 days out.
export function sslLooksIssued(ssl) {
  if (ssl?.status) return ssl.status === "ready";
  const pem = ssl?.pem;
  if (typeof pem === "string" && pem.includes("BEGIN CERTIFICATE")) return true;
  const t = Date.parse(ssl?.expireDate || "");
  return Number.isFinite(t) && t - Date.now() > 6 * 3600 * 1000;
}

// Poll until the certificate is issued. Applying over DNS takes real time: the
// backend runs the ACME order (writing the TXT record, waiting for propagation,
// then fetching the cert) before it flips the status to ready.
export async function pollSslUntilIssued(base, key, id, { timeoutMs = 180000, intervalMs = 3000, onLog, signal } = {}) {
  const log = onLog || (() => {});
  const deadline = Date.now() + timeoutMs;
  let last = "";
  let reported = "";
  for (;;) {
    const ssl = await getSsl(base, key, id, signal);
    if (sslLooksIssued(ssl)) return ssl;
    const status = ssl?.status;
    // A hard failure must surface at once rather than burning the whole timeout.
    if (status === "applyError" || status === "error") {
      throw new Error(`证书申请失败${ssl?.message ? `: ${ssl.message}` : "(1Panel 未返回原因,请在面板中查看证书日志)"}`);
    }
    last = ssl?.message || last;
    if (last && last !== reported) {
      reported = last;
      log(`  ${last}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`证书申请超时(${Math.round(timeoutMs / 1000)} 秒,当前状态 ${status || "未知"})${last ? ` — ${last}` : ""}`);
    }
    await sleep(intervalMs);
  }
}

// --- Website HTTPS -----------------------------------------------------------

export async function getWebsiteHttps(base, key, websiteId, signal) {
  return record(await panelFetch(base, key, `/websites/${websiteId}/https`, { signal }));
}

// Bind `websiteSSLId` to the site and turn HTTPS on. `type: "existed"` means
// "use this certificate record"; SSLProtocol/algorithm are passed through from
// the site's current config so the panel's own TLS defaults are preserved.
export async function enableHttps(
  base,
  key,
  { websiteId, websiteSSLId, httpConfig = "HTTPToHTTPS", hsts = false, SSLProtocol, algorithm },
  signal,
) {
  await panelFetch(base, key, `/websites/${websiteId}/https`, {
    method: "POST",
    body: {
      websiteId,
      type: "existed",
      websiteSSLId: Number(websiteSSLId),
      enable: true,
      httpConfig,
      hsts: !!hsts,
      SSLProtocol: SSLProtocol?.length ? SSLProtocol : ["TLSv1.2", "TLSv1.3"],
      algorithm: algorithm || "",
    },
    signal,
  });
}

// Bind + enable, retrying a few times. Even once the record reads `ready` the
// panel can momentarily answer "证书文件异常，请检查证书状态！" while the nginx
// config picks the freshly written files up, so a couple of spaced retries turn
// a transient panel-side race into a success instead of a failed publish.
export async function enableHttpsResilient(base, key, opts, { attempts = 5, initialDelayMs = 2000, sleepFn = sleep, onLog, signal } = {}) {
  const log = onLog || (() => {});
  let delay = initialDelayMs;
  for (let i = 1; ; i++) {
    try {
      return await enableHttps(base, key, opts, signal);
    } catch (e) {
      if (i >= attempts || signal?.aborted) throw e;
      const why = String(e.message).replace(/^1Panel 错误 \([^)]*\) — /, "").slice(0, 70);
      log(`  ${why} — ${Math.round(delay / 1000)} 秒后重试(${i}/${attempts - 1})…`);
      await sleepFn(delay);
      delay = Math.min(Math.round(delay * 1.6), 15000);
    }
  }
}

// Orchestrate "make https://<domain> work": reuse the certificate already in the
// panel when one covers the domain, otherwise apply for one with the accounts
// the user selected (both read from the panel), then bind it and enable HTTPS.
// Idempotent — re-running with the same inputs skips the work.
export async function ensureHttps({
  base: knownBase,
  baseUrl,
  apiKey,
  domain,
  method = "dnsAccount",
  acmeAccountId,
  dnsAccountId,
  sslId,
  httpConfig = "HTTPToHTTPS",
  hsts,
  autoRenew = true,
  timeoutMs = 180000,
  onLog,
  signal,
}) {
  if (!apiKey) throw new Error("请先在发布设置里填写服务器地址与 API Key");
  if (!domain) throw new Error("请填写要启用 HTTPS 的域名");
  const log = onLog || (() => {});
  const base = knownBase || (await detectApiBase(baseUrl, apiKey, signal));

  const site = await findWebsite(base, apiKey, domain, signal);
  if (!site) throw new Error(`未在 1Panel 中找到域名 ${domain} 的网站,请先发布一次`);

  let ssl = sslId ? await getSsl(base, apiKey, sslId, signal) : await findSslByDomain(base, apiKey, domain, signal);
  if (ssl?.id) {
    log(`已复用现有证书 #${ssl.id}${ssl.expireDate ? `(到期 ${ssl.expireDate})` : ""}`);
  } else {
    if (!acmeAccountId) throw new Error("请选择 ACME 账号(1Panel 中还没有的话,请先在面板里创建一个)");
    if (method === "dnsAccount" && !dnsAccountId) throw new Error("自动 DNS 验证需要选择一个已配置的 DNS 账号");
    log(`申请新证书(${method === "http" ? "HTTP 验证" : method === "dnsManual" ? "手动 DNS 验证" : "自动 DNS 验证"})…`);
    if (method === "dnsManual") {
      // The panel's manual flow needs a human to add the TXT record (its own UI
      // prints the value and waits), so driving the order from here would stall
      // the publish. Create the record and hand that step to the panel; the next
      // publish finds the issued certificate and just binds it.
      ssl = await createSsl(
        base,
        apiKey,
        { acmeAccountId, dnsAccountId, provider: method, primaryDomain: domain, autoRenew, apply: false },
        signal,
      );
      log(`已创建证书记录 #${ssl.id},手动 DNS 验证需要在 1Panel 面板中完成:`);
      log("  网站 → SSL → 证书 → 找到该记录,按提示添加 TXT 记录后继续申请。");
      log("  签发完成后重新发布即可自动绑定(不会重复申请)。");
      return { base, site, ssl, changed: false, pendingManual: true };
    }
    ssl = await createSsl(
      base,
      apiKey,
      { acmeAccountId, dnsAccountId, provider: method, primaryDomain: domain, autoRenew, apply: true },
      signal,
    );
    log("证书申请已开始(1Panel 在后台异步签发,通常需要几十秒)…");
    ssl = await pollSslUntilIssued(base, apiKey, ssl.id, { timeoutMs, onLog: log, signal });
    log(`证书已签发${ssl.expireDate ? `(到期 ${ssl.expireDate})` : ""}`);
  }

  const current = await getWebsiteHttps(base, apiKey, site.id, signal);
  if (current?.enable && record(current.SSL)?.id === ssl.id && current?.httpConfig === httpConfig) {
    log("HTTPS 已启用且证书一致,无需改动");
    return { base, site, ssl, changed: false };
  }
  await enableHttpsResilient(
    base,
    apiKey,
    {
      websiteId: site.id,
      websiteSSLId: ssl.id,
      httpConfig,
      hsts: hsts ?? current?.hsts ?? false,
      SSLProtocol: current?.SSLProtocol,
      algorithm: current?.algorithm,
    },
    { onLog: log, signal },
  );
  log(`✅ 已为 ${domain} 启用 HTTPS(${httpConfig})`);
  return { base, site, ssl, changed: true };
}

// Settings the GUI needs to render the HTTPS form: the accounts to choose from
// plus any certificate already covering the domain.
export async function httpsOptions({ baseUrl, apiKey, domain, signal }) {
  const base = await detectApiBase(baseUrl, apiKey, signal);
  const [acme, dns] = await Promise.all([listAcmeAccounts(base, apiKey, signal), listDnsAccounts(base, apiKey, signal)]);
  const site = domain ? await findWebsite(base, apiKey, domain, signal) : null;
  const ssl = domain ? await findSslByDomain(base, apiKey, domain, signal) : null;
  return {
    base,
    acmeAccounts: acme.map((a) => ({ id: a.id, email: a.email, type: a.type })),
    dnsAccounts: dns.map((d) => ({ id: d.id, name: d.name, type: d.type })),
    existingSsl: ssl ? { id: ssl.id, domains: ssl.domains, expireDate: ssl.expireDate } : null,
    site: site ? { id: site.id, primaryDomain: site.primaryDomain } : null,
  };
}

// --- 数据后端(见 docs/data-api.md) ------------------------------------------
// 站点命名空间必须与 data-api/slug.mjs、注入页面的运行时逐字符一致。
// databind.test.mjs 用同一批样本钉住浏览器与后端两处,这里是第三处。

export function slugifySite(host) {
  return String(host || "")
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

// 用户可能只填域名,也可能填到 /api/v1;两种都接受。
export function normalizeDataApi(url) {
  const base = String(url || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  return /\/api\/v\d+$/.test(base) ? base : `${base}/api/v1`;
}

// 从 databinds.json 推导要声明的集合。构建产物里有什么,后端就注册什么 ——
// 避免"页面在用但后端没声明"的静默 404。
export function collectionsFromDatabinds(outDir) {
  let items = [];
  try {
    const d = JSON.parse(readFileSync(join(outDir, "databinds.json"), "utf8"));
    items = Array.isArray(d?.items) ? d.items : [];
  } catch {
    return {};
  }
  const out = {};
  for (const b of items) {
    if (!b?.collection) continue;
    // 同一集合被多处使用时,只要有一处要 single 就取 single(更严格的那个)
    const want = b.mode === "single" ? "single" : "append";
    out[b.collection] = { mode: out[b.collection]?.mode === "single" ? "single" : want };
  }
  return out;
}

async function dataFetch(base, token, path, { method = "GET", body, signal } = {}) {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok || (data && data.ok === false)) {
    const msg = data?.error?.message || `数据后端错误 ${res.status}`;
    throw new Error(`${msg} (${path})`);
  }
  return data;
}

export async function dataApiHealth({ baseUrl, adminToken, signal }) {
  const base = normalizeDataApi(baseUrl);
  if (!base) throw new Error("请先填写数据后端地址");
  const health = await dataFetch(base, adminToken || "", "/health", { signal });
  let sites = null;
  if (adminToken) {
    const list = await dataFetch(base, adminToken, "/admin/sites", { signal });
    sites = (list?.sites || []).length;
  }
  return { base, version: health?.version, sites };
}

// 发布成功后把域名白名单与集合声明同步到数据后端(幂等)。
// 失败不应让发布整体失败 —— 静态站点已经传上去了,数据功能晚一步注册即可。
export async function registerSite({ dataApi, adminToken, domain, outDir, signal }) {
  const base = normalizeDataApi(dataApi);
  if (!base) return null;
  if (!adminToken) throw new Error("请先填写数据后端的 Admin Token");
  const site = slugifySite(domain);
  if (!site) throw new Error(`无法从域名推导站点标识: ${domain}`);
  const collections = outDir ? collectionsFromDatabinds(outDir) : {};
  // 默认只放行这个域名和它的 www 变体。**不自动加通配** —— 通配共享托管域
  // (如 *.figma.site)会等于把后端开放给全世界,必须由人显式决定。
  const alt = domain.startsWith("www.") ? domain.slice(4) : `www.${domain}`;
  const payload = {
    origins: [`https://${domain}`, `https://${alt}`],
    collections,
  };
  const r = await dataFetch(base, adminToken, `/admin/sites/${site}`, { method: "PUT", body: payload, signal });
  return { base, site, collections, origins: r?.site?.origins || payload.origins };
}
