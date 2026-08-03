const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getDefaults: () => ipcRenderer.invoke("get-defaults"),
  pickDir: (def) => ipcRenderer.invoke("pick-dir", def),
  run: (payload) => ipcRenderer.invoke("run", payload),
  onLog: (cb) => ipcRenderer.on("log", (_e, line) => cb(line)),
});
