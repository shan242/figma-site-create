const logEl = document.getElementById("log");
const statusEl = document.getElementById("status");
const urlInput = document.getElementById("url");
const outInput = document.getElementById("out");
const btnScrape = document.getElementById("btn-scrape");
const btnBuild = document.getElementById("btn-build");

function appendLog(line) {
  if (!line) return;
  const el = document.createElement("div");
  el.textContent = line;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
}

function setRunning(running) {
  btnScrape.disabled = running;
  btnBuild.disabled = running;
  statusEl.textContent = running ? "运行中..." : "就绪";
}

async function run(cmd, url) {
  if (cmd === "scrape" && !url.trim()) {
    appendLog("请先填写站点网址。");
    return;
  }
  const outDir = outInput.value.trim();
  setRunning(true);
  logEl.textContent = "";
  appendLog(`── ${cmd === "scrape" ? `抓取: ${url.trim()}` : "生成站点"} ──`);
  const res = await window.api.run({ cmd, url: url.trim(), outDir });
  if (!res.ok) appendLog("失败: " + res.error);
  setRunning(false);
}

window.api.onLog(appendLog);

btnScrape.addEventListener("click", () => run("scrape", urlInput.value));
btnBuild.addEventListener("click", () => run("build", ""));
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") run("scrape", urlInput.value);
});
document.getElementById("btn-pick").addEventListener("click", async () => {
  const p = await window.api.pickDir(outInput.value);
  if (p) outInput.value = p;
});

(async () => {
  const d = await window.api.getDefaults();
  outInput.value = d.outDir;
})();
