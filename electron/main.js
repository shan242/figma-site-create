// main.js — Electron main process for the Figma Site Replica GUI.
//
// Runs scrape/build from worker.cjs in-process and streams their console
// output to the renderer, so the packaged app needs no external Node or
// browser beyond the bundled Chromium.
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const { writeFileSync } = require("fs");
const { scrapeSite, buildSite } = require("./worker.cjs");

let win = null;

function defaultOutDir() {
  return path.join(app.getPath("home"), "replicate-out");
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

function createWindow() {
  win = new BrowserWindow({
    width: 1024,
    height: 760,
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
ipcMain.handle("run", (event, { cmd, url, outDir }) =>
  runPipeline(cmd, url, outDir, (line) => event.sender.send("log", line)),
);

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
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
