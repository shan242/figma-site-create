// 契约测试:docs/data-api.md 里每一条行为都在这里钉住。
// 直接调 app.handle(new Request(...)),不碰端口。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.mjs";
import { openDb } from "../db.mjs";
import { createApp } from "../app.mjs";
import { createRateLimiter } from "../ratelimit.mjs";

const TOKEN = "test-admin-token";
const SITE = "didsdi-com";
const ORIGIN = "https://didsdi.com";
const CLIENT = "5f3a1c2e-8b7d-4a91-9c3e-2f1d4b6a8c0e";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "dataapi-"));
  const config = { ...loadConfig(dir), adminToken: TOKEN };
  const db = openDb(dir);
  const app = createApp({ db, config, limiter: createRateLimiter(), log: () => {} });
  return { dir, db, config, app };
}

async function req(app, method, path, { body, origin, token, ip = "1.2.3.4", headers = {} } = {}) {
  const h = { ...headers };
  if (origin) h.origin = origin;
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined) h["content-type"] = "application/json";
  const r = await app.handle(
    new Request(`http://data.local${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }),
    { ip, startedAt: Date.now() },
  );
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null };
}

const register = (app, slug = SITE, extra = {}) =>
  req(app, "PUT", `/api/v1/admin/sites/${slug}`, { token: TOKEN, body: { origins: [ORIGIN], ...extra } });

// 默认带站点来源;传 origin: null 可模拟无 Origin 的 curl 请求
const post = (app, body, { origin = ORIGIN, ...opts } = {}) =>
  req(app, "POST", `/api/v1/${SITE}/votes`, { origin, body, ...opts });

// --- 基础 / 健康 -------------------------------------------------------------

test("health 无鉴权、无限流,并带通配 CORS", async () => {
  const { app } = setup();
  const r = await req(app, "GET", "/api/v1/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
});

test("未知接口返回 404", async () => {
  const { app } = setup();
  assert.equal((await req(app, "GET", "/api/v1")).status, 404);
  assert.equal((await req(app, "GET", "/nope")).status, 404);
});

// --- 管理端:注册站点 ---------------------------------------------------------

test("管理端需要 Bearer 令牌", async () => {
  const { app } = setup();
  assert.equal((await req(app, "GET", "/api/v1/admin/sites")).status, 401);
  assert.equal((await req(app, "GET", "/api/v1/admin/sites", { token: "wrong" })).status, 401);
  assert.equal((await req(app, "GET", "/api/v1/admin/sites", { token: TOKEN })).status, 200);
});

test("注册站点幂等,并接受集合声明", async () => {
  const { app } = setup();
  const a = await register(app, SITE, { collections: { votes: { mode: "append" } } });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.site.origins, [ORIGIN]);
  const b = await register(app, SITE, { note: "改了备注" });
  assert.equal(b.status, 200);
  assert.equal(b.body.site.note, "改了备注");
  assert.deepEqual(b.body.site.origins, [ORIGIN]);
  const list = await req(app, "GET", "/api/v1/admin/sites", { token: TOKEN });
  assert.equal(list.body.sites.length, 1);
});

test("注册时校验 origins", async () => {
  const { app } = setup();
  assert.equal((await req(app, "PUT", `/api/v1/admin/sites/${SITE}`, { token: TOKEN, body: {} })).status, 400);
  assert.equal((await req(app, "PUT", `/api/v1/admin/sites/${SITE}`, { token: TOKEN, body: { origins: ["not a url"] } })).status, 400);
});

test("未注册的站点:公开写入返回 404 SITE_NOT_FOUND", async () => {
  const { app } = setup();
  const r = await post(app, { data: { choice: "A" } });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, "SITE_NOT_FOUND");
});

// --- 公开写入 ---------------------------------------------------------------

test("追加记录:自动建集合、回 id、CORS 回显来源", async () => {
  const { app } = setup();
  await register(app);
  const r = await post(app, { data: { choice: "A" }, client: CLIENT, meta: { page: "index" } });
  assert.equal(r.status, 201);
  assert.equal(r.body.ok, true);
  assert.ok(Number.isInteger(r.body.id));
  assert.equal(r.body.replaced, false);
  assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(r.headers.get("vary"), "Origin");
});

test("来源不在白名单 → 403 ORIGIN_DENIED,且不回 CORS 头", async () => {
  const { app } = setup();
  await register(app);
  const r = await post(app, { data: { choice: "A" } }, { origin: "https://evil.example.com" });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, "ORIGIN_DENIED");
  assert.equal(r.headers.get("access-control-allow-origin"), null);
});

test("OPTIONS 预检:白名单内 204、名单外 403", async () => {
  const { app } = setup();
  await register(app);
  const ok = await req(app, "OPTIONS", `/api/v1/${SITE}/votes`, { origin: ORIGIN });
  assert.equal(ok.status, 204);
  assert.match(ok.headers.get("access-control-allow-methods"), /POST/);
  const no = await req(app, "OPTIONS", `/api/v1/${SITE}/votes`, { origin: "https://evil.example.com" });
  assert.equal(no.status, 403);
});

test("无 Origin 的非浏览器请求(curl)可正常写入", async () => {
  const { app } = setup();
  await register(app);
  const r = await post(app, { data: { choice: "A" } }, { origin: null });
  assert.equal(r.status, 201);
  assert.equal(r.headers.get("access-control-allow-origin"), null);
});

// --- 写入校验(契约 §2.4) ----------------------------------------------------

test("拒绝非法 data", async () => {
  const { app } = setup();
  await register(app);
  for (const [data, hint] of [
    [undefined, /data/],
    [[1, 2], /对象/],
    ["str", /对象/],
    [Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, 1])), /字段数/],
    [{ ok: 1, "bad name": 2 }, /字段名/],
    [{ text: "x".repeat(501) }, /500/],
    [{ a: { b: { c: { d: 1 } } } }, /嵌套/],
    // 每个字段都合法,但总量超过 4KB(16 字段 × 300 字符 ≈ 4800 字节)
    [Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`f${i}`, "y".repeat(300)])), /字节/],
  ]) {
    const r = await post(app, { data });
    assert.equal(r.status, 400, `${JSON.stringify(data)?.slice(0, 40)} 应被拒绝`);
    assert.match(r.body.error.message + r.body.error.code, hint);
  }
});

test("拒绝非法 client", async () => {
  const { app } = setup();
  await register(app);
  assert.equal((await post(app, { data: { a: 1 }, client: "short" })).status, 400);
  assert.equal((await post(app, { data: { a: 1 }, client: "has space and symbols!!" })).status, 400);
});

// --- 读取 / mine / stats ----------------------------------------------------

test("列表按 id 倒序,支持 fields 投影,且不泄露 client", async () => {
  const { app } = setup();
  await register(app);
  for (const c of ["A", "B", "C"]) await post(app, { data: { choice: c, secret: "x" }, client: CLIENT });
  const r = await req(app, "GET", `/api/v1/${SITE}/votes?fields=choice`, { origin: ORIGIN });
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 3);
  assert.deepEqual(r.body.items[0].data, { choice: "C" });
  assert.equal(r.body.total, 3);
  assert.equal(JSON.stringify(r.body).includes(CLIENT), false, "公开列表不得回传 client");
  assert.equal(JSON.stringify(r.body).includes("clientHash"), false);
});

test("order=asc 与 since 过滤", async () => {
  const { app } = setup();
  await register(app);
  await post(app, { data: { choice: "A" } });
  await post(app, { data: { choice: "B" } });
  const asc = await req(app, "GET", `/api/v1/${SITE}/votes?order=asc`, { origin: ORIGIN });
  assert.deepEqual(asc.body.items.map((i) => i.data.choice), ["A", "B"]);
  const future = await req(app, "GET", `/api/v1/${SITE}/votes?since=2999-01-01T00:00:00Z`, { origin: ORIGIN });
  assert.equal(future.body.items.length, 0);
});

test("mine 只返回自己的记录 —— '提交过就不再问' 的依据", async () => {
  const { app } = setup();
  await register(app);
  await post(app, { data: { choice: "A" }, client: CLIENT });
  await post(app, { data: { choice: "B" }, client: "another-client-id-1234" });

  const mine = await req(app, "GET", `/api/v1/${SITE}/votes/mine?client=${CLIENT}`, { origin: ORIGIN });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.items.length, 1);
  assert.equal(mine.body.items[0].data.choice, "A");

  const none = await req(app, "GET", `/api/v1/${SITE}/votes/mine?client=never-seen-client-99`, { origin: ORIGIN });
  assert.deepEqual(none.body.items, []);

  assert.equal((await req(app, "GET", `/api/v1/${SITE}/votes/mine?client=bad`, { origin: ORIGIN })).status, 400);
});

test("stats 聚合按 count 降序、同数按 key 升序(结果稳定)", async () => {
  const { app } = setup();
  await register(app);
  for (const c of ["A", "A", "A", "B", "B", "C", "C"]) await post(app, { data: { choice: c } });
  await post(app, { data: { other: 1 } }); // 缺字段 → key null
  const r = await req(app, "GET", `/api/v1/${SITE}/votes/stats?field=choice&limit=10`, { origin: ORIGIN });
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 8);
  assert.deepEqual(r.body.buckets, [
    { key: "A", count: 3 },
    { key: "B", count: 2 },
    { key: "C", count: 2 },
    { key: null, count: 1 },
  ]);
});

test("stats 需要合法 field,非法字段被拒(防注入)", async () => {
  const { app } = setup();
  await register(app);
  for (const bad of ["", "a b", "a'); DROP TABLE records;--", "1abc", "$.x"]) {
    const r = await req(app, "GET", `/api/v1/${SITE}/votes/stats?field=${encodeURIComponent(bad)}`, { origin: ORIGIN });
    assert.equal(r.status, 400, `field=${bad} 应被拒绝`);
  }
  // 注入尝试之后数据仍然完好
  const ok = await req(app, "GET", `/api/v1/${SITE}/votes/stats?field=choice`, { origin: ORIGIN });
  assert.equal(ok.status, 200);
});

test("未创建的集合读取 → 404", async () => {
  const { app } = setup();
  await register(app);
  const r = await req(app, "GET", `/api/v1/${SITE}/nothing`, { origin: ORIGIN });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, "COLLECTION_NOT_FOUND");
});

// --- single 模式 -------------------------------------------------------------

test("mode=single:同一 client 后写覆盖前写", async () => {
  const { app } = setup();
  await register(app, SITE, { collections: { profile: { mode: "single" } } });
  const p1 = await req(app, "POST", `/api/v1/${SITE}/profile`, { origin: ORIGIN, body: { data: { name: "甲" }, client: CLIENT } });
  assert.equal(p1.body.replaced, false);
  const p2 = await req(app, "POST", `/api/v1/${SITE}/profile`, { origin: ORIGIN, body: { data: { name: "乙" }, client: CLIENT } });
  assert.equal(p2.body.replaced, true);

  const mine = await req(app, "GET", `/api/v1/${SITE}/profile/mine?client=${CLIENT}`, { origin: ORIGIN });
  assert.equal(mine.body.items.length, 1);
  assert.equal(mine.body.items[0].data.name, "乙");

  // 另一个 client 不受影响
  await req(app, "POST", `/api/v1/${SITE}/profile`, { origin: ORIGIN, body: { data: { name: "丙" }, client: "other-client-5678" } });
  const all = await req(app, "GET", `/api/v1/${SITE}/profile`, { origin: ORIGIN });
  assert.equal(all.body.total, 2);
});

test("append 模式(默认)不做去重", async () => {
  const { app } = setup();
  await register(app);
  await post(app, { data: { choice: "A" }, client: CLIENT });
  await post(app, { data: { choice: "A" }, client: CLIENT });
  const r = await req(app, "GET", `/api/v1/${SITE}/votes`, { origin: ORIGIN });
  assert.equal(r.body.total, 2);
});

// --- 集合字段白名单 / 停用 / 配额 -------------------------------------------

test("集合 writeFields 丢弃未声明字段", async () => {
  const { app } = setup();
  await register(app, SITE, { collections: { votes: { writeFields: ["choice"] } } });
  await post(app, { data: { choice: "A", injected: "should be dropped" } });
  const r = await req(app, "GET", `/api/v1/${SITE}/votes`, { origin: ORIGIN });
  assert.deepEqual(r.body.items[0].data, { choice: "A" });
});

test("停用站点后公开接口返回 503", async () => {
  const { app } = setup();
  await register(app);
  await post(app, { data: { choice: "A" } });
  await req(app, "POST", `/api/v1/admin/sites/${SITE}/disable`, { token: TOKEN });
  const r = await req(app, "GET", `/api/v1/${SITE}/votes`, { origin: ORIGIN });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, "DISABLED");
  await req(app, "POST", `/api/v1/admin/sites/${SITE}/enable`, { token: TOKEN });
  assert.equal((await req(app, "GET", `/api/v1/${SITE}/votes`, { origin: ORIGIN })).status, 200);
});

test("达到条数配额 → 429 QUOTA_EXCEEDED,不静默丢数据", async () => {
  const { app } = setup();
  await register(app, SITE, { quota: { maxRecordsPerCollection: 2 } });
  assert.equal((await post(app, { data: { choice: "A" } })).status, 201);
  assert.equal((await post(app, { data: { choice: "B" } })).status, 201);
  const over = await post(app, { data: { choice: "C" } });
  assert.equal(over.status, 429);
  assert.equal(over.body.error.code, "QUOTA_EXCEEDED");
  const list = await req(app, "GET", `/api/v1/${SITE}/votes`, { origin: ORIGIN });
  assert.equal(list.body.total, 2, "超限的写入不能落库");
});

test("限流:同一 IP 超过每分钟 20 次写入 → 429 且带 Retry-After", async () => {
  const { app } = setup();
  await register(app);
  let limited = null;
  for (let i = 0; i < 25 && !limited; i++) {
    const r = await post(app, { data: { choice: `c${i}` } });
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, "应触发限流");
  assert.equal(limited.body.error.code, "RATE_LIMITED");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
});

// --- 管理端数据操作 ---------------------------------------------------------

test("管理端:列表带 clientHash、删单条、清空集合、删站点", async () => {
  const { app } = setup();
  await register(app);
  await post(app, { data: { choice: "A" }, client: CLIENT });
  await post(app, { data: { choice: "B" } });

  const list = await req(app, "GET", `/api/v1/admin/${SITE}/votes`, { token: TOKEN });
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 2);
  assert.ok(list.body.items.some((i) => i.clientHash), "管理端应能看到 clientHash");
  const firstId = list.body.items[0].id;

  const del = await req(app, "DELETE", `/api/v1/admin/${SITE}/votes/${firstId}`, { token: TOKEN });
  assert.equal(del.body.deleted, true);
  assert.equal((await req(app, "GET", `/api/v1/admin/${SITE}/votes`, { token: TOKEN })).body.items.length, 1);

  assert.equal((await req(app, "DELETE", `/api/v1/admin/${SITE}/votes`, { token: TOKEN })).body.deleted, 1);
  assert.equal((await req(app, "GET", `/api/v1/admin/${SITE}/votes`, { token: TOKEN })).body.total, 0);

  const cols = await req(app, "GET", `/api/v1/admin/${SITE}/collections`, { token: TOKEN });
  assert.equal(cols.body.collections[0].collection, "votes");

  assert.equal((await req(app, "DELETE", `/api/v1/admin/sites/${SITE}`, { token: TOKEN })).body.deleted, true);
  assert.equal((await req(app, "GET", "/api/v1/admin/sites", { token: TOKEN })).body.sites.length, 0);
  assert.equal((await req(app, "GET", `/api/v1/${SITE}/votes`, { origin: ORIGIN })).status, 404);
});

test("管理端:PATCH 改集合 mode", async () => {
  const { app } = setup();
  await register(app);
  await post(app, { data: { choice: "A" } });
  const r = await req(app, "PATCH", `/api/v1/admin/${SITE}/votes`, { token: TOKEN, body: { mode: "single" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.collection.mode, "single");
});

test("管理端概览统计", async () => {
  const { app } = setup();
  await register(app);
  await post(app, { data: { choice: "A" } });
  const r = await req(app, "GET", "/api/v1/admin/stats", { token: TOKEN });
  assert.deepEqual(r.body, { ok: true, sites: 1, collections: 1, records: 1, bytes: r.body.bytes });
  assert.ok(r.body.bytes > 0);
});

// --- 子域名通配(契约 §6.4) --------------------------------------------------

test("通配来源:匹配任意层级子域,但不匹配裸域", async () => {
  const { app } = setup();
  await req(app, "PUT", `/api/v1/admin/sites/${SITE}`, { token: TOKEN, body: { origins: ["https://*.example.com"] } });
  const write = (origin) => post(app, { data: { choice: "A" } }, { origin });
  assert.equal((await write("https://a.example.com")).status, 201);
  assert.equal((await write("https://a.b.example.com")).status, 201);
  assert.equal((await write("https://example.com")).status, 403, "裸域不匹配");
  assert.equal((await write("http://a.example.com")).status, 403, "协议必须一致");
  assert.equal((await write("https://notexample.com")).status, 403);
});

test("通配共享托管域会被记警告", async () => {
  const { app } = setup();
  const logs = [];
  const dir = mkdtempSync(join(tmpdir(), "dataapi-"));
  const db = openDb(dir);
  const app2 = createApp({ db, config: { adminToken: TOKEN }, limiter: createRateLimiter(), log: (m) => logs.push(m) });
  await req(app2, "PUT", `/api/v1/admin/sites/${SITE}`, { token: TOKEN, body: { origins: ["https://*.figma.site"] } });
  assert.ok(logs.some((l) => l.includes("共享托管域")), "应记录警告");
  assert.ok(app); // 保持 setup 一致
});
