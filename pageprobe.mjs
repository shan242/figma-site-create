// pageprobe.mjs — "把产物页面真的打开看一眼"用的探针。
//
// 为什么需要:这一整轮排查里,"DOM 全对但页面上什么都没有"出现了很多次 ——
// 词云 canvas 存在却一个像素没画、面板带着 data-db-state="submitted" 却是 opacity 0、
// 控件在 HTML 里却点不动。**这些都不是结构问题,只有把页面真的渲染一遍、
// 读计算样式和像素才能发现。** 而 AI 看不到页面,所以必须由程序代替它的眼睛。
//
// 和 netfetch.mjs 同样的思路:两层实现,可替换。
//   · Electron 里:主进程注入一个隐藏 BrowserWindow 的实现(自带浏览器,不需要外部依赖);
//   · CLI 下:自己找一个本机 Chromium(Chrome / Edge / Chromium)用 CDP 驱动。
// 两者都只需要回答同一个问题:在页面里跑一段 JS,把结果拿回来。
let impl = null;

// Electron 侧在 app ready 之后注入。传 null 恢复默认(CLI 实现)。
export function setPageProbe(fn) {
  impl = typeof fn === "function" ? fn : null;
}

export const usingPageProbe = () => !!impl;

// 本机 Chromium 的常见位置。找不到就返回 null —— 上层要给出可读的说明,
// 而不是抛一个 ENOENT。
const CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function findBrowser() {
  for (const p of CANDIDATES) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

// 在页面里跑一段表达式并拿回结果(值必须可 JSON 序列化)。
// script 形如 "(function(){ ... return {...}; })()"。
async function cliProbe(url, script, { timeoutMs = 45000 } = {}) {
  const { spawn } = await import("node:child_process");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const bin = findBrowser();
  if (!bin) throw new Error(`找不到可用的浏览器(Chrome / Edge / Chromium)。设 CHROME_PATH 环境变量指定一个,或改用桌面版程序运行(check_page 在 GUI 里用内置浏览器,不需要外部依赖)。`);

  const port = 9200 + Math.floor(Math.random() * 500);
  const proc = spawn(bin, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--window-size=1440,900", `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(tmpdir(), "replica-probe-" + port)}`, "about:blank",
  ], { stdio: "ignore" });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const started = Date.now();
  try {
    // 等调试端口起来
    let target = null;
    while (Date.now() - started < 15000) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
        if (r.ok) { target = await r.json(); break; }
      } catch {}
      await sleep(300);
    }
    if (!target) throw new Error("浏览器启动超时(调试端口没起来)");

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("连不上调试通道")); });
    let id = 0;
    const pend = new Map();
    const errors = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
      else if (m.method === "Runtime.exceptionThrown") errors.push(String(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || "").slice(0, 300));
    };
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(Number(process.env.REPLICA_PROBE_WAIT || 6000));
    const r = await send("Runtime.evaluate", { expression: script, returnByValue: true, awaitPromise: true });
    ws.close();
    if (r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description || "页面里执行出错").slice(0, 300));
    return { value: r.result?.result?.value, errors };
  } finally {
    try { proc.kill(); } catch {}
  }
}

export function pageProbe(url, script, opts) {
  return (impl || cliProbe)(url, script, opts);
}

import { existsSync } from "node:fs";
