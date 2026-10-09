// db.mjs — node:sqlite 封装。schema / 查询 / 配额记账都在这里。
//
// 之所以能用内置 SQLite:Node 24 起 node:sqlite 无需任何开关;prepare/run/all/get
// 与 json_extract 的**绑定路径参数**都可用(见 test/)。绑定参数是关键 —— 聚合字段名
// 是用户输入,拼进 SQL 就是注入。
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_QUOTA = { maxRecordsPerCollection: 100000, maxBytesPerCollection: 52428800 };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sites (
  slug        TEXT PRIMARY KEY,
  origins     TEXT NOT NULL,
  note        TEXT,
  quota       TEXT,
  salt        TEXT NOT NULL,
  disabled    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collections (
  site         TEXT NOT NULL,
  name         TEXT NOT NULL,
  mode         TEXT NOT NULL DEFAULT 'append',
  write_fields TEXT,
  count        INTEGER NOT NULL DEFAULT 0,
  bytes        INTEGER NOT NULL DEFAULT 0,
  disabled     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (site, name)
);
CREATE TABLE IF NOT EXISTS records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site        TEXT NOT NULL,
  collection  TEXT NOT NULL,
  data        TEXT NOT NULL,
  meta        TEXT,
  client_hash TEXT,
  ip_hash     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_list   ON records (site, collection, id DESC);
CREATE INDEX IF NOT EXISTS idx_records_client ON records (site, collection, client_hash);
`;

const iso = (ms) => new Date(ms).toISOString();
const parse = (s, fallback = null) => {
  if (s === null || s === undefined || s === "") return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};
const asNum = (v) => (typeof v === "bigint" ? Number(v) : v);

export function openDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "data.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);

  const stmt = (sql) => db.prepare(sql);

  // --- sites ---------------------------------------------------------------
  const siteGet = stmt("SELECT * FROM sites WHERE slug = ?");
  const siteAll = stmt("SELECT * FROM sites ORDER BY created_at");
  const siteDel = stmt("DELETE FROM sites WHERE slug = ?");

  const siteRow = (r) =>
    r && {
      site: r.slug,
      origins: parse(r.origins, []),
      note: r.note || undefined,
      quota: parse(r.quota, null) || undefined,
      disabled: !!r.disabled,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };

  const api = {
    raw: db,

    getSite(slug) {
      return siteRow(siteGet.get(slug));
    },

    listSites() {
      const counts = stmt(
        "SELECT site, COALESCE(SUM(count),0) AS records, COALESCE(SUM(bytes),0) AS bytes FROM collections GROUP BY site",
      ).all();
      const bySite = new Map(counts.map((c) => [c.site, c]));
      return siteAll.all().map((r) => {
        const c = bySite.get(r.slug) || { records: 0, bytes: 0 };
        return { ...siteRow(r), records: asNum(c.records), bytes: asNum(c.bytes) };
      });
    },

    // 幂等:同名重复 PUT 就是更新(契约 §4.2)
    upsertSite({ slug, origins, note, quota, collections }) {
      const t = iso(Date.now());
      const existing = siteGet.get(slug);
      if (existing) {
        stmt("UPDATE sites SET origins = ?, note = ?, quota = ?, updated_at = ? WHERE slug = ?").run(
          JSON.stringify(origins || []),
          note ?? existing.note ?? null,
          quota ? JSON.stringify(quota) : existing.quota,
          t,
          slug,
        );
      } else {
        stmt("INSERT INTO sites (slug, origins, note, quota, salt, disabled, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?)").run(
          slug,
          JSON.stringify(origins || []),
          note ?? null,
          quota ? JSON.stringify(quota) : null,
          randomBytes(16).toString("hex"),
          t,
          t,
        );
      }
      for (const [name, cfg] of Object.entries(collections || {})) {
        api.ensureCollection(slug, name, cfg);
      }
      return api.getSite(slug);
    },

    setSiteDisabled(slug, disabled) {
      stmt("UPDATE sites SET disabled = ?, updated_at = ? WHERE slug = ?").run(disabled ? 1 : 0, iso(Date.now()), slug);
      return api.getSite(slug);
    },

    deleteSite(slug) {
      db.exec("BEGIN");
      try {
        stmt("DELETE FROM records WHERE site = ?").run(slug);
        stmt("DELETE FROM collections WHERE site = ?").run(slug);
        const r = siteDel.run(slug);
        db.exec("COMMIT");
        return asNum(r.changes) > 0;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },

    // --- collections -------------------------------------------------------
    getCollection(site, name) {
      const r = stmt("SELECT * FROM collections WHERE site = ? AND name = ?").get(site, name);
      return (
        r && {
          collection: r.name,
          mode: r.mode,
          writeFields: parse(r.write_fields, null) || undefined,
          count: asNum(r.count),
          bytes: asNum(r.bytes),
          disabled: !!r.disabled,
          createdAt: r.created_at,
        }
      );
    },

    listCollections(site) {
      return stmt("SELECT name FROM collections WHERE site = ? ORDER BY name")
        .all(site)
        .map((r) => api.getCollection(site, r.name));
    },

    // 未声明则按 append 自动创建(契约 §3.1)
    ensureCollection(site, name, cfg = {}) {
      const cur = api.getCollection(site, name);
      if (cur) {
        if (cfg.mode || cfg.writeFields) {
          stmt("UPDATE collections SET mode = ?, write_fields = ? WHERE site = ? AND name = ?").run(
            cfg.mode === "single" ? "single" : cur.mode,
            cfg.writeFields ? JSON.stringify(cfg.writeFields) : cur.writeFields ? JSON.stringify(cur.writeFields) : null,
            site,
            name,
          );
        }
        return api.getCollection(site, name);
      }
      stmt("INSERT INTO collections (site, name, mode, write_fields, count, bytes, disabled, created_at) VALUES (?,?,?,?,0,0,0,?)").run(
        site,
        name,
        cfg.mode === "single" ? "single" : "append",
        cfg.writeFields ? JSON.stringify(cfg.writeFields) : null,
        iso(Date.now()),
      );
      return api.getCollection(site, name);
    },

    updateCollection(site, name, patch = {}) {
      const cur = api.getCollection(site, name);
      if (!cur) return null;
      stmt("UPDATE collections SET mode = ?, write_fields = ?, disabled = ? WHERE site = ? AND name = ?").run(
        patch.mode === "single" || patch.mode === "append" ? patch.mode : cur.mode,
        patch.writeFields !== undefined
          ? patch.writeFields
            ? JSON.stringify(patch.writeFields)
            : null
          : cur.writeFields
            ? JSON.stringify(cur.writeFields)
            : null,
        patch.disabled !== undefined ? (patch.disabled ? 1 : 0) : cur.disabled ? 1 : 0,
        site,
        name,
      );
      return api.getCollection(site, name);
    },

    clearCollection(site, name) {
      db.exec("BEGIN");
      try {
        const r = stmt("DELETE FROM records WHERE site = ? AND collection = ?").run(site, name);
        stmt("UPDATE collections SET count = 0, bytes = 0 WHERE site = ? AND name = ?").run(site, name);
        db.exec("COMMIT");
        return asNum(r.changes);
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },

    quotaOf(site, collection) {
      const s = api.getSite(site);
      const c = api.getCollection(site, collection);
      return { ...DEFAULT_QUOTA, ...(s?.quota || {}), count: c?.count ?? 0, bytes: c?.bytes ?? 0 };
    },

    // --- records -----------------------------------------------------------
    // mode=single 时同一 client 的旧记录被替换,整个过程在同一事务里(契约 §5)。
    insertRecord({ site, collection, data, meta, clientHash, ipHash }) {
      const t = iso(Date.now());
      const json = JSON.stringify(data);
      const bytes = Buffer.byteLength(json, "utf8");
      const coll = api.getCollection(site, collection);
      const mode = coll?.mode === "single" ? "single" : "append";
      db.exec("BEGIN");
      try {
        let replaced = false;
        if (mode === "single" && clientHash) {
          // records 表没有 bytes 列,用 UTF-8 字节长度记账(与 Buffer.byteLength 一致)
          const prev = stmt(
            "SELECT id, LENGTH(CAST(data AS BLOB)) AS n FROM records WHERE site = ? AND collection = ? AND client_hash = ?",
          ).all(site, collection, clientHash);
          if (prev.length) {
            replaced = true;
            const freed = prev.reduce((n, r) => n + asNum(r.n || 0), 0);
            stmt("DELETE FROM records WHERE site = ? AND collection = ? AND client_hash = ?").run(site, collection, clientHash);
            stmt("UPDATE collections SET count = MAX(0, count - ?), bytes = MAX(0, bytes - ?) WHERE site = ? AND name = ?").run(
              prev.length,
              freed,
              site,
              collection,
            );
          }
        }
        const r = stmt(
          "INSERT INTO records (site, collection, data, meta, client_hash, ip_hash, created_at) VALUES (?,?,?,?,?,?,?)",
        ).run(site, collection, json, meta ? JSON.stringify(meta) : null, clientHash || null, ipHash || null, t);
        const id = asNum(r.lastInsertRowid);
        stmt("UPDATE collections SET count = count + 1, bytes = bytes + ? WHERE site = ? AND name = ?").run(bytes, site, collection);
        db.exec("COMMIT");
        return { id, createdAt: t, replaced, bytes };
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },

    listRecords({ site, collection, limit, order = "desc", since, fields, clientHash }) {
      const where = ["site = ?", "collection = ?"];
      const params = [site, collection];
      if (since) {
        where.push("created_at >= ?");
        params.push(since);
      }
      if (clientHash) {
        where.push("client_hash = ?");
        params.push(clientHash);
      }
      const rows = stmt(
        `SELECT id, data, created_at FROM records WHERE ${where.join(" AND ")} ORDER BY id ${order === "asc" ? "ASC" : "DESC"} LIMIT ?`,
      ).all(...params, limit);
      const totalRow = stmt(`SELECT COUNT(*) AS n FROM records WHERE ${where.join(" AND ")}`).get(...params);
      const total = asNum(totalRow.n);
      const items = rows.map((r) => {
        const d = parse(r.data, {});
        return {
          id: asNum(r.id),
          data: fields?.length ? Object.fromEntries(Object.entries(d).filter(([k]) => fields.includes(k))) : d,
          createdAt: r.created_at,
        };
      });
      return { items, total, hasMore: items.length < total && items.length >= limit };
    },

    // 管理端:带 meta / clientHash,便于风控定位
    listRecordsAdmin({ site, collection, limit, offset }) {
      const rows = stmt(
        "SELECT id, data, meta, client_hash, ip_hash, created_at FROM records WHERE site = ? AND collection = ? ORDER BY id DESC LIMIT ? OFFSET ?",
      ).all(site, collection, limit, offset);
      const total = asNum(stmt("SELECT COUNT(*) AS n FROM records WHERE site = ? AND collection = ?").get(site, collection).n);
      return {
        items: rows.map((r) => ({
          id: asNum(r.id),
          data: parse(r.data, {}),
          meta: parse(r.meta, undefined),
          clientHash: r.client_hash || undefined,
          createdAt: r.created_at,
        })),
        total,
      };
    },

    // 聚合:路径作为**绑定参数**,字段名已过白名单(契约 §5)。
    // 参数顺序必须与 SQL 中的 ? 一致:路径 → site → collection → [since] → limit
    stats({ site, collection, field, limit, since }) {
      const where = ["site = ?", "collection = ?"];
      const params = [site, collection];
      if (since) {
        where.push("created_at >= ?");
        params.push(since);
      }
      const rows = stmt(
        `SELECT json_extract(data, ?) AS k, COUNT(*) AS n FROM records WHERE ${where.join(" AND ")} GROUP BY k ORDER BY n DESC, k ASC LIMIT ?`,
      ).all(`$.${field}`, ...params, limit);
      const total = asNum(stmt(`SELECT COUNT(*) AS n FROM records WHERE ${where.join(" AND ")}`).get(...params).n);
      return {
        field,
        total,
        buckets: rows.map((r) => ({ key: r.k === null || r.k === undefined ? null : String(r.k), count: asNum(r.n) })),
      };
    },

    deleteRecord(site, collection, id) {
      db.exec("BEGIN");
      try {
        const row = stmt("SELECT LENGTH(CAST(data AS BLOB)) AS n FROM records WHERE id = ? AND site = ? AND collection = ?").get(
          id,
          site,
          collection,
        );
        const r = stmt("DELETE FROM records WHERE id = ? AND site = ? AND collection = ?").run(id, site, collection);
        if (asNum(r.changes) > 0) {
          stmt("UPDATE collections SET count = MAX(0, count - 1), bytes = MAX(0, bytes - ?) WHERE site = ? AND name = ?").run(
            asNum(row?.n || 0),
            site,
            collection,
          );
        }
        db.exec("COMMIT");
        return asNum(r.changes) > 0;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },

    globalStats() {
      const sites = asNum(stmt("SELECT COUNT(*) AS n FROM sites").get().n);
      const collections = asNum(stmt("SELECT COUNT(*) AS n FROM collections").get().n);
      const records = asNum(stmt("SELECT COUNT(*) AS n FROM records").get().n);
      const bytes = asNum(stmt("SELECT COALESCE(SUM(bytes),0) AS n FROM collections").get().n);
      return { sites, collections, records, bytes };
    },
  };

  return api;
}

// client_hash = sha256(站点盐 + client);IP 哈希用每日轮换的主盐(契约 §6.1)。
export const hashClient = (salt, client) => createHash("sha256").update(`${salt}:${client}`).digest("hex");
export const hashIp = (ipSalt, ip, day) => createHash("sha256").update(`${ipSalt}:${day}:${ip}`).digest("hex");
