const logEl = document.getElementById("log");
const statusEl = document.getElementById("status");
const urlInput = document.getElementById("url");
const outInput = document.getElementById("out");
const btnScrape = document.getElementById("btn-scrape");
const btnBuild = document.getElementById("btn-build");
const btnOpen = document.getElementById("btn-open");
const recentSel = document.getElementById("recent");
const dirStatus = document.getElementById("dir-status");

const chatEl = document.getElementById("chat");
const chatInput = document.getElementById("chat-input");
const btnSend = document.getElementById("btn-send");
const btnCancel = document.getElementById("btn-cancel");

// --- 左侧:抓取 / 生成 / 日志 ------------------------------------------------

function appendLog(line) {
  if (!line) return;
  const el = document.createElement("div");
  el.textContent = line;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
}

let blockedRender = false;

function setRunning(running) {
  btnScrape.disabled = running || blockedRender;
  btnBuild.disabled = running || blockedRender;
  btnOpen.disabled = running || blockedRender;
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
  if (res.ok) {
    await window.api.addRecentDir(outDir);
    await refreshRecent();
  }
  if (!res.ok) appendLog("失败: " + res.error);
  setRunning(false);
}

window.api.onLog(appendLog);

// --- 最近输出目录:下拉一键加载已生成(含 AI 编辑)的站点 ---------------------

async function refreshRecent(selected) {
  const { recentDirs } = await window.api.getRecentDirs();
  recentSel.textContent = "";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = "— 选择最近使用过的目录 —";
  recentSel.appendChild(ph);
  for (const d of recentDirs) {
    const o = document.createElement("option");
    o.value = d;
    o.textContent = d;
    if (selected && d === selected) o.selected = true;
    recentSel.appendChild(o);
  }
}

async function updateDirStatus(dir) {
  if (!dir) {
    dirStatus.textContent = "";
    dirStatus.className = "dir-status";
    return;
  }
  const s = await window.api.checkDir(dir);
  if (!s.exists) {
    dirStatus.textContent = "目录不存在";
    dirStatus.className = "dir-status bad";
  } else if (s.hasManifest) {
    dirStatus.textContent = `已生成(${s.pages} 页),可直接对话`;
    dirStatus.className = "dir-status ok";
  } else {
    dirStatus.textContent = "尚未抓取,请先「1. 抓取站点」";
    dirStatus.className = "dir-status warn";
  }
}

btnScrape.addEventListener("click", () => run("scrape", urlInput.value));
btnBuild.addEventListener("click", () => run("build", ""));
btnOpen.addEventListener("click", async () => {
  const res = await window.api.openPage(outInput.value.trim());
  if (!res.ok) appendLog(res.error || "打开失败");
});
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") run("scrape", urlInput.value);
});
document.getElementById("btn-pick").addEventListener("click", async () => {
  const p = await window.api.pickDir(outInput.value);
  if (p) {
    outInput.value = p;
    recentSel.value = "";
    await window.api.addRecentDir(p);
    await refreshRecent(p);
    await updateDirStatus(p);
  }
});
recentSel.addEventListener("change", async () => {
  if (!recentSel.value) return;
  outInput.value = recentSel.value;
  await updateDirStatus(outInput.value);
});
outInput.addEventListener("input", () => {
  recentSel.value = "";
  dirStatus.textContent = "";
  dirStatus.className = "dir-status";
});
outInput.addEventListener("blur", () => updateDirStatus(outInput.value.trim()));

(async () => {
  const d = await window.api.getDefaults();
  outInput.value = d.outDir;
  await refreshRecent();
  await updateDirStatus(outInput.value);
})();

// --- 右侧:AI 对话 -----------------------------------------------------------

let assistantEl = null; // 当前正在流式输出中的助手气泡
let lastToolEl = null; // 当前工具行(等待 tool_end 补上结果)
let chatRunning = false;

function chatBubble(cls) {
  const div = document.createElement("div");
  div.className = "chat-msg " + cls;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

function addMeta(cls, text) {
  const el = document.createElement("div");
  el.className = "meta " + cls;
  el.textContent = text;
  chatEl.appendChild(el);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function shortArgs(args) {
  if (!args) return "";
  try {
    const s = JSON.stringify(args);
    return s.length > 120 ? s.slice(0, 120) + "…" : s;
  } catch {
    return String(args);
  }
}

function setChatRunning(running) {
  chatRunning = running;
  chatInput.disabled = running;
  btnSend.disabled = running;
  btnCancel.disabled = !running;
  if (running) chatInput.focus();
}

function handleChatEvent(evt) {
  switch (evt.type) {
    case "status":
      assistantEl = null;
      break;
    case "delta": {
      if (!assistantEl) assistantEl = chatBubble("assistant");
      assistantEl.textContent += evt.text;
      chatEl.scrollTop = chatEl.scrollHeight;
      break;
    }
    case "tool_start":
      assistantEl = null;
      lastToolEl = chatBubble("tool");
      lastToolEl.textContent = `🔧 调用 ${evt.tool}${evt.args ? " " + shortArgs(evt.args) : ""}`;
      break;
    case "tool_end":
      if (lastToolEl) {
        lastToolEl.textContent = `${evt.ok ? "✅" : "✗"} ${evt.tool}: ${evt.summary || ""}`;
        lastToolEl.classList.add(evt.ok ? "ok" : "err");
      }
      lastToolEl = null;
      chatEl.scrollTop = chatEl.scrollHeight;
      break;
    case "log":
      // run_build 的构建输出回到左侧日志面板
      appendLog(evt.text);
      break;
    case "confirm":
      showConfirm(evt.id, evt.kind, evt.payload);
      break;
    case "done":
      if (evt.text) {
        if (!assistantEl) assistantEl = chatBubble("assistant");
        assistantEl.textContent = evt.text;
        assistantEl = null;
      }
      addMeta("", `完成(共 ${evt.turnCount} 轮)`);
      break;
    case "error":
      assistantEl = chatBubble("assistant err");
      assistantEl.textContent = "⚠ " + evt.message;
      assistantEl = null;
      break;
  }
}

window.api.onChat(handleChatEvent);

async function sendChat() {
  const message = chatInput.value.trim();
  if (!message || chatRunning) return;
  const outDir = outInput.value.trim();
  const user = chatBubble("user");
  user.textContent = message;
  chatInput.value = "";
  setChatRunning(true);
  try {
    const res = await window.api.chat({ message, outDir });
    if (res.ok) {
      await window.api.addRecentDir(outDir);
      await refreshRecent();
    } else {
      addMeta("err", "对话出错: " + res.error);
    }
  } catch (e) {
    addMeta("err", "对话出错: " + e.message);
  } finally {
    setChatRunning(false);
  }
}

btnSend.addEventListener("click", sendChat);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !chatRunning) sendChat();
});
btnCancel.addEventListener("click", () => window.api.cancelChat());

addMeta("", "输入消息开始与 AI 对话。发送前请先完成「1. 抓取站点」与「2. 生成站点」。");

// --- 确认框 ----------------------------------------------------------------

const confirmEl = document.getElementById("confirm");
const confirmTitle = document.getElementById("confirm-title");
const confirmBody = document.getElementById("confirm-body");
let currentConfirmId = null;

function showConfirm(id, kind, payload) {
  currentConfirmId = id;
  confirmBody.textContent = "";
  const pre = document.createElement("pre");
  pre.className = "literal";
  if (kind === "write") {
    confirmTitle.textContent = "确认文件修改";
    const shown = payload.content.length;
    pre.textContent = `路径: ${payload.path}\n内容(前 ${shown} / 共 ${payload.fullLength} 字符):\n${payload.content}`;
  } else if (kind === "edit") {
    if (payload.delete) {
      confirmTitle.textContent = "确认撤销修改";
      pre.textContent = `撤销修改 id: ${payload.id}\n页面: ${payload.slug}\n节点: ${payload.nodeId}`;
    } else {
      confirmTitle.textContent = "确认文本/样式修改";
      const lines = [`页面: ${payload.slug}`, `节点: ${payload.nodeId}`, `当前文本(前 80 字): ${payload.currentText}`];
      for (const [k, v] of Object.entries(payload.change || {})) lines.push(`${k}: ${JSON.stringify(v)}`);
      pre.textContent = lines.join("\n");
    }
  } else if (kind === "node_style") {
    if (payload.delete) {
      confirmTitle.textContent = "确认撤销节点样式";
      pre.textContent = `撤销样式 id: ${payload.id}\n页面: ${payload.slug}\n节点: ${payload.nodeId}`;
    } else {
      confirmTitle.textContent = "确认节点样式修改";
      pre.textContent = `页面: ${payload.slug}\n节点: ${payload.nodeId} (${payload.nodeType})\n样式:\n${JSON.stringify(payload.style, null, 2)}`;
    }
  } else if (kind === "css") {
    if (payload.delete) {
      confirmTitle.textContent = "确认删除全局 CSS";
      pre.textContent = `删除 CSS id: ${payload.id}\n内容:\n${payload.preview}`;
    } else {
      confirmTitle.textContent = "确认追加全局 CSS";
      const shown = payload.css.length;
      pre.textContent = `内容(前 ${shown} / 共 ${payload.fullLength} 字符):\n${payload.css}`;
    }
  } else if (payload.delete) {
    confirmTitle.textContent = "确认删除词云";
    pre.textContent = `删除词云 id: ${payload.id}\n页面: ${payload.slug}`;
  } else {
    confirmTitle.textContent = "确认放置词云";
    const r = payload.rect;
    pre.textContent =
      `页面: ${payload.slug}\n位置: left=${r.left} top=${r.top} width=${r.width} height=${r.height}\n` +
      `规格:\n${JSON.stringify(payload.spec, null, 2)}`;
  }
  confirmBody.appendChild(pre);
  confirmEl.hidden = false;
}

async function resolveConfirm(approved) {
  if (currentConfirmId == null) return;
  const id = currentConfirmId;
  currentConfirmId = null;
  confirmEl.hidden = true;
  await window.api.resolveConfirm(id, approved);
}

document.getElementById("btn-confirm-yes").addEventListener("click", () => resolveConfirm(true));
document.getElementById("btn-confirm-no").addEventListener("click", () => resolveConfirm(false));

// --- AI 设置 ----------------------------------------------------------------

const settingsEl = document.getElementById("settings");
const cfgKey = document.getElementById("cfg-key");
const cfgBase = document.getElementById("cfg-base");
const cfgModel = document.getElementById("cfg-model");
const cfgAuto = document.getElementById("cfg-auto");
const cfgMsg = document.getElementById("cfg-msg");
const licCode = document.getElementById("lic-code");
const licStatus = document.getElementById("lic-status");

function setBlockedUI(blocked) {
  blockedRender = blocked;
  btnScrape.disabled = blocked;
  btnBuild.disabled = blocked;
  btnOpen.disabled = blocked;
  btnPublish.disabled = blocked;
  if (blocked) appendLog("软件发生错误,请稍后再试或联系技术支持");
}

async function openSettings() {
  const c = await window.api.getAiConfig();
  cfgKey.value = "";
  cfgKey.placeholder = c.hasKey ? "已配置(留空保持不变)" : "sk-...";
  cfgBase.value = c.baseUrl || "";
  cfgModel.value = c.model || "";
  cfgAuto.checked = !!c.autoApply;
  const l = await window.api.getLicense();
  licCode.value = l.machineCode || "";
  licStatus.textContent = l.blocked ? "已禁用" : "授权正常";
  licStatus.className = l.blocked ? "lic-status bad" : "lic-status";
  cfgMsg.textContent = "";
  settingsEl.hidden = false;
}

async function saveSettings() {
  cfgMsg.textContent = "保存中…";
  const r = await window.api.setAiConfig({
    apiKey: cfgKey.value.trim(),
    baseUrl: cfgBase.value.trim(),
    model: cfgModel.value.trim(),
    autoApply: cfgAuto.checked,
  });
  cfgMsg.textContent = r.ok ? "已保存" : "保存失败";
}

document.getElementById("btn-settings").addEventListener("click", openSettings);
document.getElementById("btn-cfg-save").addEventListener("click", saveSettings);
document.getElementById("btn-cfg-cancel").addEventListener("click", () => {
  settingsEl.hidden = true;
});

// 授权状态:被服务端封禁时禁用功能并显示错误;本地"校验授权"按钮主动刷新。
document.getElementById("btn-lic-refresh").addEventListener("click", async () => {
  licStatus.textContent = "校验中…";
  const r = await window.api.licenseRefresh();
  licStatus.textContent = r.blocked ? "已禁用" : "授权正常";
  licStatus.className = r.blocked ? "lic-status bad" : "lic-status";
  if (r.blocked) setBlockedUI(true);
});

window.api.onLicenseEvent((evt) => {
  if (evt && evt.blocked) {
    setBlockedUI(true);
    licStatus.textContent = "已禁用";
    licStatus.className = "lic-status bad";
  }
});

// --- 发布到 1Panel 服务器 -----------------------------------------------------

const btnPublish = document.getElementById("btn-publish");
const btnPublishCancel = document.getElementById("btn-publish-cancel");
const btnPublishSettings = document.getElementById("btn-publish-settings");
const publishStatusEl = document.getElementById("publish-status");
const pubEl = document.getElementById("publish-settings");
const pubKey = document.getElementById("pub-key");
const pubBase = document.getElementById("pub-base");
const pubDomain = document.getElementById("pub-domain");
const pubAlias = document.getElementById("pub-alias");
const pubGroup = document.getElementById("pub-group");
const pubMsg = document.getElementById("pub-msg");

function setPublishStatus(text, cls) {
  publishStatusEl.textContent = text;
  publishStatusEl.className = cls ? `status ${cls}` : "status";
}

function setPublishRunning(running) {
  btnPublish.disabled = running || blockedRender;
  btnPublishCancel.disabled = !running;
  setPublishStatus(running ? "发布中..." : "", "");
}

// 发布进度流:log 进左日志面板,done/error 更新按钮状态与状态行。
window.api.onPublishEvent((evt) => {
  if (evt.type === "log") appendLog(evt.text);
  else if (evt.type === "done") setPublishStatus("已发布", "ok");
  else if (evt.type === "error") setPublishStatus("发布失败", "err");
});

async function openPublishSettings() {
  const c = await window.api.getPublishConfig();
  pubKey.value = "";
  pubKey.placeholder = c.hasKey ? "已配置(留空保持不变)" : "sk-...";
  pubBase.value = c.baseUrl || "";
  pubDomain.value = c.domain || "";
  pubAlias.value = c.alias || "";
  pubGroup.value = c.groupID || 1;
  pubMsg.textContent = "";
  pubEl.hidden = false;
}

async function savePublishSettings() {
  pubMsg.textContent = "保存中…";
  const r = await window.api.setPublishConfig({
    apiKey: pubKey.value.trim(),
    baseUrl: pubBase.value.trim(),
    domain: pubDomain.value.trim(),
    alias: pubAlias.value.trim(),
    groupID: Number(pubGroup.value) || 1,
  });
  pubMsg.textContent = r.ok ? "已保存" : "保存失败";
}

async function testConnection() {
  await savePublishSettings();
  pubMsg.textContent = "测试中…";
  try {
    const r = await window.api.publishTest();
    if (!r.ok) throw new Error(r.error || "未知错误");
    const parts = [`API ${r.base}`];
    parts.push(r.found ? "已找到网站" : "将新建网站");
    if (r.root) parts.push(`根目录 ${r.root}`);
    pubMsg.textContent = "连接成功 · " + parts.join(" · ");
  } catch (e) {
    pubMsg.textContent = "连接失败: " + e.message;
  }
}

btnPublish.addEventListener("click", async () => {
  const outDir = outInput.value.trim();
  if (!outDir) {
    appendLog("请先选择输出目录。");
    return;
  }
  setPublishRunning(true);
  appendLog("── 发布到服务器 ──");
  const res = await window.api.publishRun(outDir);
  setPublishRunning(false);
  if (!res.ok) {
    appendLog("发布失败: " + (res.error || ""));
    setPublishStatus("发布失败", "err");
  } else {
    setPublishStatus("已发布", "ok");
  }
});
btnPublishCancel.addEventListener("click", () => window.api.publishCancel());
btnPublishSettings.addEventListener("click", openPublishSettings);
document.getElementById("btn-pub-save").addEventListener("click", savePublishSettings);
document.getElementById("btn-pub-test").addEventListener("click", testConnection);
document.getElementById("btn-pub-cancel").addEventListener("click", () => {
  pubEl.hidden = true;
});
