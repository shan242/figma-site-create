// gui-worker.mjs — Bundle entry for the Electron main process. esbuild inlines
// scrape.mjs/build.mjs/lib.mjs/wordcloud.mjs/ai.mjs/publish.mjs/license.mjs into
// worker.cjs so the GUI can run the whole pipeline + the AI chat agent + 1Panel
// publish + license checks in-process with no external Node or DeepSeek SDK.
import { scrapeSite } from "../scrape.mjs";
import { buildSite } from "../build.mjs";
import { runAgent, createDeepSeekModel, makeTools } from "../ai.mjs";
import { layoutWordCloud } from "../wordcloud.mjs";
import { publishSite, testPanel } from "../publish.mjs";
import { machineCode, checkLicense } from "../license.mjs";

export { scrapeSite, buildSite, runAgent, createDeepSeekModel, makeTools, layoutWordCloud, publishSite, testPanel, machineCode, checkLicense };
