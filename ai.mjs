// ai.mjs — DeepSeek tool-calling agent for the Electron GUI's chat panel.
//
// Three layers, kept separable so the tricky parts are unit-testable:
//   - parseSSE()           pure: normalize an OpenAI-compatible SSE byte/text
//                          stream into content/toolCall/finish events.
//   - createDeepSeekModel()  the real streaming HTTP client (fetch + retries +
//                          timeout). Returns a `model` function used below.
//   - runAgent()           the tool-calling loop: stream, accumulate tool
//                          calls, execute the injected handlers, feed results
//                          back, repeat until the model stops asking for tools.
//
// File access is the security boundary. All tools run in the main process and
// are rooted at the user's output dir; write_file refuses to touch critical
// generated files; edits are gated behind a human confirmation unless
// autoApply is on. There is no shell access.

import { readFileSync, writeFileSync, renameSync, realpathSync, existsSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import { buildSite } from "./build.mjs";
import { findCanvas, hexToColor } from "./lib.mjs";
import { extractKeywordsLocal } from "./wordcloud.mjs";

const SYSTEM_PROMPT = `你是「Figma 站点静态复制工具」的桌面端助手。用户会描述想对生成的站点做什么(常见是放置词云、调整文本、查看页面)。

你可以调用工具。规则:
- 站点输出目录里的文件是唯一可写范围;不要在对话里编造文件名,先 list_pages / read_file / read_page_text 再动手。
- 放置词云:调用 apply_wordcloud。slug 来自 list_pages;rect 是画布坐标系内的矩形 {left,top,width,height};spec.words 是从页面文本提炼的关键词,weight 1-100(越高字越大);spec.colors 选与页面配色协调的颜色;不要超过矩形区域。词云可以放在页面内容下方(让 top 大于画布高度),构建时画布会自动向下扩展;宽度应保持在画布宽度内。
- 修改页面文本:调用 edit_text(slug, nodeId, 以及 text/fontSize/fontWeight/color 中至少一个)。nodeId 来自 read_page_text 返回的 all 列表中 type=TEXT 的节点;color 用 #RRGGBB。持久保存,重新生成后仍在。
- 修改任意节点(文本/图片/矩形)的样式:调用 edit_node(slug, nodeId, style)。style 是原始 CSS 属性对象,如 {color:'#ff0000','font-size':'24px'};nodeId 来自 read_page_text 的 all 列表。持久保存,重新生成后仍在。
- 全站全局样式:调用 append_css(css),会追加到 styles.css 末尾,作用于所有页面。
- 宽度自适应(等比缩放):用户要求宽度自适应且未强调「重排/流式」时,调用 get_standard('width-adaptive') 拿到标准。返回的 template 字段就是唯一允许的 CSS,把里面所有 {W} 逐字替换为 read_page_text 返回的 canvas.width,再 append_css 一次套用;content 字段里有步骤和禁用写法,照做。禁止自行发明其他方案,尤其禁止给 .canvas 设 width:100% / max-width / transform 缩放,以及 calc(100vw ÷ …px) 这种无效写法;禁止用 write_file 重写 styles.css 来做缩放式自适应。
- 宽度自适应(真正重排):仅当用户明确要求「重排/流式/真正自适应/列数塌缩」时,调用 get_standard('width-reflow')。该标准没有唯一 CSS 模板(返回的 template 是参考骨架),按 content 里的步骤用 read_file / write_file 改写 styles.css;不适用时回复用户说明原因。禁止在重排时用 zoom 缩放。
- 修改颜色/字号/间距/圆角前,先 read_file('design-report.md') 读设计报告,复用报告里的原子变量(主色/辅色/背景色/文字色、字号阶梯、间距、圆角)与布局模式,不要凭空发明与报告不符的值。报告由抓取时自动生成;旧目录没有该文件时跳过此步即可。
- 需要大改页面结构时,可以用 write_file 改写生成的 *.html(也可以写 data/ 下的页面数据)。改写 *.html 后,系统会在每次重新生成后把你改的内容自动套回去(记录在 file-locks.json),所以是持久的。
- 注意:对同一个页面,要么用 edit_text / edit_node / apply_wordcloud 这类覆盖层工具改,要么用 write_file 整体改写 HTML,不要混用——整体改写会把该页覆盖层的改动盖掉。append_css 与 write_file 改 styles.css 同理。
- 不要改写 manifest.json、wordclouds.json、edits.json、nodeStyles.json、overrides.json、file-locks.json、design-report.md、design-report.json(它们是构建元数据/覆盖层来源/设计报告,直接改会破坏一致性)。
- 修改类工具成功后,系统会自动重新生成页面,你一般无需调用 run_build;如确需立即重建可调用。
- 用中文回答;完成后的回复要简短说明改了什么。`;

// Built-in "standards": exact, versioned text the AI must follow verbatim for
// mechanical changes like width adaptation. Kept as a JS string — not a loose
// file — so the identical content reaches Node runs, tests, and the
// esbuild-bundled worker.cjs shipped in the packaged GUI. The AI fetches one
// via get_standard() and applies the `template` field literally; it must not
// paraphrase or improvise its own CSS.
export const STANDARDS = {
  "width-adaptive": {
    content: `宽度自适应标准 v1 —— 把固定宽度画布改为按视口等比缩放。以下为唯一允许的实现,必须逐字套用,禁止自行发明其他 CSS 方案。

目标:
- 画布保持设计稿宽度 W(=read_page_text 返回的 canvas.width),任意视口下等比缩放、水平居中、无横向滚动条、绝对定位布局不被拉伸。

操作步骤:
1. read_page_text(slug) 拿到 canvas.width,记为 W。
2. 把 template 字段里所有 {W} 逐字替换为 W(例如 1440),其余一字不改。
3. 用 append_css 一次套用(追加到 styles.css 末尾,能覆盖旧规则)。若你之前加过 .canvas 宽度规则,先 clear_css 删掉,避免叠加冲突。
4. run_build 重新生成。
5. 完成时告诉用户:已按标准套用宽度自适应,请用「打开页面」确认无横向滚动条、内容居中且不变形。

禁用(不要做):
- 给 .canvas 设 width:100% / max-width / transform 缩放,或 zoom 用 calc(100vw ÷ {W}px)——CSS 除法右操作数必须是纯数字,这种写法无效,会被浏览器丢弃。
- 用 write_file 整体重写 styles.css 来做宽度自适应。
- 多次 append_css 叠加宽度规则(会造成冲突)。套用前先 clear_css 清掉旧的 .canvas 宽度规则。

说明:
- 如需大屏保持 1:1 不放大,删除 template 里所有 @media (min-width: …) 规则即可。
- {W} 替换时保留 calc({W}px * 0.96) 的乘法结构,不要展开计算。`,
    template: `.canvas {
  width: {W}px !important;
  max-width: none !important;
  transform: none !important;
  margin-left: auto !important;
  margin-right: auto !important;
  zoom: 1 !important;
}
body { overflow-x: hidden; }
@media (max-width: calc({W}px * 0.96)) { .canvas { zoom: 0.92 !important; } }
@media (max-width: calc({W}px * 0.92)) { .canvas { zoom: 0.88 !important; } }
@media (max-width: calc({W}px * 0.88)) { .canvas { zoom: 0.84 !important; } }
@media (max-width: calc({W}px * 0.84)) { .canvas { zoom: 0.80 !important; } }
@media (max-width: calc({W}px * 0.80)) { .canvas { zoom: 0.75 !important; } }
@media (max-width: calc({W}px * 0.75)) { .canvas { zoom: 0.70 !important; } }
@media (max-width: calc({W}px * 0.70)) { .canvas { zoom: 0.65 !important; } }
@media (max-width: calc({W}px * 0.65)) { .canvas { zoom: 0.60 !important; } }
@media (max-width: calc({W}px * 0.60)) { .canvas { zoom: 0.55 !important; } }
@media (max-width: calc({W}px * 0.55)) { .canvas { zoom: 0.50 !important; } }
@media (max-width: calc({W}px * 0.50)) { .canvas { zoom: 0.45 !important; } }
@media (max-width: calc({W}px * 0.45)) { .canvas { zoom: 0.40 !important; } }
@media (max-width: calc({W}px * 0.40)) { .canvas { zoom: 0.35 !important; } }
@media (max-width: calc({W}px * 0.35)) { .canvas { zoom: 0.30 !important; } }
@media (max-width: calc({W}px * 0.30)) { .canvas { zoom: 0.25 !important; } }
@media (max-width: calc({W}px * 0.25)) { .canvas { zoom: 0.20 !important; } }
@media (max-width: calc({W}px * 0.20)) { .canvas { zoom: 0.20 !important; } }
@media (min-width: calc({W}px * 1.05)) { .canvas { zoom: 1.05 !important; } }
@media (min-width: calc({W}px * 1.10)) { .canvas { zoom: 1.10 !important; } }
@media (min-width: calc({W}px * 1.20)) { .canvas { zoom: 1.20 !important; } }
@media (min-width: calc({W}px * 1.30)) { .canvas { zoom: 1.30 !important; } }
@media (min-width: calc({W}px * 1.40)) { .canvas { zoom: 1.40 !important; } }
@media (min-width: calc({W}px * 1.60)) { .canvas { zoom: 1.60 !important; } }
@media (min-width: calc({W}px * 1.80)) { .canvas { zoom: 1.80 !important; } }
@media (min-width: calc({W}px * 2.00)) { .canvas { zoom: 2.00 !important; } }
@media (min-width: calc({W}px * 2.40)) { .canvas { zoom: 2.40 !important; } }
@media (min-width: calc({W}px * 3.00)) { .canvas { zoom: 2.60 !important; } }`,
  },
  "width-reflow": {
    content: `真正重排式宽度自适应标准 v1 —— 把固定宽度绝对定位画布改为流式响应式布局。仅当用户明确要求「重排 / 流式 / 真正自适应 / 列数塌缩」时使用;默认宽度自适应请用 width-adaptive(等比缩放)。没有唯一 CSS 模板,以下步骤 + 参考骨架按实际页面改写。

适用条件:
- 用户要求布局随视口真实重排(列数塌缩、卡片换行),而不是整体缩放。
- 页面是「内容型布局」(导航、卡片列表、段落文字);整页定制的像素海报不适合重排,应改用 width-adaptive。

操作步骤:
1. read_file('design-report.md'),记下主色/辅色/背景色/文字色、字号阶梯、间距、圆角、布局模式(主轴方向、对齐、典型列数/卡片宽)。颜色/间距/圆角一律用报告里的值。
2. read_page_text(slug) 拿到 canvas.width(W) 与节点结构;对每个需要重排的页面:
   a. read_file 该页 *.html,看 .canvas 与主要容器的 class/style 结构。
   b. write_file 重写 styles.css:.canvas 改为流式容器(width:100%;max-width:Wpx;margin:0 auto),把「框架级容器」(导航、页头、卡片网格)从绝对定位改为 flex/grid,用报告的间距/圆角/颜色,加 @media 断点让列数随视口塌缩(先 2 列、再 1 列)。
   c. 卡片容器用 flex-wrap: wrap 或 grid-template-columns: repeat(auto-fill, minmax(卡片宽, 1fr)) 实现自动换行;卡片宽用报告里的典型卡片宽。
3. 字号可用 clamp() 随视口缩放,但保持报告的字体阶梯比例。
4. run_build 重新生成(write_file 改 styles.css 会记录到 file-locks.json,重新生成后仍保留)。
5. 完成时告诉用户:已按重排标准改布局,请用「打开页面」确认小屏下列数塌缩、无横向滚动条;并说明重排会牺牲像素级保真,verify.mjs 不再适用。

禁用(不要做):
- 不要用 zoom 缩放做重排(那是 width-adaptive 的方案)。
- 不要混用两种标准(同一 styles.css 里既 zoom 又重排)。
- 不要继续用绝对定位 left/top 摆节点——重排的关键就是放弃绝对定位。
- 不要改写 manifest.json、wordclouds.json、edits.json、nodeStyles.json、overrides.json、file-locks.json、design-report.md、design-report.json。

说明:
- 优先重排「框架级容器」,文字与图片等叶节点保持原样,不要逐节点重写。
- hover 态设计数据里没有,按报告主色/辅色生成轻微加深或变色的 hover 即可。
- 若页面结构无法安全重排(无清晰的行列容器),回复用户说明并建议改用 width-adaptive。`,
    template: `/* width-reflow 参考骨架 — 用 write_file 改写 styles.css,把占位替换为报告 token 与 W,不要原样套用占位符号。 */
.canvas {
  width: 100% !important;
  max-width: {W}px;
  margin: 0 auto !important;
}
/* 卡片网格:{CARDW}=报告典型卡片宽,{GAP}=报告 itemSpacing */
.grid-row {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax({CARDW}px, 1fr));
  gap: {GAP}px;
}
@media (max-width: calc({W}px * 0.75)) { .grid-row { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: calc({W}px * 0.45)) { .grid-row { grid-template-columns: 1fr; } }`,
  },
};

// --- SSE parsing -------------------------------------------------------------

function parseBlock(block) {
  let data = "";
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  if (!data.trim()) return [];
  if (data.trim() === "[DONE]") return ["[DONE]"];
  let json;
  try {
    json = JSON.parse(data);
  } catch {
    return [];
  }
  const choice = json.choices && json.choices[0];
  if (!choice) return []; // keep-alive chunk
  const events = [];
  const delta = choice.delta || {};
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      if (tc.index === undefined) continue;
      events.push({ type: "toolCall", index: tc.index, id: tc.id, name: tc.function?.name, argsChunk: tc.function?.arguments || "" });
    }
  }
  if (typeof delta.content === "string" && delta.content) events.push({ type: "content", text: delta.content });
  if (choice.finish_reason) events.push({ type: "finish", finishReason: choice.finish_reason });
  return events;
}

// Normalize a stream of SSE text chunks into events. Pure — tests feed arrays
// of canned strings; the real client feeds decoded body chunks.
export async function* parseSSE(chunks) {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let m;
    while ((m = buffer.match(/\r?\n\r?\n/)) && m.index !== undefined) {
      const block = buffer.slice(0, m.index);
      buffer = buffer.slice(m.index + m[0].length);
      for (const evt of parseBlock(block)) {
        if (evt === "[DONE]") return;
        yield evt;
      }
    }
  }
  if (buffer.trim()) {
    for (const evt of parseBlock(buffer)) {
      if (evt !== "[DONE]") yield evt;
    }
  }
}

async function* decodeBody(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    yield decoder.decode(value, { stream: true });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- DeepSeek client ---------------------------------------------------------

export function createDeepSeekModel(config) {
  const baseUrl = (config.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
  const modelName = config.model || "deepseek-v4-flash";

  async function fetchWithRetry(url, opts, signal) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, opts);
      if (res.status === 429 && attempt < 2) {
        await sleep(800 * (attempt + 1));
        if (signal.aborted) return res;
        continue;
      }
      if (res.status >= 500 && res.status < 600 && attempt < 1) {
        await sleep(600);
        if (signal.aborted) return res;
        continue;
      }
      return res;
    }
  }

  return async function callModel(messages, toolSchemas, signal, onEvent) {
    const body = { model: modelName, messages, stream: true };
    if (toolSchemas?.length) body.tools = toolSchemas;

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), config.timeoutMs || 90000);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort);
    try {
      const res = await fetchWithRetry(
        `${baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        },
        ctrl.signal,
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        const label = { 401: "API Key 无效", 403: "API 无权限", 429: "请求过于频繁" }[res.status];
        throw new Error(`${label || `API 错误 ${res.status}`}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
      }

      let content = "";
      const toolBuf = new Map();
      for await (const evt of parseSSE(decodeBody(res.body))) {
        if (evt.type === "content") {
          content += evt.text;
          onEvent?.({ type: "delta", text: evt.text });
        } else if (evt.type === "toolCall") {
          const t = toolBuf.get(evt.index) || { id: null, name: null, args: "" };
          if (evt.id) t.id = evt.id;
          if (evt.name) t.name = evt.name;
          t.args += evt.argsChunk || "";
          toolBuf.set(evt.index, t);
        } else if (evt.type === "finish") {
          break;
        }
      }
      const toolCalls = [...toolBuf.values()].map((t) => {
        let parsed;
        try {
          parsed = JSON.parse(t.args || "{}");
        } catch {
          parsed = { __raw: t.args };
        }
        return { id: t.id, name: t.name, arguments: parsed };
      });
      return { content, toolCalls };
    } catch (e) {
      if (e.name === "AbortError") throw new Error("请求已取消或超时");
      throw e;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

// --- Agent loop --------------------------------------------------------------

export async function runAgent({ messages, model, tools, onEvent, config, maxTurns }) {
  const history = [{ role: "system", content: SYSTEM_PROMPT }, ...messages];
  let finalText = "";
  // No turn cap by default — the GUI's abort button (config.signal) is the
  // escape hatch. Explicit maxTurns is still honored for tests.
  const limit = maxTurns == null ? Infinity : maxTurns;
  for (let turn = 0; turn < limit; turn++) {
    onEvent?.({ type: "status", turn });
    let res;
    try {
      res = await model(history, tools.schemas, config.signal, onEvent);
    } catch (e) {
      onEvent?.({ type: "error", message: e.message });
      return { text: finalText || `调用出错: ${e.message}`, turnCount: turn, error: e.message };
    }
    history.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls.length ? res.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.arguments ?? {}) } })) : undefined });

    if (!res.toolCalls.length) {
      finalText = res.content;
      onEvent?.({ type: "done", text: finalText, turnCount: turn + 1 });
      return { text: finalText, turnCount: turn + 1 };
    }

    for (const tc of res.toolCalls) {
      onEvent?.({ type: "tool_start", tool: tc.name, args: tc.arguments });
      let result;
      if (tc.arguments && tc.arguments.__raw) {
        result = { error: `工具参数不是合法 JSON: ${tc.arguments.__raw.slice(0, 160)}` };
      } else {
        const fn = tools.handlers[tc.name];
        if (!fn) result = { error: `未知工具: ${tc.name}` };
        else {
          try {
            result = await fn(tc.arguments || {});
          } catch (e) {
            result = { error: e.message };
          }
        }
      }
      const ok = !result?.error;
      onEvent?.({ type: "tool_end", tool: tc.name, ok, summary: summarize(tc.name, result) });
      history.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  onEvent?.({ type: "done", text: finalText, turnCount: limit });
  return { text: finalText, turnCount: limit };
}

function summarize(name, result) {
  if (result?.error) return `失败: ${result.error}`;
  if (name === "list_pages") return `共 ${result?.pages?.length ?? 0} 个页面`;
  if (name === "read_page_text") return `${result?.slug ?? ""} 页面文本 ${result?.text?.length ?? 0} 字符`;
  if (name === "read_file") return `已读 ${result?.path ?? ""}`;
  if (name === "write_file") return `已写入 ${result?.path ?? ""}`;
  if (name === "apply_wordcloud") return `词云 ${result?.wordCount ?? 0} 词 → ${result?.slug ?? ""}`;
  if (name === "delete_wordcloud") return `已删除词云 ${result?.id ?? ""}`;
  if (name === "edit_text") return `已保存文本/样式修改 → ${result?.nodeId ?? ""}`;
  if (name === "delete_edit") return `已撤销修改 ${result?.id ?? ""}`;
  if (name === "edit_node") return `已保存节点样式 → ${result?.nodeId ?? ""}`;
  if (name === "delete_node_style") return `已撤销节点样式 ${result?.id ?? ""}`;
  if (name === "append_css") return `已追加全局 CSS ${result?.chars ?? 0} 字符`;
  if (name === "clear_css") return `已删除全局 CSS ${result?.id ?? ""}`;
  if (name === "run_build") return `构建完成`;
  if (name === "get_standard") return `已读取标准 ${result?.name ?? ""}`;
  return "完成";
}

// --- Tools -------------------------------------------------------------------

// Build metadata / overlay sources the AI must not rewrite directly: touching
// them corrupts the build or bypasses the dedicated overlay tools. Everything
// else under the out dir (generated *.html, styles.css, data/**, aux files) is
// writable.
const WRITE_DENY = ["manifest.json", "wordclouds.json", "edits.json", "file-locks.json", "nodeStyles.json", "overrides.json", "design-report.md", "design-report.json"];

export function makeTools({ outDir, confirm, onLog, buildFn = buildSite }) {
  const root = resolve(outDir);
  const norm = (p) => p.replace(/\\/g, "/").toLowerCase();
  const rootNorm = norm(realpathSync(root));

  // A path may pass the string-prefix check yet still escape via a symlink or
  // junction (Windows). Resolve the real parent dir and re-check against the
  // real root so those can't slip through.
  function resolveInDir(raw) {
    const p = resolve(root, raw);
    const parentNorm = norm(realpathSync(dirname(p)));
    if (parentNorm !== rootNorm && !parentNorm.startsWith(rootNorm + "/")) {
      throw new Error(`路径越界,不允许访问: ${raw}`);
    }
    return p;
  }

  const deny = (raw) => {
    const rel = norm(resolve(root, raw).slice(root.length + 1));
    return WRITE_DENY.some((d) => rel === norm(d) || rel.startsWith(norm(d) + "/"));
  };

  // Files the build regenerates on every pass. A write_file to one of these
  // records the full new content in file-locks.json, and the build re-applies
  // it after regenerating, so the AI's direct edit survives a rebuild.
  const isGeneratedProduct = (rel) => rel.endsWith(".html") || rel === "styles.css";

  const loadPages = () => {
    const m = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
    return m.pages;
  };

  const loadWordClouds = () => {
    try {
      const d = JSON.parse(readFileSync(resolve(root, "wordclouds.json"), "utf8"));
      return Array.isArray(d?.items) ? d.items : [];
    } catch {
      return [];
    }
  };

  const saveWordClouds = (items) => {
    const file = resolve(root, "wordclouds.json");
    writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, items }, null, 2));
    renameSync(`${file}.tmp`, file);
  };

  const loadEdits = () => {
    try {
      const d = JSON.parse(readFileSync(resolve(root, "edits.json"), "utf8"));
      return Array.isArray(d?.items) ? d.items : [];
    } catch {
      return [];
    }
  };

  const saveEdits = (items) => {
    const file = resolve(root, "edits.json");
    writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, items }, null, 2));
    renameSync(`${file}.tmp`, file);
  };

  const loadNodeStyles = () => {
    try {
      const d = JSON.parse(readFileSync(resolve(root, "nodeStyles.json"), "utf8"));
      return Array.isArray(d?.items) ? d.items : [];
    } catch {
      return [];
    }
  };

  const saveNodeStyles = (items) => {
    const file = resolve(root, "nodeStyles.json");
    writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, items }, null, 2));
    renameSync(`${file}.tmp`, file);
  };

  const loadOverrides = () => {
    try {
      const d = JSON.parse(readFileSync(resolve(root, "overrides.json"), "utf8"));
      return Array.isArray(d?.items) ? d.items : [];
    } catch {
      return [];
    }
  };

  const saveOverrides = (items) => {
    const file = resolve(root, "overrides.json");
    writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, items }, null, 2));
    renameSync(`${file}.tmp`, file);
  };

  const loadFileLocks = () => {
    try {
      const d = JSON.parse(readFileSync(resolve(root, "file-locks.json"), "utf8"));
      return d?.files && typeof d.files === "object" ? d.files : {};
    } catch {
      return {};
    }
  };

  const saveFileLocks = (files) => {
    const file = resolve(root, "file-locks.json");
    writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, files }, null, 2));
    renameSync(`${file}.tmp`, file);
  };

  const pageTextOf = (slug) => {
    const data = JSON.parse(readFileSync(resolve(root, "data", `${slug}.json`), "utf8"));
    const parts = [];
    for (const n of Object.values(data.nodeById || {})) {
      if (n.type === "TEXT" && n.characters) parts.push(n.characters);
    }
    return { data, text: parts.join("\n") };
  };

  const handlers = {
    async list_pages() {
      return { pages: loadPages().map(({ path, slug, title, file }) => ({ path, slug, title, file })) };
    },

    async read_page_text({ slug }) {
      const page = loadPages().find((p) => p.slug === slug);
      if (!page) return { error: `没有这个页面: ${slug}。可用 list_pages 查看。` };
      const { data, text } = pageTextOf(slug);
      const canvas = findCanvas(data);
      const cb = canvas?.absoluteBoundingBox;
      const truncated = text.length > 20000 ? `${text.slice(0, 20000)}\n…(truncated)` : text;
      // Node ids for edit_text/edit_node targeting: every node with position
      // and type, TEXT nodes carrying a short snippet. Bounded so the reply
      // stays small; the model picks a nodeId from here rather than inventing
      // one.
      const all = [];
      for (const n of Object.values(data.nodeById || {})) {
        const bb = n.absoluteBoundingBox;
        const entry = { id: n.id, type: n.type, x: Math.round(bb?.x ?? 0), y: Math.round(bb?.y ?? 0), w: Math.round(bb?.width ?? 0), h: Math.round(bb?.height ?? 0) };
        if (n.type === "TEXT" && n.characters) entry.text = n.characters.length > 40 ? `${n.characters.slice(0, 40)}…` : n.characters;
        all.push(entry);
        if (all.length >= 150) break;
      }
      return { slug, canvas: cb ? { width: cb.width, height: cb.height } : null, text: truncated, all };
    },

    async read_file({ path }) {
      let p;
      try {
        p = resolveInDir(path);
      } catch (e) {
        return { error: e.message };
      }
      if (!existsSync(p)) return { error: `文件不存在: ${path}` };
      let content = readFileSync(p, "utf8");
      const truncated = content.length > 50000;
      if (truncated) content = content.slice(0, 50000) + "\n…(truncated)";
      return { path, content, truncated };
    },

    async write_file({ path, content }) {
      let p;
      try {
        p = resolveInDir(path);
      } catch (e) {
        return { error: e.message };
      }
      if (deny(path)) return { error: `不允许改写关键文件: ${path}` };
      if (typeof content !== "string") return { error: "content 必须是字符串" };
      if (!(await confirm({ kind: "write", payload: { path, content: content.slice(0, 2000), fullLength: content.length } }))) {
        return { error: "用户拒绝了这次修改" };
      }
      writeFileSync(p, content);
      const rel = norm(p.slice(root.length + 1));
      const locked = isGeneratedProduct(rel);
      if (locked) {
        const locks = loadFileLocks();
        locks[rel] = content;
        saveFileLocks(locks);
      }
      return { path, bytes: Buffer.byteLength(content), locked };
    },

    async apply_wordcloud({ id, slug, rect, spec }) {
      const page = loadPages().find((p) => p.slug === slug);
      if (!page) return { error: `没有这个页面: ${slug}` };
      if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
        return { error: "rect 需要 {left,top,width,height} 数值" };
      }
      const { data } = pageTextOf(slug);
      const canvas = findCanvas(data);
      const cb = canvas?.absoluteBoundingBox;
      // Horizontal placement stays inside the canvas so a cloud can't overflow
      // the page width. Vertical placement may extend BELOW the canvas bottom
      // (top > canvas height) — the build grows the canvas to fit (build.mjs),
      // so "below the content" is a valid request, not a mistake to re-clamp.
      const cw = cb?.width ?? rect.width;
      const r = {
        left: Math.max(0, Math.min(rect.left, cw - Math.min(rect.width, cw))),
        top: Math.max(0, rect.top),
        width: Math.min(Math.max(1, rect.width), cw),
        height: Math.max(1, rect.height),
      };
      const words = Array.isArray(spec?.words) && spec.words.length ? spec.words : extractKeywordsLocal(pageTextOf(slug).text);
      const newSpec = {
        words: words.slice(0, 60),
        colors: spec?.colors,
        fontFamily: spec?.fontFamily,
        maxFont: spec?.maxFont,
      };
      const newId = id || `wc-${Date.now().toString(36)}`;
      if (!(await confirm({ kind: "wordcloud", payload: { id: newId, slug, rect: r, spec: newSpec } }))) {
        return { error: "用户拒绝了这次词云放置" };
      }
      const items = loadWordClouds().filter((i) => i.id !== newId);
      items.push({ id: newId, slug, rect: r, spec: newSpec, createdAt: new Date().toISOString() });
      saveWordClouds(items);
      return { id: newId, slug, rect: r, wordCount: newSpec.words.length };
    },

    async delete_wordcloud({ id }) {
      const items = loadWordClouds();
      const hit = items.find((i) => i.id === id);
      if (!hit) return { error: `没有这个词云 id: ${id}` };
      if (!(await confirm({ kind: "wordcloud", payload: { id, slug: hit.slug, delete: true } }))) {
        return { error: "用户拒绝了删除" };
      }
      saveWordClouds(items.filter((i) => i.id !== id));
      return { id, slug: hit.slug };
    },

    async edit_text({ id, slug, nodeId, text, fontSize, fontWeight, color }) {
      const page = loadPages().find((p) => p.slug === slug);
      if (!page) return { error: `没有这个页面: ${slug}` };
      const data = JSON.parse(readFileSync(resolve(root, "data", `${slug}.json`), "utf8"));
      const node = data.nodeById?.[nodeId];
      if (!node) return { error: `页面 ${slug} 没有节点 ${nodeId}` };
      if (node.type !== "TEXT") return { error: `节点 ${nodeId} 不是文本节点(type=${node.type})` };
      const change = {};
      if (text != null) change.text = String(text);
      if (fontSize != null) {
        if (!Number.isFinite(fontSize) || fontSize <= 0) return { error: "fontSize 必须是正数" };
        change.fontSize = fontSize;
      }
      if (fontWeight != null) {
        if (![100, 200, 300, 400, 500, 600, 700, 800, 900].includes(fontWeight)) return { error: "fontWeight 需为 100-900 的百位数值" };
        change.fontWeight = fontWeight;
      }
      if (color != null) {
        if (!hexToColor(color)) return { error: "颜色格式不对,需 #RRGGBB 或 #RGB" };
        change.color = String(color).trim();
      }
      if (!Object.keys(change).length) return { error: "至少要提供 text / fontSize / fontWeight / color 之一" };
      const newId = id || `e-${Date.now().toString(36)}`;
      if (!(await confirm({ kind: "edit", payload: { id: newId, slug, nodeId, currentText: String(node.characters || "").slice(0, 80), change } }))) {
        return { error: "用户拒绝了这次修改" };
      }
      // Updating by id merges the new change onto the existing entry so a
      // partial update (e.g. only fontSize) doesn't wipe previously set fields.
      const items = loadEdits();
      const existing = items.find((i) => i.id === newId) || {};
      const kept = items.filter((i) => i.id !== newId);
      kept.push({ ...existing, id: newId, slug, nodeId, ...change, createdAt: new Date().toISOString() });
      saveEdits(kept);
      return { id: newId, slug, nodeId, change };
    },

    async delete_edit({ id }) {
      const items = loadEdits();
      const hit = items.find((i) => i.id === id);
      if (!hit) return { error: `没有这个修改 id: ${id}` };
      if (!(await confirm({ kind: "edit", payload: { id, slug: hit.slug, nodeId: hit.nodeId, delete: true } }))) {
        return { error: "用户拒绝了撤销" };
      }
      saveEdits(items.filter((i) => i.id !== id));
      return { id, slug: hit.slug, nodeId: hit.nodeId };
    },

    async edit_node({ id, slug, nodeId, style }) {
      const page = loadPages().find((p) => p.slug === slug);
      if (!page) return { error: `没有这个页面: ${slug}` };
      const data = JSON.parse(readFileSync(resolve(root, "data", `${slug}.json`), "utf8"));
      const node = data.nodeById?.[nodeId];
      if (!node) return { error: `页面 ${slug} 没有节点 ${nodeId}` };
      if (!style || typeof style !== "object" || Array.isArray(style)) return { error: "style 需要是一个 CSS 属性对象" };
      // Values are inlined into style="..." attributes, so anything that would
      // break the attribute or escape into markup is rejected outright.
      const clean = {};
      for (const [k, v] of Object.entries(style)) {
        if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(k)) return { error: `非法样式属性名: ${k}` };
        if (typeof v !== "string" && typeof v !== "number") return { error: `属性 ${k} 的值需要是字符串或数字` };
        const s = String(v).trim();
        if (!s) return { error: `属性 ${k} 的值不能为空` };
        if (s.length > 200 || /[";<>]/.test(s)) return { error: `属性 ${k} 的值含非法字符或过长` };
        clean[k] = s;
      }
      const newId = id || `ns-${Date.now().toString(36)}`;
      if (!(await confirm({ kind: "node_style", payload: { id: newId, slug, nodeId, nodeType: node.type, style: clean } }))) {
        return { error: "用户拒绝了这次样式修改" };
      }
      const items = loadNodeStyles();
      const existing = items.find((i) => i.id === newId) || {};
      const kept = items.filter((i) => i.id !== newId);
      // Merge onto the existing style so a partial update (e.g. only color)
      // doesn't wipe previously set props on the same node.
      kept.push({ ...existing, id: newId, slug, nodeId, style: { ...(existing.style || {}), ...clean }, createdAt: new Date().toISOString() });
      saveNodeStyles(kept);
      return { id: newId, slug, nodeId, props: Object.keys(clean) };
    },

    async delete_node_style({ id }) {
      const items = loadNodeStyles();
      const hit = items.find((i) => i.id === id);
      if (!hit) return { error: `没有这个样式修改 id: ${id}` };
      if (!(await confirm({ kind: "node_style", payload: { id, slug: hit.slug, nodeId: hit.nodeId, delete: true } }))) {
        return { error: "用户拒绝了撤销" };
      }
      saveNodeStyles(items.filter((i) => i.id !== id));
      return { id, slug: hit.slug, nodeId: hit.nodeId };
    },

    async append_css({ id, css }) {
      if (typeof css !== "string" || !css.trim()) return { error: "css 需要是非空字符串" };
      if (css.length > 8000) return { error: "css 过长(最多 8000 字符)" };
      if (/<\/style|<\/script/i.test(css)) return { error: "css 内容非法" };
      const newId = id || `css-${Date.now().toString(36)}`;
      if (!(await confirm({ kind: "css", payload: { id: newId, css: css.slice(0, 2000), fullLength: css.length } }))) {
        return { error: "用户拒绝了这次全局 CSS" };
      }
      const items = loadOverrides();
      const existing = items.find((i) => i.id === newId) || {};
      const kept = items.filter((i) => i.id !== newId);
      kept.push({ ...existing, id: newId, css, createdAt: new Date().toISOString() });
      saveOverrides(kept);
      return { id: newId, chars: css.length };
    },

    async clear_css({ id }) {
      const items = loadOverrides();
      const hit = items.find((i) => i.id === id);
      if (!hit) return { error: `没有这个全局 CSS id: ${id}` };
      if (!(await confirm({ kind: "css", payload: { id, delete: true, preview: hit.css.slice(0, 200) } }))) {
        return { error: "用户拒绝了删除" };
      }
      saveOverrides(items.filter((i) => i.id !== id));
      return { id };
    },

    async get_standard({ name }) {
      const standard = STANDARDS[name];
      if (!standard) return { error: `没有这个标准: ${name}。可用标准: ${Object.keys(STANDARDS).join(", ")}` };
      return { name, content: standard.content, template: standard.template, chars: standard.content.length + standard.template.length };
    },

    async run_build() {
      if (!existsSync(resolve(root, "manifest.json"))) return { error: "输出目录还没有抓取结果,请先抓取并生成站点" };
      // buildSite reports progress via console.*; route it to the injected
      // onLog so the GUI's build panel shows the rebuild live in the chat flow.
      const orig = { log: console.log, warn: console.warn, error: console.error };
      if (onLog) {
        console.log = (...a) => onLog(a.join(" "));
        console.warn = (...a) => onLog("⚠ " + a.join(" "));
        console.error = (...a) => onLog("✗ " + a.join(" "));
      }
      try {
        await buildFn(root);
      } finally {
        console.log = orig.log;
        console.warn = orig.warn;
        console.error = orig.error;
      }
      onLog?.(`✅ 已重新生成站点`);
      return { rebuilt: true };
    },
  };

  const schemas = [
    {
      type: "function",
      function: {
        name: "list_pages",
        description: "列出输出站点里的所有页面(slug/title)",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "read_page_text",
        description: "读取某个页面(slug)的全部文本与画布尺寸,用于提炼关键词和选择词云位置",
        parameters: { type: "object", properties: { slug: { type: "string", description: "页面 slug,来自 list_pages" } }, required: ["slug"] },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "读取输出目录里的一个文件(html/json 等)",
        parameters: { type: "object", properties: { path: { type: "string", description: "相对于输出目录的路径" } }, required: ["path"] },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "在输出目录写入/覆盖一个文件(可写生成的 *.html、styles.css、data/ 下文件;不能改 manifest.json、wordclouds.json、edits.json、nodeStyles.json、overrides.json、file-locks.json、design-report.md、design-report.json)。改写 *.html / styles.css 会记录到 file-locks.json,重新生成后仍保留。会请求用户确认",
        parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      },
    },
    {
      type: "function",
      function: {
        name: "apply_wordcloud",
        description: "在指定页面的矩形区域放置一个交互词云。spec.words 为关键词数组 {text,weight},weight 1-100;colors 建议与页面配色一致。会请求用户确认",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "可选;更新已存在的词云时传它的 id" },
            slug: { type: "string", description: "页面 slug" },
            rect: { type: "object", description: "画布坐标系内矩形", properties: { left: { type: "number" }, top: { type: "number" }, width: { type: "number" }, height: { type: "number" } }, required: ["left", "top", "width", "height"] },
            spec: {
              type: "object",
              properties: {
                words: { type: "array", items: { type: "object", properties: { text: { type: "string" }, weight: { type: "number" } } } },
                colors: { type: "array", items: { type: "string" } },
                fontFamily: { type: "string" },
                maxFont: { type: "number" },
              },
            },
          },
          required: ["slug", "rect", "spec"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete_wordcloud",
        description: "删除一个已放置的词云(按 id)。会请求用户确认",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
    },
    {
      type: "function",
      function: {
        name: "edit_text",
        description: "持久修改某个页面某个文本节点的文本或样式(text/fontSize/fontWeight/color)。nodeId 来自 read_page_text 的 all 列表中 type=TEXT 的节点;color 用 #RRGGBB。修改会持久保存,重新生成后仍在。会请求用户确认",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "可选;更新已存在的修改时传它的 id" },
            slug: { type: "string", description: "页面 slug" },
            nodeId: { type: "string", description: "文本节点 id,来自 read_page_text" },
            text: { type: "string", description: "新的文本内容" },
            fontSize: { type: "number", description: "新的字号(px)" },
            fontWeight: { type: "number", description: "新的字重,100-900" },
            color: { type: "string", description: "新的文字颜色,#RRGGBB" },
          },
          required: ["slug", "nodeId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete_edit",
        description: "撤销之前的一个文本/样式修改(按 id)。会请求用户确认",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
    },
    {
      type: "function",
      function: {
        name: "edit_node",
        description: "持久修改任意节点(文本/图片/矩形)的样式。style 为原始 CSS 属性对象,如 {color:'#ff0000','font-size':'24px'}。nodeId 来自 read_page_text 的 all 列表。修改持久保存,重新生成后仍在。会请求用户确认",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "可选;更新已存在的样式修改时传它的 id" },
            slug: { type: "string", description: "页面 slug" },
            nodeId: { type: "string", description: "任意节点 id,来自 read_page_text 的 all 列表" },
            style: { type: "object", description: "要合并设置的 CSS 属性(不删除未提及属性)" },
          },
          required: ["slug", "nodeId", "style"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete_node_style",
        description: "撤销之前的一个节点样式修改(按 id)。会请求用户确认",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
    },
    {
      type: "function",
      function: {
        name: "append_css",
        description: "追加一条全站全局 CSS 到 styles.css 末尾,作用于所有页面。会请求用户确认",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "可选;更新已存在的全局 CSS 时传它的 id" },
            css: { type: "string", description: "CSS 规则文本,如 .nav-link { color: #123 !important; }" },
          },
          required: ["css"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "clear_css",
        description: "删除之前追加的一条全局 CSS(按 id)。会请求用户确认",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
    },
    {
      type: "function",
      function: {
        name: "get_standard",
        description: "读取内置标准文本。width-adaptive(等比缩放)返回 content(步骤与禁用写法)和 template(唯一允许的 CSS,含 {W} 占位符),必须逐字照做;width-reflow(真正重排)返回的 template 只是参考骨架,按 content 步骤改写 styles.css。不要自行发明方案",
        parameters: { type: "object", properties: { name: { type: "string", description: "标准名,如 width-adaptive / width-reflow" } }, required: ["name"] },
      },
    },
    {
      type: "function",
      function: {
        name: "run_build",
        description: "重新生成所有静态页面(把 wordclouds.json 与 edits.json 的改动渲染进 HTML)",
        parameters: { type: "object", properties: {} },
      },
    },
  ];

  return { handlers, schemas, root };
}
