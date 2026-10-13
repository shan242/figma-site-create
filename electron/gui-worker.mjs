// gui-worker.mjs — Bundle entry for the Electron main process. esbuild inlines
// scrape.mjs/build.mjs/lib.mjs/wordcloud.mjs/ai.mjs/publish.mjs/license.mjs into
// worker.cjs so the GUI can run the whole pipeline + the AI chat agent + 1Panel
// publish + license checks in-process with no external Node or DeepSeek SDK.
import { scrapeSite } from "../scrape.mjs";
import { buildSite } from "../build.mjs";
import { runAgent, createDeepSeekModel, makeTools, loadChatHistory, saveChatHistory, trimChatHistory, CHAT_HISTORY_FILE, CHAT_HISTORY_LIMITS } from "../ai.mjs";
import { layoutWordCloud } from "../wordcloud.mjs";
import { publishSite, testPanel, httpsOptions, ensureHttps, dataApiHealth } from "../publish.mjs";
import { machineCode, checkLicense } from "../license.mjs";
import { setFetch, usingNetFetch } from "../netfetch.mjs";
import { setPageProbe, usingPageProbe } from "../pageprobe.mjs";
import { applyConfigPatch } from "./config-merge.cjs";

// applyConfigPatch 也走 worker.cjs 导出,而不是让 main.js 去 require 一个单独的
// .cjs —— electron-builder 的 `files` 是白名单,新加的 .cjs 不在里面就**不会被打进
// asar**,本地怎么测都好,装到用户机器上启动即 `Cannot find module`。
export { scrapeSite, buildSite, runAgent, createDeepSeekModel, makeTools, loadChatHistory, saveChatHistory, trimChatHistory, CHAT_HISTORY_FILE, CHAT_HISTORY_LIMITS, layoutWordCloud, publishSite, testPanel, httpsOptions, ensureHttps, dataApiHealth, machineCode, checkLicense, setFetch, usingNetFetch, setPageProbe, usingPageProbe, applyConfigPatch };
