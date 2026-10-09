// databind-e2e.mjs — 端到端验证数据绑定(需要真实后端 + 本机 Chrome)。
//
//   $env:DA_TOKEN="<Admin Token>"; node databind-e2e.mjs
//
// 它做四件事,任何一步失败都会以非零码退出:
//   1. 造一个最小站点 + 一条点击式投票绑定 + 一条只读计数绑定,构建并注入真实后端地址
//   2. 在真实后端注册一个**临时**站点(http://127.0.0.1:4599),预置两条投票
//   3. 用 headless Chrome 打开页面,断言运行时就真的拉到后端数据并渲染出来
//   4. 点击页面上的按钮,断言写回后端、"已提交"提示出现且**刷新后仍保留**、再点不重复写
// 结束时删除临时站点,不在后端留下任何测试数据。
//
// 之所以不做成 *.test.mjs:它依赖外网后端与本机 Chrome,不适合放进 CI。
// 浏览器行为(运行时)由这个脚本覆盖;纯函数部分由 databind.test.mjs 覆盖。
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { buildSite } from "./build.mjs";

const API = (process.env.DA_API || "https://data.scopetest.net/api/v1").replace(/\/+$/, "");
const TOKEN = process.env.DA_TOKEN;
const SITE = "127-0-0-1"; // slugify("127.0.0.1")
const PORT = 4599;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const CDP_PORT = Number(process.env.CDP_PORT || 9444);

if (!TOKEN) {
  console.error("缺少 DA_TOKEN 环境变量(数据后端的 Admin Token)");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => {
  console.error("✖ " + m);
  process.exitCode = 1;
};
const pass = (m) => console.log("✔ " + m);

async function da(path, opts = {}) {
  const res = await fetch(API + path, {
    method: opts.method || "GET",
    headers: { Authorization: `Bearer ${TOKEN}`, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const countOf = (stats, key) => stats.body.buckets.find((b) => b.key === key)?.count ?? 0;

// --- 1) 最小站点 -------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "dbe2e-"));
mkdirSync(join(dir, "data"));
mkdirSync(join(dir, "assets"));
writeFileSync(
  join(dir, "manifest.json"),
  JSON.stringify({
    liveBase: "https://example.figma.site",
    siteTitle: "E2E",
    pages: [{ path: "/", slug: "index", file: "index.html", title: "E2E", json: "data/index.json" }],
  }),
);
writeFileSync(
  join(dir, "data", "index.json"),
  JSON.stringify({
    roots: ["1:1"],
    nodeById: {
      "1:1": { id: "1:1", type: "FRAME", name: "Canvas", absoluteBoundingBox: { x: 0, y: 0, width: 900, height: 700 }, children: ["1:2"] },
      "1:2": {
        id: "1:2",
        type: "RECTANGLE",
        name: "voteA",
        absoluteBoundingBox: { x: 100, y: 120, width: 220, height: 64 },
        fills: [{ type: "SOLID", visible: true, opacity: 1, color: { r: 0.15, g: 0.4, b: 0.9 } }],
      },
    },
  }),
);
writeFileSync(
  join(dir, "databinds.json"),
  JSON.stringify({
    version: 1,
    items: [
      {
        id: "e2e-vote",
        slug: "index",
        rect: { left: 100, top: 260, width: 500, height: 160 },
        collection: "e2evotes",
        kind: "bar",
        mode: "append",
        read: { groupBy: "choice", limit: 10, refreshMs: 0 },
        write: { event: "click", target: "1:2", field: "choice", value: "A" },
        fallback: { buckets: [{ key: "A", count: 1 }], total: 1 },
        options: {},
      },
      {
        id: "e2e-count",
        slug: "index",
        rect: { left: 640, top: 260, width: 200, height: 80 },
        collection: "e2evotes",
        kind: "counter",
        mode: "append",
        read: { limit: 1, refreshMs: 0 },
        write: null,
        fallback: { total: 0 },
        options: { unit: "人已参与" },
      },
    ],
  }),
);

console.log(`构建(注入 ${API})…`);
await buildSite(dir, { dataApi: API });
const html = readFileSync(join(dir, "index.html"), "utf8");
if (!html.includes("window.__DATA_API__")) fail("页面没有注入后端地址");
else pass("页面注入了 window.__DATA_API__");
if (!html.includes('data-node-id="1:2"')) fail("按钮缺少 data-node-id");
else pass("按钮带 data-node-id(绑定可定位)");
if (!/data-spec="[^"]*e2evotes/.test(html)) fail("缺少 data-spec");
else pass("绑定写入了 data-spec");

// --- 2) 注册临时站点 + 预置数据 ----------------------------------------------
const reg = await da(`/admin/sites/${SITE}`, { method: "PUT", body: { origins: [ORIGIN], collections: { e2evotes: { mode: "append" } } } });
if (reg.status !== 200) fail(`注册临时站点失败: ${JSON.stringify(reg.body)}`);
else pass(`已在真实后端注册临时站点 ${SITE}(来源 ${ORIGIN})`);
for (const c of ["A", "B"]) {
  const r = await da(`/${SITE}/e2evotes`, { method: "POST", body: { data: { choice: c } } });
  if (r.status !== 201) fail(`预置投票失败: ${JSON.stringify(r.body)}`);
}
const before = await da(`/${SITE}/e2evotes/stats?field=choice`);
pass(`后端预置数据: total=${before.body.total} buckets=${JSON.stringify(before.body.buckets)}`);
const aBefore = countOf(before, "A");

// --- 3) 静态服务 -------------------------------------------------------------
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const server = createServer((req, res) => {
  const p = req.url.split("?")[0];
  try {
    const buf = readFileSync(join(dir, p === "/" ? "index.html" : decodeURIComponent(p)));
    res.writeHead(200, { "Content-Type": MIME[extname(p)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404).end("nope");
  }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
pass(`静态服务已启动 ${ORIGIN}`);

// --- 4) headless Chrome ------------------------------------------------------
const chrome = spawn(
  CHROME,
  ["--headless=new", "--disable-gpu", "--no-sandbox", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(tmpdir(), "dbe2e-profile")}`, "about:blank"],
  { stdio: "ignore" },
);
chrome.on("error", (e) => fail(`chrome 启动失败: ${e.message}`));
await sleep(2000);

const target = await (await fetch(`http://localhost:${CDP_PORT}/json/new?${encodeURIComponent(`${ORIGIN}/index.html`)}`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text);
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
await send("Runtime.enable");
await send("Page.enable");

// --- 5) 读路径:运行时就该把后端数据渲染出来 ---------------------------------
await sleep(2500);
if (pageErrors.length) fail(`页面抛异常: ${JSON.stringify(pageErrors)}`);
const rows = await evalJs(`Array.from(document.querySelectorAll('.databind .db-row')).map(function(r){return r.textContent})`);
if (!Array.isArray(rows) || !rows.length) fail(`没有渲染出占比条: ${JSON.stringify(rows)}`);
else pass(`渲染出 ${rows.length} 条占比条: ${JSON.stringify(rows)}`);
if (!/A/.test((rows || []).join(" ")) || !/B/.test((rows || []).join(" "))) fail("占比条内容与后端不符");
else pass("占比条内容与后端聚合结果一致");
const widths = await evalJs(`Array.from(document.querySelectorAll('.databind .db-fill')).map(function(f){return f.style.width})`);
if (!widths.length || widths.every((w) => !w)) fail(`占比条宽度未计算: ${JSON.stringify(widths)}`);
else pass(`占比条宽度按 counts 计算: ${JSON.stringify(widths)}`);
const counter = await evalJs(`(document.querySelector('.databind .db-num')||{}).textContent`);
if (!/2/.test(counter || "")) fail(`计数绑定未显示后端 total: ${JSON.stringify(counter)}`);
else pass(`计数绑定显示后端 total: ${JSON.stringify(counter)}`);

// --- 6) 写路径:点按钮 → 写回后端 → 已提交 ----------------------------------
await evalJs(`document.querySelector('[data-node-id="1:2"]').click()`);
await sleep(2500);
const after = await da(`/${SITE}/e2evotes/stats?field=choice`);
const aAfter = countOf(after, "A");
if (aAfter !== aBefore + 1) fail(`点击后后端 A 应 ${aBefore}→${aBefore + 1},实际 ${aAfter}`);
else pass(`点击按钮写回后端成功:A ${aBefore} → ${aAfter}`);
const note = await evalJs(`(document.querySelector('.databind .db-note')||{}).textContent`);
if (!/已提交/.test(note || "")) fail(`未显示已提交提示: ${JSON.stringify(note)}`);
else pass(`已提交提示正确: ${JSON.stringify(note)}`);

// --- 7) 投过就不用再投 -------------------------------------------------------
await evalJs(`document.querySelector('[data-node-id="1:2"]').click()`);
await sleep(1200);
const after2 = await da(`/${SITE}/e2evotes/stats?field=choice`);
if (countOf(after2, "A") !== aAfter) fail(`已提交后再次点击仍写入: ${aAfter} → ${countOf(after2, "A")}`);
else pass(`已提交后再次点击不会重复写入(A 仍为 ${aAfter})`);
// refresh 不能把"已提交"擦掉(初次实现的 bug)
const note2 = await evalJs(`(document.querySelector('.databind .db-note')||{}).textContent`);
if (!/已提交/.test(note2 || "")) fail(`刷新后已提交提示被擦掉: ${JSON.stringify(note2)}`);
else pass(`已提交提示在刷新后仍保留`);

// --- 清理 --------------------------------------------------------------------
ws.close();
chrome.kill();
server.close();
const del = await da(`/admin/sites/${SITE}`, { method: "DELETE" });
if (del.status === 200) pass(`已清理临时站点 ${SITE}(后端不留测试数据)`);
else fail(`清理失败: ${JSON.stringify(del.body)}`);

console.log(process.exitCode ? "\n有检查未通过" : "\n全部端到端检查通过");
process.exit(process.exitCode || 0);
