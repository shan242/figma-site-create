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

import { readFileSync, writeFileSync, renameSync, realpathSync, existsSync, statSync, readdirSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { resolve, dirname, sep, join, basename } from "node:path";
import { buildSite } from "./build.mjs";
import { findCanvas, hexToColor, expandInstances, collectAll, videoTracks, videoOptionsFrom } from "./lib.mjs";
import { createHash } from "node:crypto";
import { extractKeywordsLocal } from "./wordcloud.mjs";
import { pageProbe } from "./pageprobe.mjs";
import { pathToFileURL } from "node:url";

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
// 在 assets/ 里按内容哈希找落地文件。扩展名要**按用途给** —— 视频是 .mp4,
// 图片是 png/jpg/svg 那一串。以前只认图片扩展名,于是找视频必然返回 null,
// 调用方会报"文件缺失,需重新抓取"这种**假警报**。
function findAssetFile(assetDir, hash, exts) {
  if (!hash) return null;
  for (const ext of exts || ["png", "jpg", "jpeg", "gif", "webp", "svg"]) {
    const p = join(assetDir, `${hash}.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

// --- 系统提示词:分节注册表 ------------------------------------------------------
//
// 以前是**一整块 5000 字符的模板字符串**,一个小标题都没有。三个后果:
//   · 模型很难在里面定位("改文字"的规则和"CSS 硬规矩"混在同一个扁平列表里);
//   · 维护者改坏它毫无阻力 —— 这个 session 里我就把它弄坏过三次(整句重复、
//     反引号截断、把相邻段落连带替换掉),其中一次的字面残留至今还在(见下面
//     "warnings" 与 "CSS 硬规矩" 之间那段粘连的文字,已在本节修正);
//   · 某个工具将来若被移除,它的说明仍然会占着 token。
//
// 做法借鉴 DSH 的 system-prompt:**每节是一个有名字、有顺序的片段**,
// `when` 指向一个工具名,那个工具不存在时整节渲染成空串(不占 token)。
// 顺序由中心的 order 决定,而不是各节自己写死的拼接顺序 —— 增删一节不会把
// 其余节的相对次序搞乱。
//
// 与 DSH 的差别:它的正文只有 2.5–4KB 且每节一两句话;这里内容多得多,所以
// 额外加了 markdown 小标题 —— 模型可以按标题跳读,而不是顺序扫过 5000 字。
const PROMPT_ORDER = {
  identity: 0,
  rules: 100,
  files: 200,
  wordcloud: 300,
  data: 400,
  image: 500,
  video: 600,
  videoOptions: 610,
  text: 700,
  node: 710,
  css: 720,
  width: 800,
  design: 900,
  html: 1000,
  locks: 1100,
  discover: 1200,
  overlays: 1300,
  history: 1400,
  warnings: 1500,
  cssRules: 1600,
  build: 1700,
  output: 9000,
};

export const PROMPT_SECTIONS = [
  {
    id: "identity",
    order: PROMPT_ORDER.identity,
    text:
      "你是「Figma 站点静态复制工具」的桌面端助手。用户会描述想对生成的站点做什么(常见是放置词云、调整文本、查看页面)。\n" +
      "\n" +
      "## 基本规则\n" +
      "你可以调用工具。站点输出目录里的文件是唯一可写范围;不要在对话里编造文件名,先 list_pages / read_file / read_page_text 再动手。",
  },
  {
    id: "wordcloud",
    order: PROMPT_ORDER.wordcloud,
    when: "apply_wordcloud",
    text:
      "## 词云\n" +
      "- 放置词云:调用 apply_wordcloud。slug 来自 list_pages;rect 是画布坐标系内的矩形 {left,top,width,height};spec.words 是从页面文本提炼的关键词,weight 1-100(越高字越大);spec.colors 选与页面配色协调的颜色;不要超过矩形区域。词云可以放在页面内容下方(让 top 大于画布高度),构建时画布会自动向下扩展;宽度应保持在画布宽度内。**直接调用即可,不需要先读 wordclouds.json** —— 覆盖层文件(wordclouds/databinds/videos/edits/nodeStyles/overrides)由这些工具自己读写,第一次添加前它们并不存在,那是正常状态。",
  },
  {
    id: "data",
    order: PROMPT_ORDER.data,
    when: "bind_data",
    text:
      "## 数据绑定(投票 / 词云 / 留言 / 计数)\n" +
      "- 需要跨访客持久化的功能一律用 bind_data,不要自己写 <script> 去 fetch 后端:\n" +
      "  · 投票:kind='bar',read.groupBy 填选项字段(如 choice),write.target 指向页面上的按钮节点、write.field 填同一字段;访客点按钮即投票。\n" +
      "  · 收集关键词做实时词云:kind='wordcloud',write.input=true(矩形内自动生成输入框+按钮),write.field 用 text。\n" +
      "  · 留言板:kind='list',write.input=true,field 用内容字段名。\n" +
      "  · 参与人数:kind='counter',options.unit 填单位(如「人已参与」)。\n" +
      "  · 只写入、不在页面上画东西:kind='action'。它要求 write.target,rect 可省略。**「点某个标签投一票」就用它** —— 不要用 1×1 的词云矩形去凑,更不要为此写 CSS 把假元素藏起来。\n" +
      "  · 每个访客能投几次由 options.perVisitor 决定:once(默认,每一项一次)/ many(可重复)/ single(可改主意,后端后写覆盖前写)。注意 once 是**每一项一次**,不是总共一票。\n" +
      "  · fallback 必填,且形状要与 kind 对应(bar/wordcloud 给 {buckets:[{key,count}],total};list 给 {items:[{data:{...}}]};counter 给 {total})——后端不可用时访客看到的就是它。\n" +
      "  · rect 用画布坐标,宽度别超出画布;纵向可以放在内容下方。",
  },
  {
    id: "image",
    order: PROMPT_ORDER.image,
    when: "view_image",
    text:
      "## 看图\n" +
      "- 需要看图片时:先 list_images(slug) 拿到图片节点的 nodeId,再 view_image({slug, nodeId})。图片会附在下一条消息里给你,之后你就能描述它、判断内容,或据此改动页面(例如替换该图片节点、调整尺寸/样式)。\n" +
      "  · 只支持 JPEG/PNG/GIF/WebP,单张 ≤32MB;SVG 这类矢量只能当文本读源码,无法\"看图\"。\n" +
      "  · 只看大概用 detail:'low'(快、省 token);要看细节用 detail:'original'。\n" +
      "  · 若 view_image 报错说模型不支持图片,说明当前模型不是多模态的,需在设置里换一个多模态模型(deepseek-v4-flash 或 deepseek-flash)。\n" +
      "  · **list_images 也会列出页面上的视频**(设计自带的 VIDEO 填充和 insert_video 插入的),并标注文件里到底有没有音轨。要拿视频的 nodeId 就用它。",
  },
  {
    id: "video",
    order: PROMPT_ORDER.video,
    when: "insert_video",
    text:
      "## 插入视频\n" +
      "- 调用 insert_video(slug, nodeId, src, ...)。把某个已存在的节点**整体换成** <video>,位置尺寸沿用该节点 —— 所以挑一个占位矩形即可,**不要**用 write_file 去改 HTML(首页动辄 600+ 节点,read_file 会截断,凭半份内容写回会把后半页整段弄丢)。\n" +
      "  · src 填输出目录内的视频路径(如 assets/clip.mp4)或 http(s) 直链;本地文件必须真实存在,找不到时工具会列出目录里的媒体文件。\n" +
      "  · 视频文件放进输出目录就会被发布(发布是整个目录递归上传),不需要额外操作。\n" +
      "  · 可选:poster(封面图)、fit(cover/contain/fill)、controls、autoplay、loop、muted。\n" +
      "  · autoplay 会自动加 muted —— 浏览器一律拦截带声音的自动播放,这不是 bug。\n" +
      "  · 想插在空白处:让用户先在 Figma 里画一个矩形占位,或挑一个现有矩形节点。\n" +
      "  · 删除用 delete_video(id 或 nodeId),该节点恢复原本渲染。",
  },
  {
    id: "videoOptions",
    order: PROMPT_ORDER.videoOptions,
    when: "set_video_options",
    text:
      "## 改已有视频的声音 / 控件\n" +
      "- 改**已有视频**的播放选项(声音/控件/自动播放/循环/换文件):调用 set_video_options(slug, nodeId, ...)。**设计自带的视频也能改** —— 这一点很重要:Figma 的 VIDEO 填充永远带着 muted:true / showControls:false,而且 Figma 里**没有任何开关可以改**,所以\"视频没声音\"\"视频没有进度条\"这类诉求只能靠这个工具解决。\n" +
      "  · 要有声音+进度条:set_video_options({nodeId, muted:false, controls:true})。\n" +
      "  · 有声音就**不能**自动播放(浏览器一律拦截),工具会自动摘掉 autoplay 并在 note 里说明。\n" +
      "  · 只想要一个跟设计同色的播放按钮、不要浏览器那套亮色 UI:controls:\"custom\"。\n" +
      "  · nodeId **不要按节点名字猜** —— 名字里有\"视频\"的节点不一定真有视频填充。用 list_images(它会列出设计自带的 VIDEO 填充和 insert_video 插入的,并标注**文件里到底有没有音轨**)拿 nodeId;check_page 报视频时也会带上 nodeId。\n" +
      "  · 文件有音轨却被静音,是用户只能靠耳朵发现的事 —— 遇到这种就主动告诉他。",
  },
  {
    id: "text",
    order: PROMPT_ORDER.text,
    when: "edit_text",
    text:
      "## 改文字 / 样式\n" +
      "- 修改页面文本:调用 edit_text(slug, nodeId, 以及 text/fontSize/fontWeight/color 中至少一个)。nodeId 来自 read_page_text 返回的 all 列表中 type=TEXT 的节点;color 用 #RRGGBB。持久保存,重新生成后仍在。",
  },
  {
    id: "node",
    order: PROMPT_ORDER.node,
    when: "edit_node",
    text:
      "- 修改任意节点(文本/图片/矩形)的样式:调用 edit_node(slug, nodeId, style)。style 是原始 CSS 属性对象,如 {color:'#ff0000','font-size':'24px'};nodeId 来自 read_page_text 的 all 列表。也可以直接给 height / width(纯数字,单位 px)—— **edit_text 警告文字溢出时就用它把框调大**。持久保存,重新生成后仍在。",
  },
  {
    id: "css",
    order: PROMPT_ORDER.css,
    when: "append_css",
    text: "- 全站全局样式:调用 append_css(css),会追加到 styles.css 末尾,作用于所有页面。",
  },
  {
    id: "width",
    order: PROMPT_ORDER.width,
    when: "get_standard",
    text:
      "## 宽度自适应\n" +
      "- 宽度自适应(等比缩放):用户要求宽度自适应且未强调「重排/流式」时,调用 get_standard('width-adaptive') 拿到标准。返回的 template 字段就是唯一允许的 CSS,把里面所有 {W} 逐字替换为 read_page_text 返回的 canvas.width,再 append_css 一次套用;content 字段里有步骤和禁用写法,照做。禁止自行发明其他方案,尤其禁止给 .canvas 设 width:100% / max-width / transform 缩放,以及 calc(100vw ÷ …px) 这种无效写法;禁止用 write_file 重写 styles.css 来做缩放式自适应。\n" +
      "- 宽度自适应(真正重排):仅当用户明确要求「重排/流式/真正自适应/列数塌缩」时,调用 get_standard('width-reflow')。该标准没有唯一 CSS 模板(返回的 template 是参考骨架),按 content 里的步骤用 read_file / write_file 改写 styles.css;不适用时回复用户说明原因。禁止在重排时用 zoom 缩放。",
  },
  {
    id: "design",
    order: PROMPT_ORDER.design,
    text:
      "## 设计规范\n" +
      "- 修改颜色/字号/间距/圆角前,先 read_file('design-report.md') 读设计报告,复用报告里的原子变量(主色/辅色/背景色/文字色、字号阶梯、间距、圆角)与布局模式,不要凭空发明与报告不符的值。报告由抓取时自动生成;旧目录没有该文件时跳过此步即可。",
  },
  {
    id: "html",
    order: PROMPT_ORDER.html,
    when: "write_file",
    text:
      "## 整体改写 HTML\n" +
      "- 需要大改页面结构时,可以用 write_file 改写生成的 *.html(也可以写 data/ 下的页面数据)。改写 *.html 后,系统会在每次重新生成后把你改的内容自动套回去(记录在 file-locks.json),所以是持久的。\n" +
      "  · **设计重新拉取过之后要注意**:锁里记着改动时的底稿哈希,底稿变了就不会自动套回(否则会把你客户的新设计盖掉),那时系统会明确告诉你哪些文件被跳过了。遇到这种情况要在**新版本**上重新应用一次你的改动。\n" +
      "- 注意:对同一个页面,要么用 edit_text / edit_node / apply_wordcloud 这类覆盖层工具改,要么用 write_file 整体改写 HTML,不要混用——整体改写会把该页覆盖层的改动盖掉。append_css 与 write_file 改 styles.css 同理。",
  },
  {
    id: "locks",
    order: PROMPT_ORDER.locks,
    text:
      "- 不要改写 manifest.json、wordclouds.json、databinds.json、videos.json、edits.json、nodeStyles.json、overrides.json、file-locks.json、design-report.md、design-report.json(它们是构建元数据/覆盖层来源/设计报告,直接改会破坏一致性)。",
  },
  {
    id: "discover",
    order: PROMPT_ORDER.discover,
    when: "list_images",
    text:
      "## 先发现,再动手\n" +
      "- **绝不要靠节点名字猜 id,也不要一个个试。** 名字里有\"视频\"/\"图片\"/\"按钮\"的节点不一定真是那个东西。要拿 nodeId 就用对应的列举工具:图片和**视频**用 list_images(它同时列出设计自带的 VIDEO 填充和 insert_video 插入的),文字用 read_page_text,页面上有什么问题用 check_page(check_page 报视频时会带上 nodeId)。实测有一次 AI 因为找不到视频节点,连猜了 20 多个 id 才放弃 —— 那些调用全是白费的。\n" +
      "- **改从来不会渲染的节点是白费的。** 发布数据里有一大块组件定义区的原件:在数据里有坐标、看着正常,但页面上永远不出现。工具会拒绝这种 id 并列出一个可用的;遇到就直接改用列出来的那些。",
  },
  {
    id: "overlays",
    order: PROMPT_ORDER.overlays,
    when: "list_overlays",
    text:
      "- **加任何覆盖层之前先 list_overlays(slug)**。你看不到页面,而词云/绑定/视频是你自己加的、发布数据里没有 —— 只靠记忆很容易在同一处叠第二个(实测:25 条绑定全绑同一个 collection,其中两条的矩形完全重叠,页面上两行字叠着)。它还会直接告诉你哪些已经重叠了。",
  },
  {
    id: "history",
    order: PROMPT_ORDER.history,
    when: "restore_history",
    text:
      "- **改坏了可以回退**:每次改动覆盖层(文字/样式/词云/绑定/视频)之前程序都会自动存一份快照。如果用户说\"还是刚才那样好\"、或者你发现把样式改烂了,用 list_history 找到那一步、再 restore_history 回去 —— **不要靠自己凭记忆反着改**,那几乎一定改不回来。回滚本身也是可逆的。",
  },
  {
    id: "warnings",
    order: PROMPT_ORDER.warnings,
    text:
      "## 警告必须处理\n" +
      "- **工具的返回值里出现 warnings 或 problems 时,必须逐条处理,不能只记下来。** 你**看不到页面**,这些是程序代替你的眼睛算出来的:文字会溢出框、覆盖层会叠在一起、样式里有让功能失效的写法、页面渲染后某块是空的。忽略它们等于把问题留给用户去发现。\n" +
      "  · 改文字(edit_text)后如果估算会溢出节点框,警告会说明超多少、以及要不要用 edit_node 调大 height —— 节点若是 textAutoResize:\"NONE\"(固定高度),多出来的文字会**直接盖到相邻内容上**,用户看到的就是\"文字叠在一起\"。请缩短文字或调大 height,不要放着不管。\n" +
      "  · 放词云 / 数据绑定时如果矩形和已有的覆盖层重叠,警告会列出撞上了谁、重叠多少。**同一个位置再绑一次通常是错的** —— 想改原来的那条就传它的 id 更新,想加新的就换一个没有内容的 rect。\n" +
      "  · 改完东西之后程序会**自动重新生成并渲染页面**再检查一遍;如果检查出问题,你会收到一条说明。看到它就继续处理,处理完才算做完。",
  },
  {
    id: "cssRules",
    order: PROMPT_ORDER.cssRules,
    when: "append_css",
    text:
      "## CSS 硬规矩\n" +
      "违反时工具会返回 warnings,必须改掉而不是忽略:\n" +
      "  · **不要用 [style*=\"6850\"] 这种按内联样式字符串匹配的选择器** —— 那等于把坐标写死,元素一挪就全失效,而且没人知道那个数字指哪里。用 [data-node-id=\"...\"] 这种稳定标识。\n" +
      "  · **少用 !important** —— 数量一多就互相打架,出问题时无法判断哪条生效。要覆盖就提高选择器特异性,而不是无脑加 !important。\n" +
      "  · **过渡时长不超过 5 秒** —— 长过渡会让\"状态切换\"看起来像\"没反应\"。曾经有人写了 transition: 100000s,结果刷新后词云永远不显示,必须再点一次才出来。\n" +
      "  · **不要给 video 或播放控件加 pointer-events: none** —— 控件会显示但点不动。\n" +
      "  · **状态用 data-* 属性表达,不要靠某段提示文字或 .db-ok 之类的类名** —— 文案可以被关掉,状态不行(关掉文案时整个状态机就断了)。",
  },
  {
    id: "build",
    order: PROMPT_ORDER.build,
    when: "run_build",
    text: "- 修改类工具成功后,系统会自动重新生成页面,你一般无需调用 run_build;如确需立即重建可调用。",
  },
  {
    id: "output",
    order: PROMPT_ORDER.output,
    text: "## 回复\n- 用中文回答;完成后的回复要简短说明改了什么。",
  },
];

/**
 * 拼出系统提示词。`toolNames` 里没有的工具,它那一节不出现(不占 token)。
 * 不传就是全部工具(测试与 CLI 用)。
 */
export function buildSystemPrompt(toolNames) {
  const has = toolNames ? (n) => toolNames.has(n) : () => true;
  return PROMPT_SECTIONS.filter((s) => !s.when || has(s.when))
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((s) => s.text)
    .join("\n");
}

const SYSTEM_PROMPT = buildSystemPrompt(null);

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

// --- 工具结果剪枝 --------------------------------------------------------------
//
// 为什么需要:工具结果一旦进 history 就**永不清理** —— 单条 `read_page_text`
// 可以返回 20000 字符,`read_file` 50000,`get_standard` 是整份 template,
// 而 `view_image` 的 base64 会在本轮后续每一轮里重发。长任务里上下文就是这么炸的
// (实测:模型跑到一半开始"忘记"前面看过的内容,然后重复做已经做过的事)。
//
// 做法借鉴 DSH 的 compaction-tool-result-pruner:纯函数、零模型调用、
// 保留**头 + 尾**、中段换成显式标记。两个细节照抄:
//   · 按 **Unicode code point** 切,不劈开代理对(否则 emoji/生僻字会变成乱码);
//   · 剪完**再验一次确实变小了**,不然宁可不动。
//
// 与 DSH 的差别:它剪的是渲染后的整段文本,而我们返回的是 JSON ——
// 直接砍字符串会得到非法 JSON,模型想按字段读就废了。所以这里**按字段递归剪**:
// 长字符串各自保留头尾,超长数组保留前若干项,结构始终是合法 JSON。
export const PRUNE_MARKER = "\n\n[... 中间内容已裁剪 ...]\n\n";
export const PRUNE_DEFAULTS = Object.freeze({ thresholdChars: 8192, headChars: 4096, tailChars: 1024, maxItems: 80, keepItems: 40, maxDepth: 6 });

/** 按 code point 切,避免劈开代理对。 */
function slicePoints(s, start, end) {
  const pts = Array.from(s);
  return pts.slice(start, end).join("");
}

/**
 * 递归剪枝一个工具结果。返回新对象,不修改入参。
 * 只在确实变短时才替换,否则原样返回(照抄 DSH 的自检)。
 */
export function pruneToolResult(result, cfg = {}) {
  const c = { ...PRUNE_DEFAULTS, ...cfg };
  const pruneString = (s) => {
    // 按 code point 数,不是 .length —— 汉字/emoji 的 .length 会偏大
    const n = Array.from(s).length;
    if (n <= c.thresholdChars) return s;
    return slicePoints(s, 0, c.headChars) + PRUNE_MARKER + slicePoints(s, n - c.tailChars, n);
  };
  const walk = (v, depth) => {
    if (typeof v === "string") return pruneString(v);
    if (depth >= c.maxDepth) return v;
    if (Array.isArray(v)) {
      const mapped = v.map((x) => walk(x, depth + 1));
      if (mapped.length <= c.maxItems) return mapped;
      return [
        ...mapped.slice(0, c.keepItems),
        `[... 省略 ${mapped.length - c.keepItems} 项,共 ${mapped.length} 项。需要更多就缩小范围再查一次 ...]`,
      ];
    }
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val, depth + 1);
      return out;
    }
    return v;
  };
  const pruned = walk(result, 0);
  // 自检:没变小就别动(照抄 DSH 的 "must be smaller" 断言思路,只是这里降级为不动)
  try {
    if (JSON.stringify(pruned).length >= JSON.stringify(result).length) return result;
  } catch {
    return result;
  }
  return pruned;
}

// --- 会话历史:持久化 + 裁剪 ----------------------------------------------------
//
// 以前历史只存在 `main.js` 的一个内存 `Map` 里,所以:
//   · **关掉程序就全没了** —— 用户重开一次就得把需求重说一遍;
//   · 超出预算时从**最旧**开始丢 —— 而最旧的那条恰恰是他最初的需求,
//     于是模型记得"再大一点",却不记得"大一点"的是什么东西。
//
// 现在落到 `<输出目录>/chat-history.json`:跟着目录走,换机器/换目录都还对得上。
// 裁剪规则也改了:**永远保住第一条用户消息**(那是任务本身),中间的先丢。
//
// 借鉴 DSH 的 session-persistence:历史是**可回放**的一等对象,不是进程里的临时变量。
// 与 DSH 的差别:它用 append-only 的 JSONL + 四代格式迁移;这里只有一条对话,
// 单个 JSON 文件足够,不值得为它背上迁移的复杂度。
export const CHAT_HISTORY_FILE = "chat-history.json";
export const CHAT_HISTORY_LIMITS = Object.freeze({ maxMessages: 24, maxChars: 40000 });

/** 纯函数:裁剪历史。保住第一条用户消息,其余从中间丢。 */
export function trimChatHistory(list, limits = {}) {
  const lim = { ...CHAT_HISTORY_LIMITS, ...limits };
  if (!Array.isArray(list)) return [];
  let out = list.filter((m) => m && typeof m.content === "string" && m.content.trim());
  // 第一条用户消息 = 用户最初的需求,模型后面所有"再改一点"都依赖它
  const firstUser = out.find((m) => m.role === "user") || null;
  const rest = out.filter((m) => m !== firstUser);
  // 先按条数砍(从中间砍,不砍第一条)
  while (rest.length + (firstUser ? 1 : 0) > lim.maxMessages) rest.shift();
  // 再按长度砍
  const size = (l) => l.reduce((n, m) => n + m.content.length, 0);
  while (firstUser && rest.length && (size(rest) + firstUser.content.length) > lim.maxChars) rest.shift();
  return firstUser ? [firstUser, ...rest] : rest;
}

/** 读历史。文件不存在/坏了都返回空数组 —— 历史丢了不该让程序起不来。 */
export function loadChatHistory(outDir) {
  try {
    const raw = readFileSync(join(outDir, CHAT_HISTORY_FILE), "utf8");
    // 兼容两种形状:直接是数组,或 { version, messages }
    const d = JSON.parse(raw);
    const list = Array.isArray(d) ? d : d?.messages;
    return Array.isArray(list) ? list.filter((m) => m && typeof m.content === "string") : [];
  } catch {
    return [];
  }
}

/** 写历史(原子替换)。写失败只警告,不影响对话。 */
export function saveChatHistory(outDir, list) {
  try {
    const file = join(outDir, CHAT_HISTORY_FILE);
    writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, messages: list }, null, 2));
    renameSync(`${file}.tmp`, file);
    return true;
  } catch (e) {
    // 磁盘满之类 —— 历史存不下不是致命错误,但不能一声不吭
    console.warn(`会话历史保存失败(${e.message});这一轮的上下文重开程序后会丢失。`);
    return false;
  }
}

// --- 强制自检 ------------------------------------------------------------------
//
// 为什么需要:这一整轮所有"DOM 全对但页面不对"的问题,模型**一个都发现不了** ——
// 词云 canvas 在、尺寸对、一个像素没画;面板带着 submitted 却 opacity 0.0003;
// 控件在 HTML 里却被 pointer-events 挡住。而 check_page 明明能查出来,却**从来没被
// 自动调用过**:模型说一句"改好了"就结束了,页面上是什么样它并不知道。
//
// 做法:模型不再请求工具(= 它认为做完了)时,**如果这一轮真的写过东西**,
// 程序先自己跑一遍 check_page。有问题就把问题作为一条 user 消息回灌,强制它继续。
// 借鉴 DSH 的 repair.js:把"某件事的状态"翻译成"唯一正确的下一步"。
//
// 两道闸:最多自检 SELF_CHECK_MAX 轮(防止来回打转),且**允许模型说明某条是误报**
// —— 硬性"不许结束"会把有意的设计(比如"提交前就该藏着")也判成错。
export const SELF_CHECK_WRITE_TOOLS = new Set([
  "write_file", "append_css", "apply_wordcloud", "bind_data", "insert_video", "set_video_options",
  "edit_text", "edit_node", "clear_css", "restore_history",
  "delete_wordcloud", "delete_databind", "delete_video", "delete_edit", "delete_node_style",
]);
export const SELF_CHECK_MAX = 3;

/** 把 check_page 的问题整理成一条给模型的消息。 */
export function formatSelfCheck(reports) {
  const blocks = reports.map((r) => `【${r.slug}】\n${r.problems.map((p) => " · " + p).join("\n")}`);
  return (
    "你说做完了,但程序替你**实际渲染了页面**并检查过,发现还有问题:\n\n" +
    blocks.join("\n\n") +
    "\n\n浏览器控制台一条都不会报这些 —— 你看不到页面,所以只能靠这一步。请逐条处理,处理完我会再检查一次。\n" +
    "如果某一条是**有意为之**(比如面板本来就要在提交前藏着、过渡慢是设计要的效果),就直接说明理由,不用改。"
  );
}

// --- 图片卸载 ------------------------------------------------------------------
//
// 为什么需要:view_image 的图片只能作为一条 **user** 消息送达(工具结果不能带图)。
// 那条消息带着完整 base64 进 history 之后,**本轮后续每一轮都会重发** ——
// 看 4 张 1MB 的图 ≈ 5.3M 字符,一轮就把上下文吃干净,后面的工具结果全被挤掉。
// 剪枝对它是无效的:base64 在一个 image_url 块里,不是字符串字段。
//
// 做法借鉴 DSH 的 compaction-image-offload:超出预算时,把**最老的**图片换成
// 一句占位符(说明卸载了什么、怎么再看),最近几张保留 —— 模型当下正在看的多半是
// 刚请求的那几张。
export const IMAGE_BUDGET = Object.freeze({ maxImages: 4, maxBytes: 6 * 1024 * 1024 });

/**
 * 就地把 history 里最老的图片换成占位符。返回卸载了几张。
 * 只在**超出预算**时动手,且**至少保留最新的一张** —— 全卸载等于让模型凭空回答。
 */
export function offloadOldImages(history, budget = {}) {
  const b = { ...IMAGE_BUDGET, ...budget };
  // 收集所有图片块的位置
  const spots = [];
  for (let mi = 0; mi < history.length; mi++) {
    const m = history[mi];
    if (!Array.isArray(m?.content)) continue;
    for (let bi = 0; bi < m.content.length; bi++) {
      const block = m.content[bi];
      if (block?.type !== "image_url") continue;
      const url = String(block.image_url?.url || "");
      spots.push({ mi, bi, bytes: url.length, label: block.__label || "" });
    }
  }
  if (spots.length <= 1) return 0;
  const totalBytes = spots.reduce((n, s) => n + s.bytes, 0);
  if (spots.length <= b.maxImages && totalBytes <= b.maxBytes) return 0;

  // 从最老的开始卸,直到满足预算;但**永远保留最后一张**
  let count = spots.length;
  let bytes = totalBytes;
  let dropped = 0;
  for (let i = 0; i < spots.length - 1; i++) {
    if (count <= b.maxImages && bytes <= b.maxBytes) break;
    const s = spots[i];
    history[s.mi].content[s.bi] = {
      type: "text",
      text: `[图片${s.label ? " " + s.label : ""} 已从上下文中卸载以节省空间。如果还需要看它,重新调用 view_image 即可。]`,
    };
    count--;
    bytes -= s.bytes;
    dropped++;
  }
  return dropped;
}

// --- 循环检测 ------------------------------------------------------------------
//
// 为什么需要:模型会**卡在同一个调用上反复敲** —— 同一个 id、同样的参数、连着好几遍,
// 每次都拿回同样的失败,而它每次都"再看一次"结果然后原样重发。这在一轮无上限的
// 循环里能烧掉大量 token 和时间。这一轮真出现过:AI 找不到视频节点,连续试了
// 20 多个 id(那次参数各不相同,循环检测救不了;但"同一个 id 试三遍"是另一种)。
//
// 做法借鉴 DSH 的 repeat-tool-reminder:
//   · 按 (工具名, **规范化**参数) 连续计数;
//   · 在 3 / 5 / 8 次时注入提醒,措辞逐级加重,到后面直接点名参数;
//   · **数的是"尝试",不是"成功"** —— 被拒绝的调用也算;模型对着一个被拒的调用
//     反复敲,恰恰是最该打断的那种循环;
//   · 提醒是**建议性**的,不阻断任何合法调用。
//
// 规范化的关键:按键排序后再序列化。否则 `{a:1,b:2}` 和 `{b:2,a:1}` 会被当成
// 两次不同的调用,循环就漏检了。
export const REPEAT_THRESHOLDS = Object.freeze([3, 5, 8]);

export function canonicalArgs(args) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  try {
    return JSON.stringify(walk(args ?? {}));
  } catch {
    return String(args);
  }
}

export function repeatReminder(tool, count, argsCanonical) {
  if (count < 5) {
    return (
      `你把同一个工具调用连着发了 ${count} 次,参数完全一样。\n` +
      "先仔细看上一轮的结果再决定下一步:如果任务还没完成,换一个思路或换一组参数,**不要原样再发一次**。"
    );
  }
  return (
    `检测到重复调用:\n` +
    `- 工具: ${tool}\n` +
    `- 连续次数: ${count}\n` +
    `- 参数: ${String(argsCanonical).slice(0, 300)}\n` +
    "这些调用没有带来任何进展。**不要再用这组参数调用这个工具。** 看最新的结果,然后换一个动作、\n" +
    "换一组参数,或者在你已经拿到的证据足够时直接结束任务。\n" +
    "如果这个调用是因为缺信息而失败的,先想办法拿到那个信息(用对应的列举工具),而不是继续试。"
  );
}

export async function runAgent({ messages, model, tools, onEvent, config, maxTurns }) {
  // 按**这一轮实际可用的工具**拼提示词:某个工具不存在,它的那一节就不出现。
  // 现在 25 个工具总是全在,收益是零;但工具一旦按需注册(或某个被配置关掉),
  // 就不会再往提示词里塞用不上的说明、占 token 也误导模型。
  const toolNames = new Set((tools.schemas || []).map((s) => s?.function?.name).filter(Boolean));
  const history = [{ role: "system", content: toolNames.size ? buildSystemPrompt(toolNames) : SYSTEM_PROMPT }, ...messages];
  let finalText = "";
  // No turn cap by default — the GUI's abort button (config.signal) is the
  // escape hatch. Explicit maxTurns is still honored for tests.
  const limit = maxTurns == null ? Infinity : maxTurns;
  // 本轮改过哪些页面 —— 自检只查这些,不去渲染没动过的页(每次要起一次浏览器)。
  const touched = new Set();
  let selfChecks = 0;
  // 循环检测状态:上一次的 (工具,规范化参数) 与连续次数
  let lastKey = null;
  let repeatCount = 0;
  const selfCheckOn = config?.selfCheck !== false && typeof tools.handlers?.check_page === "function";
  for (let turn = 0; turn < limit; turn++) {
    onEvent?.({ type: "status", turn });
    // 发请求之前先卸掉过期的图片 —— base64 每一轮都会重发,不卸的话
    // 一次 view_image 就能把后面所有工具结果挤出上下文。
    const offloaded = offloadOldImages(history);
    if (offloaded) onEvent?.({ type: "images_offloaded", count: offloaded });
    let res;
    try {
      res = await model(history, tools.schemas, config.signal, onEvent);
    } catch (e) {
      onEvent?.({ type: "error", message: e.message });
      return { text: finalText || `调用出错: ${e.message}`, turnCount: turn, error: e.message };
    }
    history.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls.length ? res.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.arguments ?? {}) } })) : undefined });

    if (!res.toolCalls.length) {
      // 模型认为做完了。如果这一轮真的改过东西,先**替它看一眼页面**。
      if (selfCheckOn && touched.size && selfChecks < SELF_CHECK_MAX) {
        selfChecks++;
        onEvent?.({ type: "self_check", round: selfChecks, slugs: [...touched] });
        // **先重建再检查**。check_page 渲染的是构建产物,而模型改的是覆盖层 JSON ——
        // 不重建的话看到的是上一次的页面,"还没生效"会被误判成"没问题"。
        let buildError = null;
        if (typeof tools.build === "function") {
          try {
            await tools.build();
          } catch (e) {
            buildError = e.message;
          }
        }
        const reports = [];
        if (buildError) {
          reports.push({ slug: [...touched].join("、"), problems: [`重新生成页面失败: ${buildError}`] });
        } else {
          for (const slug of touched) {
            let r;
            try {
              r = await tools.handlers.check_page({ slug });
            } catch (e) {
              r = { error: e.message };
            }
            // 查不了就说查不了(比如产物还没生成),不要当成"检查通过"
            if (r?.error) reports.push({ slug, problems: [`检查没能进行: ${r.error}`] });
            else if (r?.problems?.length) reports.push({ slug, problems: r.problems });
          }
        }
        if (reports.length) {
          history.push({ role: "user", content: formatSelfCheck(reports) });
          onEvent?.({ type: "self_check_failed", round: selfChecks, count: reports.reduce((n, r) => n + r.problems.length, 0) });
          continue; // ← 不许结束,回轮
        }
        onEvent?.({ type: "self_check_passed", round: selfChecks });
      }
      finalText = res.content;
      onEvent?.({ type: "done", text: finalText, turnCount: turn + 1 });
      return { text: finalText, turnCount: turn + 1, selfChecks };
    }

    for (const tc of res.toolCalls) {
      onEvent?.({ type: "tool_start", tool: tc.name, args: tc.arguments });
      // 循环检测:**执行之前**计数。被拒绝/失败的调用也要算 ——
      // 模型对着一个失败的调用反复敲,正是最该打断的那种循环(DSH 同理)。
      const key = `${tc.name}\u0000${canonicalArgs(tc.arguments)}`;
      if (key === lastKey) repeatCount++;
      else { lastKey = key; repeatCount = 1; }
      if (REPEAT_THRESHOLDS.includes(repeatCount)) {
        history.push({ role: "user", content: repeatReminder(tc.name, repeatCount, canonicalArgs(tc.arguments)) });
        onEvent?.({ type: "repeat_detected", tool: tc.name, count: repeatCount });
      }
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
      // 记下改过哪些页面(自检只查这些)
      if (ok && SELF_CHECK_WRITE_TOOLS.has(tc.name)) {
        const slug = result?.slug || tc.arguments?.slug || null;
        if (slug) touched.add(slug);
      }
      // 进 history 之前先剪 —— 见 pruneToolResult 的说明。
      // 结果一旦进 history 就永不清理,不剪的话长任务必然撑爆上下文。
      history.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(pruneToolResult(result)) });
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
          ...imgs.map((i) => ({ type: "image_url", image_url: { url: i.dataUrl, detail: i.detail }, __label: i.label })),
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

// --- check_page 的页面探针脚本 ------------------------------------------------
//
// 在页面里跑,只回答"渲染出来到底是什么样"。这几项都是这一轮真出过问题的:
// canvas 存在但一个像素没画、面板带着 submitted 属性却 opacity 0、
// 过渡时长 27 小时、控件被 pointer-events 挡住、文字互相压住。
const PAGE_PROBE = `(function () {
  var out = { url: location.href, databinds: 0, states: {}, clouds: [], hidden: [], slowTransition: [], blocked: [], overlaps: [], canvasTotal: 0 };
  var els = document.querySelectorAll(".databind");
  out.databinds = els.length;
  for (var i = 0; i < els.length; i++) {
    var st = els[i].getAttribute("data-db-state") || "(无)";
    out.states[st] = (out.states[st] || 0) + 1;
  }
  // 词云 canvas:真的画了东西吗?读像素,不看 DOM。
  var cvs = document.querySelectorAll("canvas");
  out.canvasTotal = cvs.length;
  for (var i = 0; i < cvs.length; i++) {
    var c = cvs[i], r = c.getBoundingClientRect();
    if (r.width < 40 || r.height < 20) continue;
    var painted = 0, samples = 0;
    try {
      var d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      for (var j = 3; j < d.length; j += 4 * 53) { samples++; if (d[j] > 8) painted++; }
    } catch (e) { painted = -1; }
    // 容器可见吗?不可见时"没画像素"不算问题 —— 揭示式的面板本来就藏着。
    var host = c.closest(".databind") || c.parentElement;
    var hostOp = host ? parseFloat(getComputedStyle(host.querySelector(".db-body") || host).opacity) : 1;
    out.clouds.push({ size: c.width + "x" + c.height, box: Math.round(r.width) + "x" + Math.round(r.height),
      y: Math.round(r.top + window.scrollY), painted: painted, samples: samples,
      pct: samples ? Math.round(painted / samples * 100) : -1,
      visible: hostOp > 0.05, opacity: hostOp });
  }
  // 有内容却几乎看不见的容器
  var all = document.querySelectorAll(".databind, .db-body, .replica-video");
  for (var i = 0; i < all.length; i++) {
    var el = all[i], cs = getComputedStyle(el);
    var op = parseFloat(cs.opacity);
    if (op > 0.001 && op < 0.9 && el.getBoundingClientRect().width > 40) {
      out.hidden.push({ sel: el.className.split(" ")[0], opacity: cs.opacity, node: el.getAttribute("data-node-id") || "" });
    }
    if (parseFloat(cs.opacity) <= 0.001 && el.getBoundingClientRect().width > 40) {
      out.hidden.push({ sel: el.className.split(" ")[0], opacity: cs.opacity, node: el.getAttribute("data-node-id") || "", note: "完全透明" });
    }
  }
  // 过渡时长异常(会让"切换状态"看起来像没反应)
  var every = document.querySelectorAll("*");
  for (var i = 0; i < every.length && out.slowTransition.length < 5; i++) {
    var cs2 = getComputedStyle(every[i]);
    var durs = String(cs2.transitionDuration || "").split(",");
    for (var k = 0; k < durs.length; k++) {
      var sec = durs[k].trim().endsWith("ms") ? parseFloat(durs[k]) / 1000 : parseFloat(durs[k]);
      if (sec > 5) { out.slowTransition.push({ sel: (every[i].className || every[i].tagName).toString().slice(0, 40), duration: durs[k].trim() }); break; }
    }
  }
  // video / 控件被挡住
  var vids = document.querySelectorAll("video");
  for (var i = 0; i < vids.length; i++) {
    var cs3 = getComputedStyle(vids[i]);
    // **必须带 nodeId**。不带的话 AI 只知道"页面上有个视频",不知道**是哪个节点**,
    // 于是只能去猜 id —— 实测它连猜了 20 多个(2:178/2:156/2:155/2:153…),
    // 全部失败,而真正的视频在 2:1915。猜 id 是纯粹的浪费。
    out.blocked.push({ tag: "video", nodeId: vids[i].getAttribute("data-node-id") || "",
      videoId: vids[i].getAttribute("data-video-id") || "",
      muted: vids[i].muted, controls: vids[i].controls, autoplay: vids[i].autoplay,
      hasAudio: null,
      src: (vids[i].getAttribute("src") || "").split("/").pop().slice(0, 24), pointerEvents: cs3.pointerEvents });
  }
  // 文字互相压住:带 data-node-id 的叶子文本块两两比
  var texts = [];
  for (var i = 0; i < every.length; i++) {
    var el = every[i];
    if (!el.getAttribute || !el.getAttribute("data-node-id")) continue;
    var own = "";
    for (var m = 0; m < el.childNodes.length; m++) { var n = el.childNodes[m]; if (n.nodeType === 3) own += n.textContent; }
    if (!own.trim()) continue;
    var rr = el.getBoundingClientRect();
    if (rr.width < 8 || rr.height < 6) continue;
    texts.push({ id: el.getAttribute("data-node-id"), x: rr.left, y: rr.top + window.scrollY, w: rr.width, h: rr.height, t: own.replace(/\\s+/g, " ").trim().slice(0, 30) });
  }
  for (var a = 0; a < texts.length; a++) for (var b = a + 1; b < texts.length; b++) {
    var A = texts[a], B = texts[b];
    var ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
    var oy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
    if (ox <= 1 || oy <= 1) continue;
    var pct = (ox * oy) / Math.min(A.w * A.h, B.w * B.h);
    if (pct > 0.5) out.overlaps.push({ a: A.id + " " + A.t, b: B.id + " " + B.t, pct: Math.round(pct * 100) });
  }
  out.overlaps = out.overlaps.slice(0, 8);
  return out;
})()`;

// --- CSS 体检 -----------------------------------------------------------------
// 为什么需要:这一整轮排查下来,页面上"样式不生效 / 看不见 / 点不动"的问题**全部**
// 出在 AI 手写的 CSS 上,而且是它自己看不出来的那种:
//   · `[style*="6850"]` 按坐标字符串匹配元素 —— 实测 65 处。位置一改全失效,
//     而且读的人完全不知道 6850 指哪里;
//   · `!important` 137 个,互相打架 —— 排查揭示失败时就是被更特异的规则盖住;
//   · `transition: 100000s`(27 小时)—— 揭示动画永远跑不完,刷新后词云不显示,
//     用户报"得再点一次 Submit 才出来";
//   · `pointer-events: none` 落在 video 上 —— 控件看得见点不动。
// 这些都不是语法错误,浏览器不会报任何东西,所以必须由程序指出来。
const CSS_LIMITS = { important: 25, transitionSec: 5 };

export function auditCss(css) {
  const out = [];
  const text = String(css || "");
  const add = (level, rule, message, sample) => out.push({ level, rule, message, ...(sample ? { sample: String(sample).trim().slice(0, 90) } : {}) });

  // 1) 按坐标/尺寸字符串匹配内联样式
  const styleAttr = [...text.matchAll(/\[style\*=\s*["'][^"']*["']\s*\]/g)];
  if (styleAttr.length) {
    add("warn", "style-attr-match",
      `用 [style*="..."] 按内联样式字符串匹配元素,共 ${styleAttr.length} 处。这等于把坐标/尺寸写死在选择器里 —— 元素位置一改就全部失效,而且读代码的人不知道那个数字指哪里。**改用 [data-node-id="..."]**(它是稳定标识)。`,
      styleAttr[0][0]);
  }

  // 2) !important 数量
  const bangs = (text.match(/!important/g) || []).length;
  if (bangs > CSS_LIMITS.important) {
    add("warn", "important-count",
      `!important 用了 ${bangs} 个(建议不超过 ${CSS_LIMITS.important})。数量一多就会互相打架,而且排查问题时无法判断是哪条在生效 —— 这一轮就踩过:揭示规则被更特异的 !important 盖住,页面看着"没反应"。优先提高选择器特异性,而不是加 !important。`);
  }

  // 3) 过渡/动画时长异常
  // 注意 `\d*\.?\d+` —— 不能写成 `\d+(\.\d+)?`,否则 `.45s` 会被当成 `45s`
  // (小数点被跳过),正常时长全变成误报。
  for (const m of text.matchAll(/(?:transition|animation)(?:-duration)?\s*:[^;}]*?(\d*\.?\d+)(ms|s)\b/gi)) {
    const sec = m[2].toLowerCase() === "ms" ? Number(m[1]) / 1000 : Number(m[1]);
    if (sec > CSS_LIMITS.transitionSec) {
      add("error", "transition-too-long",
        `过渡时长 ${m[1]}${m[2]} 太长(上限建议 ${CSS_LIMITS.transitionSec}s)。长过渡会让"切换状态"看起来像"没反应" —— 实测 100000s 的过渡导致刷新后词云不显示,必须再点一次才出来。`,
        m[0]);
      break;
    }
  }

  // 4) video / 控件被禁用交互
  if (/pointer-events\s*:\s*none/i.test(text) && /video|\[controls\]|::-webkit-media-controls/i.test(text)) {
    add("error", "video-pointer-events",
      `有 pointer-events: none 落在 video / 播放控件上 —— 控件会显示但点不动。这是"控件没成功"的典型原因。`,
      (text.match(/[^{}]*video[^{}]*\{[^}]*pointer-events[^}]*\}/i) || [])[0]);
  }

  // 5) 硬编码坐标定位到具体节点
  const hardPos = [...text.matchAll(/\[data-node-id=[^\]]+\][^{]*\{[^}]*(?:left|top)\s*:\s*-?\d+(?:\.\d+)?px[^}]*!important/gi)];
  if (hardPos.length >= 3) {
    add("warn", "hardcoded-position",
      `有 ${hardPos.length} 处把 left/top 用固定 px 钉在具体节点上(还带 !important)。这些坐标是设计稿里的绝对值,页面一改版就全错位。要调整位置优先用节点自身的约束/样式,实在需要覆盖时集中写在一处并注明原因。`,
      hardPos[0][0]);
  }

  return out;
}



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

// 两个矩形重叠了多少(占较小者的比例)。浮点坐标先取整,免得 0.4px 的差被算成重叠。
export function rectOverlap(a, b) {
  const ox = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const oy = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  if (ox <= 1 || oy <= 1) return 0;
  const smaller = Math.min(a.width * a.height, b.width * b.height);
  return smaller > 0 ? (ox * oy) / smaller : 0;
}

// 把一个新矩形和已有的覆盖层比一遍,返回会被压住的那些。
//
// 为什么需要:AI **看不见页面**,它判断"这块地方有没有东西"只能靠坐标;
// 而覆盖层(wordclouds / databinds / videos)是它自己加的,**发布数据里没有**,
// 所以它看不到上一轮自己放了什么,极容易在同一处叠第二个。
// 实测(coco figma2):26 条 databind 里有两条 counter 的矩形**完全重叠**
// (都是 400x26 @(502,6792)),页面上两行字叠在一起;用户的描述是
// "词云生成之后提示内容不会消失" —— 其实是第二个 counter 的文字压在第一个上。
export function overlayCollisions(rect, existing) {
  const hits = [];
  for (const it of existing || []) {
    const r = it?.rect;
    if (!r || !Number.isFinite(r.left) || !Number.isFinite(r.top)) continue;
    const pct = rectOverlap(rect, r);
    if (pct < 0.25) continue;
    hits.push({ id: it.id, kind: it.kind || (it.spec && it.spec.kind) || "overlay", slug: it.slug, overlap: Math.round(pct * 100) });
  }
  return hits.sort((a, b) => b.overlap - a.overlap);
}

// 估算一段文字排进这个框需要多少高度 —— AI 改文字时它自己也算不出来,
// 于是"改长了"就直接溢出;而 textAutoResize:"NONE" 的节点是**固定高度**,
// 溢出部分会盖到相邻内容上(设计里 25px/33.7px 行高的正文,溢出 27px 就压到下一行标题)。
// 用等宽近似:汉字按 1em、其余按 0.5em 累计,再做换行。
export function estimateTextHeight(text, { width, fontSize, lineHeight, padding = 0 }) {
  const usable = Math.max(1, width - padding);
  const lines = String(text)
    .split(/\r\n|\r|\n|\u2028|\u2029/)
    .reduce((sum, line) => {
      let w = 0;
      for (const ch of line) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uffef]/.test(ch) ? 1 : 0.5;
      return sum + Math.max(1, Math.ceil((w * fontSize) / usable));
    }, 0);
  return lines * lineHeight;
}

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

  // --- 覆盖层快照 -------------------------------------------------------------
  //
  // 为什么需要:覆盖层文件(AI 的全部改动都落在这些文件里)是**唯一的事实来源**,
  // 但它们只由 AI 自己的工具写 —— 一次写坏就没有回去的路。
  // 这一轮真的发生过:我用脚本清理 CSS 时按 `}` 切块删规则,把紧跟在
  // "关于预览的注释"后面的**按钮样式整块删掉了**,页面上按钮全没样式,
  // 最后是靠文件旁边的 `.bak` 才救回来。那不该靠运气。
  //
  // 做法:每次 save* 之前把当前所有覆盖层文件拷一份到 `.history/<时间>-<谁>/`。
  // 只留最近 HISTORY_KEEP 份,免得无限增长。恢复就是整目录拷回来。
  const HISTORY_KEEP = 40;
  const OVERLAY_FILES = ["edits.json", "nodeStyles.json", "overrides.json", "wordclouds.json", "databinds.json", "videos.json", "databind-locks.json"];
  const historyDir = resolve(root, ".history");
  let lastSnapHash = "";

  const snapshot = (label) => {
    try {
      // 按**内容**去重,不是按时间:同一秒内连着改两次是两件事,必须各存一份
      // (否则回滚只能回到更早的状态,"撤掉刚才那一下"就做不到)。
      // 内容没变才跳过 —— 那种情况再存一份也没有意义。
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
      let hash = "";
      for (const f of OVERLAY_FILES) {
        const src = resolve(root, f);
        if (existsSync(src)) { try { hash += createHash("sha1").update(readFileSync(src)).digest("hex").slice(0, 8); } catch {} }
      }
      if (hash && hash === lastSnapHash) return;
      lastSnapHash = hash;
      const dir = join(historyDir, `${stamp}-${label}`);
      mkdirSync(dir, { recursive: true });
      let n = 0;
      for (const f of OVERLAY_FILES) {
        const src = resolve(root, f);
        if (existsSync(src)) { copyFileSync(src, join(dir, f)); n++; }
      }
      // 一份覆盖层文件都没有也要留档:那是"什么都没改"的初始状态,
      // 而"回到什么都没改"恰恰是回滚最常见的用途。恢复时对不存在的文件会删掉,
      // 所以空快照能真正把覆盖层清回初始态。
      writeFileSync(join(dir, "meta.json"), JSON.stringify({ label, at: new Date().toISOString(), files: n }, null, 2));
      // 只留最近 N 份
      const all = readdirSync(historyDir).filter((d) => !d.startsWith(".")).sort();
      for (const old of all.slice(0, Math.max(0, all.length - HISTORY_KEEP))) {
        rmSync(join(historyDir, old), { recursive: true, force: true });
      }
    } catch (e) {
      // 快照失败不能挡住真正的写入 —— 但要让人知道
      console.warn("覆盖层快照失败:", e.message);
    }
  };

  // 节点必须**会被渲染**才能改。
  //
  // 发布数据里有一大块组件定义区的原件:它们在 nodeById 里有坐标、看着完全正常,
  // 却永远不会出现在页面上。只查 nodeById 的话,edit_text / edit_node / bind_data
  // 都会"成功"返回,而页面上什么都没变 —— 用户看到的是"AI 说改了但页面没变",
  // 而 AI 完全不知道自己做错了(insert_video 早就有这道校验,其余几个漏了)。
  const requireRenderable = (slug, nodeId, what) => {
    const page = loadPages().find((p) => p.slug === slug);
    if (!page) return { error: `没有这个页面: ${slug}` };
    const { data } = pageTextOf(slug);
    const node = data.nodeById?.[nodeId];
    if (!node) return { error: `页面 ${slug} 没有节点 ${nodeId}` };
    if (!collectAll(data).some((n) => n.id === nodeId)) {
      const cands = collectAll(data)
        .filter((n) => (n.type === "TEXT" || n.type === "RECTANGLE" || n.type === "FRAME") && n.id !== nodeId)
        .slice(0, 6)
        .map((n) => `${n.id}(${n.type} ${n.name ? String(n.name).slice(0, 14) : ""})`);
      return {
        error: `节点 ${nodeId} 不在页面上(它是组件定义区的原件,永远不会被渲染),改它不会有任何效果`,
        hint: cands.length ? `${what || "可改"}的节点举例: ${cands.join(", ")}。用 read_page_text 拿完整列表` : undefined,
      };
    }
    return { node, data };
  };

  const saveWordClouds = (items) => {
    snapshot("wordcloud");    const file = resolve(root, "wordclouds.json");
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
    snapshot("databind");
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
    snapshot("video");
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
    snapshot("edit");
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
    snapshot("nodestyle");
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
    snapshot("css");
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
    snapshot("filelock");
    const file = resolve(root, "file-locks.json");
    writeFileSync(`${file}.tmp`, JSON.stringify({ version: 2, files }, null, 2));
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
      // 只列**会被渲染**的节点。nodeById 里有组件定义区的原件:存在、有坐标、
      // 永远不出现 —— 把它们列出来,AI 会挑中它们然后白忙一场。
      const renderable = new Set(collectAll(data).map((n) => n.id));
      const images = [];
      const videos = [];
      for (const n of Object.values(data.nodeById || {})) {
        if (!renderable.has(n.id)) continue;
        // **视频也必须列**。这个工具是"这页有什么媒体"的答案,而 VIDEO 填充
        // 以前被完全跳过 —— 实测 AI 想改首页视频时,唯一能拿到 nodeId 的地方
        // 都没有它,于是它按节点**名字**猜了个像视频的矩形,失败后又连猜了
        // 20 多个 id。真正的视频是另一个名字几乎一样、id 完全不同的节点。
        const vid = (n.fills || []).find((f) => f.type === "VIDEO");
        if (vid) {
          const vfile = findAssetFile(assetDir, vid.videoRef, ["mp4", "webm", "mov"]);
          const vbb = n.absoluteBoundingBox || {};
          videos.push({
            nodeId: n.id, kind: "video", name: n.name || "",
            w: Math.round(vbb.width || 0), h: Math.round(vbb.height || 0),
            file: vfile ? basename(vfile) : `${vid.videoRef} (文件缺失,需重新抓取)`,
            mb: vfile ? +(statSync(vfile).size / 1048576).toFixed(1) : 0,
            muted: vid.muted !== false, controls: vid.showControls === true,
            autoplay: vid.autoplay === true, loop: vid.mediaLoop === true,
            ...(vfile ? { audio: (videoTracks(vfile) || {}).audio === true } : {}),
            via: "设计自带的 VIDEO 填充",
          });
          continue;
        }
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
      // insert_video 插的(覆盖层里,不在发布数据里)
      for (const v of loadVideos().filter((i) => i.slug === slug && i.kind !== "fillOptions")) {
        videos.push({ nodeId: v.nodeId, kind: "inserted-video", file: v.src, muted: v.muted, controls: v.controls, autoplay: v.autoplay, via: "insert_video 插入" });
      }
      return {
        slug,
        count: images.length,
        images,
        ...(videos.length ? { videos, videoNote: "视频用 set_video_options({slug, nodeId, muted, controls}) 改声音/控件;nodeId 就是上面这些(不要按节点名字猜)。" } : {}),
      };
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
      // 记下**改之前**的内容 —— 那是构建生成的底稿。
      // 存它有什么用:构建时如果发现"现在的底稿"和"当初记的底稿"不一样,
      // 就说明**设计被重新拉取过**,不能拿 AI 的旧副本盖掉新设计。
      // 借鉴 DSH 的 FS_STALE_VERSION:写工具不信任自己上一次的读。
      const baseBefore = existsSync(p) ? readFileSync(p, "utf8") : null;
      writeFileSync(p, content);
      const rel = norm(p.slice(root.length + 1));
      const locked = isGeneratedProduct(rel);
      if (locked) {
        const locks = loadFileLocks();
        locks[rel] = {
          content,
          baseHash: baseBefore == null ? null : createHash("sha1").update(baseBefore).digest("hex").slice(0, 12),
          at: new Date().toISOString(),
        };
        saveFileLocks(locks);
      }
      // 写 styles.css 时也体检 —— 这是 AI 手写 CSS 的另一条路径,
      // append_css 那份是覆盖层,这份是整体替换,两边都得看。
      let cssWarnings = [];
      if (rel === "styles.css") {
        cssWarnings = auditCss(content).map((w) => `[${w.rule}] ${w.message}${w.sample ? `  例: ${w.sample}` : ""}`);
      }
      return { path, bytes: Buffer.byteLength(content), locked, ...(cssWarnings.length ? { warnings: cssWarnings } : {}) };
    },

    // 列出某个页面上**已经放过的覆盖层**。AI 看不到页面,而覆盖层是它自己加的、
    // 发布数据里没有 —— 没有这张表,它只能靠记忆,于是同一个地方叠第二个
    // (实测:25 条 databind 全绑同一个 collection,其中两条矩形完全重叠)。
    async list_overlays({ slug }) {
      const page = loadPages().find((p) => p.slug === slug);
      if (!page) return { error: `没有这个页面: ${slug}` };
      const onPage = (i) => i.slug === slug;
      const clouds = loadWordClouds().filter(onPage).map((i) => ({ id: i.id, rect: i.rect, words: (i.spec?.words || []).length }));
      const binds = loadDatabinds().filter(onPage).map((i) => ({
        id: i.id, kind: i.kind, collection: i.collection, rect: i.rect,
        ...(i.write?.target ? { clicksOn: i.write.target, writes: `${i.write.field}=${i.write.value ?? "(节点文字)"}` } : {}),
        ...(i.read?.groupBy ? { reads: i.read.groupBy } : {}),
      }));
      const videos = loadVideos().filter(onPage).map((i) => ({
        nodeId: i.nodeId, src: i.src, kind: i.kind || "insert",
        muted: i.muted, controls: i.controls, autoplay: i.autoplay,
      }));
      const edits = loadEdits().filter(onPage).map((i) => ({ id: i.id, nodeId: i.nodeId, fields: Object.keys(i).filter((k) => !["id", "slug", "nodeId", "createdAt"].includes(k)) }));
      const styles = loadNodeStyles().filter(onPage).map((i) => ({ nodeId: i.nodeId, props: Object.keys(i.style || {}) }));
      const css = loadOverrides().map((i) => ({ id: i.id, chars: (i.css || "").length }));
      // 重叠检查也顺便做掉 —— 这是 AI 最容易犯又最难自查的错
      const boxes = [...clouds.map((c) => ({ id: c.id, kind: "wordcloud", rect: c.rect })), ...binds.map((b) => ({ id: b.id, kind: b.kind, rect: b.rect }))]
        .filter((b) => b.rect && b.rect.width > 2 && b.rect.height > 2);
      const overlaps = [];
      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          const pct = rectOverlap(boxes[a].rect, boxes[b].rect);
          if (pct >= 0.25) overlaps.push(`${boxes[a].id} 与 ${boxes[b].id} 重叠 ${Math.round(pct * 100)}%`);
        }
      }
      return {
        slug,
        wordclouds: clouds,
        databinds: binds,
        videos,
        textEdits: edits,
        nodeStyles: styles,
        globalCss: css,
        ...(overlaps.length ? { overlaps, warn: "这些覆盖层互相压着 —— 页面上会看到内容叠在一起。除非有意的,否则应该合并(用同一个 id 更新)或挪开。" } : {}),
        ...(clouds.length + binds.length + videos.length + edits.length + styles.length + css.length === 0 ? { note: "这个页面上还没有任何覆盖层(还没有 AI 改动)" } : {}),
      };
    },

    // 列出覆盖层快照 —— 每次 AI 改动覆盖层之前都会自动存一份。
    // 用它是为了"改坏了能回去":覆盖层是唯一的事实来源,一次写坏就没有退路。
    async list_history({ limit }) {
      if (!existsSync(historyDir)) return { steps: [], note: "还没有任何快照(这是第一次改动前的状态)" };
      const dirs = readdirSync(historyDir).filter((d) => !d.startsWith(".")).sort().reverse();
      const steps = [];
      for (const d of dirs.slice(0, Math.max(1, Math.min(50, limit || 15)))) {
        let meta = {};
        try { meta = JSON.parse(readFileSync(join(historyDir, d, "meta.json"), "utf8")); } catch {}
        let files = [];
        try { files = readdirSync(join(historyDir, d)).filter((f) => f !== "meta.json"); } catch {}
        steps.push({ id: d, label: meta.label || "?", at: meta.at || "", files });
      }
      return { steps, total: dirs.length, note: "用 restore_history({id}) 回到某一步" };
    },

    // 把覆盖层整体回滚到某个快照。**只动覆盖层,不动产物 HTML** ——
    // 产物 regenerate 一次就会按回滚后的覆盖层重建。
    async restore_history({ id }) {
      const dir = join(historyDir, String(id || ""));
      if (!id || !existsSync(dir)) {
        const r = await this.list_history({});
        return { error: `没有这个快照: ${id}`, ...(r.steps?.length ? { hint: `可用的: ${r.steps.slice(0, 8).map((s) => s.id).join(", ")}` } : {}) };
      }
      // 回滚本身也要可逆:先把"当前状态"存一份
      snapshot("before-restore");
      lastSnapHash = "";
      const restored = [];
      for (const f of OVERLAY_FILES) {
        const src = join(dir, f);
        if (existsSync(src)) { copyFileSync(src, resolve(root, f)); restored.push(f); }
        else if (existsSync(resolve(root, f))) { rmSync(resolve(root, f), { force: true }); }
      }
      return { restoredTo: id, files: restored, note: "覆盖层已回滚;需要 regenerate 一次才能让产物反映出来" };
    },

    // 把产物页面真的打开看一眼 —— 代替 AI 的眼睛。
    // 这一轮所有"DOM 全对但页面不对"的问题都只能靠它发现。
    async check_page({ slug, waitMs }) {
      const page = loadPages().find((p) => p.slug === slug);
      if (!page) return { error: `没有这个页面: ${slug}` };
      const file = resolve(root, page.file);
      if (!existsSync(file)) return { error: `产物还没生成: ${page.file}。先 regenerate 再检查` };
      if (waitMs) process.env.REPLICA_PROBE_WAIT = String(Math.max(1000, Math.min(20000, waitMs)));
      let r;
      try {
        r = await pageProbe(pathToFileURL(file).href, PAGE_PROBE);
      } catch (e) {
        return { error: `打不开页面做检查: ${e.message}` };
      }
      const v = r?.value || {};
      const problems = [];
      for (const c of v.clouds || []) {
        // 只在**容器可见**时判定"画没画" —— 还没提交时面板本来就 opacity:0 藏着,
        // 那时候 canvas 里是 fallback,报"一个像素没画"是误报,只会让 AI 白忙。
        if (c.visible === false) {
          problems.push(`词云容器 ${c.box} 当前是隐藏的(opacity ${c.opacity}) —— 如果这是"提交后才揭示"的设计就正常;否则检查揭示逻辑。`);
          continue;
        }
        if (c.painted === 0) problems.push(`词云画布 ${c.box}(y=${c.y}) 一个像素都没画 —— canvas 在、尺寸对,但内容是空的。通常是布局函数返回了空数组(比如权重全为 0 被过滤掉),或者渲染器没挂上。`);
        else if (c.pct >= 0 && c.pct < 1) problems.push(`词云画布 ${c.box} 只有 ${c.pct}% 的采样点有颜色,基本等于空白。`);
      }
      for (const h of v.hidden || []) {
        problems.push(`${h.sel}${h.node ? " (节点 " + h.node + ")" : ""} 的 opacity 是 ${h.opacity}${h.note ? "(" + h.note + ")" : ""} —— 有内容却几乎看不见。这一轮遇到过:面板带着 data-db-state="submitted" 却是 opacity 0.0003,原因是揭示卡在 27 小时的过渡动画中途。`);
      }
      // 同一种时长只报一次 —— 页面上往往几十个元素共用同一条规则,
      // 逐条列出来会把真正的问题淹掉。
      const slowSeen = new Set();
      for (const t of v.slowTransition || []) {
        if (slowSeen.has(t.duration)) continue;
        slowSeen.add(t.duration);
        problems.push(`有元素披着 ${t.duration} 的过渡(超过 5 秒)—— 状态切换会看起来像"没反应"。这一轮就踩过:100000s 的过渡让揭示永远跑不完,刷新后词云不显示,必须再点一次才出来。`);
      }
      for (const b of v.blocked || []) {
        const at = b.nodeId ? `节点 ${b.nodeId}` : b.src;
        if (b.pointerEvents === "none") problems.push(`video(${b.src}) 被设了 pointer-events: none —— 控件会显示但点不动。`);
        if (b.muted && b.controls === false && b.autoplay === false) problems.push(`video(${at}) 既静音、又没控件、又不自动播放 —— 访客完全无法播放它。要有声音和控件就用 set_video_options({nodeId:"${b.nodeId}", muted:false, controls:true});只想要一个跟设计同色的播放按钮就传 controls:"custom"。`);
        else if (b.muted && b.controls === false) problems.push(`video(${at}) 没有播放控件,而访客默认听不到声音。要有声音用 set_video_options({nodeId:"${b.nodeId}", muted:false, controls:true})。`);
      }
      for (const o of v.overlaps || []) problems.push(`文字叠在一起: ${o.a} 与 ${o.b}(重叠 ${o.pct}%)。`);
      for (const e of r?.errors || []) problems.push(`页面抛了 JS 异常: ${e}`);
      return {
        slug,
        ok: problems.length === 0,
        databinds: v.databinds,
        states: v.states,
        clouds: (v.clouds || []).length,
        videos: v.blocked || [],
        problems,
        ...(problems.length ? { hint: "这些问题浏览器控制台一条都不会报,只能靠这个检查发现。请逐条处理。" } : {}),
      };
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
      const allClouds = loadWordClouds();
      const collisions = overlayCollisions(r, [
        ...allClouds.filter((i) => i.id !== newId),
        ...loadDatabinds(),
        ...loadVideos(),
      ]);
      const items = allClouds.filter((i) => i.id !== newId);
      items.push({ id: newId, slug, rect: r, spec: newSpec, createdAt: new Date().toISOString() });
      saveWordClouds(items);
      // **被夹取要说明**。横向会夹进画布宽度、纵向允许低于画布(构建会把画布加高),
      // 但"我按原样放的"和"程序替我挪了"必须分得清 —— 否则 AI 以为放在 A 处、
      // 实际落在别处,后面所有关于位置的判断都建立在错的坐标上。
      const moved = [];
      if (Math.round(r.left) !== Math.round(rect.left)) moved.push(`left ${Math.round(rect.left)} → ${Math.round(r.left)}`);
      if (Math.round(r.top) !== Math.round(rect.top)) moved.push(`top ${Math.round(rect.top)} → ${Math.round(r.top)}`);
      if (Math.round(r.width) !== Math.round(rect.width)) moved.push(`width ${Math.round(rect.width)} → ${Math.round(r.width)}(画布宽 ${Math.round(cw)}px,不能超出)`);
      if (Math.round(r.height) !== Math.round(rect.height)) moved.push(`height ${Math.round(rect.height)} → ${Math.round(r.height)}`);
      return {
        id: newId,
        slug,
        rect: r,
        wordCount: newSpec.words.length,
        ...(moved.length ? { adjusted: moved, note: `你给的矩形被调整过:${moved.join(";")}。实际生效的是返回的 rect。` } : {}),
        ...(collisions.length
          ? {
              warnings: collisions.map(
                (c) => `矩形和已有的「${c.id}」(${c.kind}, ${c.overlap}% 重叠)压在一起 —— 词云会盖住它、或者被它盖住。` +
                  `确认是有意的;否则挪开,或者改用 id="${c.id}" 更新原来那条。`,
              ),
            }
          : {}),
      };
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
      if (!["bar", "counter", "list", "wordcloud", "action"].includes(k)) {
        return { error: "kind 必须是 bar(占比条,投票) / counter(计数) / list(列表,留言) / wordcloud(实时词云) / action(只写入、不渲染)" };
      }
      // action = 只把点击接到后端,**不在页面上画任何东西**。
      // 缺了它,「点这个标签给词云投一票」只能靠 kind=wordcloud + 1×1 的矩形硬凑 ——
      // 实测 coco figma2 就是这么干的:24 个分类标签 = 24 条 wordcloud,其中 23 条
      // rect 是 1x1,再写 CSS `.databind[style*="width:1px"]{display:none}` 把它们藏掉。
      // 65 处 [style*=] 坐标 hack、137 个 !important、618 行 CSS,全是为了绕开这一点。
      if (k === "action") {
        if (!write || !write.target) return { error: "action 绑定必须给 write.target(点哪个节点)" };
        rect = rect || { left: 0, top: 0, width: 0, height: 0 };
      }
      if (!rect || !["left", "top", "width", "height"].every((f) => Number.isFinite(rect[f]))) {
        return { error: "rect 需要 {left,top,width,height} 数值" };
      }
      const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
      const rd = read || {};
      // action 不读数据(groupBy 只用于 /stats 的字段名,action 用不到)
      if ((k === "bar" || k === "wordcloud") && !FIELD_RE.test(String(rd.groupBy || ""))) {
        return { error: "read.groupBy 必须是合法字段名(字母/下划线开头),例如 choice / text" };
      }

      let w = null;
      if (write) {
        if (!FIELD_RE.test(String(write.field || ""))) return { error: "write.field 必须是合法字段名" };
        if (write.target) {
          // 只查 nodeById 不够:组件定义区的原件在数据里存在、有坐标,却永远不渲染。
          // 绑到那种节点上,点击永远不会有反应,而这里会"成功"返回。
          const chk = requireRenderable(slug, String(write.target), "可绑点击");
          if (chk.error) return chk;
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
      // 每个访客能投几次。默认 once(每一项一次,防刷票),但用户经常需要
      // "同一项也能再投"或"改主意"。以前只有 once 一种行为,而且被拒绝时**不吭声**
      // (用户报"有些提交没成功",其实是重复点同一个标签)。
      const perVisitor = ["once", "many", "single"].includes(options?.perVisitor) ? options.perVisitor : "once";
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
        options: { ...(options || {}), perVisitor },
        createdAt: new Date().toISOString(),
      };
      if (!(await confirm({ kind: "databind", payload: item }))) return { error: "用户拒绝了这次数据绑定" };
      const all = loadDatabinds();
      // 和自己以外的所有覆盖层比一遍 —— AI 看不到页面,这是唯一能提醒它"这里已经有东西"的机会
      const existing = [...all.filter((i) => i.id !== newId), ...loadWordClouds(), ...loadVideos()];
      const collisions = overlayCollisions(r, existing);
      const items = all.filter((i) => i.id !== newId);
      items.push(item);
      saveDatabinds(items);
      return {
        id: newId,
        slug,
        collection: item.collection,
        kind: k,
        mode: w ? (w.target ? `点击节点 ${w.target} 提交` : "访客输入后提交") : "只读",
        ...(collisions.length
          ? {
              warnings: collisions.map(
                (c) => `矩形和已有的「${c.id}」(${c.kind}, ${c.overlap}% 重叠)压在一起 —— 页面上会看到两段内容叠着。` +
                  `请确认这是有意的;如果只是想给同一个位置再绑一次,应该用 id 更新原来那条(传 id="${c.id}"),` +
                  `或者把 rect 挪到没有内容的位置。`,
              ),
            }
          : {}),
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
      // 默认**不静音**。旧写法 `muted !== false` 在没传时是 true —— AI 调用时
      // 通常不会特意传 muted,于是每个插入的视频都变成哑巴(实测 2026101203:
      // 那个文件有音轨、93 秒,页面上却一声不响,而没人要求过静音)。
      // 只有两种情况静音:显式 muted:true,或者要自动播放(浏览器一律拦截带声音的自动播放)。
      const wantsAutoplay = !!autoplay;
      const spec = {
        id: newId,
        slug,
        nodeId,
        src: useSrc,
        poster: usePoster,
        fit: fit === "contain" || fit === "fill" ? fit : "cover",
        // 有声音就必须给控件,否则访客既听不到也没法自己播
        controls: controls !== false,
        autoplay: wantsAutoplay && muted !== false,
        loop: !!loop,
        muted: muted === true || (wantsAutoplay && muted !== false),
      };
      // 查一下文件里到底有没有音轨 —— 有声音却被静音,是用户最需要知道的那种
      const tracks = /^https?:\/\//i.test(useSrc) ? null : videoTracks(resolve(root, useSrc));
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
        muted: spec.muted,
        controls: spec.controls,
        note: [
          srcSwapped ? `你说的是 ${srcSwapped.from},它不存在;已改用实际存在的 ${srcSwapped.to}(中文文件名被错误编码过就会这样),要换请告诉用户` : null,
          spec.autoplay && spec.muted ? "已自动加 muted:浏览器会拦截带声音的自动播放" : null,
          // 有音轨却被静音 —— 这是用户最需要知道的一条,因为他只能靠耳朵发现
          tracks?.audio && spec.muted ? `这个视频**含音轨**,但当前是静音播放(访客听不到)。要有声音就用 set_video_options({nodeId:"${nodeId}", muted:false, controls:true});注意有声音就不能自动播放。` : null,
          tracks?.audio && !spec.muted ? "已开启声音(浏览器要求访客先点一下播放)" : null,
          tracks && !tracks.audio ? "这个文件里没有音轨(纯画面),设 muted 与否都一样" : null,
        ]
          .filter(Boolean)
          .join("；") || undefined,
      };
    },

    // 改一个**已存在**视频的播放选项 —— 设计自带的 VIDEO 填充也包括在内。
    // 存在的理由:Figma 的 VIDEO 填充永远带着 muted:true / showControls:false,
    // 而且**在 Figma 里根本没有开关可以改**(Figma 不处理视频声音)。
    // 于是文件里明明有音轨、页面上却一声不响,用户只能靠"看页面"发现。
    // 这个工具让 AI/用户把 Figma 给不了的选项补上。
    async set_video_options({ slug, nodeId, muted, controls, autoplay, loop, src }) {
      const chk = requireRenderable(slug, nodeId, "可改视频");
      if (chk.error) return chk;
      const node = chk.node;

      const existing = loadVideos().find((i) => i.nodeId === nodeId && i.slug === slug);
      const fill = (node.fills || []).find((f) => f.type === "VIDEO");
      if (!existing && !fill) {
        // 提示要把**设计自带的 VIDEO 填充**也列出来,不能只看 videos.json ——
        // 那是 AI 插入的记录,全新抓取的站点里根本没有这个文件。
        // 实测:AI 按节点**名字**(叫"lily网站视频 1")挑了个没有 VIDEO 填充的矩形,
        // 收到"没有视频"后因为没有别的线索,又连猜了 20 多个 id,全部失败 ——
        // 而真正的视频是另一个名字几乎一样的节点。
        const vids = [
          // kind:"fillOptions" 的是"只改设计自带视频的选项"的记录,它指向的就是
          // 下面那个设计填充本身 —— 不排掉的话同一个节点会列两遍。
          ...loadVideos().filter((i) => i.slug === slug && i.kind !== "fillOptions").map((i) => `${i.nodeId}(插入的 ${i.src.split("/").pop()})`),
          ...collectAll(chk.data || pageTextOf(slug).data)
            .filter((n) => (n.fills || []).some((f) => f.type === "VIDEO"))
            .map((n) => {
              const f = n.fills.find((x) => x.type === "VIDEO");
              return `${n.id}(设计自带 ${Math.round(n.absoluteBoundingBox?.width)}x${Math.round(n.absoluteBoundingBox?.height)} "${String(n.name || "").slice(0, 20)}"${f.muted ? " 静音" : ""})`;
            }),
        ];
        return {
          error: `节点 ${nodeId} 上没有视频(既不是设计自带的 VIDEO 填充,也没有 insert_video 记录)`,
          ...(vids.length
            ? { hint: `这个页面上的视频在: ${vids.join(", ")}。**不要靠节点名字猜** —— 名字里有"视频"的节点不一定真的有视频填充;用上面这些 id,或者用 list_images 看全貌。` }
            : { hint: "这个页面上没有视频。要加视频先用 insert_video。" }),
        };
      }

      // controls 除了 true/false 还接受 "custom"(用自带的播放按钮,不要浏览器那套 UI)
      const pickCtl = (v, cur) => (v === "custom" ? "custom" : typeof v === "boolean" ? v : cur);
      const pick = (v, cur) => (typeof v === "boolean" ? v : cur);
      let next;
      if (existing) {
        next = { ...existing, muted: pick(muted, existing.muted), controls: pickCtl(controls, existing.controls), autoplay: pick(autoplay, existing.autoplay), loop: pick(loop, existing.loop) };
        if (src) next.src = String(src);
      } else {
        // 设计自带的 VIDEO 填充:基底是 Figma 的默认值(永远静音、永远没控件)
        const base = videoOptionsFrom(fill, {});
        next = {
          kind: "fillOptions",
          id: `vopt-${nodeId}`,
          slug,
          nodeId,
          src: `assets/${fill.videoRef}.mp4`,
          muted: pick(muted, base.muted),
          controls: pickCtl(controls, base.controls),
          autoplay: pick(autoplay, base.autoplay),
          loop: pick(loop, base.loop),
        };
      }

      const notes = [];
      // 有声音 + 自动播放 = 浏览器直接不播,必须摘掉一个
      if (next.muted === false && next.autoplay) {
        next.autoplay = false;
        notes.push("有声音时不能自动播放(浏览器一律拦截),已把 autoplay 关掉");
      }
      if (next.muted === false && next.controls === false) {
        next.controls = true;
        notes.push("开了声音但没给控件,已把 controls 打开 —— 否则访客没法自己点播放");
      }
      if (next.muted === false && next.controls === "custom") {
        notes.push("用的是自定义播放按钮(controls:custom)—— 按钮只在访客点它之后才有声音,这是浏览器的要求");
      }
      const local = next.src && !/^https?:\/\//i.test(next.src) ? join(root, next.src) : null;
      const tracks = local ? videoTracks(local) : null;
      if (tracks?.audio && next.muted) notes.push("这个文件**含音轨**,现在仍是静音;要听得到就 muted:false");
      if (tracks && !tracks.audio) notes.push("这个文件里没有音轨(纯画面)");

      if (!(await confirm({ kind: "video", payload: next }))) return { error: "用户拒绝了这次修改" };
      const kept = loadVideos().filter((i) => !(i.nodeId === nodeId && i.slug === slug));
      kept.push({ ...next, createdAt: new Date().toISOString() });
      saveVideos(kept);
      return { slug, nodeId, muted: next.muted, controls: next.controls, autoplay: next.autoplay, loop: next.loop, note: notes.join("；") || undefined };
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
      const chk = requireRenderable(slug, nodeId, "可改文字");
      if (chk.error) return chk;
      const node = chk.node;
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

      // 文字改长了会不会溢出?AI 自己算不出来(它看不到页面),而
      // textAutoResize:"NONE" 是**固定高度**,溢出部分会直接盖到相邻内容上 ——
      // 用户看到的就是"AI 把文字放到别的文字上面"。所以在这里估算一次并明说。
      const bb = node.absoluteBoundingBox || {};
      const st = node.style || {};
      const fs = change.fontSize ?? st.fontSize ?? 16;
      const lh = st.lineHeightPx || fs * 1.3;
      const finalText = change.text ?? String(node.characters || "");
      const warnings = [];
      if (bb.width > 0 && bb.height > 0) {
        const need = estimateTextHeight(finalText, { width: bb.width, fontSize: fs, lineHeight: lh });
        const before = estimateTextHeight(String(node.characters || ""), { width: bb.width, fontSize: fs, lineHeight: lh });
        // 只在"明显放不下"或"比原来明显更高"时提醒,免得每改一次都刷一堆噪音
        if (need > bb.height * 1.15) {
          const fixed = st.textAutoResize === "NONE";
          warnings.push(
            `这段文字按 ${fs}px / 行高 ${lh.toFixed(1)}px 估算需要约 ${Math.round(need)}px,而节点框只有 ${Math.round(bb.height)}px` +
              (fixed ? "(textAutoResize=NONE,固定高度 → 多出来的部分会溢出压到相邻内容上)" : "") +
              `。要么把文字缩短,要么用 edit_node 把 height 调大到 ${Math.ceil(need)}px 以上。` +
              (need > before * 1.2 ? `(原来约 ${Math.round(before)}px,这次明显变高了)` : ""),
          );
        } else if (need > bb.height) {
          warnings.push(`估算需要约 ${Math.round(need)}px,略超节点框 ${Math.round(bb.height)}px —— 可能会压到下一行,注意检查。`);
        }
      }
      return { id: newId, slug, nodeId, change, ...(warnings.length ? { warnings } : {}) };
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

    // style 之外再支持 width/height 两个**语义化**参数。
    // 为什么:edit_text 会因为文字变长而警告"估算需要 Xpx,节点框只有 Ypx";
    // 而修的办法就是用 height 把框调大。之前只能塞进 style:{height:"Xpx"},
    // 但那样得自己记得写单位,而且工具说明里没引导 —— AI 往往就放着不管了。
    async edit_node({ id, slug, nodeId, style, height, width }) {
      const chk = requireRenderable(slug, nodeId, "可改样式");
      if (chk.error) return chk;
      const node = chk.node;
      if (!style && height === undefined && width === undefined) {
        return { error: "至少要提供 style 或 height / width" };
      }
      if (style !== undefined && (typeof style !== "object" || Array.isArray(style) || style === null)) return { error: "style 需要是一个 CSS 属性对象" };
      const clean = {};
      for (const [k, v] of Object.entries(style || {})) {
        if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(k)) return { error: `非法样式属性名: ${k}` };
        if (typeof v !== "string" && typeof v !== "number") return { error: `属性 ${k} 的值需要是字符串或数字` };
        const s = String(v).trim();
        if (!s) return { error: `属性 ${k} 的值不能为空` };
        if (s.length > 200 || /[";<>]/.test(s)) return { error: `属性 ${k} 的值含非法字符或过长` };
        clean[k] = s;
      }
      // width/height 走同一套校验(它们是 CSS 值,直接内联进 style 属性)
      const num = (v, name) => {
        if (v === undefined) return null;
        if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return { error: `${name} 需要是正数(单位 px;不写单位)` };
        if (v > 20000) return { error: `${name} 太大了(${v}px),确认一下是不是写错了` };
        return Math.round(v);
      };
      const h = num(height, "height");
      if (h && h.error) return { error: h.error };
      const wd = num(width, "width");
      if (wd && wd.error) return { error: wd.error };
      if (h) clean.height = `${h}px`;
      if (wd) clean.width = `${wd}px`;

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
      // 改了高度就顺便核对一下文字放不放得下 —— 这正是这个功能的用途
      const notes = [];
      if (h && node.type === "TEXT") {
        const bb = node.absoluteBoundingBox || {};
        const st = node.style || {};
        const fs = st.fontSize || 16;
        const lh = st.lineHeightPx || fs * 1.3;
        const need = estimateTextHeight(String(node.characters || ""), { width: bb.width || 1, fontSize: fs, lineHeight: lh });
        if (need > h * 1.15) notes.push(`文字按 ${fs}px/行高 ${lh.toFixed(1)}px 估算需要约 ${Math.round(need)}px,仍超过新的 ${h}px —— 还要再调大,或者缩短文字。`);
        else notes.push(`框已调到 ${h}px(文字估算约 ${Math.round(need)}px),放得下了。`);
      }
      return { id: newId, slug, nodeId, props: Object.keys(clean), ...(notes.length ? { note: notes.join("；") } : {}) };
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
      // 体检整份覆盖 CSS(不只是这次新增的):!important 会跨条累积打架,
      // 只看这一条发现不了。要跟已有的合起来看。
      const all = kept.map((i) => i.css).join("\n");
      const warnings = auditCss(all).map((w) => `[${w.rule}] ${w.message}${w.sample ? `  例: ${w.sample}` : ""}`);
      return { id: newId, chars: css.length, ...(warnings.length ? { warnings } : {}) };
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
        name: "list_overlays",
        description:
          "列出这个页面上**已经放过的**覆盖层:词云、数据绑定(含点哪个节点写什么字段)、视频、文字改动、节点样式、全局 CSS。还会指出互相重叠的那些。" +
          "**加任何新东西之前先看它** —— 你看不到页面,而覆盖层是你自己加的、发布数据里没有,只靠记忆很容易在同一处叠第二个。不消耗 API 额度",
        parameters: { type: "object", properties: { slug: { type: "string", description: "页面 slug" } }, required: ["slug"] },
      },
    },
    {
      type: "function",
      function: {
        name: "list_history",
        description:
          "列出覆盖层的自动快照(每次你改动 edits/nodeStyles/overrides/wordclouds/databinds/videos 之前都会自动存一份)。" +
          "改动改坏了、或者用户说刚才那样挺好的时候,用这个找到要回到的那一步,再调 restore_history。不消耗 API 额度",
        parameters: { type: "object", properties: { limit: { type: "number", description: "最多列几步,默认 15" } } },
      },
    },
    {
      type: "function",
      function: {
        name: "restore_history",
        description:
          "把覆盖层整体回滚到某个快照(id 来自 list_history)。只动覆盖层,产物需要 regenerate 一次才会体现。" +
          "回滚本身也是可逆的(会自动先存一份当前状态)。会请求用户确认",
        parameters: { type: "object", properties: { id: { type: "string", description: "快照 id" } }, required: ["id"] },
      },
    },
    {
      type: "function",
      function: {
        name: "check_page",
        description:
          "把生成好的页面真的打开渲染一遍,报告**只有渲染后才发现得了**的问题:词云 canvas 是不是真的画了像素、有内容的容器是不是几乎透明(opacity 接近 0)、过渡时长是否长得离谱、" +
          "video 是否被 pointer-events 挡住/既静音又没控件、文字是否互相压住、页面有没有抛 JS 异常。" +
          "这些问题浏览器控制台一条都不会报,而你**看不到页面** —— 改完样式、放完词云、插完视频后都应该调一次。返回 problems 数组时逐条处理。不消耗 API 额度",
        parameters: {
          type: "object",
          properties: {
            slug: { type: "string", description: "页面 slug" },
            waitMs: { type: "number", description: "可选;等页面渲染多久再检查,默认 6000 毫秒(有轮询/动画时可以调大)" },
          },
          required: ["slug"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "set_video_options",
        description:
          "改一个**已存在**视频的播放选项(设计自带的 VIDEO 填充也能改)。" +
          "存在的理由:Figma 的视频填充永远带着 muted:true / showControls:false,而且 Figma 里**没有开关可以改** —— " +
          "文件里明明有音轨、页面上却一声不响,用户只能靠看页面发现。这个工具把 Figma 给不了的选项补上。" +
          "注意:浏览器一律拦截带声音的自动播放,所以 muted:false 与 autoplay:true 不能同时成立(会自动摘掉 autoplay 并说明);" +
          "开了声音就一定保留控件,否则访客没法自己点播放。会请求用户确认",
        parameters: {
          type: "object",
          properties: {
            slug: { type: "string", description: "页面 slug" },
            nodeId: { type: "string", description: "视频所在节点(insert_video 用的那个,或设计里带 VIDEO 填充的节点)" },
            muted: { type: "boolean", description: "是否静音。想让访客听到声音就传 false" },
            controls: { type: "string", enum: ["true", "false", "custom"], description: "播放控件:true=浏览器自带;false=完全不显示(有声音时会强制打开);custom=只给一个跟设计同色的播放按钮,不要浏览器那套亮色 UI" },
            autoplay: { type: "boolean", description: "是否自动播放。有声音时会被关掉(浏览器拦截)" },
            loop: { type: "boolean", description: "是否循环" },
            src: { type: "string", description: "可选;顺便换掉视频文件" },
          },
          required: ["slug", "nodeId"],
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
                done: { type: "string", description: "已提交后的提示文字,默认「已提交」;传空串表示提交后不显示任何提示" },
                perVisitor: {
                  type: "string",
                  enum: ["once", "many", "single"],
                  description:
                    "每个访客能投几次。once(默认)=每一项一次,再点会提示「你已经投过了」——防刷票;" +
                    "many=同一项可以重复投(累加);single=可以改主意,后端后写覆盖前写。" +
                    "注意 once 是**每一项一次**:24 个选项就是最多 24 票,不是总共一票。",
                },
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
        description:
          "持久修改任意节点(文本/图片/矩形)的样式。style 为原始 CSS 属性对象,如 {color:'#ff0000','font-size':'24px'}。" +
          "也可以直接给 height / width(数字,单位 px)—— **edit_text 警告文字溢出时就用它把框调大**,不用自己拼单位。" +
          "nodeId 来自 read_page_text 的 all 列表。修改持久保存,重新生成后仍在。会请求用户确认",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "可选;更新已存在的样式修改时传它的 id" },
            slug: { type: "string", description: "页面 slug" },
            nodeId: { type: "string", description: "任意节点 id,来自 read_page_text 的 all 列表" },
            style: { type: "object", description: "要合并设置的 CSS 属性(不删除未提及属性)" },
            height: { type: "number", description: "可选;把节点高度设成这个像素值(修文字溢出用)" },
            width: { type: "number", description: "可选;把节点宽度设成这个像素值" },
          },
          required: ["slug", "nodeId"],
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
    // 自检前必须先重建 —— check_page 渲染的是**构建产物**。
    // 模型改的是覆盖层(JSON),产物 HTML 要重新生成才会反映出来;
    // 不重建就自检,看到的是上一次的页面,会把"还没生效"误判成"没问题"。
    // (GUI 本来就有自动重建,但它在 runAgent 返回之后才跑 —— 对自检来说太晚了。)
    build: () => buildFn(root),
    // 取走待发图片(取走即清空,避免重复发送同一张图浪费 token)
    takePendingImages() {
      return pendingImages.splice(0, pendingImages.length);
    },
  };
}
