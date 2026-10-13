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

import { readFileSync, writeFileSync, renameSync, realpathSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve, dirname, sep, join, basename } from "node:path";
import { buildSite } from "./build.mjs";
import { findCanvas, hexToColor, expandInstances, collectAll } from "./lib.mjs";
import { extractKeywordsLocal } from "./wordcloud.mjs";

// --- 图片理解 ------------------------------------------------------------------
// DeepSeek 的图像理解只接受 JPEG/PNG/GIF/WebP,且**只允许出现在 user 消息里**
// (system/assistant 带图会 400,见 api-docs.deepseek.com/zh-cn/guides/vision)。
// 因为工具结果是 role:"tool" 消息,图片**不能**经工具返回值传给模型 —— 所以
// view_image 只是把图片放进一个待发队列,由 runAgent 在工具轮之后补一条 user
// 消息把图带过去。
const IMG_MIME = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};
const MAX_IMAGE_BYTES = 32 * 1024 * 1024; // 文档限制:base64/URL 单图 32 MiB

// 按**文件内容**判断格式(文档明确说以内容为准,不看扩展名)。
export function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return IMG_MIME.jpeg;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return IMG_MIME.png;
  if (buf.slice(0, 3).toString("latin1") === "GIF") return IMG_MIME.gif;
  if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return IMG_MIME.webp;
  return null;
}

// assets/ 里的文件可能是 .png 名字装着 JPEG 字节(scrape 会嗅探后按真实扩展名落盘),
// 所以这里按 base 名找所有可能扩展名,再由内容定 mime。
function findAssetFile(assetDir, hash) {
  if (!hash) return null;
  for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "svg"]) {
    const p = join(assetDir, `${hash}.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

const SYSTEM_PROMPT = `你是「Figma 站点静态复制工具」的桌面端助手。用户会描述想对生成的站点做什么(常见是放置词云、调整文本、查看页面)。

你可以调用工具。规则:
- 站点输出目录里的文件是唯一可写范围;不要在对话里编造文件名,先 list_pages / read_file / read_page_text 再动手。
- 放置词云:调用 apply_wordcloud。slug 来自 list_pages;rect 是画布坐标系内的矩形 {left,top,width,height};spec.words 是从页面文本提炼的关键词,weight 1-100(越高字越大);spec.colors 选与页面配色协调的颜色;不要超过矩形区域。词云可以放在页面内容下方(让 top 大于画布高度),构建时画布会自动向下扩展;宽度应保持在画布宽度内。**直接调用即可,不需要先读 wordclouds.json** —— 覆盖层文件(wordclouds/databinds/videos/edits/nodeStyles/overrides)由这些工具自己读写,第一次添加前它们并不存在,那是正常状态。
- 需要跨访客持久化的功能一律用 bind_data,不要自己写 <script> 去 fetch 后端:
  · 投票:kind='bar',read.groupBy 填选项字段(如 choice),write.target 指向页面上的按钮节点、write.field 填同一字段;访客点按钮即投票,已经投过的人不会再被要求投。
  · 收集关键词做实时词云:kind='wordcloud',write.input=true(矩形内自动生成输入框+按钮),write.field 用 text。
  · 留言板:kind='list',write.input=true,field 用内容字段名。
  · 参与人数:kind='counter',options.unit 填单位(如「人已参与」)。
  · fallback 必填,且形状要与 kind 对应(bar/wordcloud 给 {buckets:[{key,count}],total};list 给 {items:[{data:{...}}]};counter 给 {total})——后端不可用时访客看到的就是它。
  · rect 用画布坐标,宽度别超出画布;纵向可以放在内容下方。
- 需要看图片时:先 list_images(slug) 拿到图片节点的 nodeId,再 view_image({slug, nodeId})。图片会附在下一条消息里给你,之后你就能描述它、判断内容,或据此改动页面(例如替换该图片节点、调整尺寸/样式)。
  · 只支持 JPEG/PNG/GIF/WebP,单张 ≤32MB;SVG 这类矢量只能当文本读源码,无法"看图"。
  · 只看大概用 detail:'low'(快、省 token);要看细节用 detail:'original'。
  · 若 view_image 报错说模型不支持图片,说明当前模型不是多模态的,需在设置里换一个多模态模型(deepseek-v4-flash 或 deepseek-flash)。
- 插入视频:调用 insert_video(slug, nodeId, src, ...)。把某个已存在的节点**整体换成** <video>,位置尺寸沿用该节点 —— 所以挑一个占位矩形即可,**不要**用 write_file 去改 HTML(首页动辄 600+ 节点,read_file 会截断,凭半份内容写回会把后半页整段弄丢)。
  · src 填输出目录内的视频路径(如 assets/clip.mp4)或 http(s) 直链;本地文件必须真实存在,找不到时工具会列出目录里的媒体文件。
  · 视频文件放进输出目录就会被发布(发布是整个目录递归上传),不需要额外操作。
  · 可选:poster(封面图)、fit(cover/contain/fill)、controls、autoplay、loop、muted。
  · autoplay 会自动加 muted —— 浏览器一律拦截带声音的自动播放,这不是 bug。
  · 想插在空白处:让用户先在 Figma 里画一个矩形占位,或挑一个现有矩形节点。
  · 删除用 delete_video(id 或 nodeId),该节点恢复原本渲染。
- 修改页面文本:调用 edit_text(slug, nodeId, 以及 text/fontSize/fontWeight/color 中至少一个)。nodeId 来自 read_page_text 返回的 all 列表中 type=TEXT 的节点;color 用 #RRGGBB。持久保存,重新生成后仍在。
- 修改任意节点(文本/图片/矩形)的样式:调用 edit_node(slug, nodeId, style)。style 是原始 CSS 属性对象,如 {color:'#ff0000','font-size':'24px'};nodeId 来自 read_page_text 的 all 列表。持久保存,重新生成后仍在。
- 全站全局样式:调用 append_css(css),会追加到 styles.css 末尾,作用于所有页面。
- 宽度自适应(等比缩放):用户要求宽度自适应且未强调「重排/流式」时,调用 get_standard('width-adaptive') 拿到标准。返回的 template 字段就是唯一允许的 CSS,把里面所有 {W} 逐字替换为 read_page_text 返回的 canvas.width,再 append_css 一次套用;content 字段里有步骤和禁用写法,照做。禁止自行发明其他方案,尤其禁止给 .canvas 设 width:100% / max-width / transform 缩放,以及 calc(100vw ÷ …px) 这种无效写法;禁止用 write_file 重写 styles.css 来做缩放式自适应。
- 宽度自适应(真正重排):仅当用户明确要求「重排/流式/真正自适应/列数塌缩」时,调用 get_standard('width-reflow')。该标准没有唯一 CSS 模板(返回的 template 是参考骨架),按 content 里的步骤用 read_file / write_file 改写 styles.css;不适用时回复用户说明原因。禁止在重排时用 zoom 缩放。
- 修改颜色/字号/间距/圆角前,先 read_file('design-report.md') 读设计报告,复用报告里的原子变量(主色/辅色/背景色/文字色、字号阶梯、间距、圆角)与布局模式,不要凭空发明与报告不符的值。报告由抓取时自动生成;旧目录没有该文件时跳过此步即可。
- 需要大改页面结构时,可以用 write_file 改写生成的 *.html(也可以写 data/ 下的页面数据)。改写 *.html 后,系统会在每次重新生成后把你改的内容自动套回去(记录在 file-locks.json),所以是持久的。
- 注意:对同一个页面,要么用 edit_text / edit_node / apply_wordcloud 这类覆盖层工具改,要么用 write_file 整体改写 HTML,不要混用——整体改写会把该页覆盖层的改动盖掉。append_css 与 write_file 改 styles.css 同理。
- 不要改写 manifest.json、wordclouds.json、databinds.json、edits.json、nodeStyles.json、overrides.json、file-locks.json、design-report.md、design-report.json(它们是构建元数据/覆盖层来源/设计报告,直接改会破坏一致性)。
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
- 不要改写 manifest.json、wordclouds.json、databinds.json、edits.json、nodeStyles.json、overrides.json、file-locks.json、design-report.md、design-report.json。

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
  // 没有 choice 的块是 keep-alive:连接活着,但没有内容。也要给一个 tick ——
  // 长思考期间模型可能只发心跳,消费端靠它判断"还没超时"。
  if (!choice) return [{ type: "tick" }];
  const events = [];
  const delta = choice.delta || {};
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      if (tc.index === undefined) continue;
      events.push({ type: "toolCall", index: tc.index, id: tc.id, name: tc.function?.name, argsChunk: tc.function?.arguments || "" });
    }
  }
  if (typeof delta.content === "string" && delta.content) events.push({ type: "content", text: delta.content });
  // 推理模型的"思考"流(reasoning_content)。之前完全没解析它 —— 两个后果:
  //   1) 思考过程被丢掉,界面上什么都不显示,看起来像卡死;
  //   2) 一个只吐 reasoning_content 的 chunk 解析出**零个事件**,于是消费端的
  //      空闲计时器**不会被重置**。模型认真思考超过 120 秒就被当成超时杀掉 ——
  //      这正是"每次任务没完成就报超时"的来源。
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
    events.push({ type: "reasoning", text: delta.reasoning_content });
  }
  // 只要这一块有内容就是"连接还活着",哪怕没有任何可显示的东西(keep-alive、
  // 只有 usage 的收尾块……)。消费端据此重置空闲计时器。
  if (choice.finish_reason) events.push({ type: "finish", finishReason: choice.finish_reason });
  if (!events.length) events.push({ type: "tick" });
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
      let res;
      try {
        res = await fetch(url, opts);
      } catch (e) {
        // Network error (connection reset / DNS / TLS) — retry, but never on a
        // caller- or timeout-initiated abort.
        if (e.name === "AbortError" || signal?.aborted) throw e;
        if (attempt < 2) {
          await sleep(600 * (attempt + 1));
          continue;
        }
        throw e;
      }
      if (res.status === 429 && attempt < 2) {
        await sleep(800 * (attempt + 1));
        if (signal?.aborted) return res;
        continue;
      }
      if (res.status >= 500 && res.status < 600 && attempt < 1) {
        await sleep(600);
        if (signal?.aborted) return res;
        continue;
      }
      return res;
    }
  }

  return async function callModel(messages, toolSchemas, signal, onEvent) {
    const body = { model: modelName, messages, stream: true };
    if (toolSchemas?.length) body.tools = toolSchemas;

    const ctrl = new AbortController();
    // 两个预算分开,因为它们是完全不同的事:
    //   firstByte —— 从发出请求到模型吐出**第一个** token。这一段包含排队、读完整
    //                个上下文、以及推理模型"思考"的时间,长 prompt(系统提示词 +
    //                工具结果)下轻松超过两分钟。之前它和"流卡住"共用同一个 120 秒,
    //                于是正常的长思考被当成超时杀掉 —— 用户看到的就是
    //                "请求已取消或超时"。
    //   idle      —— 流已经开始之后,两个 chunk 之间的最大间隔。这个才该短。
    const firstByteMs = config.firstByteTimeoutMs || 300000; // 5 分钟
    const idleMs = config.idleTimeoutMs || config.timeoutMs || 120000;
    let timeout;
    let abortReason = null; // "timeout-first" | "timeout-idle" | "user"
    let started = false;
    const arm = (ms, reason) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        abortReason = reason;
        ctrl.abort();
      }, ms);
    };
    arm(firstByteMs, "timeout-first");
    const bump = () => {
      if (!started) started = true;
      arm(idleMs, "timeout-idle");
    };
    const onAbort = () => {
      abortReason = "user";
      ctrl.abort();
    };
    signal?.addEventListener("abort", onAbort);
    const startedAt = Date.now();
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
        // 图片理解只对多模态模型开放。DeepSeek 会以 400 拒绝,但错误文案比较绕,
        // 这里翻译成"该改哪个设置",否则用户只会看到一串 API 术语。
        const hasImage = JSON.stringify(body.messages).includes('"image_url"');
        if (hasImage && res.status === 400 && /image|vision|multimodal|多模态|图片/i.test(detail)) {
          throw new Error(
            `当前模型「${modelName}」不支持图片理解。请在设置里换一个多模态模型(deepseek-v4-flash 或 deepseek-flash)后重试。原始错误:${detail.slice(0, 180)}`,
          );
        }
        throw new Error(`${label || `API 错误 ${res.status}`}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
      }

      let content = "";
      const toolBuf = new Map();
      for await (const evt of parseSSE(decodeBody(res.body))) {
        bump();
        if (evt.type === "content") {
          content += evt.text;
          onEvent?.({ type: "delta", text: evt.text });
        } else if (evt.type === "reasoning") {
          // 思考阶段也要让用户看见"它在动",否则长思考看起来就是卡死
          onEvent?.({ type: "reasoning", text: evt.text });
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
      const secs = Math.round((Date.now() - startedAt) / 1000);
      // 把"用户点了取消"和"等超时了"分开报。原来两种都只说一句
      // "请求已取消或超时",用户既不知道发生了什么,也不知道该改什么。
      if (e.name === "AbortError") {
        if (abortReason === "user") throw new Error("已取消");
        if (abortReason === "timeout-first") {
          throw new Error(
            `等待模型响应超过 ${Math.round(firstByteMs / 1000)} 秒仍未开始输出(已等待 ${secs} 秒)。` +
              `上下文较长时首次响应会变慢 —— 可在设置里调大「首字节超时」,或把页面拆小一点再试`,
          );
        }
        throw new Error(`模型输出中断超过 ${Math.round(idleMs / 1000)} 秒(已等待 ${secs} 秒),已停止`);
      }
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

    // view_image 请求的图片只能以 **user** 消息送达 —— DeepSeek 的图像理解
    // 不接受 system/assistant 消息带图,而工具结果是 role:"tool",同样不能带。
    // 所以在工具轮之后补一条 user 消息把图交给模型。
    const imgs = tools.takePendingImages?.() || [];
    if (imgs.length) {
      history.push({
        role: "user",
        content: [
          { type: "text", text: `以下是你请求查看的图片(${imgs.map((i) => i.label).join("、")}),请据此回答:` },
          ...imgs.map((i) => ({ type: "image_url", image_url: { url: i.dataUrl, detail: i.detail } })),
        ],
      });
      onEvent?.({ type: "images", count: imgs.length, labels: imgs.map((i) => i.label) });
    }
  }
  onEvent?.({ type: "done", text: finalText, turnCount: limit });
  return { text: finalText, turnCount: limit };
}

function summarize(name, result) {
  if (result?.error) return `失败: ${result.error}`;
  if (name === "list_pages") return `共 ${result?.pages?.length ?? 0} 个页面`;
  if (name === "read_page_text") return `${result?.slug ?? ""} 页面文本 ${result?.text?.length ?? 0} 字符`;
  if (name === "list_images") return `${result?.count ?? 0} 张图片`;
  if (name === "view_image") return result?.error ? result.error : `已把图片交给模型查看: ${result?.label ?? ""}`;
  if (name === "insert_video") return result?.error ? result.error : `已插入视频到 ${result?.nodeId ?? ""} (${result?.box ?? ""})`;
  if (name === "delete_video") return result?.error ? result.error : `已删除视频 ${result?.id ?? ""}`;
  if (name === "read_file") return `已读 ${result?.path ?? ""}`;
  if (name === "write_file") return `已写入 ${result?.path ?? ""}`;
  if (name === "apply_wordcloud") return `词云 ${result?.wordCount ?? 0} 词 → ${result?.slug ?? ""}`;
  if (name === "delete_wordcloud") return `已删除词云 ${result?.id ?? ""}`;
  if (name === "bind_data") return result?.error ? result.error : `数据绑定 ${result?.collection ?? ""}(${result?.kind ?? ""} · ${result?.mode ?? ""}) → ${result?.slug ?? ""}`;
  if (name === "delete_databind") return `已删除数据绑定 ${result?.id ?? ""}`;
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
const WRITE_DENY = ["manifest.json", "wordclouds.json", "databinds.json", "videos.json", "edits.json", "file-locks.json", "nodeStyles.json", "overrides.json", "design-report.md", "design-report.json"];

// 覆盖层文件的「空」状态。这些文件由 AI 的声明式工具按需创建,**还没有任何一条
// 记录时它们根本不存在** —— 那是正常的初始状态,不是错误。
// 但 AI 动手前习惯先 read_file 看一眼现状,拿到 error 就会以为出了问题:
// 实际事故是加词云时反复收到「read_file 失败: 文件不存在: wordclouds.json」,
// 然后回头问用户 / 反复重试,词云一直没加上。对这几个已知文件返回空结构 +
// 一句说明,既保留了"路径写错要报错"的保护(其它路径照旧报错),又不把
// "还没添加过" 当成故障。
const OVERLAY_EMPTY = {
  "wordclouds.json": { version: 1, items: [] },
  "databinds.json": { version: 1, items: [] },
  "edits.json": { version: 1, items: [] },
  "nodeStyles.json": { version: 1, items: [] },
  "overrides.json": { version: 1, items: [] },
  "videos.json": { version: 1, items: [] },
  "file-locks.json": {},
};
const OVERLAY_HINT = {
  "wordclouds.json": "词云用 apply_wordcloud 添加",
  "databinds.json": "数据绑定用 bind_data 添加",
  "videos.json": "视频用 insert_video 添加",
  "edits.json": "文字改动用 edit_text 添加",
  "nodeStyles.json": "样式改动用 edit_node 添加",
  "overrides.json": "节点覆盖用 edit_node 添加",
  "file-locks.json": "改写 *.html / styles.css 时自动记录",
};

export function makeTools({ outDir, confirm, onLog, buildFn = buildSite }) {
  const root = resolve(outDir);
  const assetDir = join(root, "assets");
  // view_image 把图放这里;runAgent 在工具轮之后用它补一条 user 消息
  // (图片不能出现在 role:"tool" 的消息里,见文件头的说明)。
  const pendingImages = [];
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

  const loadDatabinds = () => {
    try {
      const d = JSON.parse(readFileSync(resolve(root, "databinds.json"), "utf8"));
      return Array.isArray(d?.items) ? d.items : [];
    } catch {
      return [];
    }
  };

  const saveDatabinds = (items) => {
    const file = resolve(root, "databinds.json");
    writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, items }, null, 2));
    renameSync(`${file}.tmp`, file);
  };

  // 插入的视频(insert_video)。和别的覆盖层一样:ai.mjs 写,build.mjs 只读。
  const loadVideos = () => {
    try {
      const d = JSON.parse(readFileSync(resolve(root, "videos.json"), "utf8"));
      return Array.isArray(d?.items) ? d.items : [];
    } catch {
      return [];
    }
  };

  const saveVideos = (items) => {
    const file = resolve(root, "videos.json");
    writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, items }, null, 2));
    renameSync(`${file}.tmp`, file);
  };

  // 输出目录里的媒体文件 —— 用户说"视频放在文件夹里"时,AI 需要知道文件叫什么。
  // 没有「列目录」工具,所以由 insert_video 在找不到 src 时把它列出来。
  const MEDIA_EXT = new Set([".mp4", ".webm", ".ogv", ".mov", ".m4v", ".avi", ".mkv"]);
  const listMediaFiles = (dir = root, prefix = "", depth = 0) => {
    if (depth > 2) return [];
    const found = [];
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // node_modules 之类不可能有用户的视频,别白翻
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        found.push(...listMediaFiles(resolve(dir, e.name), rel, depth + 1));
      } else if (MEDIA_EXT.has(e.name.toLowerCase().slice(e.name.lastIndexOf(".")))) {
        found.push(rel);
      }
    }
    return found;
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
    // INSTANCE 的子树在发布数据里是复合 id,不展开的话 AI 既看不到实例里的文字,
    // 也拿不到实例里的图片(list_images 会漏掉整块轮播)。与构建用的是同一个函数,
    // 所以合成 id 完全一致 —— AI 据此写的覆盖在重建时能对上。
    expandInstances(data);
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
      // Node ids for edit_text/edit_node/insert_video targeting: every node with
      // position and type, TEXT nodes carrying a short snippet. Bounded so the
      // reply stays small; the model picks a nodeId from here rather than
      // inventing one.
      //
      // **只列真正会被渲染的节点**(从 roots 可达)。发布数据里还有一大块组件定义区
      // 的原件:它们在 nodeById 里、有坐标、看着完全正常,但**永远不会出现在页面上**。
      // 之前把整张表都列给模型,它挑中幽灵节点后 edit_text / insert_video 都"成功"了
      // 却什么都没发生 —— 用户看到的是"AI 说改了但页面没变"。
      const all = [];
      for (const n of collectAll(data)) {
        const bb = n.absoluteBoundingBox;
        const entry = { id: n.id, type: n.type, x: Math.round(bb?.x ?? 0), y: Math.round(bb?.y ?? 0), w: Math.round(bb?.width ?? 0), h: Math.round(bb?.height ?? 0) };
        if (n.type === "TEXT" && n.characters) entry.text = n.characters.length > 40 ? `${n.characters.slice(0, 40)}…` : n.characters;
        all.push(entry);
        if (all.length >= 150) break;
      }
      return { slug, canvas: cb ? { width: cb.width, height: cb.height } : null, text: truncated, all };
    },

    // 列出页面上的图片节点,让模型知道"有哪些图可以看"以及它们的 id。
    // read_page_text 的 all 里看不出哪个节点带图片填充,所以需要这个。
    async list_images({ slug }) {
      const page = loadPages().find((p) => p.slug === slug);
      if (!page) return { error: `没有这个页面: ${slug}` };
      const { data } = pageTextOf(slug);
      const images = [];
      for (const n of Object.values(data.nodeById || {})) {
        const refs = [n.hash, ...(n.fills || []).filter((f) => f.type === "IMAGE").map((f) => f.imageRef)].filter(Boolean);
        if (!refs.length) continue;
        const ref = refs[0];
        const file = findAssetFile(assetDir, ref);
        const bb = n.absoluteBoundingBox || {};
        images.push({
          nodeId: n.id,
          type: n.type,
          name: n.name || "",
          w: Math.round(bb.width || 0),
          h: Math.round(bb.height || 0),
          asset: file ? basename(file) : `${ref} (文件缺失,需重新抓取)`,
          kb: file ? Math.round(statSync(file).size / 1024) : 0,
          readable: !!file && !!sniffImageMime(readFileSync(file)),
        });
      }
      return { slug, count: images.length, images };
    },

    // 让模型"看"一张图。图片不能走工具返回值(role:"tool" 不支持图片),
    // 所以这里只把图放进待发队列,由 runAgent 补一条 user 消息带给模型。
    async view_image({ slug, nodeId, path, detail }) {
      let file = null;
      let label = "";
      if (path) {
        try {
          file = resolveInDir(path);
        } catch (e) {
          return { error: e.message };
        }
        if (!existsSync(file)) return { error: `文件不存在: ${path}` };
        label = basename(file);
      } else if (slug && nodeId) {
        const page = loadPages().find((p) => p.slug === slug);
        if (!page) return { error: `没有这个页面: ${slug}` };
        const { data } = pageTextOf(slug);
        const n = data.nodeById?.[nodeId];
        if (!n) return { error: `页面 ${slug} 没有节点 ${nodeId}` };
        const ref = [n.hash, ...(n.fills || []).filter((f) => f.type === "IMAGE").map((f) => f.imageRef)].filter(Boolean)[0];
        if (!ref) return { error: `节点 ${nodeId} 不是图片节点。可用 list_images 查看该页有哪些图。` };
        file = findAssetFile(assetDir, ref);
        if (!file) return { error: `节点 ${nodeId} 的图片文件缺失(${ref}),请重新抓取站点` };
        label = `${n.name || nodeId} (${basename(file)})`;
      } else {
        return { error: "需要 path,或 slug + nodeId" };
      }

      const buf = readFileSync(file);
      const mime = sniffImageMime(buf);
      if (!mime) return { error: `不是支持的图片格式(仅 JPEG/PNG/GIF/WebP): ${basename(file)}` };
      if (buf.length > MAX_IMAGE_BYTES) {
        return { error: `图片 ${(buf.length / 1048576).toFixed(1)}MB 超过 32MB 上限,模型无法接收` };
      }
      const d = detail === "low" || detail === "high" || detail === "original" ? detail : "auto";
      pendingImages.push({ dataUrl: `data:${mime};base64,${buf.toString("base64")}`, detail: d, label });
      return {
        queued: true,
        label,
        mime,
        kb: Math.round(buf.length / 1024),
        detail: d,
        note: "图片已附在下一条消息里,你现在就能看到它。",
      };
    },

    async read_file({ path }) {
      let p;
      try {
        p = resolveInDir(path);
      } catch (e) {
        return { error: e.message };
      }
      if (!existsSync(p)) {
        // 已知的覆盖层文件"还不存在"= 还没有添加过任何一条,是正常初始状态。
        // 返回空结构而不是 error,避免 AI 把"还没添加过"当成故障去问用户或重试。
        const rel = norm(path);
        if (rel in OVERLAY_EMPTY) {
          return {
            path: rel,
            content: `${JSON.stringify(OVERLAY_EMPTY[rel], null, 2)}\n`,
            missing: true,
            note: `该文件尚不存在,说明这个目录里还没有任何记录(${OVERLAY_HINT[rel]})。这是正常的初始状态,**不是错误** —— 直接用对应工具添加第一条即可,不需要先创建它。`,
          };
        }
        return { error: `文件不存在: ${path}` };
      }
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

    // 把页面元素接到数据后端(投票 / 词云采集 / 留言 / 计数)。
    // 只写 databinds.json,构建时由 databind.mjs 注入 —— AI 不直接写浏览器脚本,
    // 因此不存在"AI 生成任意 JS"的攻击面。
    async bind_data({ id, slug, rect, collection, kind, read, write, fallback, options }) {
      const page = loadPages().find((p) => p.slug === slug);
      if (!page) return { error: `没有这个页面: ${slug}` };

      const COLL_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
      if (!COLL_RE.test(String(collection || ""))) {
        return { error: "collection 必须是 [a-z0-9-] 组成的标识,如 votes / words / guestbook" };
      }
      const k = kind || "bar";
      if (!["bar", "counter", "list", "wordcloud"].includes(k)) {
        return { error: "kind 必须是 bar(占比条,投票) / counter(计数) / list(列表,留言) / wordcloud(实时词云)" };
      }
      if (!rect || !["left", "top", "width", "height"].every((f) => Number.isFinite(rect[f]))) {
        return { error: "rect 需要 {left,top,width,height} 数值" };
      }
      const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
      const rd = read || {};
      if ((k === "bar" || k === "wordcloud") && !FIELD_RE.test(String(rd.groupBy || ""))) {
        return { error: "read.groupBy 必须是合法字段名(字母/下划线开头),例如 choice / text" };
      }

      let w = null;
      if (write) {
        if (!FIELD_RE.test(String(write.field || ""))) return { error: "write.field 必须是合法字段名" };
        if (write.target) {
          const data = JSON.parse(readFileSync(resolve(root, "data", `${slug}.json`), "utf8"));
          if (!data.nodeById?.[write.target]) {
            return { error: `页面 ${slug} 没有节点 ${write.target},请先用 read_page_text 拿到正确的节点 id` };
          }
          w = { event: "click", target: String(write.target), field: write.field, value: write.value };
        } else if (write.input) {
          w = {
            input: true,
            field: write.field,
            placeholder: write.placeholder || "",
            button: write.button || "提交",
            maxLength: Math.min(200, Math.max(1, Number(write.maxLength) || 40)),
          };
        } else {
          return { error: "write 需要 target(点某个节点就提交) 或 input:true(给访客一个输入框)" };
        }
      }

      // 与 apply_wordcloud 同一套夹取:横向不出画布;纵向允许低于画布(构建时扩高)。
      const { data } = pageTextOf(slug);
      const cw = findCanvas(data)?.absoluteBoundingBox?.width ?? rect.width;
      const r = {
        left: Math.max(0, Math.min(rect.left, cw - Math.min(rect.width, cw))),
        top: Math.max(0, rect.top),
        width: Math.min(Math.max(1, rect.width), cw),
        height: Math.max(1, rect.height),
      };

      const newId = id || `db-${Date.now().toString(36)}`;
      // 集合模式:投票/词云这类"每次提交都是一条"用 append(默认,不去重);
      // "每个人的个人内容"(资料、个人留言)用 single —— 同一访客后写覆盖前写。
      const mode = options?.mode === "single" ? "single" : "append";
      const item = {
        id: newId,
        slug,
        rect: r,
        collection: String(collection),
        kind: k,
        mode,
        read: rd,
        write: w,
        fallback: fallback || null,
        options: options || {},
        createdAt: new Date().toISOString(),
      };
      if (!(await confirm({ kind: "databind", payload: item }))) return { error: "用户拒绝了这次数据绑定" };
      const items = loadDatabinds().filter((i) => i.id !== newId);
      items.push(item);
      saveDatabinds(items);
      return {
        id: newId,
        slug,
        collection: item.collection,
        kind: k,
        mode: w ? (w.target ? `点击节点 ${w.target} 提交` : "访客输入后提交") : "只读",
      };
    },

    async delete_databind({ id }) {
      const items = loadDatabinds();
      const hit = items.find((i) => i.id === id);
      if (!hit) return { error: `没有这个数据绑定 id: ${id}` };
      if (!(await confirm({ kind: "databind", payload: { id, slug: hit.slug, delete: true } }))) {
        return { error: "用户拒绝了删除" };
      }
      saveDatabinds(items.filter((i) => i.id !== id));
      return { id, slug: hit.slug };
    },

    // 往页面里放一个视频。做法:把某个已存在的节点(nodeId)整体换成 <video>,
    // 位置尺寸沿用该节点 —— 所以 AI 只要挑一个占位矩形即可,不必改 HTML。
    // 这是之前缺失的能力:工具集里没有「插入媒体」,想让 AI 塞视频只能整体改写
    // HTML,而首页 600+ 节点、read_file 会截断,凭半份内容写回会把后半页弄丢。
    async insert_video({ id, slug, nodeId, src, poster, fit, controls, autoplay, loop, muted }) {
      const page = loadPages().find((p) => p.slug === slug);
      if (!page) return { error: `没有这个页面: ${slug}` };
      const { data } = pageTextOf(slug);
      const node = data.nodeById?.[nodeId];
      if (!node) return { error: `页面 ${slug} 没有节点 ${nodeId}` };
      // 必须选**会被渲染**的节点:发布数据里有一大块组件定义区的原件,位置尺寸都正常
      // 但永远不出现在页面上。插到那种节点上会"成功"却什么也看不见。
      const renderable = new Set(collectAll(data).map((n) => n.id));
      if (!renderable.has(nodeId)) {
        const cands = collectAll(data)
          .filter((n) => (n.type === "RECTANGLE" || n.type === "FRAME" || n.type === "IMAGE") && (n.absoluteBoundingBox?.width ?? 0) > 80)
          .slice(0, 6)
          .map((n) => `${n.id}(${n.type} ${Math.round(n.absoluteBoundingBox.width)}x${Math.round(n.absoluteBoundingBox.height)})`);
        return {
          error: `节点 ${nodeId} 不在页面上(它是组件定义区的原件,永远不会被渲染),换一个`,
          ...(cands.length ? { hint: `页面上的可用矩形: ${cands.join(", ")}` } : {}),
        };
      }
      if (!src) return { error: "需要 src:输出目录里的视频文件路径(如 assets/clip.mp4),或一个 http(s) 直链" };

      // 外部直链直接用;本地文件必须真的存在 —— 否则页面上是个静默 404 的空白播放器
      let useSrc = String(src).trim();
      let srcSwapped = null;
      if (!/^https?:\/\//i.test(useSrc)) {
        let p;
        try {
          p = resolveInDir(useSrc);
        } catch (e) {
          return { error: e.message };
        }
        if (!existsSync(p)) {
          const media = listMediaFiles();
          const want = useSrc.split("/").pop();
          const ext = want.slice(want.lastIndexOf(".")).toLowerCase();
          const ascii = (s) => (s.match(/^[\x20-\x7e]*/) || [""])[0].toLowerCase();
          const wp = ascii(want);
          const byPrefix = media.find((m) => {
            const b = m.split("/").pop();
            return b !== want && wp.length >= 3 && b.toLowerCase().endsWith(ext) && ascii(b) === wp;
          });
          const fallback = byPrefix || (media.length === 1 ? media[0] : null);
          if (fallback) {
            // **直接用它,不要回头问用户**。中文名被 GBK/UTF-8 错读时,ASCII 前缀和
            // 扩展名会原样保留(lily网站视频_副本.mp4 → lily缃戠珯瑙嗛_鍓湰.mp4),
            // 而"用户以为的文件名"是唯一他不可能答得上来的问题 —— 实测这样来回两轮
            // 都卡住,视频一直插不进去。文件名是输入的问题,不该让程序卡死。
            // 替换会在返回值里说明,AI 会转述给用户,想换也能再改。
            srcSwapped = { from: useSrc, to: fallback };
            useSrc = fallback;
          } else {
            return {
              error: `找不到视频文件: ${useSrc}`,
              ...(media.length ? { hint: `输出目录里的媒体文件: ${media.slice(0, 12).join(", ")}。如果用户要的就是其中之一,直接用那个名字重试` } : { hint: "输出目录里没有找到任何视频文件,请先把视频放进去" }),
            };
          }
        } else {
          useSrc = useSrc.replace(/\\/g, "/").replace(/^\.\//, "");
        }
        useSrc = useSrc.replace(/\\/g, "/").replace(/^\.\//, "");
      }

      let usePoster = null;
      if (poster) {
        usePoster = String(poster).trim();
        if (!/^https?:\/\//i.test(usePoster)) {
          let pp;
          try {
            pp = resolveInDir(usePoster);
          } catch (e) {
            return { error: e.message };
          }
          if (!existsSync(pp)) return { error: `找不到封面图: ${usePoster}` };
          usePoster = usePoster.replace(/\\/g, "/").replace(/^\.\//, "");
        }
      }

      const newId = id || `vid-${Date.now().toString(36)}`;
      const spec = {
        id: newId,
        slug,
        nodeId,
        src: useSrc,
        poster: usePoster,
        fit: fit === "contain" || fit === "fill" ? fit : "cover",
        controls: controls !== false,
        autoplay: !!autoplay,
        loop: !!loop,
        muted: muted !== false,
      };
      if (!(await confirm({ kind: "video", payload: spec }))) return { error: "用户拒绝了插入视频" };
      const kept = loadVideos().filter((i) => i.id !== newId && i.nodeId !== nodeId);
      kept.push({ ...spec, createdAt: new Date().toISOString() });
      saveVideos(kept);
      const bb = node.absoluteBoundingBox || {};
      return {
        id: newId,
        slug,
        nodeId,
        src: useSrc,
        box: `${Math.round(bb.width ?? 0)}x${Math.round(bb.height ?? 0)}`,
        autoplay: spec.autoplay,
        note: [
          srcSwapped ? `你说的是 ${srcSwapped.from},它不存在;已改用实际存在的 ${srcSwapped.to}(中文文件名被错误编码过就会这样),要换请告诉用户` : null,
          spec.autoplay && !muted ? "已自动加 muted:浏览器会拦截带声音的自动播放" : null,
        ]
          .filter(Boolean)
          .join("；") || undefined,
      };
    },

    async delete_video({ id }) {
      const items = loadVideos();
      const hit = items.find((i) => i.id === id || i.nodeId === id);
      if (!hit) return { error: `没有这个视频 id: ${id}` };
      if (!(await confirm({ kind: "video", payload: { id: hit.id, slug: hit.slug, delete: true } }))) {
        return { error: "用户拒绝了删除" };
      }
      saveVideos(items.filter((i) => i.id !== hit.id));
      return { id: hit.id, slug: hit.slug, nodeId: hit.nodeId };
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
        name: "list_images",
        description:
          "列出某个页面上的所有图片节点(nodeId、名称、尺寸、资源文件、是否可读给模型)。想看某张图之前先用它拿到 nodeId —— read_page_text 的 all 列表看不出哪个节点带图片填充",
        parameters: { type: "object", properties: { slug: { type: "string", description: "页面 slug" } }, required: ["slug"] },
      },
    },
    {
      type: "function",
      function: {
        name: "view_image",
        description:
          "真正让模型『看到』一张图片并理解其内容(例如识别图中的世界地图、图表、截图文字)。图片会在下一条消息里附给你。" +
          "用法:传 slug + nodeId(来自 list_images),或传 path(输出目录内任意图片文件)。" +
          "注意:只能看 JPEG/PNG/GIF/WebP,单张上限 32MB。图片理解需要多模态模型;" +
          "若返回错误说明当前模型不支持图片,需在设置里把模型换成 deepseek-flash。",
        parameters: {
          type: "object",
          properties: {
            slug: { type: "string", description: "页面 slug;与 nodeId 搭配使用" },
            nodeId: { type: "string", description: "图片节点 id,来自 list_images" },
            path: { type: "string", description: "或直接指定输出目录内的图片路径" },
            detail: { type: "string", enum: ["low", "auto", "original"], description: "low 更快更省 token(缩到 512×512);默认 auto" },
          },
        },
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
        description: "在输出目录写入/覆盖一个文件(可写生成的 *.html、styles.css、data/ 下文件;不能改 manifest.json、wordclouds.json、databinds.json、edits.json、nodeStyles.json、overrides.json、file-locks.json、design-report.md、design-report.json)。改写 *.html / styles.css 会记录到 file-locks.json,重新生成后仍保留。会请求用户确认",
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
        name: "bind_data",
        description:
          "把页面元素接到数据后端,实现跨访客持久化:投票、实时词云、留言板、参与人数。用户说「让访客投票」「收集关键词做词云」「显示多少人参与」「留言」时用它。" +
          "kind=bar 显示各选项占比条(投票);wordcloud 显示实时词云;list 显示最近内容(留言);counter 只显示一个数字。" +
          "写入两种方式:write.target 指向页面上的节点(如投票按钮),访客点它就提交;write.input=true 在矩形内自动生成输入框+按钮,访客输入后提交(采集关键词用)。不传 write 即只读展示。" +
          "fallback 是后端不可用时展示的静态内容,形状要与 kind 对应。" +
          "后端按浏览器本地标识记住每位访客,所以「投过的人不用再投」是自动的。会请求用户确认",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "可选;更新已有绑定时传它的 id" },
            slug: { type: "string", description: "页面 slug,来自 list_pages" },
            rect: {
              type: "object",
              description: "画布坐标系内的展示矩形",
              properties: { left: { type: "number" }, top: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
              required: ["left", "top", "width", "height"],
            },
            collection: { type: "string", description: "数据集合名,小写字母/数字/短横线,如 votes / words / guestbook" },
            kind: { type: "string", enum: ["bar", "wordcloud", "list", "counter"], description: "展示形态" },
            read: {
              type: "object",
              description: "读取参数",
              properties: {
                groupBy: { type: "string", description: "按哪个字段聚合(bar/wordcloud 必填),如 choice / text" },
                limit: { type: "number", description: "取前 N 项;bar/wordcloud 默认 10,list 默认 20" },
                refreshMs: { type: "number", description: "轮询间隔毫秒,默认 15000;0 表示不轮询" },
              },
            },
            write: {
              type: "object",
              description: "写入方式;不传则只读",
              properties: {
                target: { type: "string", description: "节点 id(来自 read_page_text),访客点它就提交" },
                input: { type: "boolean", description: "true 则在矩形内生成输入框+按钮" },
                field: { type: "string", description: "写入的字段名,如 choice / text" },
                value: { type: "string", description: "点击式写入时固定提交的值;省略则取被点节点的文字" },
                placeholder: { type: "string", description: "输入框提示文字" },
                button: { type: "string", description: "按钮文字,默认「提交」" },
                maxLength: { type: "number", description: "输入长度上限,默认 40" },
              },
              required: ["field"],
            },
            fallback: { type: "object", description: "后端不可用时的静态兜底内容(形状见工具说明)" },
            options: {
              type: "object",
              description: "展示选项",
              properties: {
                colors: { type: "array", items: { type: "string" }, description: "词云配色,建议与页面一致" },
                maxFont: { type: "number" },
                minFont: { type: "number" },
                maxWords: { type: "number" },
                unit: { type: "string", description: "counter 的后缀,如「人已参与」" },
                empty: { type: "string", description: "无数据时的提示文字" },
                done: { type: "string", description: "已提交后的提示文字,默认「已提交」" },
                mode: {
                  type: "string",
                  enum: ["append", "single"],
                  description: "append(默认)=每次提交都新增一条,适合投票/词云;single=同一位访客只保留一条、后写覆盖,适合「每个人自己的内容」(资料、个人留言)",
                },
              },
            },
          },
          required: ["slug", "rect", "collection", "kind"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete_databind",
        description: "删除一个数据绑定(按 id)。会请求用户确认",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
    },
    {
      type: "function",
      function: {
        name: "insert_video",
        description:
          "往页面里插入视频:把某个已存在的节点(nodeId)整体换成 <video>,位置和尺寸沿用该节点。" +
          "src 填输出目录里的视频文件路径(如 assets/clip.mp4),或一个 http(s) 直链;本地文件必须真实存在。" +
          "视频文件放进输出目录即可,发布时会一起上传。" +
          "想插到空白处就先让用户画一个占位矩形,或挑一个现有矩形节点。会请求用户确认",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "可选,自定义 id;不填自动生成" },
            slug: { type: "string", description: "页面 slug" },
            nodeId: { type: "string", description: "要被替换成视频的节点 id,来自 read_page_text 的 all 列表" },
            src: { type: "string", description: "视频路径(输出目录内)或 http(s) 直链" },
            poster: { type: "string", description: "可选封面图,播放前显示" },
            fit: { type: "string", enum: ["cover", "contain", "fill"], description: "视频如何填满节点框,默认 cover(裁切铺满)" },
            controls: { type: "boolean", description: "是否显示播放控件,默认 true" },
            autoplay: { type: "boolean", description: "自动播放(会自动加 muted,否则浏览器拦截)" },
            loop: { type: "boolean", description: "循环播放" },
            muted: { type: "boolean", description: "静音,默认 true" },
          },
          required: ["slug", "nodeId", "src"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete_video",
        description: "删除一个已插入的视频(按 id 或 nodeId),该节点恢复原本的渲染。会请求用户确认",
        parameters: { type: "object", properties: { id: { type: "string", description: "视频 id 或 nodeId" } }, required: ["id"] },
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
        description: "重新生成所有静态页面(把 wordclouds.json、databinds.json 与 edits.json 的改动渲染进 HTML)",
        parameters: { type: "object", properties: {} },
      },
    },
  ];

  return {
    handlers,
    schemas,
    root,
    // 取走待发图片(取走即清空,避免重复发送同一张图浪费 token)
    takePendingImages() {
      return pendingImages.splice(0, pendingImages.length);
    },
  };
}
