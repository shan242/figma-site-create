// verify.mjs — Compare computed text styles between the live site and the local
// replica by driving headless Chrome over the DevTools Protocol.
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9333;
const PROFILE = "C:/Users/hxy/AppData/Local/Temp/cdp-profile";

const url = process.argv[2];
const outFile = process.argv[3];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
chrome.on("error", (e) => { console.error("chrome spawn error:", e.message); process.exit(1); });

await sleep(1500);

const target = await (await fetch(`http://localhost:${PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) =>
  new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url });

// Wait for load + fonts, then a little more so images/layout settle.
await sleep(4500);
await send("Runtime.evaluate", {
  expression: `document.fonts.ready.then(() => true)`,
  awaitPromise: true,
  returnByValue: true,
});
await sleep(1500);

const expr = `(() => {
  const out = [];
  const skipTags = new Set(["SCRIPT", "STYLE", "META", "LINK", "HEAD"]);
  for (const el of document.querySelectorAll("body *")) {
    if (skipTags.has(el.tagName)) continue;
    if (el.querySelector("p, div, span, a, h1, h2, h3, h4, h5, li")) continue;
    const txt = (el.textContent || "").replace(/\\s+/g, " ").trim();
    if (!txt) continue;
    const cs = getComputedStyle(el);
    out.push({
      t: txt.slice(0, 70),
      fs: parseFloat(cs.fontSize),
      fw: cs.fontWeight,
      ff: (cs.fontFamily || "").split(",")[0].replace(/["']/g, "").trim(),
      lh: cs.lineHeight,
      c: cs.color,
      ta: cs.textAlign,
      ls: parseFloat(cs.letterSpacing),
    });
  }
  return out;
})()`;

const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
const value = res.result?.result?.value;
writeFileSync(outFile, JSON.stringify(value, null, 1));
console.log(`captured ${value?.length || 0} text elements -> ${outFile}`);
ws.close();
chrome.kill();
