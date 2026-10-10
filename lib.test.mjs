// 实例(INSTANCE)展开测试。
//
// 起因:lily2026new 的「Memories from the late-1800s」画廊轮播在复刻页里整块空白,
// 只剩卡片底色。原因是发布数据里 INSTANCE 的 children 是**复合 id**
// (`I<实例id>;<组件内原始id>`),而 nodeById 里没有这些键 —— 照 children 走会
// 一个子节点都取不到。这里的用例把这个还原逻辑钉死。
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandInstances, collectAll, renderNode, swapTargetOf, swapRuntime } from "./lib.mjs";

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
