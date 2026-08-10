// main.js — Electron main process for the Figma Site Replica GUI.
//
// Runs scrape/build/chat from worker.cjs in-process and streams their console
// output to the renderer, so the packaged app needs no external Node or
// browser beyond the bundled Chromium.
//
// The chat agent is the AI editing surface: messages flow renderer → main via
// `chat:send`, the tool-calling loop runs here (the renderer never touches the
// filesystem), file/word-cloud edits are gated by human confirmation through
// `chat:resolve`, and the whole run can be cancelled with `chat:cancel`.
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require("electron");
const path = require("path");
const { writeFileSync, readFileSync, renameSync, existsSync } = require("fs");
const { scrapeSite, buildSite, runAgent, createDeepSeekModel, makeTools, publishSite, testPanel, machineCode: computeMachineCode, checkLicense } = require("./worker.cjs");

let win = null;
let chatRunning = false;
let chatAbort = null;
let publishRunning = false;
let publishAbort = null;
let licenseBlocked = false;
let licenseWasBlocked = false;
let licenseTimer = null;
const LICENSE_INTERVAL_MS = 30 * 60 * 1000;
let confirmSeq = 0;
const confirmWaiters = new Map();
const CONFIRM_TTL_MS = 5 * 60 * 1000;

// Tools whose successful run only shows up in the generated pages after a
// rebuild. The chat handler auto-rebuilds once at the end of a run if any of
// these succeeded, so an edit is visible without depending on the model
// remembering to call run_build.
const REBUILD_TOOLS = new Set(["write_file", "edit_text", "edit_node", "delete_edit", "delete_node_style", "apply_wordcloud", "delete_wordcloud", "append_css", "clear_css"]);

function defaultOutDir() {
  return path.join(app.getPath("home"), "replicate-out");
}

// --- AI config persistence (userData/config.json, key encrypted if possible) --

const configFile = () => path.join(app.getPath("userData"), "config.json");
const defaultConfig = () => ({ apiKey: "", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", autoApply: false, maxWords: 60, recentDirs: [], publish: { baseUrl: "", apiKey: "", domain: "", alias: "", groupID: 1 }, machineCode: "" });
const RECENT_DIRS_MAX = 8;

function decryptKey(v) {
  if (v && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(v, "base64"));
    } catch {
      return "";
    }
  }
  return typeof v === "string" ? v : "";
}

function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync(configFile(), "utf8"));
    raw.apiKey = decryptKey(raw.apiKey);
    if (raw.publish) raw.publish.apiKey = decryptKey(raw.publish.apiKey);
    const d = defaultConfig();
    return { ...d, ...raw, apiKey: raw.apiKey, publish: { ...d.publish, ...(raw.publish || {}) } };
  } catch {
    return defaultConfig();
  }
}

function saveConfig(cfg) {
  const prev = loadConfig();
  const out = { ...prev, ...cfg };
  // Empty apiKey in the payload means "keep the existing one" — only replace
  // when the user typed a new key.
  if (!cfg.apiKey && prev.apiKey) out.apiKey = prev.apiKey;
  if (out.apiKey && safeStorage.isEncryptionAvailable()) {
    out.apiKey = safeStorage.encryptString(out.apiKey).toString("base64");
  }
  // Same keep-old-when-empty rule for the publish API key, applied before the
  // unconditional encrypt below (which also re-encrypts keys loaded plaintext).
  const newPub = cfg.publish;
  if (newPub && !newPub.apiKey && prev.publish?.apiKey) out.publish.apiKey = prev.publish.apiKey;
  if (out.publish?.apiKey && safeStorage.isEncryptionAvailable()) {
    out.publish.apiKey = safeStorage.encryptString(out.publish.apiKey).toString("base64");
  }
  const file = configFile();
  writeFileSync(`${file}.tmp`, JSON.stringify(out, null, 2));
  renameSync(`${file}.tmp`, file);
}

// --- Machine-code licensing ------------------------------------------------
// The machine code is derived from hardware once and cached in config so every
// check sends the same identity. The built-in license server gets a check on
// startup, every 30 min, and before each scrape/build/chat/publish action; a
// blocked machine is told so and the GUI shows a generic error. A network blip
// keeps the last known state — blocking a machine is what revokes it, not a
// lost connection.

function getOrCreateMachineCode() {
  const cfg = loadConfig();
  if (cfg.machineCode) return cfg.machineCode;
  const code = computeMachineCode();
  saveConfig({ machineCode: code });
  return code;
}

async function refreshLicense() {
  try {
    const r = await checkLicense({ machineCode: getOrCreateMachineCode() });
    licenseBlocked = !r.ok;
    return { blocked: licenseBlocked };
  } catch {
    return { blocked: licenseBlocked };
  }
}

// Fresh check for a single action ("every access carries the machine code").
async function requireLicense() {
  const { blocked } = await refreshLicense();
  if (blocked) throw new Error("软件发生错误,请稍后再试");
}

// Periodic check; notifies the renderer when a machine flips to blocked so it
// can disable the action buttons and show the error.
async function licenseCheckAndNotify() {
  const { blocked } = await refreshLicense();
  if (blocked !== licenseWasBlocked) {
    licenseWasBlocked = blocked;
    if (win && !win.isDestroyed()) win.webContents.send("license:event", { blocked });
  }
  return blocked;
}

function startLicenseLoop() {
  licenseCheckAndNotify();
  licenseTimer = setInterval(licenseCheckAndNotify, LICENSE_INTERVAL_MS);
  licenseTimer.unref?.();
}

// Run one pipeline step, forwarding every console line to `send`. Console is
// temporarily swapped because the core modules report progress via console.*;
// the swap is restored in all cases.
async function runPipeline(cmd, url, outDir, send) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => send(a.join(" "));
  console.warn = (...a) => send("⚠ " + a.join(" "));
  console.error = (...a) => send("✗ " + a.join(" "));
  try {
    if (cmd === "scrape") await scrapeSite(outDir, url);
    else if (cmd === "build") await buildSite(outDir);
    else throw new Error(`unknown command: ${cmd}`);
    send("\n✅ 完成");
    return { ok: true };
  } catch (e) {
    send(`\n✗ ${e.message}`);
    return { ok: false, error: e.message };
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
}

// Ask the renderer to approve/reject a gated tool edit. Resolves false on
// timeout or if the renderer vanished, so a stuck confirmation can't hang the
// agent run forever.
function requestConfirm(payload) {
  return new Promise((resolve) => {
    const id = `c${++confirmSeq}`;
    const waiter = {
      resolve,
      timer: setTimeout(() => {
        confirmWaiters.delete(id);
        resolve(false);
      }, CONFIRM_TTL_MS),
    };
    confirmWaiters.set(id, waiter);
    if (!win.isDestroyed()) win.webContents.send("chat:event", { type: "confirm", id, ...payload });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  return win;
}

ipcMain.handle("get-defaults", () => ({ outDir: defaultOutDir() }));
ipcMain.handle("pick-dir", async (event, def) => {
  const r = await dialog.showOpenDialog(win, {
    defaultPath: def,
    properties: ["openDirectory", "createDirectory"],
  });
  return r.canceled ? null : r.filePaths[0];
});

// --- Recent output dirs: remembered so a previously generated + AI-edited
// site can be reloaded without re-scraping. Persisted in config.json.
ipcMain.handle("recent-dirs:get", () => ({ recentDirs: loadConfig().recentDirs || [] }));

ipcMain.handle("recent-dirs:add", (event, { dir }) => {
  const d = String(dir || "").trim();
  if (!d) return { ok: false };
  const c = loadConfig();
  const recentDirs = [d, ...(c.recentDirs || []).filter((x) => x !== d)].slice(0, RECENT_DIRS_MAX);
  saveConfig({ recentDirs });
  return { ok: true, recentDirs };
});

// Tell the renderer whether a dir is ready to chat from (has manifest.json)
// or still needs scraping, so a loaded recent dir shows its state.
ipcMain.handle("dir:status", (event, { dir }) => {
  const d = String(dir || "").trim();
  if (!d) return { exists: false, hasManifest: false, pages: 0 };
  const mf = path.join(d, "manifest.json");
  if (!existsSync(mf)) return { exists: existsSync(d), hasManifest: false, pages: 0 };
  try {
    const m = JSON.parse(readFileSync(mf, "utf8"));
    return { exists: true, hasManifest: true, pages: Array.isArray(m.pages) ? m.pages.length : 0 };
  } catch {
    return { exists: true, hasManifest: true, pages: 0 };
  }
});
ipcMain.handle("run", async (event, { cmd, url, outDir }) => {
  try {
    await requireLicense();
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return runPipeline(cmd, url, outDir, (line) => event.sender.send("log", line));
});

ipcMain.handle("ai-config:get", () => {
  const c = loadConfig();
  return { baseUrl: c.baseUrl, model: c.model, autoApply: c.autoApply, maxWords: c.maxWords, hasKey: !!c.apiKey };
});
ipcMain.handle("ai-config:set", (event, cfg) => {
  saveConfig({
    baseUrl: String(cfg.baseUrl || "").trim() || undefined,
    model: String(cfg.model || "").trim() || undefined,
    autoApply: !!cfg.autoApply,
    maxWords: Number(cfg.maxWords) || 60,
    apiKey: cfg.apiKey,
  });
  return { ok: true };
});

ipcMain.handle("chat:send", async (event, { message, outDir }) => {
  if (chatRunning) throw new Error("对话正在进行中,请稍候");
  if (!message || !message.trim()) throw new Error("消息不能为空");
  if (!existsSync(path.join(outDir, "manifest.json"))) {
    throw new Error("输出目录还没有抓取结果,请先用「1. 抓取站点」和「2. 生成站点」");
  }
  try {
    await requireLicense();
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const config = loadConfig();
  if (!config.apiKey) throw new Error("请先在设置里配置 DeepSeek API Key");
  if (!config.baseUrl) throw new Error("缺少 API 地址");

  chatRunning = true;
  const sender = event.sender;
  let needsRebuild = false;
  let builtThisRun = false;
  const send = (evt) => {
    if (!sender.isDestroyed()) sender.send("chat:event", evt);
    if (evt && typeof evt === "object" && evt.type === "tool_end") {
      if (evt.tool === "run_build") {
        if (evt.ok) builtThisRun = true;
      } else if (evt.ok && REBUILD_TOOLS.has(evt.tool)) {
        needsRebuild = true;
      }
    }
  };
  const abort = new AbortController();
  chatAbort = abort;
  try {
    const model = createDeepSeekModel(config);
    const tools = makeTools({
      outDir,
      confirm: (payload) => (config.autoApply ? Promise.resolve(true) : requestConfirm(payload)),
      onLog: (line) => send({ type: "log", text: line }),
    });
    const result = await runAgent({
      messages: [{ role: "user", content: message }],
      model,
      tools,
      onEvent: send,
      config: { signal: abort.signal },
    });
    // A successful edit only lands in the generated HTML after a rebuild. If
    // the agent changed files but never asked to rebuild, do it once here so
    // the change is immediately visible; skip when the agent already built.
    if (needsRebuild && !builtThisRun && result && !result.error) {
      send({ type: "log", text: "\n── 已自动重新生成页面 ──" });
      await runPipeline("build", "", outDir, (line) => send({ type: "log", text: line }));
    }
    return { ok: true, ...result };
  } catch (e) {
    send({ type: "error", message: e.message });
    return { ok: false, error: e.message };
  } finally {
    chatRunning = false;
    chatAbort = null;
  }
});

ipcMain.handle("chat:resolve", (event, { id, approved }) => {
  const waiter = confirmWaiters.get(id);
  if (!waiter) return { ok: false };
  clearTimeout(waiter.timer);
  confirmWaiters.delete(id);
  waiter.resolve(!!approved);
  return { ok: true };
});

ipcMain.handle("chat:cancel", () => {
  chatAbort?.abort();
  return { ok: true };
});

// --- Publish to 1Panel -------------------------------------------------------
// Publishes the current output dir to a 1Panel static website (created on
// first publish). Config mirrors the AI config: baseUrl/domain/alias/groupID
// plain, apiKey safeStorage-encrypted; progress streams over "publish:event".
ipcMain.handle("publish-config:get", () => {
  const p = loadConfig().publish || {};
  return { baseUrl: p.baseUrl, domain: p.domain, alias: p.alias, groupID: p.groupID, hasKey: !!p.apiKey };
});

ipcMain.handle("publish-config:set", (event, cfg) => {
  saveConfig({
    publish: {
      baseUrl: String(cfg.baseUrl || "").trim() || undefined,
      domain: String(cfg.domain || "").trim() || undefined,
      alias: String(cfg.alias || "").trim() || undefined,
      groupID: Number(cfg.groupID) || 1,
      apiKey: cfg.apiKey, // empty string keeps the stored key (see saveConfig)
    },
  });
  return { ok: true };
});

ipcMain.handle("publish:run", async (event, { outDir }) => {
  if (publishRunning) throw new Error("发布正在进行中,请稍候");
  const p = loadConfig().publish || {};
  if (!p.baseUrl || !p.apiKey) throw new Error("请先在发布设置里填写服务器地址与 API Key");
  if (!p.domain) throw new Error("请填写要发布到的域名");
  try {
    await requireLicense();
  } catch (e) {
    return { ok: false, error: e.message };
  }

  publishRunning = true;
  const sender = event.sender;
  const send = (evt) => {
    if (!sender.isDestroyed()) sender.send("publish:event", evt);
  };
  const abort = new AbortController();
  publishAbort = abort;
  try {
    const result = await publishSite({
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      outDir,
      domain: p.domain,
      alias: p.alias,
      groupID: p.groupID,
      onLog: (line) => send({ type: "log", text: line }),
      signal: abort.signal,
    });
    send({ type: "done", text: `共上传 ${result.uploaded} 个文件` });
    return { ok: true, ...result };
  } catch (e) {
    send({ type: "error", text: e.message });
    return { ok: false, error: e.message };
  } finally {
    publishRunning = false;
    publishAbort = null;
  }
});

ipcMain.handle("publish:test", async () => {
  const p = loadConfig().publish || {};
  if (!p.baseUrl || !p.apiKey) throw new Error("请先填写服务器地址与 API Key");
  const res = await testPanel({ baseUrl: p.baseUrl, apiKey: p.apiKey, domain: p.domain });
  return { ok: true, ...res };
});

ipcMain.handle("publish:cancel", () => {
  publishAbort?.abort();
  return { ok: true };
});

// --- License IPC ------------------------------------------------------------

ipcMain.handle("license:get", () => ({ machineCode: getOrCreateMachineCode(), blocked: licenseBlocked }));

ipcMain.handle("license:refresh", async () => ({ blocked: await licenseCheckAndNotify() }));

ipcMain.handle("open-page", async (event, { dir }) => {
  const file = path.join(dir, "index.html");
  if (!existsSync(file)) return { ok: false, error: "index.html 不存在,请先生成站点" };
  await shell.openPath(file);
  return { ok: true };
});

// --snapshot <png> [--url <site>] : test hook. Renders the UI, optionally runs
// a scrape first so the log panel is populated, then writes two files:
//   <png>.json  a DOM report (proves the UI rendered + logs streamed in)
//   <png>       a window capture (for human inspection)
// capturePage is raced against a timeout so a stalled capture can't hang CI.
async function snapshotMode() {
  const argv = process.argv;
  const snapFile = argv[argv.indexOf("--snapshot") + 1];
  const urlIdx = argv.indexOf("--url");
  const url = urlIdx >= 0 ? argv[urlIdx + 1] : null;
  const send = (line) => win.webContents.send("log", line);
  if (url) {
    console.log("[snapshot] scraping…");
    await runPipeline("scrape", url, path.join(app.getPath("temp"), "replicate-snapshot"), send);
    console.log("[snapshot] scrape done");
    await new Promise((r) => setTimeout(r, 800));
  }
  const report = await win.webContents.executeJavaScript(`(() => ({
    title: document.title,
    hasHeader: !!document.querySelector("h1"),
    urlValue: document.getElementById("url").value,
    outValue: document.getElementById("out").value,
    logLines: document.getElementById("log").children.length,
    logTail: (document.getElementById("log").lastChild && document.getElementById("log").lastChild.textContent) || "",
    hasChatPanel: !!document.getElementById("chat"),
    hasChatInput: !!document.getElementById("chat-input"),
    hasSettingsBtn: !!document.getElementById("btn-settings"),
    hasRecentSelect: !!document.getElementById("recent"),
  }))()`);
  writeFileSync(snapFile.replace(/\.png$/, ".json"), JSON.stringify(report, null, 2));
  console.log("[snapshot] report:", JSON.stringify(report));
  try {
    const image = await Promise.race([
      win.webContents.capturePage(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("capturePage timeout")), 15000)),
    ]);
    writeFileSync(snapFile, image.toPNG());
    console.log("[snapshot] png written");
  } catch (e) {
    console.log("[snapshot] png skipped:", e.message);
  }
  app.quit();
}

app.whenReady().then(() => {
  createWindow();
  if (process.argv.includes("--snapshot")) {
    win.webContents.on("did-finish-load", () =>
      setTimeout(() => snapshotMode().catch((e) => { console.error("[snapshot] error:", e.message); app.quit(); }), 1200),
    );
  } else {
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
    startLicenseLoop();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
