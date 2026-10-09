// app.mjs — 请求处理。纯 WHATWG Request → Response,不碰 socket,
// 所以测试可以直接构造请求、不需要监听端口。
//
// 契约见 docs/data-api.md。路由只有三层:
//   /api/v1/health
//   /api/v1/admin/**            Bearer adminToken
//   /api/v1/{site}/{collection}[/mine|/stats]      公开,按 Origin 白名单放行
import { CLIENT_RE, FIELD_RE, isClient, isCollection, isField, isSite, originAllowed, wildcardOverSharedHost } from "./slug.mjs";
import { hashClient, hashIp } from "./db.mjs";

const MAX_BODY = 16 * 1024; // 传输上限;业务上限 4KB 在 validateData 里
const MAX_DATA_KEYS = 16;
const MAX_DATA_BYTES = 4096;
const MAX_STRING = 500;
const MAX_DEPTH = 3;
const PUBLIC_TOTAL_LIMIT = 100;

const LIMITS = {
  // [按站点, 按 IP]
  post: [60, 20],
  get: [600, 120],
  mine: [120, 40],
  stats: [300, 60],
};
const WINDOW_MS = 60_000;

const MSG = {
  BAD_REQUEST: "请求格式不正确",
  ORIGIN_DENIED: "该来源未被允许访问此数据",
  SITE_NOT_FOUND: "站点未注册,请先在软件中发布一次",
  COLLECTION_NOT_FOUND: "数据集合不存在",
  METHOD_NOT_ALLOWED: "不支持的请求方法",
  PAYLOAD_TOO_LARGE: "提交内容过大",
  RATE_LIMITED: "请求过于频繁,请稍后再试",
  QUOTA_EXCEEDED: "该集合已达到存储上限,暂时无法提交",
  DISABLED: "该功能已被管理员停用",
  INTERNAL: "服务内部错误",
  UNAUTHORIZED: "管理令牌无效",
};

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}
// 第 4 个参数是**响应头**(CORS / Retry-After),不是 body 字段 ——
// 早先把 headers 合并进 error 对象,导致 Retry-After 根本没发出去。
const fail = (status, code, message, headers = {}) =>
  json(status, { ok: false, error: { code, message: message || MSG[code] || "请求失败" } }, headers);

// --- 输入校验(契约 §2.4) -----------------------------------------------------

function depthOf(v, d = 1) {
  if (v === null || typeof v !== "object") return d;
  let max = d;
  for (const x of Object.values(v)) max = Math.max(max, depthOf(x, d + 1));
  return max;
}

function validateData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "data 必须是 JSON 对象";
  const keys = Object.keys(data);
  if (keys.length > MAX_DATA_KEYS) return `data 字段数不能超过 ${MAX_DATA_KEYS}`;
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_DATA_BYTES) return `data 不能超过 ${MAX_DATA_BYTES} 字节`;
  if (depthOf(data) > MAX_DEPTH) return `data 嵌套不能超过 ${MAX_DEPTH} 层`;
  for (const [k, v] of Object.entries(data)) {
    if (!FIELD_RE.test(k)) return `字段名不合法: ${k}`;
    if (typeof v === "string" && v.length > MAX_STRING) return `字段 ${k} 超过 ${MAX_STRING} 字符`;
  }
  return null;
}

async function readJson(request) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_BODY) return { error: "PAYLOAD_TOO_LARGE" };
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY) return { error: "PAYLOAD_TOO_LARGE" };
  if (!text.trim()) return { value: undefined };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: "BAD_REQUEST" };
  }
}

// --- 应用 --------------------------------------------------------------------

export function createApp({ db, config, limiter, now = () => Date.now(), log = () => {} }) {
  const corsFor = (origin, patterns) => {
    if (!origin) return {}; // 非浏览器请求(curl)无需 CORS 头
    if (!originAllowed(origin, patterns)) return null;
    return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  };

  const preflight = (origin, patterns) => {
    if (!origin) return new Response(null, { status: 204 });
    if (!originAllowed(origin, patterns)) return fail(403, "ORIGIN_DENIED");
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      },
    });
  };

  const limited = (bucket, siteSlug, ipHash) => {
    const [perSite, perIp] = LIMITS[bucket];
    const a = limiter.check(`site:${siteSlug}:${bucket}`, perSite, WINDOW_MS);
    if (!a.ok) return a;
    if (ipHash) {
      const b = limiter.check(`ip:${ipHash}:${bucket}`, perIp, WINDOW_MS);
      if (!b.ok) return b;
    }
    return { ok: true };
  };

  const adminAuth = (request) => {
    const h = request.headers.get("authorization") || "";
    const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    return token && token === config.adminToken;
  };

  async function handle(request, ctx = {}) {
    const url = new URL(request.url);
    const seg = url.pathname.split("/").filter(Boolean);
    const method = request.method.toUpperCase();
    const ip = ctx.ip || "";
    const ipHash = ip ? hashIp(config.ipSalt, ip, new Date(now()).toISOString().slice(0, 10)) : "";

    if (seg[0] !== "api" || seg[1] !== "v1") return fail(404, "BAD_REQUEST", "未知接口");

    // --- health -------------------------------------------------------------
    if (seg[2] === "health" && seg.length === 3) {
      return json(200, { ok: true, version: "1.0.0", uptimeSec: Math.floor((now() - ctx.startedAt) / 1000) }, { "Access-Control-Allow-Origin": "*" });
    }

    // --- admin --------------------------------------------------------------
    if (seg[2] === "admin") {
      if (!adminAuth(request)) return fail(401, "UNAUTHORIZED");
      return handleAdmin(request, seg, url, method);
    }

    // --- 公开接口 -----------------------------------------------------------
    const siteSlug = seg[2];
    const collection = seg[3];
    const sub = seg[4];
    if (!isSite(siteSlug)) return fail(404, "SITE_NOT_FOUND");
    if (seg.length > 5) return fail(404, "BAD_REQUEST", "未知接口");
    if (collection !== undefined && !isCollection(collection)) return fail(404, "COLLECTION_NOT_FOUND");

    const site = db.getSite(siteSlug);
    if (!site) return fail(404, "SITE_NOT_FOUND");

    const origin = request.headers.get("origin");
    if (method === "OPTIONS") return preflight(origin, site.origins);
    const cors = corsFor(origin, site.origins);
    if (cors === null) return fail(403, "ORIGIN_DENIED");
    if (site.disabled) return fail(503, "DISABLED", MSG.DISABLED, cors);

    // v1 里集合是必填的(没有"站点信息"接口)
    if (collection === undefined) return fail(404, "COLLECTION_NOT_FOUND", MSG.COLLECTION_NOT_FOUND, cors);

    // GET /{site}/{collection}
    if (method === "GET" && sub === undefined) {
      const r = limited("get", siteSlug, ipHash);
      if (!r.ok) return fail(429, "RATE_LIMITED", MSG.RATE_LIMITED, { ...cors, "Retry-After": String(r.retryAfterSec) });
      const coll = db.getCollection(siteSlug, collection);
      if (!coll) return fail(404, "COLLECTION_NOT_FOUND", MSG.COLLECTION_NOT_FOUND, cors);
      if (coll.disabled) return fail(503, "DISABLED", MSG.DISABLED, cors);
      const limit = clampInt(url.searchParams.get("limit"), 20, 1, PUBLIC_TOTAL_LIMIT);
      const order = url.searchParams.get("order") === "asc" ? "asc" : "desc";
      const since = isoOrNull(url.searchParams.get("since"));
      const fields = (url.searchParams.get("fields") || "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => isField(s));
      const out = db.listRecords({ site: siteSlug, collection, limit, order, since, fields: fields.length ? fields : null });
      return json(200, { ok: true, ...out }, cors);
    }

    // GET /{site}/{collection}/mine
    if (method === "GET" && sub === "mine") {
      const r = limited("mine", siteSlug, ipHash);
      if (!r.ok) return fail(429, "RATE_LIMITED", MSG.RATE_LIMITED, { ...cors, "Retry-After": String(r.retryAfterSec) });
      const client = url.searchParams.get("client") || "";
      if (!isClient(client)) return fail(400, "BAD_REQUEST", "client 参数不合法", cors);
      const limit = clampInt(url.searchParams.get("limit"), 20, 1, PUBLIC_TOTAL_LIMIT);
      const clientHash = hashClient(site.salt, client);
      const out = db.listRecords({ site: siteSlug, collection, limit, order: "desc", clientHash });
      return json(200, { ok: true, ...out }, cors);
    }

    // GET /{site}/{collection}/stats
    if (method === "GET" && sub === "stats") {
      const r = limited("stats", siteSlug, ipHash);
      if (!r.ok) return fail(429, "RATE_LIMITED", MSG.RATE_LIMITED, { ...cors, "Retry-After": String(r.retryAfterSec) });
      const field = url.searchParams.get("field") || "";
      if (!isField(field)) return fail(400, "BAD_REQUEST", "field 参数不合法", cors);
      const limit = clampInt(url.searchParams.get("limit"), 10, 1, PUBLIC_TOTAL_LIMIT);
      const since = isoOrNull(url.searchParams.get("since"));
      const out = db.stats({ site: siteSlug, collection, field, limit, since });
      return json(200, { ok: true, ...out }, cors);
    }

    // POST /{site}/{collection}
    if (method === "POST" && collection !== undefined && sub === undefined) {
      const r = limited("post", siteSlug, ipHash);
      if (!r.ok) return fail(429, "RATE_LIMITED", MSG.RATE_LIMITED, { ...cors, "Retry-After": String(r.retryAfterSec) });
      const body = await readJson(request);
      if (body.error) return fail(body.error === "PAYLOAD_TOO_LARGE" ? 413 : 400, body.error, undefined, cors);
      const payload = body.value;
      if (!payload || typeof payload !== "object") return fail(400, "BAD_REQUEST", "请求体必须是 JSON 对象", cors);
      const bad = validateData(payload.data);
      if (bad) return fail(400, "BAD_REQUEST", bad, cors);
      if (payload.client !== undefined && !isClient(payload.client)) return fail(400, "BAD_REQUEST", "client 不合法", cors);

      const coll = db.ensureCollection(siteSlug, collection);
      if (coll.disabled) return fail(503, "DISABLED", MSG.DISABLED, cors);

      // 集合级字段白名单:不在表里的字段直接丢弃
      let data = payload.data;
      if (coll.writeFields?.length) {
        data = Object.fromEntries(Object.entries(data).filter(([k]) => coll.writeFields.includes(k)));
      }

      const q = db.quotaOf(siteSlug, collection);
      if (q.count >= q.maxRecordsPerCollection || q.bytes >= q.maxBytesPerCollection) {
        return fail(429, "QUOTA_EXCEEDED", MSG.QUOTA_EXCEEDED, cors);
      }

      const rec = db.insertRecord({
        site: siteSlug,
        collection,
        data,
        meta: payload.meta,
        clientHash: payload.client ? hashClient(site.salt, payload.client) : null,
        ipHash,
      });
      return json(201, { ok: true, id: rec.id, createdAt: rec.createdAt, replaced: rec.replaced }, cors);
    }

    return fail(405, "METHOD_NOT_ALLOWED");
  }

  // --- 管理端 -----------------------------------------------------------------
  async function handleAdmin(request, seg, url, method) {
    const sub = seg[3];

    // /admin/sites
    if (sub === "sites") {
      if (seg.length === 4 && method === "GET") return json(200, { ok: true, sites: db.listSites() });
      const slug = seg[4];
      if (seg.length === 5 && isSite(slug)) {
        if (method === "PUT") {
          const body = await readJson(request);
          if (body.error) return fail(body.error === "PAYLOAD_TOO_LARGE" ? 413 : 400, body.error);
          const p = body.value || {};
          if (!Array.isArray(p.origins) || !p.origins.length) return fail(400, "BAD_REQUEST", "origins 必须是非空数组");
          for (const o of p.origins) {
            try {
              new URL(o);
            } catch {
              return fail(400, "BAD_REQUEST", `origins 不是合法来源: ${o}`);
            }
          }
          const site = db.upsertSite({ slug, origins: p.origins, note: p.note, quota: p.quota, collections: p.collections });
          const risky = wildcardOverSharedHost(p.origins);
          if (risky) log(`warn: 站点 ${slug} 的白名单通配了共享托管域 *.${risky},后端将对该域下所有站点开放`);
          return json(200, { ok: true, site });
        }
        if (method === "DELETE") return json(200, { ok: true, deleted: db.deleteSite(slug) });
      }
      if (seg.length === 6 && isSite(slug) && (seg[5] === "disable" || seg[5] === "enable") && method === "POST") {
        return json(200, { ok: true, site: db.setSiteDisabled(slug, seg[5] === "disable") });
      }
      return fail(404, "BAD_REQUEST", "未知管理接口");
    }

    // /admin/stats
    if (sub === "stats" && seg.length === 4 && method === "GET") {
      return json(200, { ok: true, ...db.globalStats() });
    }

    // /admin/{site}/...
    const siteSlug = seg[3];
    if (!isSite(siteSlug)) return fail(404, "SITE_NOT_FOUND");
    if (!db.getSite(siteSlug)) return fail(404, "SITE_NOT_FOUND");

    if (seg.length === 5 && seg[4] === "collections" && method === "GET") {
      return json(200, { ok: true, collections: db.listCollections(siteSlug) });
    }

    const collection = seg[4];
    if (!isCollection(collection)) return fail(404, "COLLECTION_NOT_FOUND");

    if (seg.length === 5) {
      if (method === "GET") {
        const limit = clampInt(url.searchParams.get("limit"), 100, 1, 1000);
        const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
        return json(200, { ok: true, ...db.listRecordsAdmin({ site: siteSlug, collection, limit, offset }) });
      }
      if (method === "DELETE") return json(200, { ok: true, deleted: db.clearCollection(siteSlug, collection) });
      if (method === "PATCH") {
        const body = await readJson(request);
        if (body.error) return fail(400, body.error);
        const coll = db.updateCollection(siteSlug, collection, body.value || {});
        if (!coll) return fail(404, "COLLECTION_NOT_FOUND");
        return json(200, { ok: true, collection: coll });
      }
    }

    if (seg.length === 6 && method === "DELETE") {
      const id = Number(seg[5]);
      if (!Number.isSafeInteger(id)) return fail(400, "BAD_REQUEST", "id 必须是整数");
      return json(200, { ok: true, deleted: db.deleteRecord(siteSlug, collection, id) });
    }

    return fail(404, "BAD_REQUEST", "未知管理接口");
  }

  return { handle };
}

function clampInt(raw, dflt, lo, hi) {
  // 注意 Number(null) === 0:参数缺省时必须先判空,否则会被夹到 lo
  if (raw === null || raw === undefined || String(raw).trim() === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

function isoOrNull(raw) {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
