// 实例(INSTANCE)展开测试。
//
// 起因:lily2026new 的「Memories from the late-1800s」画廊轮播在复刻页里整块空白,
// 只剩卡片底色。原因是发布数据里 INSTANCE 的 children 是**复合 id**
// (`I<实例id>;<组件内原始id>`),而 nodeById 里没有这些键 —— 照 children 走会
// 一个子节点都取不到。这里的用例把这个还原逻辑钉死。
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandInstances, collectAll, renderNode, swapTargetOf, swapRuntime, fillToCss, videoElement, textRuns, videoSpecFromFill, videoTracks, videoOptionsFrom, videoRuntime } from "./lib.mjs";

// --- 插入视频(videoElement) --------------------------------------------------
// 把某个节点整体换成 <video>,位置尺寸沿用该节点。之前工具集里没有「插入媒体」,
// 想让 AI 塞视频只能整体改写 HTML —— 首页 600+ 节点、read_file 会截断,
// 凭半份内容写回会把后半页弄丢。

const vctx = () => ({ assetDir: "D:/out/assets", fontStack: (f) => `'${f}', sans-serif`, parentOf: new Map(), nodeStyles: new Map() });
const vcanvas = { x: 0, y: 0, width: 1440, height: 19200 };
const vnode = (extra = {}) => ({
  id: "2:178",
  type: "RECTANGLE",
  name: "clip",
  absoluteBoundingBox: { x: 100, y: 200, width: 640, height: 360 },
  constraints: { horizontal: "CENTER" },
  fills: [{ type: "SOLID", visible: true, opacity: 0.5, color: { r: 1, g: 1, b: 1, a: 1 } }],
  ...extra,
});

test("videoElement:沿用节点的定位与尺寸", () => {
  const html = videoElement(vnode(), vcanvas, vctx(), { id: "v1", src: "assets/clip.mp4" });
  assert.match(html, /^ {2}<video /, "和其它元素一样两空格缩进");
  assert.match(html, /top: 200px/);
  assert.match(html, /width: 640px/);
  assert.match(html, /height: 360px/);
  // CENTER 约束 → calc(50% ± off),和普通节点同一套规则
  assert.match(html, /left: calc\(50% - 620px\)/);
  assert.match(html, /data-node-id="2:178"/);
});

test("videoElement:不再画出原节点的填充", () => {
  const html = videoElement(vnode(), vcanvas, vctx(), { id: "v1", src: "a.mp4" });
  assert.equal(/background-color/.test(html), false, "原节点的纯色填充不该画在视频后面");
  assert.equal(/background-image/.test(html), false);
  // fill 的透明度是 nodeStyle 为图像填充塞进 opacity 的,视频不该继承
  assert.equal(/opacity:/.test(html), false, "不该带上填充的透明度");
});

test("videoElement:节点自身的 opacity 仍然保留", () => {
  const html = videoElement(vnode({ opacity: 0.4 }), vcanvas, vctx(), { id: "v1", src: "a.mp4" });
  assert.match(html, /opacity: 0.4/, "节点自己的透明度是设计意图");
});

test("videoElement:没传 muted 时**不**默认静音(2026101203 的教训)", () => {
  // 旧写法 `spec.muted !== false` 在没传时是 true → 默认静音。2026101203 那个
  // 视频文件里明明有音轨(["vide","soun"],93 秒),渲染出来却是哑巴,
  // 而且没有任何人要求过静音 —— 用户是看了页面才发现没声音。
  const plain = videoElement(vnode(), vcanvas, vctx(), { id: "v", src: "a.mp4" });
  assert.equal(/ muted/.test(plain), false, "没人要求静音就不该静音");
  assert.match(plain, / controls/, "默认给控件,否则没法播也没法调音量");
  // 显式要求静音才静音
  assert.match(videoElement(vnode(), vcanvas, vctx(), { id: "v", src: "a.mp4", muted: true }), / muted/);
  // 自动播放必须静音:浏览器一律拦截带声音的自动播放,不静音等于根本不播
  const auto = videoElement(vnode(), vcanvas, vctx(), { id: "v", src: "a.mp4", autoplay: true });
  assert.match(auto, / autoplay/);
  assert.match(auto, / muted/, "自动播放要配 muted");
  // 明确要声音时 muted 生效(autoplay 由 videoOptionsFrom 摘掉,见那边的测试)
  const manual = videoElement(vnode(), vcanvas, vctx(), { id: "v", src: "a.mp4", autoplay: false, muted: false });
  assert.equal(/ autoplay/.test(manual), false);
  assert.equal(/ muted/.test(manual), false, "muted:false 应当尊重");
});

test("videoElement:controls:'custom' 用自带按钮,不要浏览器那套 UI", () => {
  // 浏览器自带控件是亮色 UI,常常和设计完全不搭;但完全不给控件又等于访客没法播
  // (实测那个视频既静音、没控件、又不自动播放 —— 页面上就是一张不会动的图)。
  const html = videoElement(vnode(), vcanvas, vctx(), { id: "vid-x", src: "a.mp4", controls: "custom", muted: false });
  assert.equal(/ controls\b/.test(html), false, "不要浏览器自带控件");
  assert.match(html, /data-video-toggle="vid-x"/, "要有自己的按钮");
  assert.match(html, /data-video-id="vid-x"/, "按钮要能对上视频");
  assert.equal(/ muted\b/.test(html), false, "要声音就别静音");
  // 普通 controls 一个字节都不该多
  const plain = videoElement(vnode(), vcanvas, vctx(), { id: "vid-x", src: "a.mp4" });
  assert.equal(/video-toggle/.test(plain), false, "默认不该有自定义按钮");
});

test("videoRuntime:自定义按钮切换播放/静音,并且带状态同步", () => {
  assert.match(videoRuntime, /data-video-toggle/);
  assert.match(videoRuntime, /v\.muted = false/, "第一次点要解除静音(浏览器要求用户手势)");
  assert.match(videoRuntime, /play\(\)/, "要真的播放");
  assert.match(videoRuntime, /volumechange|pause/, "状态变化要同步按钮外观");
});

test("videoOptionsFrom:controls 支持 custom,并且有声音时不会放任无控件", () => {
  const figma = { muted: true, showControls: false, autoplay: false, mediaLoop: false };
  // custom 透传
  assert.equal(videoOptionsFrom(figma, { __videoOptions: { controls: "custom" } }).controls, "custom");
  // 有声音却没控件 → 强制打开,并且标记(不能悄悄改)
  const forced = videoOptionsFrom(figma, { __videoOptions: { muted: false, controls: false } });
  assert.equal(forced.controls, true, "有声音就有控件");
  assert.equal(forced.__controlsForced, true, "要告诉调用方被改过");
});

test("videoTracks / videoOptionsFrom:认出音轨,且声音与自动播放不可兼得", () => {
  // 真实的那个文件确实两条轨都有
  const t = videoTracks("D:/Project/Scope/figma-context-mcp/output/2026101203/assets/30d9d3a016fc1ef8444dbf3bb9c714895e728298.mp4");
  if (t) { assert.equal(t.video, true); assert.equal(t.audio, true, "这个文件确实有音轨"); }
  assert.equal(videoTracks("definitely-not-here.mp4"), null, "读不到就返回 null(不知道),不要瞎猜");
  // Figma 的 VIDEO 填充永远带着 muted:true / showControls:false,且**在 Figma 里改不了**
  const figma = { muted: true, showControls: false, autoplay: true, mediaLoop: true };
  assert.deepEqual(videoOptionsFrom(figma, {}), { muted: true, controls: false, autoplay: true, loop: true });
  // 覆盖层要能补上 Figma 补不了的东西:开声音 + 给控件
  const want = videoOptionsFrom(figma, { __videoOptions: { muted: false, controls: true } });
  assert.equal(want.muted, false, "要声音就打开");
  assert.equal(want.controls, true, "有声音就要有控件,否则用户没法自己播");
  assert.equal(want.autoplay, false, "有声音就不能自动播放");
  assert.equal(want.__autoplayDropped, true, "要告诉调用方 autoplay 被摘掉了,不能悄悄改");
});

test("videoElement:controls / loop / fit / poster", () => {
  const plain = videoElement(vnode(), vcanvas, vctx(), { id: "v", src: "a.mp4" });
  assert.match(plain, / controls/, "默认显示控件");
  assert.equal(/ loop/.test(plain), false, "默认不循环");
  assert.match(plain, /object-fit: cover/, "默认 cover");
  assert.match(plain, /playsinline/);

  const tuned = videoElement(vnode(), vcanvas, vctx(), { id: "v", src: "a.mp4", controls: false, loop: true, fit: "contain", poster: "assets/p.jpg" });
  assert.equal(/ controls/.test(tuned), false);
  assert.match(tuned, / loop/);
  assert.match(tuned, /object-fit: contain/);
  assert.match(tuned, /poster="assets\/p.jpg"/);
});

test("videoElement:src 会被转义,不能突破属性", () => {
  const html = videoElement(vnode(), vcanvas, vctx(), { id: "v", src: 'a.mp4" onerror="alert(1)' });
  assert.equal(html.includes('onerror="alert(1)"'), false, "引号必须被转义");
  assert.match(html, /&quot;/);
});

// --- 图像/渐变填充的透明度 ---------------------------------------------------
// CSS 没有 background-opacity,所以图像填充的透明度只能落在元素 opacity 上。
// 漏掉它会让一张 6% 的背景图以全不透明渲染,把整节内容压没(实测 lily2026new)。

const url = (h) => `assets/${h}.jpg`;

test("fillToCss:纯色透明度烘进 rgba", () => {
  assert.deepEqual(fillToCss({ type: "SOLID", visible: true, opacity: 1, color: { r: 1, g: 0, b: 0, a: 1 } }), { "background-color": "rgb(255,0,0)" });
  assert.deepEqual(fillToCss({ type: "SOLID", visible: true, opacity: 0.1, color: { r: 1, g: 1, b: 1, a: 1 } }), { "background-color": "rgba(255,255,255,0.1)" });
});

test("fillToCss:图像填充的透明度必须带出来(用 opacity,不是丢掉)", () => {
  const css = fillToCss({ type: "IMAGE", visible: true, opacity: 0.06, imageRef: "abc" }, url);
  assert.equal(css["background-image"], "url(assets/abc.jpg)");
  assert.equal(css["background-size"], "cover");
  assert.equal(css.opacity, 0.06, "0.06 必须保留");

  // 不透明度为 1 时不写多余属性
  const full = fillToCss({ type: "IMAGE", visible: true, opacity: 1, imageRef: "abc" }, url);
  assert.equal("opacity" in full, false);
  // 没写 opacity 字段时也不应误加
  assert.equal("opacity" in fillToCss({ type: "IMAGE", visible: true, imageRef: "abc" }, url), false);
});

// --- 图像填充的缩放/裁剪(imageTransform / scaleMode) --------------------------
// imageTransform 把**归一化填充框坐标**映射到**归一化图像坐标**(imgNorm = T·boxNorm)。
// 方向极易搞反 —— 用线上 DOM 验证过:一张 d=0.3056 的图,线上渲染成 1705px 高
// (框只有 521px),即 100/0.3056 = 327.2%。所以 background-size 是 **100/a**,不是 a。
// 之前写反了,把"放大裁切"当成"缩成一小条再用留白居中",图片比例就完全不对。

test("fillToCss:imageTransform 决定 background-size 与 position", () => {
  // d=0.5:图在框内纵向放大 2 倍
  const css = fillToCss(
    { type: "IMAGE", visible: true, imageRef: "abc", scaleMode: "STRETCH", imageTransform: [[1, 0, 0], [0, 0.5, 0.25]] },
    url,
  );
  assert.equal(css["background-size"], "100% 200%", "d=0.5 → 放大 2 倍(100/d),不是缩到 50%");
  assert.equal(css["background-position"], "0% 50%", "0.25/(1-0.5) = 50%");
  assert.equal(css["background-repeat"], "no-repeat", "放大后不能平铺");
});

test("fillToCss:线上实测的三个真实矩阵都要能对上", () => {
  // 这三组来自 creme-zipper recommendations 页,已与线上渲染尺寸逐一对齐。
  // a/d 是矩阵里的原始值(注意不是最终百分比 —— 最终 = 100/a)。
  const cases = [
    // [a, tx, d, ty]  框w 框h  期望渲染尺寸(线上实测)
    [1, 0, 0.3056, 0.0224, 1280, 521, 1280, 1705],
    [0.9221, 0.0389, 0.8916, 0.0592, 1140, 1900, 1236, 2131],
    [0.942907, 0.028953, 0.897657, 0.058989, 1155, 1895, 1225, 2111],
  ];
  for (const [a, tx, d, ty, bw, bh, wantW, wantH] of cases) {
    const css = fillToCss(
      { type: "IMAGE", visible: true, imageRef: "x", scaleMode: "STRETCH", imageTransform: [[a, 0, tx], [0, d, ty]] },
      url,
    );
    const [sx, sy] = css["background-size"].split(" ").map((v) => parseFloat(v) / 100);
    const gotW = Math.round(bw * sx);
    const gotH = Math.round(bh * sy);
    assert.ok(
      Math.abs(gotW - wantW) <= 2 && Math.abs(gotH - wantH) <= 2,
      `a=${a} d=${d}: 期望 ${wantW}x${wantH},实际 ${gotW}x${gotH} (size=${css["background-size"]})`,
    );
  }
});

test("fillToCss:没有 imageTransform 时按 scaleMode 兜底", () => {
  const mk = (scaleMode) => fillToCss({ type: "IMAGE", visible: true, imageRef: "a", scaleMode }, url);
  assert.equal(mk("FILL")["background-size"], "cover", "FILL = 铺满裁切");
  assert.equal(mk("FIT")["background-size"], "contain", "FIT = 完整显示留白");
  assert.equal(mk("STRETCH")["background-size"], "100% 100%", "STRETCH = 真的拉伸");
  assert.equal(mk(undefined)["background-size"], "cover", "缺省按 FILL");
  assert.equal("background-repeat" in mk("FILL"), false, "cover 不需要 no-repeat");
  assert.equal(mk("FIT")["background-repeat"], "no-repeat");
  assert.equal(mk("STRETCH")["background-repeat"], "no-repeat");
});

test("fillToCss:a=1 的轴没有余量,位置取 0 且不除零", () => {
  // 矩阵第二行是 [0, d, ty] —— 写成 [1, d, ty] 会被当成有斜切而退回 cover
  const css = fillToCss(
    { type: "IMAGE", visible: true, imageRef: "a", scaleMode: "STRETCH", imageTransform: [[1, 0, 0.3], [0, 1, 0.3]] },
    url,
  );
  assert.equal(css["background-size"], "100% 100%");
  assert.equal(css["background-position"], "0% 0%", "1-a=0,不能算出 Infinity/NaN");
  assert.equal(/NaN|Infinity/.test(css["background-position"]), false);
});

test("fillToCss:带旋转/斜切的矩阵不硬套,退回 scaleMode", () => {
  const css = fillToCss(
    { type: "IMAGE", visible: true, imageRef: "a", scaleMode: "FILL", imageTransform: [[0.7, 0.7, 0], [-0.7, 0.7, 0]] },
    url,
  );
  assert.equal(css["background-size"], "cover", "有旋转就不能用纯缩放公式");
});

test("fillToCss:渐变填充的透明度同样带出来", () => {
  const grad = { type: "GRADIENT_LINEAR", visible: true, opacity: 0.25, gradientHandlePositions: [{ x: 0.5, y: 1 }, { x: 0.5, y: 0 }, { x: 0, y: 0 }], gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } }] };
  assert.equal(fillToCss(grad, url).opacity, 0.25);
});

test("fillToCss:不可见 / 全透明 / 未知类型", () => {
  assert.equal(fillToCss({ type: "IMAGE", visible: false, opacity: 1, imageRef: "a" }, url), null);
  assert.equal(fillToCss({ type: "IMAGE", visible: true, opacity: 0, imageRef: "a" }, url), null, "opacity=0 视为没有填充");
  assert.equal(fillToCss(null, url), null);
});

// 渲染一个矩形,取出它的 style 属性,看 opacity 是多少
function renderOpacity(node, nodeOpacity) {
  const cb = { x: 0, y: 0, width: 1440, height: 900 };
  const n = { ...node, id: "1:9" };
  if (nodeOpacity !== undefined) n.opacity = nodeOpacity;
  const nodes = { "1:9": n };
  const out = [];
  renderNode(n, nodes, cb, out, { assetDir: ".", parentOf: new Map(), edits: new Map(), nodeStyles: new Map(), handled: new Set() });
  const style = /style="([^"]*)"/.exec(out.join("\n"))?.[1] || "";
  const m = /opacity:\s*([\d.]+)/.exec(style);
  return { style, opacity: m ? Number(m[1]) : 1 };
}

test("节点 opacity 与填充 opacity 相乘,而不是互相覆盖", () => {
  const base = { type: "RECTANGLE", name: "bg", absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 } };

  const a = renderOpacity({ ...base, fills: [{ type: "IMAGE", visible: true, opacity: 0.06, imageRef: "abc" }] });
  assert.equal(a.opacity, 0.06, "只有填充透明度时用它");

  const b = renderOpacity({ ...base, fills: [{ type: "IMAGE", visible: true, opacity: 0.5, imageRef: "abc" }] }, 0.5);
  assert.equal(b.opacity, 0.25, "两者都有时应相乘(0.5 × 0.5)");

  const c = renderOpacity({ ...base, fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 1, b: 1, a: 1 } }] }, 0.3);
  assert.equal(c.opacity, 0.3, "纯色填充不会覆盖节点 opacity");
  assert.match(c.style, /background-color:\s*rgb\(255,255,255\)/, "纯色不带填充透明度");

  const d = renderOpacity({ ...base, fills: [{ type: "IMAGE", visible: true, opacity: 1, imageRef: "abc" }] });
  assert.equal(/opacity/.test(d.style), false, "全不透明时不该写 opacity");
});

// 组件变体轮播(SWAP_STATE)用的 fixture:
//   组件集 18:40 里有 2 个变体(18:20 主 / 18:30),
//   实例 18:10 用主变体,里面的箭头点一下切到 18:30。
function variantFixture({ withSwap = true } = {}) {
  const arrow = {
    id: "18:22",
    type: "SVG",
    name: "Arrow",
    hash: "arrowhash",
    absoluteBoundingBox: { x: 2050, y: 700, width: 12, height: 12 },
    children: [],
    interactions: withSwap
      ? [{ event: { interactionType: "ON_CLICK" }, actions: [{ navigationType: "SWAP_STATE", connectionType: "INTERNAL_NODE", transitionNodeID: { sessionID: 18, localID: 30 }, stateGroupContext: "18:40" }] }]
      : [],
  };
  return {
    roots: ["0:1"],
    nodeById: {
      "0:1": { id: "0:1", type: "FRAME", name: "Desktop", absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 }, children: ["18:10"] },
      "18:10": {
        id: "18:10",
        type: "INSTANCE",
        name: "carousel",
        mainComponentId: "18:20",
        componentSetId: "18:40",
        absoluteBoundingBox: { x: 100, y: 300, width: 420, height: 440 },
        children: ["I18:10;18:21", "I18:10;18:22"],
      },
      "18:40": { id: "18:40", type: "COMPONENT_SET", name: "set", absoluteBoundingBox: { x: 1980, y: 280, width: 460, height: 960 }, children: ["18:20", "18:30"] },
      "18:20": { id: "18:20", type: "COMPONENT", name: "v1", absoluteBoundingBox: { x: 2000, y: 300, width: 420, height: 440 }, children: ["18:21", "18:22"] },
      "18:21": { id: "18:21", type: "RECTANGLE", name: "photo1", absoluteBoundingBox: { x: 2000, y: 300, width: 420, height: 285 }, fills: [{ type: "IMAGE", visible: true, imageRef: "aaa" }], children: [] },
      "18:22": arrow,
      "18:30": { id: "18:30", type: "COMPONENT", name: "v2", absoluteBoundingBox: { x: 2000, y: 800, width: 420, height: 440 }, children: ["18:31"] },
      "18:31": { id: "18:31", type: "RECTANGLE", name: "photo2", absoluteBoundingBox: { x: 2000, y: 800, width: 420, height: 285 }, fills: [{ type: "IMAGE", visible: true, imageRef: "bbb" }], children: [] },
    },
  };
}

test("变体轮播:其它变体也渲染出来(默认隐藏),并平移到位", () => {
  const data = variantFixture();
  expandInstances(data);
  const inst = data.nodeById["18:10"];

  // 主变体(2 个)+ 另一变体(1 个)
  assert.deepEqual(inst.children, ["18:10~18:21", "18:10~18:22", "18:10~18:30~18:31"]);

  const main = data.nodeById["18:10~18:21"];
  assert.equal(main.__swap.on, true, "主变体应可见");
  assert.equal(main.__swap.variant, "18:20");
  assert.equal(main.__swap.group, "18:10");

  const other = data.nodeById["18:10~18:30~18:31"];
  assert.equal(other.__swap.on, false, "其它变体应默认隐藏");
  assert.equal(other.__swap.variant, "18:30");
  assert.equal(other.fills[0].imageRef, "bbb", "另一变体的图片要保留");
  // 平移:实例(100,300) − 变体(2000,800) = (−1900,−500)
  assert.equal(other.absoluteBoundingBox.x, 100);
  assert.equal(other.absoluteBoundingBox.y, 300);
});

test("没有 SWAP_STATE 箭头时不展开其它变体(不白渲染)", () => {
  const data = variantFixture({ withSwap: false });
  expandInstances(data);
  assert.deepEqual(data.nodeById["18:10"].children, ["18:10~18:21", "18:10~18:22"], "只展开主变体即可");
  assert.equal(data.nodeById["18:10~18:30~18:31"], undefined);
});

test("swapTargetOf 取出 SWAP_STATE 的目标变体", () => {
  assert.equal(swapTargetOf({ interactions: [{ actions: [{ navigationType: "SWAP_STATE", transitionNodeID: { sessionID: 18, localID: 30 } }] }] }), "18:30");
  assert.equal(swapTargetOf({ interactions: [{ actions: [{ navigationType: "NAVIGATE", connectionURL: "/x" }] }] }), null);
  assert.equal(swapTargetOf({}), null);
  assert.equal(swapTargetOf(null), null);
});

test("渲染出的元素带齐切换属性(data-swap-*)", () => {
  // renderNode 的第 3 个参数是 **canvas 的 bbox**,不是 canvas 节点(build.mjs 里
  // 传的就是 canvas.absoluteBoundingBox)。
  const cb = { x: 0, y: 0, width: 1440, height: 900 };
  const data = variantFixture();
  expandInstances(data);
  const nodes = data.nodeById;
  const ctx = { assetDir: ".", parentOf: new Map(), edits: new Map(), nodeStyles: new Map(), handled: new Set() };
  const render = (id) => {
    const out = [];
    renderNode(nodes[id], nodes, cb, out, ctx);
    return out.join("\n");
  };

  const visible = render("18:10~18:21");
  assert.match(visible, /data-swap-group="18:10"/);
  assert.match(visible, /data-swap-variant="18:20"/);
  assert.equal(/data-swap-off/.test(visible), false, "可见变体不能带 data-swap-off");

  // 隐藏变体:用属性而不是内联 display:none(文本靠内联 display:flex 排版)
  const hidden = render("18:10~18:30~18:31");
  assert.match(hidden, /data-swap-off/);
  assert.equal(/display:\s*none/.test(hidden), false, "不能用内联 display:none");

  // 箭头带目标变体
  const arrow = render("18:10~18:22");
  assert.match(arrow, /data-swap-to="18:30"/);
});

test("swapRuntime 只切同组、并保留内联 display", () => {
  assert.match(swapRuntime, /data-swap-group/);
  assert.match(swapRuntime, /removeAttribute\('data-swap-off'\)/);
  assert.match(swapRuntime, /setAttribute\('data-swap-off'/);
  // 绝不能直接写 style.display —— 文本节点会因此丢掉 flex 排版
  assert.equal(/style\.display/.test(swapRuntime), false);
});

// --- SCALE 约束的上下文 -------------------------------------------------------
// SCALE 的含义是「**随父级一起**缩放」,不是「无条件按画布宽度缩放」。
// 实测(creme-zipper index):一个 SCALE 矩形被 CENTER 约束的 COMPONENT 包着,
// 线上渲染 384px(设计尺寸),旧逻辑却按 1403/1280 放大成 421px —— 所有图片宽了
// 9.6%,看起来就是"图片被拉伸"。判定必须看整条父链。

test("SVG:箭头在 CENTER 组件里要跟随中心,不能只看自身约束", () => {
  // 实测:轮播左右箭头的 SVG 自身约束是 LEFT,但它在 CENTER 约束的组件实例里,
  // 线上跟着画布中心走 —— 1920 下线上 x=582/948,只按自身约束会写死成 342/708,
  // 正好差 (1920-1440)/2。SVG 路径原来两处都写成 `constraints.horizontal === "CENTER"`,
  // 应该用已经算好的 centered(它涵盖祖先链,也涵盖 SCALE 不缩放时的回落)。
  const nodes = {
    "0:1": { id: "0:1", type: "FRAME", name: "Canvas", absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 }, children: ["1:1"] },
    "1:1": { id: "1:1", type: "INSTANCE", name: "carousel", constraints: { horizontal: "CENTER" }, absoluteBoundingBox: { x: 320, y: 0, width: 420, height: 440 }, children: ["1:2"] },
    "1:2": {
      id: "1:2",
      type: "SVG",
      name: "arrow",
      constraints: { horizontal: "LEFT" },
      absoluteBoundingBox: { x: 342, y: 100, width: 12, height: 0 },
      // 渲染边界比设计框大(箭头有烘进去的留白)→ 会走 rb 那条分支
      isolatedAbsoluteRenderBounds: { x: 341.5, y: 99, width: 12.5, height: 7.36 },
      hash: "deadbeef",
      children: [],
    },
  };
  const parentOf = new Map();
  for (const n of Object.values(nodes)) for (const c of n.children || []) parentOf.set(c, n);
  const out = [];
  renderNode(nodes["1:2"], nodes, nodes["0:1"].absoluteBoundingBox, out, {
    assetDir: ".",
    parentOf,
    edits: new Map(),
    nodeStyles: new Map(),
    handled: new Set(),
    fontStack: (f) => `'${f}', sans-serif`,
  });
  const html = out.join("\n");
  assert.match(html, /left: calc\(50% - 378\.5px\)/, "341.5 - 1440/2 = -378.5");
  assert.equal(/left: 341\.5px/.test(html), false, "不能写死设计 px(宽屏下会偏 (W-1440)/2)");
});

function scaleFixture(childParent) {
  // 画布 0:1 → CENTER 容器 1:1(不缩放)→ 或直接挂 SCALE 矩形
  const nodes = {
    "0:1": { id: "0:1", type: "FRAME", name: "Canvas", absoluteBoundingBox: { x: 0, y: 0, width: 1280, height: 800 }, children: ["1:1", "1:5", "1:3"] },
    "1:1": { id: "1:1", type: "FRAME", name: "centerBox", constraints: { horizontal: "CENTER" }, absoluteBoundingBox: { x: 0, y: 0, width: 600, height: 400 }, children: ["1:2"] },
    "1:2": { id: "1:2", type: "RECTANGLE", name: "insideCenter", constraints: { horizontal: "SCALE" }, absoluteBoundingBox: { x: 10, y: 10, width: 384, height: 512 }, children: [] },
    "1:5": { id: "1:5", type: "RECTANGLE", name: "onCanvas", constraints: { horizontal: "SCALE" }, absoluteBoundingBox: { x: 20, y: 600, width: 384, height: 512 }, children: [] },
    "1:3": { id: "1:3", type: "FRAME", name: "scaledMid", constraints: { horizontal: "SCALE" }, absoluteBoundingBox: { x: 0, y: 700, width: 400, height: 100 }, children: ["1:4"] },
    "1:4": { id: "1:4", type: "RECTANGLE", name: "insideScaled", constraints: { horizontal: "SCALE" }, absoluteBoundingBox: { x: 0, y: 700, width: 200, height: 50 }, children: [] },
  };
  const parentOf = new Map();
  for (const n of Object.values(nodes)) for (const c of n.children || []) parentOf.set(c, n);
  return { nodes, parentOf, canvas: nodes["0:1"].absoluteBoundingBox };
}

function renderWith(fx, id) {
  const out = [];
  renderNode(fx.nodes[id], fx.nodes, fx.canvas, out, { assetDir: ".", parentOf: fx.parentOf, edits: new Map(), nodeStyles: new Map(), handled: new Set() });
  return out.join("\n");
}

test("SCALE:直接挂在画布上 → 按设计宽度百分比", () => {
  const html = renderWith(scaleFixture(), "1:5");
  assert.match(html, /width: 30\.0*%/, "384/1280 = 30%");
  assert.match(html, /left: 1\.5625%/, "20/1280 = 1.5625%");
});

test("SCALE:父级不缩放时宽度保持设计 px,但 left 要跟随画布中心", () => {
  const html = renderWith(scaleFixture(), "1:2");
  // 宽度:父级不缩放 ⇒ 不转百分比(实测 creme-zipper 的 384 被放大成 421 就是这里错了)
  assert.match(html, /width: 384px/, "父级不缩放,宽度不该按画布放大");
  assert.equal(/width: 30\.0*%/.test(html), false, "不能按画布宽度写百分比");
  // left:祖先里有 CENTER(1:1)⇒ 跟随中心。旧代码只看"自身是不是 SCALE"就强制不居中,
  // 而 inScaledContext 又判它不在缩放上下文里,两条路都不走 → 落在写死 px 上,
  // 宽屏下同一行的标题跟着中心走、卡片不动(实测 1920 下间距 29px → 269px)。
  assert.match(html, /left: calc\(50% - 630px\)/, "应跟随中心(10 - 1280/2 = -630)而不是写死 px");
});

test("SCALE:父级也是(可缩放的)SCALE → 继续缩放", () => {
  const fx = scaleFixture();
  const html = renderWith(fx, "1:4");
  assert.match(html, /width: 15\.6250*%/, "200/1280");
});

// --- 富文本(styleOverrideTable) ---------------------------------------------
// 起因:用户报「文字重行」。根因是 textRuns 只取 override 里的 weight/size,
// **丢掉了 fontFamily 和 lineHeightPx** —— 富文本里 20px Actor(行高 28)的段落
// 退回节点基准 25px Abril Fatface(行高 normal ≈ 33.7px),一段 7 行正文
// 是 231px vs 线上的 196px,整块超出容器 76px,用 overflow:visible 压到下面的内容上。
// 数值全部来自与线上 DOM 的逐段对比(creme-zipper index 的 2146:109)。

function richTextNode() {
  const head = "About Kulangsu";
  const body = "B".repeat(90);
  const src = "Source: UNESCO";
  // 排布:head[0..13] \n[14] \n[15] body[16..105] \n[106] \n[107] src[108..]
  // 两个空行分别落在基准段之后(override 0)与正文之后(override 479),
  // 正好覆盖"空行只继承字号"的两条分支。
  const chars = `${head}\n\n${body}\n\n${src}`;
  const bodyStart = head.length + 2;
  const bodyEnd = bodyStart + body.length;
  const overrides = [...chars].map((_, i) => (i < bodyStart ? 0 : i <= bodyEnd + 1 ? 479 : 483));
  return {
    id: "1:1",
    type: "TEXT",
    name: "rich",
    characters: chars,
    characterStyleOverrides: overrides,
    styleOverrideTable: {
      479: { fontSize: 20, fontFamily: "Actor", lineHeightPx: 28, lineHeightUnit: "PIXELS" },
      483: { fontSize: 16, fontFamily: "Actor" },
    },
    absoluteBoundingBox: { x: 0, y: 0, width: 1180, height: 419 },
    style: { fontFamily: "Abril Fatface", fontSize: 25, lineHeightPx: 33.725, lineHeightUnit: "INTRINSIC_%" },
    fills: [{ type: "SOLID", visible: true, opacity: 1, color: { r: 0, g: 0, b: 0 } }],
  };
}

test("textRuns 带上 override 的 fontFamily 与 lineHeightPx(以前只取 weight/size)", () => {
  const { runs } = textRuns(richTextNode());
  assert.equal(runs.length, 3);
  assert.deepEqual(
    runs.map((r) => ({ family: r.family, size: r.size, lineHeight: r.lineHeight })),
    [
      { family: null, size: null, lineHeight: null }, // 基准段:交给 <p> 继承节点行高
      { family: "Actor", size: 20, lineHeight: 28 }, // override 带 lineHeightPx → 用它
      { family: "Actor", size: 16, lineHeight: "normal" }, // override 没带 → normal
    ],
  );
});

test("textRuns:行高分三种情况(基准继承 / override 像素 / override 缺省 normal)", () => {
  const n = richTextNode();
  // override 带了 lineHeightPx → 用它
  assert.equal(textRuns(n).runs[1].lineHeight, 28);
  // override 没带 lineHeightPx → "normal"(实测 creme-zipper 的 16px「Source:」行
  // 线上是 19px = normal@16;若继承节点的 33.725px 会变成 34px)
  assert.equal(textRuns(n).runs[2].lineHeight, "normal");
  // 基准段 → null,交给 <p> 去继承节点自己的 lineHeightPx
  // (实测 lily `2:167`:lineHeightPx=40、字号 36、U+2028 分 3 行,线上 3×40=120)
  assert.equal(textRuns(n).runs[0].lineHeight, null);
  assert.equal(textRuns(n).runs[0].family, null, "基准段不带字族");
});

function renderText(overrides) {
  const node = {
    id: "1:1",
    type: "TEXT",
    name: "t",
    characters: "hello world",
    absoluteBoundingBox: { x: 0, y: 0, width: 330, height: 36 },
    style: { fontFamily: "Inter", fontSize: 14 },
    fills: [{ type: "SOLID", visible: true, opacity: 1, color: { r: 0, g: 0, b: 0 } }],
    ...overrides,
    style: { fontFamily: "Inter", fontSize: 14, ...(overrides.style || {}) },
  };
  const canvas = { id: "0:1", type: "FRAME", absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 } };
  const out = [];
  renderNode(node, { "1:1": node }, canvas, out, {
    assetDir: ".",
    parentOf: new Map(),
    edits: new Map(),
    nodeStyles: new Map(),
    handled: new Set(),
    fontStack: (f) => `'${f}', sans-serif`,
  });
  return out.join("\n");
}

// --- 设计自带的视频填充(VIDEO)-----------------------------------------------
// 发布数据里 fill.type === "VIDEO" 带 videoRef,线上渲染成 <video>。
// 以前完全没处理,节点变成空框(实测 germanschoolhistories 的 2:1915:
// 线上 760x427 的 <video>,本地什么都没有,整页像素差分 52.7%)。

test("videoSpecFromFill:把 VIDEO 填充翻译成 videoElement 的 spec", () => {
  const spec = videoSpecFromFill(
    { id: "2:1915" },
    { type: "VIDEO", scaleMode: "FILL", videoRef: "30d9d3a016fc1ef8444dbf3bb9c714895e728298", autoplay: true, mediaLoop: true, muted: true, showControls: false },
  );
  assert.equal(spec.src, "assets/30d9d3a016fc1ef8444dbf3bb9c714895e728298.mp4", "视频走 /_videos/v1/,落地带 .mp4 扩展名");
  assert.equal(spec.autoplay, true);
  assert.equal(spec.loop, true);
  assert.equal(spec.muted, true);
  assert.equal(spec.controls, false);
  assert.equal(spec.fit, "cover", "scaleMode FILL → cover");
});

test("videoSpecFromFill:没有 videoRef 就返回 null(别生成一个空白播放器)", () => {
  assert.equal(videoSpecFromFill({ id: "x" }, { type: "VIDEO" }), null);
  assert.equal(videoSpecFromFill({ id: "x" }, undefined), null);
});

test("renderNode:带 VIDEO 填充的节点整体换成 <video>,不是空框", () => {
  const node = {
    id: "2:1915",
    type: "RECTANGLE",
    name: "video",
    absoluteBoundingBox: { x: 340, y: 2550, width: 760, height: 427 },
    fills: [
      { type: "VIDEO", visible: true, scaleMode: "FILL", videoRef: "30d9d3a016fc1ef8444dbf3bb9c714895e728298", autoplay: true, mediaLoop: true, muted: true, showControls: false },
    ],
  };
  const canvas = { id: "0:1", type: "FRAME", absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 } };
  const out = [];
  renderNode(node, { "2:1915": node }, canvas, out, {
    assetDir: "assets",
    parentOf: new Map(),
    edits: new Map(),
    nodeStyles: new Map(),
    handled: new Set(),
    fontStack: (f) => `'${f}', sans-serif`,
  });
  const html = out.join("\n");
  assert.match(html, /<video/, "必须是 video 元素");
  assert.match(html, /autoplay/, "autoplay 来自 fill");
  assert.match(html, /loop/);
  assert.match(html, /muted/, "autoplay 必须配 muted,否则浏览器拦截");
  assert.equal(/controls/.test(html), false, "showControls=false 时不要控件");
  assert.match(html, /object-fit: cover/);
  assert.match(html, /width: 760px/);
  assert.match(html, /data-node-id="2:1915"/);
});

test("nodeStyle:NONE 用固定高度(内容居中溢出),不是 min-height", () => {
  // 实测:轮播标题设计框 36px、内容 54px。线上是 flex 居中让内容**上下对称溢出**
  // (文字从 7927 起,而不是框顶 7936);改成 height:auto/min-height 会把文字顶到
  // 框顶,整段下移 9px —— 像素差分能直接看到。
  const html = renderText({
    absoluteBoundingBox: { x: 0, y: 0, width: 330, height: 36 },
    style: { fontFamily: "Inter", fontSize: 14, textAutoResize: "NONE", textAlignVertical: "CENTER" },
  });
  assert.match(html, /height: 36px/, "NONE 要用设计高度写死");
  assert.equal(/min-height/.test(html), false, "不要 min-height(会让文字顶到框顶)");
  assert.match(html, /justify-content: center/, "要靠 flex 居中让溢出对称");
});

test("nodeStyle:只有 PIXELS 才写死行高,INTRINSIC_% 用 normal", () => {
  // lineHeightUnit 是"怎么指定的",不是"结果是什么":
  //   PIXELS     → lineHeightPx 就是最终行高(实测那个三行标题 40px)
  //   INTRINSIC_%→ 字体固有行高的百分比,percent=100 时**等于 normal**
  // 实测该页 311 个 INTRINSIC_% 节点的 lineHeightPx/fontSize = 1.18/1.203/1.253/
  // 1.349/1.448,每个字体一个常数,正是各字体的自然行高比 —— 写死那个小数会算错
  // (14px 正文:线上每行 18px → 306px;按 17.542px 只有 298px,17 行全部错位)。
  const px = renderText({
    absoluteBoundingBox: { x: 0, y: 0, width: 330, height: 40 },
    style: { fontFamily: "Inter", fontSize: 36, lineHeightPx: 40, lineHeightUnit: "PIXELS", textAutoResize: "HEIGHT" },
  });
  assert.match(px, /line-height: 40px/, "PIXELS 要照用 lineHeightPx");

  const intrinsic = renderText({
    absoluteBoundingBox: { x: 0, y: 0, width: 330, height: 36 },
    style: { fontFamily: "Inter", fontSize: 14, lineHeightPx: 17.542, lineHeightUnit: "INTRINSIC_%", lineHeightPercent: 100, textAutoResize: "HEIGHT" },
  });
  assert.match(intrinsic, /line-height: normal/, "INTRINSIC_% 要用 normal");
  assert.equal(/17\.542px/.test(intrinsic), false, "不能把固有行高当像素值写死");
});

test("renderNode:富文本段落的字体/字号/行高必须落在 <p> 上", () => {
  const node = richTextNode();
  const canvas = { id: "0:1", type: "FRAME", absoluteBoundingBox: { x: 0, y: 0, width: 1280, height: 800 } };
  const out = [];
  renderNode(node, { "1:1": node }, canvas, out, {
    assetDir: ".",
    parentOf: new Map(),
    edits: new Map(),
    nodeStyles: new Map(),
    handled: new Set(),
    fontStack: (f) => `'${f}', sans-serif`,
  });
  const html = out.join("\n");
  // 行盒高度由块级元素的 strut 决定 —— 行高只写在 span 上不起作用
  const bodyP = html.split("\n").find((l) => l.includes("BBBB"));
  assert.ok(bodyP, "正文段落要渲染出来");
  assert.match(bodyP, /font-family: 'Actor'/, "字族要落到 <p>");
  assert.match(bodyP, /font-size: 20px/);
  assert.match(bodyP, /line-height: 28px/, "28px 行高必须落在 <p> 上");
  // 基准段不带 line-height —— 让它继承容器上的节点行高(写死 normal 会让
  // 节点自己声明的行高失效,lily 首页那段三行标题因此高了 12px)
  const headP = html.split("\n").find((l) => l.includes("About Kulangsu"));
  assert.ok(headP, "基准段要渲染出来");
  assert.equal(/line-height/.test(headP), false, "基准段不该写 line-height,应继承容器");
});

test("renderNode:空行只继承 run 的字号,字族与行高都回退", () => {
  const node = richTextNode();
  const canvas = { id: "0:1", type: "FRAME", absoluteBoundingBox: { x: 0, y: 0, width: 1280, height: 800 } };
  const out = [];
  renderNode(node, { "1:1": node }, canvas, out, {
    assetDir: ".",
    parentOf: new Map(),
    edits: new Map(),
    nodeStyles: new Map(),
    handled: new Set(),
    fontStack: (f) => `'${f}', sans-serif`,
  });
  const html = out.join("\n");
  const blank = html.split("\n").filter((l) => l.includes("&#8203;"));
  assert.ok(blank.length >= 2, "应有多个空行段落");
  // 20px Actor 正文之间的空行:线上是 27px(即 normal@20 **Abril Fatface**),
  // 既不是 Actor 的 24px,也不是 run 的 28px 固定行高。
  const between = blank.find((l) => l.includes("font-size: 20px"));
  assert.ok(between, "空行要继承所在 run 的字号");
  assert.equal(/Actor/.test(between), false, "空行不使用 run 的字族");
  assert.match(between, /line-height: normal/);
});

test("renderNode 给 TEXT 也带 data-node-id(曾经漏掉,导致定位不到文字)", () => {
  const canvas = { id: "0:1", type: "FRAME", absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 } };
  const nodes = {
    "1:1": {
      id: "1:1",
      type: "TEXT",
      name: "caption",
      characters: "hello\nworld",
      absoluteBoundingBox: { x: 10, y: 20, width: 200, height: 60 },
      style: { fontFamily: "Inter", fontSize: 16 },
      fills: [{ type: "SOLID", visible: true, opacity: 1, color: { r: 0, g: 0, b: 0 } }],
    },
  };
  const out = [];
  renderNode(nodes["1:1"], nodes, canvas, out, { assetDir: ".", parentOf: new Map(), edits: new Map(), nodeStyles: new Map(), handled: new Set() });
  const html = out.join("\n");
  assert.match(html, /data-node-id="1:1"/, "多段文本也要带 data-node-id");
  assert.match(html, /hello/, "内容仍要渲染");
  // 属性必须在 style 之后 —— 既有断言依赖这个顺序
  assert.ok(html.indexOf("style=") < html.indexOf("data-node-id="), "data-node-id 应排在 style 之后");
});

// 组件放在 x=2000(画布外的组件区),实例放在 x=100 —— 平移量必须是 -1900。
function fixture() {
  return {
    roots: ["0:1"],
    nodeById: {
      "0:1": { id: "0:1", type: "FRAME", name: "Desktop", absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 }, children: ["18:10"] },
      // 实例:children 是复合 id,nodeById 里没有
      "18:10": {
        id: "18:10",
        type: "INSTANCE",
        name: "slide",
        mainComponentId: "18:20",
        componentSetId: "18:30",
        absoluteBoundingBox: { x: 100, y: 300, width: 420, height: 440 },
        children: ["I18:10;18:21", "I18:10;18:22", "I18:10;18:23"],
      },
      // 主组件 + 它的子树,全部在组件区(x=2000)
      "18:20": { id: "18:20", type: "COMPONENT", name: "c1", absoluteBoundingBox: { x: 2000, y: 300, width: 420, height: 440 }, children: ["18:21"] },
      "18:21": { id: "18:21", type: "RECTANGLE", name: "photo", absoluteBoundingBox: { x: 2000, y: 300, width: 420, height: 285 }, fills: [{ type: "IMAGE", visible: true, imageRef: "abc" }], children: [] },
      "18:22": { id: "18:22", type: "TEXT", name: "caption", characters: "hi", absoluteBoundingBox: { x: 2020, y: 640, width: 200, height: 40 }, children: [] },
      // 带嵌套子节点的组,验证整棵子树都被平移
      "18:23": { id: "18:23", type: "GROUP", name: "arrows", absoluteBoundingBox: { x: 2010, y: 700, width: 200, height: 20 }, children: ["18:24"] },
      "18:24": { id: "18:24", type: "SVG", name: "Arrow", hash: "def", absoluteBoundingBox: { x: 2180, y: 700, width: 12, height: 12 }, children: [] },
    },
  };
}

test("expandInstances 还原复合 id 子节点并按实例原点平移", () => {
  const data = fixture();
  const added = expandInstances(data);
  assert.equal(added, 4, "4 个子节点(含嵌套的箭头)都应生成合成节点");

  const inst = data.nodeById["18:10"];
  assert.deepEqual(inst.children, ["18:10~18:21", "18:10~18:22", "18:10~18:23"]);

  const photo = data.nodeById["18:10~18:21"];
  assert.equal(photo.absoluteBoundingBox.x, 100, "2000 + (100-2000) = 100");
  assert.equal(photo.absoluteBoundingBox.y, 300);
  assert.equal(photo.fills[0].imageRef, "abc", "资源引用必须保留");

  const caption = data.nodeById["18:10~18:22"];
  assert.equal(caption.absoluteBoundingBox.x, 120);
  assert.equal(caption.absoluteBoundingBox.y, 640);
  assert.equal(caption.characters, "hi", "文本内容必须保留");

  // 嵌套子树:GROUP 的位移要与实例一致(2010-1900=110)
  const arrows = data.nodeById["18:10~18:23"];
  assert.equal(arrows.absoluteBoundingBox.x, 110);
  assert.deepEqual(arrows.children, ["18:10~18:24"]);
  assert.equal(data.nodeById["18:10~18:24"].absoluteBoundingBox.x, 280, "2180 - 1900 = 280");

  // 原件必须原封不动 —— 组件定义区不该被挪到实例位置
  assert.equal(data.nodeById["18:21"].absoluteBoundingBox.x, 2000);
});

test("expandInstances 之后实例子树可被 collectAll 走到(这是修复的本质)", () => {
  const data = fixture();
  // 展开前:collectAll 走到实例就断了(children 是复合 id,查不到)
  const before = collectAll(data).length;
  expandInstances(data);
  const after = collectAll(data);
  const ids = after.map((n) => n.id);
  assert.ok(ids.includes("18:10~18:21"), "展开后图片节点必须出现在平坦列表里");
  assert.ok(ids.includes("18:10~18:24"), "嵌套的箭头也要在");
  assert.equal(after.length, before + 4, "平坦列表应多出 4 个实例子节点");
});

test("expandInstances 幂等:重复调用不会重复展开", () => {
  const data = fixture();
  const total = Object.keys(data.nodeById).length;
  const first = expandInstances(data);
  const second = expandInstances(data);
  assert.equal(first, 4);
  assert.equal(second, 0, "第二次不应再新增");
  assert.equal(Object.keys(data.nodeById).length, total + 4, "节点数只增加一次");
  assert.deepEqual(data.nodeById["18:10"].children, ["18:10~18:21", "18:10~18:22", "18:10~18:23"]);
});

test("expandInstances 对子节点本来就正常的实例不动手", () => {
  const data = fixture();
  data.nodeById["18:10"].children = ["18:21", "18:22"];
  assert.equal(expandInstances(data), 0);
  assert.deepEqual(data.nodeById["18:10"].children, ["18:21", "18:22"]);
});

test("expandInstances 在主组件不可达时安全跳过", () => {
  const data = fixture();
  delete data.nodeById["18:20"];
  delete data.nodeById["18:30"];
  assert.equal(expandInstances(data), 0, "不能抛异常");
  assert.deepEqual(data.nodeById["18:10"].children, ["I18:10;18:21", "I18:10;18:22", "I18:10;18:23"], "原样保留");
});

test("expandInstances 容忍空/坏输入", () => {
  assert.equal(expandInstances(null), 0);
  assert.equal(expandInstances({}), 0);
  assert.equal(expandInstances({ nodeById: {} }), 0);
  // 复合 id 指向的原始节点不存在时不能崩
  const data = { roots: [], nodeById: { a: { id: "a", type: "INSTANCE", mainComponentId: "b", absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 }, children: ["Ia;zzz"] }, b: { id: "b", type: "COMPONENT", absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 }, children: [] } } };
  assert.equal(expandInstances(data), 0);
  assert.deepEqual(data.nodeById.a.children, []);
});
