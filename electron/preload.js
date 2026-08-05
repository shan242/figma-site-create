const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getDefaults: () => ipcRenderer.invoke("get-defaults"),
  pickDir: (def) => ipcRenderer.invoke("pick-dir", def),
  run: (payload) => ipcRenderer.invoke("run", payload),
  onLog: (cb) => ipcRenderer.on("log", (_e, line) => cb(line)),

  getRecentDirs: () => ipcRenderer.invoke("recent-dirs:get"),
  addRecentDir: (dir) => ipcRenderer.invoke("recent-dirs:add", { dir }),
  checkDir: (dir) => ipcRenderer.invoke("dir:status", { dir }),

  // AI chat: invoke resolves at the end of the whole agent run; progress and
  // confirmations stream in through onChat.
  chat: (payload) => ipcRenderer.invoke("chat:send", payload),
  onChat: (cb) => ipcRenderer.on("chat:event", (_e, evt) => cb(evt)),
  resolveConfirm: (id, approved) => ipcRenderer.invoke("chat:resolve", { id, approved }),
  cancelChat: () => ipcRenderer.invoke("chat:cancel"),

  getAiConfig: () => ipcRenderer.invoke("ai-config:get"),
  setAiConfig: (cfg) => ipcRenderer.invoke("ai-config:set", cfg),

  // Publish to 1Panel: progress streams through onPublishEvent; run resolves
  // when the upload finishes.
  getPublishConfig: () => ipcRenderer.invoke("publish-config:get"),
  setPublishConfig: (cfg) => ipcRenderer.invoke("publish-config:set", cfg),
  publishRun: (outDir) => ipcRenderer.invoke("publish:run", { outDir }),
  publishTest: () => ipcRenderer.invoke("publish:test"),
  publishCancel: () => ipcRenderer.invoke("publish:cancel"),
  onPublishEvent: (cb) => ipcRenderer.on("publish:event", (_e, evt) => cb(evt)),

  // Machine-code license: get machine code + status, and listen for block
  // events (blocked → the renderer shows the error). The server URL is built in.
  getLicense: () => ipcRenderer.invoke("license:get"),
  licenseRefresh: () => ipcRenderer.invoke("license:refresh"),
  onLicenseEvent: (cb) => ipcRenderer.on("license:event", (_e, evt) => cb(evt)),

  openPage: (dir) => ipcRenderer.invoke("open-page", { dir }),
});
