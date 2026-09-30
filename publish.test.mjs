// publish.test.mjs — unit tests for the 1Panel deploy module. All network
// calls go through globalThis.fetch, which is stubbed per test; file uploads
// read real temp fixtures so collectDeployFiles/uploadFile are exercised end
// to end without touching a server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  signHeaders,
  detectApiBase,
  panelFetch,
  findWebsite,
  createStaticSite,
  ensureSite,
  collectDeployFiles,
  uploadFile,
  publishSite,
  testPanel,
  listAcmeAccounts,
  listDnsAccounts,
  listSsls,
  sslDomainMatches,
  createSsl,
  pollSslUntilIssued,
  enableHttps,
  ensureHttps,
  httpsOptions,
} from "./publish.mjs";

const BASE = "http://panel:8080";
const KEY = "sk-test";
const DOMAIN = "example.com";
const SITE = {
  primaryDomain: DOMAIN,
  alias: DOMAIN,
  sitePath: "/opt/1panel/www/sites/example.com",
};

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

// Router stub: records every call; returns the website list state that changed
// once a create happens (listBeforeCreate → listAfterCreate), mirroring how a
// real panel would start returning the site after POST /websites.
function stubFetch({ probe = 200, listBeforeCreate = [], listAfterCreate = [], createBody } = {}) {
  const calls = [];
  let created = false;
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    calls.push({ url, method, body: opts.body });
    if (url.endsWith("/websites/list") && !created) return jsonResponse(probe, { data: listBeforeCreate });
    if (url.endsWith("/websites/list")) return jsonResponse(200, { data: listAfterCreate });
    if (url.endsWith("/websites/search")) return jsonResponse(200, { data: { items: created ? listAfterCreate : listBeforeCreate } });
    if (url.endsWith("/websites") && method === "POST") {
      if (createBody) createBody(JSON.parse(opts.body));
      created = true;
      return jsonResponse(200, {});
    }
    if (url.endsWith("/files/upload")) return jsonResponse(200, { message: "ok" });
    return jsonResponse(404, { message: "not found" });
  };
  return { calls };
}

function makeOutDir() {
  const dir = mkdtempSync(join(tmpdir(), "publish-"));
  writeFileSync(join(dir, "index.html"), "<html>home</html>");
  writeFileSync(join(dir, "about.html"), "<html>about</html>");
  writeFileSync(join(dir, "styles.css"), "body{}");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "a.png"), Buffer.from([1, 2, 3]));
  mkdirSync(join(dir, "fonts"));
  writeFileSync(join(dir, "fonts", "x.woff2"), Buffer.from([9, 9]));
  // build metadata — must be excluded from deploy
  mkdirSync(join(dir, "data"));
  writeFileSync(join(dir, "data", "page.json"), "{}");
  for (const f of ["manifest.json", "edits.json", "nodeStyles.json", "overrides.json", "wordclouds.json", "file-locks.json"]) {
    writeFileSync(join(dir, f), "{}");
  }
  return dir;
}

test("signHeaders produces the 1Panel HMAC shape", () => {
  const h = signHeaders("secret-key", "1700000000");
  const expected = createHash("md5").update("1panelsecret-key1700000000").digest("hex");
  assert.equal(h["1Panel-Timestamp"], "1700000000");
  assert.equal(h["1Panel-Token"], expected);
  assert.match(h["1Panel-Token"], /^[0-9a-f]{32}$/);
  // deterministic for the same timestamp
  assert.deepEqual(signHeaders("k", "1"), signHeaders("k", "1"));
});

test("detectApiBase picks /api/v2, falls back to /api/v1 on 404, strips trailing slash", async () => {
  globalThis.fetch = async (url) => jsonResponse(url.includes("/api/v2") ? 200 : 404, {});
  // trailing slash on the origin must not double up the path
  assert.equal(await detectApiBase(`${BASE}/`, KEY), `${BASE}/api/v2`);
  // force 404 probe → v1
  globalThis.fetch = async (url) => jsonResponse(url.includes("/api/v2") ? 404 : 200, {});
  assert.equal(await detectApiBase(BASE, KEY), `${BASE}/api/v1`);
});

test("findWebsite matches by primaryDomain and returns null when absent", async () => {
  const { calls } = stubFetch({ listBeforeCreate: [SITE] });
  const found = await findWebsite(BASE, KEY, DOMAIN);
  assert.equal(found.sitePath, SITE.sitePath);
  // lookup prefers the search endpoint, which carries sitePath
  assert.ok(calls[0].url.includes("/websites/search"));
  const none = await findWebsite(BASE, KEY, "other.com");
  assert.equal(none, null);
});

test("createStaticSite posts the v2 static body then re-fetches", async () => {
  let posted = null;
  const { calls } = stubFetch({ listAfterCreate: [SITE], createBody: (b) => (posted = b) });
  const site = await createStaticSite(BASE, KEY, { domain: DOMAIN, alias: "alias-x", groupID: 3 });
  assert.equal(site.sitePath, SITE.sitePath);
  const createCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/websites"));
  assert.ok(createCall, "POST /websites was made");
  assert.deepEqual(posted, {
    type: "static",
    alias: "alias-x",
    webSiteGroupID: 3,
    IPV6: false,
    AppType: "new",
    domains: [{ domain: DOMAIN, port: 80, ssl: false }],
    ftpUser: "",
    ftpPassword: "",
    siteDir: "",
  });
});

test("panelFetch surfaces business errors carried in 200 responses", async () => {
  globalThis.fetch = async () => jsonResponse(200, { code: 400, message: "参数错误: AppType" });
  await assert.rejects(() => panelFetch(BASE, KEY, "/websites", { method: "POST" }), /参数错误/);
});

test("ensureSite reuses an existing site and creates+roots a missing one", async () => {
  stubFetch({ listBeforeCreate: [SITE] });
  const existing = await ensureSite(BASE, KEY, { domain: DOMAIN });
  assert.equal(existing.created, false);
  assert.equal(existing.root, "/opt/1panel/www/sites/example.com/index");

  stubFetch({ listBeforeCreate: [], listAfterCreate: [SITE] });
  const created = await ensureSite(BASE, KEY, { domain: DOMAIN, groupID: 2 });
  assert.equal(created.created, true);
  assert.equal(created.root, `${SITE.sitePath}/index`);
});

test("ensureSite throws when sitePath is missing", async () => {
  stubFetch({ listBeforeCreate: [{ primaryDomain: DOMAIN, alias: DOMAIN }] });
  await assert.rejects(() => ensureSite(BASE, KEY, { domain: DOMAIN }), /物理路径/);
});

test("collectDeployFiles excludes build metadata and keeps served files", () => {
  const dir = makeOutDir();
  const files = collectDeployFiles(dir);
  const rels = files.map((f) => f.relPath).sort();
  assert.deepEqual(rels, ["about.html", "assets/a.png", "fonts/x.woff2", "index.html", "styles.css"]);
  for (const f of files) assert.ok(f.localPath && f.relPath);
});

test("uploadFile posts multipart to the target dir with overwrite", async () => {
  const { calls } = stubFetch();
  const dir = makeOutDir();
  await uploadFile(BASE, KEY, join(dir, "assets", "a.png"), "/opt/panel/example/index/assets");
  const call = calls.find((c) => c.url.endsWith("/files/upload"));
  assert.ok(call, "upload called");
  assert.ok(call.body instanceof FormData);
  assert.equal(call.body.get("path"), "/opt/panel/example/index/assets");
  assert.equal(call.body.get("overwrite"), "True");
  assert.equal(call.body.get("file").name, "a.png");
});

test("publishSite deploys all served files into <sitePath>/index and logs", async () => {
  const { calls } = stubFetch({ listBeforeCreate: [SITE] });
  const dir = makeOutDir();
  const logs = [];
  const result = await publishSite({ baseUrl: BASE, apiKey: KEY, outDir: dir, domain: DOMAIN, onLog: (l) => logs.push(l) });
  assert.equal(result.created, false);
  assert.equal(result.root, `${SITE.sitePath}/index`);
  assert.equal(result.uploaded, 5);
  assert.ok(logs.some((l) => l.includes("发布完成,共上传 5 个文件")));
  assert.ok(logs.some((l) => l.includes("↑ assets/a.png")));

  const uploads = calls.filter((c) => c.url.endsWith("/files/upload"));
  assert.equal(uploads.length, 5);
  const byName = (n) => uploads.find((c) => c.body.get("file").name === n);
  assert.equal(byName("index.html").body.get("path"), `${SITE.sitePath}/index`);
  assert.equal(byName("a.png").body.get("path"), `${SITE.sitePath}/index/assets`);
  assert.equal(byName("x.woff2").body.get("path"), `${SITE.sitePath}/index/fonts`);
});

test("publishSite auto-creates the site when missing", async () => {
  stubFetch({ listBeforeCreate: [], listAfterCreate: [SITE] });
  const dir = makeOutDir();
  const result = await publishSite({ baseUrl: BASE, apiKey: KEY, outDir: dir, domain: DOMAIN, onLog: () => {} });
  assert.equal(result.created, true);
  assert.equal(result.uploaded, 5);
});

test("publishSite surfaces API errors with the response text", async () => {
  globalThis.fetch = async (url) => {
    if (url.endsWith("/websites/list")) return jsonResponse(200, { data: [SITE] });
    if (url.endsWith("/files/upload")) return jsonResponse(500, { message: "disk full" });
    return jsonResponse(404, {});
  };
  const dir = makeOutDir();
  await assert.rejects(() => publishSite({ baseUrl: BASE, apiKey: KEY, outDir: dir, domain: DOMAIN }), /disk full/);
});

test("publishSite validates required config", async () => {
  await assert.rejects(() => publishSite({ baseUrl: "", apiKey: "", outDir: ".", domain: DOMAIN }), /服务器地址与 API Key/);
  await assert.rejects(() => publishSite({ baseUrl: BASE, apiKey: KEY, outDir: ".", domain: "" }), /域名/);
});

test("testPanel reports connection and existing-site status", async () => {
  stubFetch({ listBeforeCreate: [SITE] });
  const res = await testPanel({ baseUrl: BASE, apiKey: KEY, domain: DOMAIN });
  assert.equal(res.base, `${BASE}/api/v2`);
  assert.equal(res.found, true);
  assert.equal(res.root, `${SITE.sitePath}/index`);
});

// --- HTTPS / certificate feature --------------------------------------------
// Router for the SSL endpoints. ACME/DNS accounts and certificates are READ
// (they live in the panel); create/obtain/enable are written.

const SITE_RECORD = { ...SITE, id: 42 };
const ACME = { id: 3, email: "me@mail.com", type: "letsencrypt", keyType: "P256" };
const DNS_ACC = { id: 5, name: "我的阿里云", type: "AliYun" };
const SSL_RECORD = { id: 7, primaryDomain: DOMAIN, domains: DOMAIN, expireDate: "2027-01-01", message: "" };

function stubHttps({ acme = [ACME], dns = [DNS_ACC], ssls = [], httpState = {}, createdSsl = [SSL_RECORD], issued = true, site = SITE_RECORD } = {}) {
  const calls = [];
  const state = { ssls: [...ssls] };
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    const body = typeof opts.body === "string" ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method, body });
    if (url.endsWith("/websites/list")) return jsonResponse(200, { data: [site] });
    if (url.endsWith("/websites/search")) return jsonResponse(200, { data: { items: [site] } });
    if (url.endsWith("/websites/acme/search")) return jsonResponse(200, { data: { items: acme } });
    if (url.endsWith("/websites/dns/search")) return jsonResponse(200, { data: { items: dns } });
    if (url.endsWith("/websites/ssl/search")) return jsonResponse(200, { data: state.ssls });
    if (url.endsWith("/websites/ssl") && method === "POST") {
      state.ssls.push(...createdSsl);
      return jsonResponse(200, {});
    }
    if (url.endsWith("/websites/ssl/obtain")) return jsonResponse(200, {});
    if (/\/websites\/ssl\/\d+$/.test(url)) {
      const rec = state.ssls.find((s) => Number(s.id) === Number(url.match(/(\d+)$/)[1]));
      return jsonResponse(200, { data: issued ? rec || SSL_RECORD : { id: 7, message: "DNS 记录未生效" } });
    }
    if (/\/websites\/\d+\/https$/.test(url)) {
      if (method === "GET") return jsonResponse(200, { data: httpState });
      return jsonResponse(200, {});
    }
    if (url.endsWith("/files/upload")) return jsonResponse(200, {});
    return jsonResponse(404, { message: "not found" });
  };
  return { calls, state };
}

test("listAcmeAccounts / listDnsAccounts read the panel's configured accounts", async () => {
  stubHttps();
  const acme = await listAcmeAccounts(`${BASE}/api/v2`, KEY);
  const dns = await listDnsAccounts(`${BASE}/api/v2`, KEY);
  assert.deepEqual(acme, [ACME]);
  assert.deepEqual(dns, [DNS_ACC]);
});

test("listSsls accepts both a bare array and a { data: [] } envelope", async () => {
  globalThis.fetch = async () => jsonResponse(200, { data: [SSL_RECORD] });
  assert.deepEqual(await listSsls(`${BASE}/api/v2`, KEY), [SSL_RECORD]);
  globalThis.fetch = async () => jsonResponse(200, [SSL_RECORD]);
  assert.deepEqual(await listSsls(`${BASE}/api/v2`, KEY), [SSL_RECORD]);
});

test("sslDomainMatches covers the primary domain and CSV extra domains", () => {
  assert.equal(sslDomainMatches({ primaryDomain: DOMAIN }, DOMAIN), true);
  assert.equal(sslDomainMatches({ primaryDomain: "a.com", domains: "a.com,www.a.com" }, "www.a.com"), true);
  assert.equal(sslDomainMatches({ primaryDomain: "a.com", domains: "a.com" }, "b.com"), false);
  assert.equal(sslDomainMatches(null, DOMAIN), false);
});

test("createSsl posts the panel's account ids and derives dnsAccountId from the provider", async () => {
  const { calls } = stubHttps();
  const ssl = await createSsl(`${BASE}/api/v2`, KEY, {
    acmeAccountId: 3,
    dnsAccountId: 5,
    provider: "dnsAccount",
    primaryDomain: DOMAIN,
    autoRenew: true,
  });
  assert.equal(ssl.id, 7);
  const post = calls.find((c) => c.url.endsWith("/websites/ssl") && c.method === "POST");
  assert.equal(post.body.acmeAccountId, 3);
  assert.equal(post.body.dnsAccountId, 5);
  assert.equal(post.body.provider, "dnsAccount");
  assert.equal(post.body.primaryDomain, DOMAIN);
  assert.equal(post.body.keyType, "P256");
  assert.equal(post.body.autoRenew, true);

  // provider=http must NOT send the DNS account (the panel rejects a stray id)
  const { calls: c2 } = stubHttps();
  await createSsl(`${BASE}/api/v2`, KEY, { acmeAccountId: 3, dnsAccountId: 5, provider: "http", primaryDomain: DOMAIN });
  const post2 = c2.find((c) => c.url.endsWith("/websites/ssl") && c.method === "POST");
  assert.equal(post2.body.dnsAccountId, 0);
});

test("createSsl fails loudly when the new record is not visible afterwards", async () => {
  const { calls } = stubHttps({ createdSsl: [] });
  await assert.rejects(
    () => createSsl(`${BASE}/api/v2`, KEY, { acmeAccountId: 3, dnsAccountId: 5, primaryDomain: DOMAIN }),
    /未能查询到/,
  );
  assert.ok(calls.some((c) => c.url.endsWith("/websites/ssl") && c.method === "POST"));
});

test("pollSslUntilIssued returns once the record carries an expiry", async () => {
  stubHttps({ ssls: [SSL_RECORD] });
  const ssl = await pollSslUntilIssued(`${BASE}/api/v2`, KEY, 7, { intervalMs: 5 });
  assert.equal(ssl.expireDate, "2027-01-01");
});

test("pollSslUntilIssued times out and surfaces the panel's message", async () => {
  stubHttps({ issued: false });
  const logs = [];
  await assert.rejects(
    () => pollSslUntilIssued(`${BASE}/api/v2`, KEY, 7, { timeoutMs: 30, intervalMs: 5, onLog: (l) => logs.push(l) }),
    /证书申请超时.*DNS 记录未生效/s,
  );
  assert.ok(logs.some((l) => l.includes("DNS 记录未生效")));
});

test("enableHttps binds type=existed with the chosen certificate", async () => {
  const { calls } = stubHttps();
  await enableHttps(`${BASE}/api/v2`, KEY, { websiteId: 42, websiteSSLId: 7, httpConfig: "HTTPToHTTPS" });
  const post = calls.find((c) => /\/websites\/42\/https$/.test(c.url) && c.method === "POST");
  assert.equal(post.body.websiteId, 42);
  assert.equal(post.body.type, "existed");
  assert.equal(post.body.websiteSSLId, 7);
  assert.equal(post.body.enable, true);
  assert.equal(post.body.httpConfig, "HTTPToHTTPS");
  assert.deepEqual(post.body.SSLProtocol, ["TLSv1.2", "TLSv1.3"]);
});

test("ensureHttps reuses an existing certificate instead of applying for one", async () => {
  const { calls } = stubHttps({ ssls: [SSL_RECORD] });
  const logs = [];
  const res = await ensureHttps({ baseUrl: BASE, apiKey: KEY, domain: DOMAIN, onLog: (l) => logs.push(l) });
  assert.equal(res.changed, true);
  assert.equal(res.ssl.id, 7);
  assert.ok(logs.some((l) => l.includes("已复用现有证书 #7")));
  assert.equal(calls.some((c) => c.url.endsWith("/websites/ssl") && c.method === "POST"), false);
  assert.equal(calls.some((c) => c.url.endsWith("/websites/ssl/obtain")), false);
});

test("ensureHttps is idempotent when HTTPS already uses the same certificate", async () => {
  const { calls } = stubHttps({ ssls: [SSL_RECORD], httpState: { enable: true, httpConfig: "HTTPToHTTPS", SSL: { id: 7 } } });
  const logs = [];
  const res = await ensureHttps({ baseUrl: BASE, apiKey: KEY, domain: DOMAIN, onLog: (l) => logs.push(l) });
  assert.equal(res.changed, false);
  assert.ok(logs.some((l) => l.includes("无需改动")));
  assert.equal(calls.some((c) => /\/websites\/42\/https$/.test(c.url) && c.method === "POST"), false);
});

test("ensureHttps applies a new certificate with the selected accounts", async () => {
  const { calls } = stubHttps({ ssls: [] });
  const logs = [];
  const res = await ensureHttps({
    baseUrl: BASE,
    apiKey: KEY,
    domain: DOMAIN,
    method: "dnsAccount",
    acmeAccountId: 3,
    dnsAccountId: 5,
    onLog: (l) => logs.push(l),
  });
  assert.equal(res.changed, true);
  const create = calls.find((c) => c.url.endsWith("/websites/ssl") && c.method === "POST");
  assert.equal(create.body.acmeAccountId, 3);
  assert.equal(create.body.dnsAccountId, 5);
  assert.equal(create.body.apply, true, "auto validation applies on create");
  const obtain = calls.find((c) => c.url.endsWith("/websites/ssl/obtain"));
  assert.equal(obtain, undefined, "dnsAccount must not double-apply");
  assert.ok(logs.some((l) => l.includes("证书已签发")));
  assert.ok(calls.some((c) => /\/websites\/42\/https$/.test(c.url) && c.method === "POST"));
});

test("ensureHttps applies separately for the manual DNS flow", async () => {
  const { calls } = stubHttps({ ssls: [] });
  await ensureHttps({ baseUrl: BASE, apiKey: KEY, domain: DOMAIN, method: "dnsManual", acmeAccountId: 3 });
  const create = calls.find((c) => c.url.endsWith("/websites/ssl") && c.method === "POST");
  assert.equal(create.body.apply, false, "manual flow creates first, applies after the TXT record");
  assert.ok(calls.some((c) => c.url.endsWith("/websites/ssl/obtain")));
});

test("ensureHttps validates its inputs", async () => {
  stubHttps({ ssls: [] });
  await assert.rejects(() => ensureHttps({ baseUrl: BASE, apiKey: KEY, domain: DOMAIN }), /ACME 账号/);
  await assert.rejects(
    () => ensureHttps({ baseUrl: BASE, apiKey: KEY, domain: DOMAIN, acmeAccountId: 3 }),
    /DNS 账号/,
  );
  // a site that is not ours: every name field must differ, `alias` included
  stubHttps({ ssls: [], site: { id: 42, primaryDomain: "other.com", alias: "other.com", domain: "other.com", domains: ["other.com"] } });
  await assert.rejects(() => ensureHttps({ baseUrl: BASE, apiKey: KEY, domain: DOMAIN }), /请先发布一次/);
});

test("httpsOptions returns the accounts and any existing certificate", async () => {
  stubHttps({ ssls: [SSL_RECORD] });
  const opts = await httpsOptions({ baseUrl: BASE, apiKey: KEY, domain: DOMAIN });
  assert.deepEqual(opts.acmeAccounts, [{ id: 3, email: "me@mail.com", type: "letsencrypt" }]);
  assert.deepEqual(opts.dnsAccounts, [{ id: 5, name: "我的阿里云", type: "AliYun" }]);
  assert.equal(opts.existingSsl.id, 7);
  assert.equal(opts.site.id, 42);
});

test("publishSite runs the HTTPS phase after uploading when asked", async () => {
  const { calls } = stubHttps({ ssls: [SSL_RECORD] });
  const dir = makeOutDir();
  const logs = [];
  const res = await publishSite({
    baseUrl: BASE,
    apiKey: KEY,
    outDir: dir,
    domain: DOMAIN,
    https: { enabled: true, httpConfig: "HTTPToHTTPS" },
    onLog: (l) => logs.push(l),
  });
  assert.equal(res.uploaded, 5);
  assert.ok(res.https, "https result returned");
  assert.equal(res.https.ssl.id, 7);
  assert.ok(logs.some((l) => l.includes("配置 HTTPS")));
  assert.ok(calls.some((c) => /\/websites\/42\/https$/.test(c.url) && c.method === "POST"));
});

