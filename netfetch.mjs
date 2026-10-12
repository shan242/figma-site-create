// netfetch.mjs — 抓取/下载用来发 HTTP 请求的那一个 fetch。
//
// 为什么需要一层间接:Node 自带的 fetch 走 undici,**不读 Windows 的系统代理**——
// 系统代理只写在注册表里(HKCU\...\Internet Settings\ProxyServer),浏览器读它,
// Node 不读。所以开着 VPN(代理模式)时会出现"浏览器能打开 figma.site,程序却拉不到"
// ——实测直连 10.6 秒 UND_ERR_CONNECT_TIMEOUT,而同一时刻经代理 883ms 就返回。
//
// 环境变量方案在这里没用:NODE_USE_ENV_PROXY 只在 Node 启动时读取,打包后的
// Electron 进程运行时再设置无效(实测过)。
//
// 正确做法是在 Electron 里换成 `net.fetch`:它走 Chromium 的网络栈,和应用里
// 那个能正常打开页面的浏览器**用的是同一套代理解析**(含系统代理与绕过列表)。
// CLI 下没有 Electron,就继续用全局 fetch。
let impl = null;

// Electron 侧在 app ready 之后注入 net.fetch。传 null 可恢复默认。
export function setFetch(fn) {
  impl = typeof fn === "function" ? fn : null;
}

export function httpFetch(url, opts) {
  return (impl || globalThis.fetch)(url, opts);
}

// 供测试与诊断:当前用的是哪一个
export const usingNetFetch = () => !!impl;
