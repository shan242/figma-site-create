// server.mjs — 启动入口。把 node:http 的请求桥接到 app.mjs 的 fetch 风格 handler。
//
// 单进程是刻意的:SQLite 的写串行化依赖它。用 systemd Restart=always 守护。
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { openDb } from "./db.mjs";
import { createApp } from "./app.mjs";
import { createRateLimiter } from "./ratelimit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3210);
const DATA_DIR = process.env.DATA_DIR || join(HERE, "data");
const TRUST_PROXY = process.env.TRUST_PROXY !== "0";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const startedAt = Date.now();
const freshlyCreated = !existsSync(join(DATA_DIR, "config.json"));

const config = loadConfig(DATA_DIR);
const db = openDb(DATA_DIR);
const limiter = createRateLimiter();
const log = (msg) => {
  if (LOG_LEVEL !== "silent") console.log(`${new Date().toISOString()} ${msg}`);
};
const app = createApp({ db, config, limiter, log });

// 反代后真实来源在 X-Forwarded-For 的第一段
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "";
}

const server = createServer(async (req, res) => {
  const url = `http://${req.headers.host || "localhost"}${req.url}`;
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    body,
  });
  let response;
  try {
    response = await app.handle(request, { ip: clientIp(req), startedAt });
  } catch (e) {
    log(`error: ${e.stack || e.message}`);
    response = new Response(JSON.stringify({ ok: false, error: { code: "INTERNAL", message: "服务内部错误" } }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  const headers = {};
  response.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

server.listen(PORT, () => {
  log(`data-api listening on :${PORT}  (data dir ${DATA_DIR})`);
  if (freshlyCreated) {
    console.log("");
    console.log("────────────────────────────────────────────────────────────");
    console.log(" 首次启动,已生成管理令牌(Admin Token)");
    console.log(" 把它填进软件「发布设置 → 数据后端」,此后不再需要:");
    console.log("");
    console.log(`   ${config.adminToken}`);
    console.log("");
    console.log(" 该令牌只应保存在软件端,绝不能写进生成的网页。");
    console.log("────────────────────────────────────────────────────────────");
    console.log("");
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`${sig} received, closing`);
    server.close(() => {
      try {
        db.raw.close();
      } catch {}
      process.exit(0);
    });
  });
}
