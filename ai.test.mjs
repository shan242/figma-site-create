import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSSE, runAgent, makeTools, createDeepSeekModel } from "./ai.mjs";
import { buildSite } from "./build.mjs";

// --- parseSSE -----------------------------------------------------------------

test("parseSSE splits content deltas and finishes", async () => {
  const chunks = [
    `data: {"choices":[{"delta":{"content":"你"}}]}\n\n`,
    `data: {"choices":[{"delta":{"content":"好"},"finish_reason":null}]}\n\n`,
    `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`,
    `data: [DONE]\n\n`,
  ];
  const events = [];
  for await (const e of parseSSE(chunks)) events.push(e);
  assert.deepEqual(events, [
    { type: "content", text: "你" },
    { type: "content", text: "好" },
    { type: "finish", finishReason: "stop" },
  ]);
});

test("parseSSE accumulates tool call args across chunks", async () => {
  const chunks = [
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_page_text","arguments":""}}]}}]}\n\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"slug\\":\\""}}]}}]}\n\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"index\\"}"}}]}}]}\n\n`,
    `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n`,
  ];
  const events = [];
  for await (const e of parseSSE(chunks)) events.push(e);
  const call = events.filter((e) => e.type === "toolCall");
  assert.equal(call.length, 3);
  assert.equal(call[0].id, "call_1");
  assert.equal(call[0].name, "read_page_text");
  assert.equal(call.map((c) => c.argsChunk).join(""), '{"slug":"index"}');
  assert.ok(events.some((e) => e.type === "finish" && e.finishReason === "tool_calls"));
});

test("parseSSE ignores keep-alive chunks", async () => {
  const events = [];
  for await (const e of parseSSE([`data: {"choices":[]}\n\n`, `data: {"choices":[{"delta":{"content":"x"}}]}\n\n`])) events.push(e);
  assert.deepEqual(events, [{ type: "content", text: "x" }]);
});

test("parseSSE tolerates chunk boundaries mid-line", async () => {
  const split = `data: {"choices":[{"delta":{"content":"hello"}}]}\n\n`;
  const half = Math.floor(split.length / 2);
  const events = [];
  for await (const e of parseSSE([split.slice(0, half), split.slice(half)])) events.push(e);
  assert.deepEqual(events, [{ type: "content", text: "hello" }]);
});

// --- runAgent -----------------------------------------------------------------

function mockModel(responses) {
  let i = 0;
  return async () => responses[Math.min(i++, responses.length - 1)];
}

const toolsFixture = {
  schemas: [],
  handlers: {
    list_pages: async () => ({ pages: [{ slug: "index" }] }),
    boom: async () => {
      throw new Error("boom");
    },
  },
};

test("runAgent ends immediately when no tool calls", async () => {
  const events = [];
  const r = await runAgent({
    messages: [{ role: "user", content: "hi" }],
    model: mockModel([{ content: "你好", toolCalls: [] }]),
    tools: toolsFixture,
    onEvent: (e) => events.push(e),
    config: {},
    maxTurns: 5,
  });
  assert.equal(r.text, "你好");
  assert.equal(r.turnCount, 1);
  assert.ok(events.some((e) => e.type === "done"));
});

test("runAgent executes tool calls and feeds results back", async () => {
  let seenToolMsg = false;
  const r = await runAgent({
    messages: [{ role: "user", content: "看看页面" }],
    model: mockModel([
      { content: "", toolCalls: [{ id: "c1", name: "list_pages", arguments: {} }] },
      { content: "有 1 个页面", toolCalls: [] },
    ]),
    tools: toolsFixture,
    onEvent: (e) => {
      if (e.type === "tool_end") {
        seenToolMsg = true;
        assert.equal(e.ok, true);
      }
    },
    config: {},
    maxTurns: 5,
  });
  assert.equal(r.text, "有 1 个页面");
  assert.equal(r.turnCount, 2);
  assert.ok(seenToolMsg);
});

test("runAgent reports a tool error back to the model", async () => {
  let sawErrorTool = false;
  await runAgent({
    messages: [{ role: "user", content: "boom" }],
    model: mockModel([
      { content: "", toolCalls: [{ id: "c1", name: "boom", arguments: {} }] },
      { content: "出错了", toolCalls: [] },
    ]),
    tools: toolsFixture,
    onEvent: (e) => {
      if (e.type === "tool_end") {
        assert.equal(e.ok, false);
        sawErrorTool = true;
      }
    },
    config: {},
    maxTurns: 5,
  });
  assert.ok(sawErrorTool);
});

test("runAgent stops at maxTurns when the model never finishes", async () => {
  const r = await runAgent({
    messages: [{ role: "user", content: "loop" }],
    model: mockModel([{ content: "", toolCalls: [{ id: "c1", name: "list_pages", arguments: {} }] }]),
    tools: toolsFixture,
    config: {},
    maxTurns: 3,
  });
  assert.equal(r.turnCount, 3);
});

test("runAgent surfaces a model exception as an error event", async () => {
  const events = [];
  const r = await runAgent({
    messages: [{ role: "user", content: "hi" }],
    model: async () => {
      throw new Error("API Key 无效");
    },
    tools: toolsFixture,
    onEvent: (e) => events.push(e),
    config: {},
    maxTurns: 3,
  });
  assert.equal(r.error, "API Key 无效");
  assert.ok(events.some((e) => e.type === "error"));
});

// --- makeTools -----------------------------------------------------------------

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rep-ai-"));
  mkdirSync(join(dir, "data"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      liveBase: "https://example.figma.site",
      siteTitle: "Test",
      pages: [{ path: "/", slug: "index", file: "index.html", title: "Home", json: "data/index.json" }],
    }),
  );
  writeFileSync(
    join(dir, "data", "index.json"),
    JSON.stringify({
      roots: ["1:1"],
      nodeById: {
        "1:1": { id: "1:1", type: "FRAME", name: "Canvas", absoluteBoundingBox: { x: 0, y: 0, width: 500, height: 400 }, children: ["1:2"] },
        "1:2": { id: "1:2", type: "TEXT", characters: "hello world hello travel", absoluteBoundingBox: { x: 20, y: 20, width: 100, height: 20 } },
      },
    }),
  );
  return dir;
}

const allowAll = async () => true;
const denyAll = async () => false;

test("tools reject path traversal", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.write_file({ path: "../escape.txt", content: "x" });
  assert.ok(r.error, "traversal must be blocked");
});

test("write_file refuses metadata / overlay files", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  for (const p of ["manifest.json", "wordclouds.json", "edits.json", "file-locks.json", "nodeStyles.json", "overrides.json", "design-report.md", "design-report.json"]) {
    const r = await handlers.write_file({ path: p, content: "{}" });
    assert.ok(r.error, `${p} must be denied`);
  }
});

test("write_file allows generated html / styles.css / data and locks products", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const css = await handlers.write_file({ path: "styles.css", content: "body { color: red }" });
  assert.equal(css.locked, true);
  const html = await handlers.write_file({ path: "index.html", content: "<html><body>AI 版</body></html>" });
  assert.equal(html.locked, true);
  const data = await handlers.write_file({ path: "data/index.json", content: JSON.stringify({ hello: 1 }) });
  assert.equal(data.locked, false);
  const locks = JSON.parse(readFileSync(join(dir, "file-locks.json"), "utf8"));
  assert.equal(locks.files["styles.css"], "body { color: red }");
  assert.equal(locks.files["index.html"], "<html><body>AI 版</body></html>");
  assert.ok(!("data/index.json" in locks.files));
});

test("locked generated files survive a rebuild", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  await handlers.write_file({ path: "styles.css", content: "body { color: red }" });
  await handlers.write_file({ path: "index.html", content: "<html><body>AI 版首页</body></html>" });
  await buildSite(dir);
  assert.equal(readFileSync(join(dir, "styles.css"), "utf8"), "body { color: red }");
  assert.equal(readFileSync(join(dir, "index.html"), "utf8"), "<html><body>AI 版首页</body></html>");
});

test("build re-applies only in-dir locks", async () => {
  const dir = fixture();
  writeFileSync(join(dir, "file-locks.json"), JSON.stringify({ version: 1, files: { "../evil.txt": "x", "index.html": "<html>ok</html>" } }));
  await buildSite(dir);
  assert.equal(readFileSync(join(dir, "index.html"), "utf8"), "<html>ok</html>");
  assert.equal(existsSync(join(dir, "..", "evil.txt")), false);
});

test("read_file can read files inside the dir", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.read_file({ path: "manifest.json" });
  assert.ok(r.content.includes("Test"));
});

test("get_standard returns the width-adaptive standard", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.get_standard({ name: "width-adaptive" });
  assert.equal(r.name, "width-adaptive");
  assert.ok(r.content.includes("禁用"));
  assert.ok(r.template.includes("{W}"));
  assert.ok(r.template.includes("@media"));
  // The template must never rely on invalid CSS division (length ÷ length).
  assert.ok(!r.template.includes("100vw /"));
  assert.ok(r.chars > 0);
});

test("get_standard returns the width-reflow standard", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.get_standard({ name: "width-reflow" });
  assert.equal(r.name, "width-reflow");
  assert.ok(r.content.includes("重排"));
  assert.ok(r.content.includes("禁用"));
  // Reflow has no single canonical template, only a reference skeleton.
  assert.ok(r.template.includes("max-width"));
  assert.ok(r.template.includes("{CARDW}"));
  assert.ok(r.chars > 0);
});

test("get_standard rejects unknown names", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.get_standard({ name: "nope" });
  assert.ok(r.error);
});

test("write_file is gated by confirmation", async () => {
  const dir = fixture();
  const denied = makeTools({ outDir: dir, confirm: denyAll });
  assert.ok((await denied.handlers.write_file({ path: "note.txt", content: "hi" })).error);
  const allowed = makeTools({ outDir: dir, confirm: allowAll });
  const r = await allowed.handlers.write_file({ path: "note.txt", content: "hi" });
  assert.equal(r.path, "note.txt");
  assert.equal(readFileSync(join(dir, "note.txt"), "utf8"), "hi");
});

test("apply_wordcloud clamps horizontally + top>=0 and persists", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.apply_wordcloud({
    slug: "index",
    rect: { left: 600, top: -50, width: 200, height: 150 },
    spec: { words: [{ text: "hello", weight: 80 }, { text: "travel", weight: 40 }] },
  });
  assert.equal(r.rect.left, 300); // 500 - 200
  assert.equal(r.rect.top, 0);
  assert.equal(r.wordCount, 2);
  const stored = JSON.parse(readFileSync(join(dir, "wordclouds.json"), "utf8"));
  assert.equal(stored.items.length, 1);
  assert.equal(stored.items[0].id, r.id);
  assert.equal(stored.items[0].spec.words.length, 2);
});

test("apply_wordcloud lets rect extend below the canvas; width still clamped", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.apply_wordcloud({
    slug: "index",
    rect: { left: 400, top: 900, width: 300, height: 120 },
    spec: { words: [{ text: "hello", weight: 80 }] },
  });
  assert.equal(r.rect.top, 900); // below the 400-high canvas — preserved
  assert.equal(r.rect.height, 120);
  assert.equal(r.rect.left, 200); // 500 - 300
  assert.equal(r.rect.width, 300);
  assert.equal(r.error, undefined);
});

test("build grows the canvas height to cover word clouds below it", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  await handlers.apply_wordcloud({ slug: "index", rect: { left: 0, top: 900, width: 200, height: 150 }, spec: { words: [{ text: "hello", weight: 80 }] } });
  await buildSite(dir);
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const m = html.match(/class="canvas" style="width:100%;min-width:(\d+)px;min-height:(\d+)px/);
  assert.ok(m, "canvas element present");
  assert.equal(m[1], "500");
  assert.equal(m[2], "1050"); // 900 + 150
  assert.ok(html.includes("wordcloud"));
});

test("SCALE-constrained nodes reflow as % of design width, vertical stays px", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rep-scale-"));
  mkdirSync(join(dir, "data"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      liveBase: "https://example.figma.site",
      siteTitle: "T",
      pages: [{ path: "/", slug: "index", file: "index.html", title: "Home", json: "data/index.json" }],
    }),
  );
  writeFileSync(
    join(dir, "data", "index.json"),
    JSON.stringify({
      roots: ["1:1"],
      nodeById: {
        "1:1": { id: "1:1", type: "FRAME", name: "Canvas", absoluteBoundingBox: { x: 0, y: 0, width: 500, height: 400 }, children: ["1:2", "1:3"] },
        // SCALE/SCALE node at design left 100, width 200 in a 500-wide canvas.
        "1:2": { id: "1:2", type: "RECTANGLE", constraints: { horizontal: "SCALE", vertical: "SCALE" }, absoluteBoundingBox: { x: 100, y: 40, width: 200, height: 80 } },
        "1:3": { id: "1:3", type: "TEXT", characters: "plain", absoluteBoundingBox: { x: 20, y: 200, width: 50, height: 20 } },
      },
    }),
  );
  await buildSite(dir);
  const html = readFileSync(join(dir, "index.html"), "utf8");
  // x=100 → 20% of 500, width=200 → 40% of 500; top/height stay at design px.
  assert.ok(html.includes("top: 40px; width: 40.0000%; height: 80px; left: 20.0000%"), "SCALE node reflows horizontally, keeps vertical px");
  assert.ok(html.includes("top: 200px; width: 50px; height: auto; left: 20px"), "unconstrained node keeps design px");
});

test("children of a clickable GROUP inherit its NAVIGATE interaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rep-grouplink-"));
  mkdirSync(join(dir, "data"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      liveBase: "https://example.figma.site",
      siteTitle: "T",
      pages: [
        { path: "/", slug: "index", file: "index.html", title: "Home", json: "data/index.json" },
        { path: "/page-4", slug: "page-4", file: "page-4.html", title: "P4", json: "data/index.json" },
      ],
    }),
  );
  // The ON_CLICK→NAVIGATE interaction lives on the GROUP (as Figma Sites emits
  // it), not on the button's background or label — the children must inherit it.
  writeFileSync(
    join(dir, "data", "index.json"),
    JSON.stringify({
      roots: ["1:1"],
      nodeById: {
        "1:1": { id: "1:1", type: "FRAME", name: "Canvas", absoluteBoundingBox: { x: 0, y: 0, width: 500, height: 400 }, children: ["1:2"] },
        "1:2": {
          id: "1:2", type: "GROUP", name: "Group 58", absoluteBoundingBox: { x: 300, y: 100, width: 180, height: 60 },
          interactions: [{ event: { interactionType: "ON_CLICK" }, actions: [{ connectionType: "INTERNAL_NODE", navigationType: "NAVIGATE", connectionURL: "/page-4" }] }],
          children: ["1:3", "1:4"],
        },
        "1:3": { id: "1:3", type: "RECTANGLE", name: "pill", absoluteBoundingBox: { x: 300, y: 100, width: 180, height: 60 }, fills: [{ type: "SOLID", visible: true, opacity: 1, color: { r: 0, g: 0.2, b: 0.8 } }] },
        "1:4": { id: "1:4", type: "TEXT", characters: "Click to continue", style: { fontFamily: "Inter", fontSize: 14 }, absoluteBoundingBox: { x: 310, y: 110, width: 160, height: 20 } },
      },
    }),
  );
  await buildSite(dir);
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const links = [...html.matchAll(/<a href="page-4\.html"[^>]*>/g)];
  assert.equal(links.length, 2, "pill background and label both link to the group's target");
  assert.ok(/Click to continue\s*<\/a>/.test(html), "label renders inside an anchor");
});

test("RECTANGLE and SVG with their own NAVIGATE interaction render as anchors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rep-anchors-"));
  mkdirSync(join(dir, "data"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      liveBase: "https://example.figma.site",
      siteTitle: "T",
      pages: [
        { path: "/", slug: "index", file: "index.html", title: "Home", json: "data/index.json" },
        { path: "/page-5", slug: "page-5", file: "page-5.html", title: "P5", json: "data/index.json" },
      ],
    }),
  );
  writeFileSync(
    join(dir, "data", "index.json"),
    JSON.stringify({
      roots: ["1:1"],
      nodeById: {
        "1:1": { id: "1:1", type: "FRAME", name: "Canvas", absoluteBoundingBox: { x: 0, y: 0, width: 500, height: 400 }, children: ["1:2", "1:3"] },
        "1:2": {
          id: "1:2", type: "RECTANGLE", name: "next", absoluteBoundingBox: { x: 20, y: 300, width: 200, height: 60 },
          interactions: [{ event: { interactionType: "ON_CLICK" }, actions: [{ connectionType: "INTERNAL_NODE", navigationType: "NAVIGATE", connectionURL: "/page-5" }] }],
          fills: [{ type: "SOLID", visible: true, opacity: 1, color: { r: 0.9, g: 0.9, b: 0.9 } }],
        },
        "1:3": {
          id: "1:3", type: "SVG", name: "arrow", hash: "bb33cc44", absoluteBoundingBox: { x: 20, y: 20, width: 40, height: 40 },
          interactions: [{ event: { interactionType: "ON_CLICK" }, actions: [{ connectionType: "INTERNAL_NODE", navigationType: "NAVIGATE", connectionURL: "/page-5" }] }],
        },
      },
    }),
  );
  // Distinct asset hash: svgGeometry caches parsed geometry per hash in a
  // module-level map, so reusing another test's hash would poison that test.
  writeFileSync(join(dir, "assets", "bb33cc44.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"></svg>');
  await buildSite(dir);
  const html = readFileSync(join(dir, "index.html"), "utf8");
  assert.ok(html.includes('<a href="page-5.html" style="position: absolute; top: 300px'), "interactive RECTANGLE renders as an anchor");
  assert.ok(html.includes('<a href="page-5.html"><img src="assets/bb33cc44.svg"'), "interactive SVG renders as an anchor-wrapped img");
});

test("fluid canvas: CENTER nodes stay centered, plain nodes keep px, body follows canvas bg", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rep-center-"));
  mkdirSync(join(dir, "data"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      liveBase: "https://example.figma.site",
      siteTitle: "T",
      pages: [{ path: "/", slug: "index", file: "index.html", title: "Home", json: "data/index.json" }],
    }),
  );
  writeFileSync(
    join(dir, "data", "index.json"),
    JSON.stringify({
      roots: ["1:1"],
      nodeById: {
        "1:1": { id: "1:1", type: "FRAME", name: "Canvas", absoluteBoundingBox: { x: 0, y: 0, width: 500, height: 400 }, fills: [{ type: "SOLID", visible: true, opacity: 1, color: { r: 0.85, g: 0.89, b: 0.8 } }], children: ["1:2", "1:3"] },
        "1:2": { id: "1:2", type: "TEXT", characters: "centered", constraints: { horizontal: "CENTER", vertical: "TOP" }, absoluteBoundingBox: { x: 200, y: 40, width: 100, height: 20 } },
        "1:3": { id: "1:3", type: "TEXT", characters: "fixed", absoluteBoundingBox: { x: 20, y: 80, width: 50, height: 20 } },
      },
    }),
  );
  await buildSite(dir);
  const html = readFileSync(join(dir, "index.html"), "utf8");
  assert.ok(/class="canvas" style="width:100%;min-width:500px;min-height:400px/.test(html), "canvas is fluid with a min-width");
  // CENTER node at design left 200 in a 500 canvas → keeps offset -50px from center.
  assert.ok(html.includes('left: calc(50% - 50px)'), "CENTER node stays centered as canvas stretches");
  assert.ok(html.includes("left: 20px"), "unconstrained node keeps its design px");
  assert.ok(html.includes("background-color: rgb(217,227,204); overflow-x: hidden;"), "body bg follows canvas and clips horizontal overflow");
});

test("SVG asset with an effect gutter renders at natural size, content-aligned to the design box", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rep-svg-"));
  mkdirSync(join(dir, "data"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      liveBase: "https://example.figma.site",
      siteTitle: "T",
      pages: [{ path: "/", slug: "index", file: "index.html", title: "Home", json: "data/index.json" }],
    }),
  );
  // The card frame: Figma bbox 256x376 at (100,20), but the shipped SVG is
  // 276x396 with the rounded rect drawn at content offset (10,4) — the gutter
  // bakes the drop shadow into the asset. Rendering at the bbox clips it.
  writeFileSync(
    join(dir, "data", "index.json"),
    JSON.stringify({
      roots: ["1:1"],
      nodeById: {
        "1:1": { id: "1:1", type: "FRAME", name: "Canvas", absoluteBoundingBox: { x: 0, y: 0, width: 500, height: 400 }, children: ["1:2"] },
        "1:2": { id: "1:2", type: "SVG", name: "Card", hash: "aa11bb22", absoluteBoundingBox: { x: 100, y: 20, width: 256, height: 376 } },
      },
    }),
  );
  writeFileSync(
    join(dir, "assets", "aa11bb22.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="276" height="396" viewBox="0 0 276 396">
  <defs><filter id="f"><feGaussianBlur stdDeviation="5"/><feOffset dy="6"/></filter></defs>
  <rect x="10" y="4" width="256" height="376" rx="12" fill="#fff" filter="url(#f)"/>
</svg>`,
  );
  await buildSite(dir);
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const img = /<img src="assets\/aa11bb22\.svg" alt="" style="([^"]+)" \/>/.exec(html);
  assert.ok(img, "SVG node rendered as an img referencing its asset");
  assert.match(img[1], /width: 276px/, "renders at the asset's natural width");
  assert.match(img[1], /height: 396px/, "renders at the asset's natural height");
  assert.match(img[1], /left: 90px/, "content-aligned: bbox left 100 - content offset 10");
  assert.match(img[1], /top: 16px/, "content-aligned: bbox top 20 - content offset 4");
});

test("apply_wordcloud fills words locally when spec has none", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.apply_wordcloud({ slug: "index", rect: { left: 0, top: 0, width: 200, height: 150 }, spec: {} });
  assert.ok(r.wordCount > 0);
});

test("delete_wordcloud removes an entry", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const a = await handlers.apply_wordcloud({ slug: "index", rect: { left: 0, top: 0, width: 200, height: 150 }, spec: { words: [{ text: "x", weight: 10 }] } });
  const d = await handlers.delete_wordcloud({ id: a.id });
  assert.equal(d.id, a.id);
  const stored = JSON.parse(readFileSync(join(dir, "wordclouds.json"), "utf8"));
  assert.equal(stored.items.length, 0);
});

test("run_build invokes the injected build function", async () => {
  const dir = fixture();
  let calls = 0;
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll, buildFn: async () => { calls++; } });
  await handlers.run_build();
  assert.equal(calls, 1);
});

test("run_build fails fast without manifest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rep-ai-empty-"));
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.run_build();
  assert.ok(r.error);
});

// --- edit_text / delete_edit -------------------------------------------------

test("read_page_text returns all nodes with ids (text + shapes)", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.read_page_text({ slug: "index" });
  assert.ok(r.all.some((n) => n.id === "1:2" && n.type === "TEXT" && n.text.includes("hello")));
  assert.ok(r.all.some((n) => n.id === "1:1" && n.type === "FRAME" && n.w === 500));
});

test("edit_text persists and upserts by id", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const a = await handlers.edit_text({ slug: "index", nodeId: "1:2", text: "new heading", color: "#ff0000" });
  assert.equal(a.nodeId, "1:2");
  const b = await handlers.edit_text({ id: a.id, slug: "index", nodeId: "1:2", fontSize: 30 });
  assert.equal(b.id, a.id);
  const stored = JSON.parse(readFileSync(join(dir, "edits.json"), "utf8"));
  assert.equal(stored.items.length, 1);
  assert.equal(stored.items[0].text, "new heading");
  assert.equal(stored.items[0].fontSize, 30);
});

test("edit_text validates node and change inputs", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  assert.ok((await handlers.edit_text({ slug: "nope", nodeId: "1:2", text: "x" })).error);
  assert.ok((await handlers.edit_text({ slug: "index", nodeId: "1:9", text: "x" })).error);
  assert.ok((await handlers.edit_text({ slug: "index", nodeId: "1:1", text: "x" })).error); // FRAME, not TEXT
  assert.ok((await handlers.edit_text({ slug: "index", nodeId: "1:2" })).error); // no change given
  assert.ok((await handlers.edit_text({ slug: "index", nodeId: "1:2", color: "red" })).error);
  assert.ok((await handlers.edit_text({ slug: "index", nodeId: "1:2", fontSize: -1 })).error);
  assert.ok((await handlers.edit_text({ slug: "index", nodeId: "1:2", fontWeight: 123 })).error);
});

test("edit_text is gated by confirmation", async () => {
  const dir = fixture();
  const denied = makeTools({ outDir: dir, confirm: denyAll });
  assert.ok((await denied.handlers.edit_text({ slug: "index", nodeId: "1:2", text: "x" })).error);
  const allowed = makeTools({ outDir: dir, confirm: allowAll });
  const r = await allowed.handlers.edit_text({ slug: "index", nodeId: "1:2", text: "ok" });
  assert.equal(r.nodeId, "1:2");
});

test("delete_edit removes an entry", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const a = await handlers.edit_text({ slug: "index", nodeId: "1:2", text: "x" });
  const d = await handlers.delete_edit({ id: a.id });
  assert.equal(d.id, a.id);
  const stored = JSON.parse(readFileSync(join(dir, "edits.json"), "utf8"));
  assert.equal(stored.items.length, 0);
});

test("edits.json changes survive a rebuild", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  await handlers.edit_text({ slug: "index", nodeId: "1:2", text: "edited heading" });
  await buildSite(dir);
  const html = readFileSync(join(dir, "index.html"), "utf8");
  assert.ok(html.includes("edited heading"));
  assert.ok(!html.includes("hello travel"));
});

// --- edit_node / delete_node_style ------------------------------------------

test("edit_node persists a raw CSS overlay for any node", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.edit_node({ slug: "index", nodeId: "1:2", style: { color: "#ff0000", "font-size": "24px" } });
  assert.equal(r.nodeId, "1:2");
  assert.deepEqual(r.props, ["color", "font-size"]);
  const stored = JSON.parse(readFileSync(join(dir, "nodeStyles.json"), "utf8"));
  assert.equal(stored.items.length, 1);
  assert.deepEqual(stored.items[0].style, { color: "#ff0000", "font-size": "24px" });
});

test("edit_node upserts by id", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const a = await handlers.edit_node({ slug: "index", nodeId: "1:2", style: { color: "#ff0000" } });
  const b = await handlers.edit_node({ id: a.id, slug: "index", nodeId: "1:2", style: { "font-size": "30px" } });
  assert.equal(b.id, a.id);
  const stored = JSON.parse(readFileSync(join(dir, "nodeStyles.json"), "utf8"));
  assert.equal(stored.items.length, 1);
  assert.deepEqual(stored.items[0].style, { color: "#ff0000", "font-size": "30px" });
});

test("edit_node validates node, style and inline-safety", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  assert.ok((await handlers.edit_node({ slug: "nope", nodeId: "1:2", style: { color: "#000" } })).error);
  assert.ok((await handlers.edit_node({ slug: "index", nodeId: "1:9", style: { color: "#000" } })).error);
  assert.ok((await handlers.edit_node({ slug: "index", nodeId: "1:2" })).error); // no style
  assert.ok((await handlers.edit_node({ slug: "index", nodeId: "1:2", style: "color:#000" })).error);
  assert.ok((await handlers.edit_node({ slug: "index", nodeId: "1:2", style: { "font-size;x": "1px" } })).error);
  assert.ok((await handlers.edit_node({ slug: "index", nodeId: "1:2", style: { color: "red;background:url(x)" } })).error);
  assert.ok((await handlers.edit_node({ slug: "index", nodeId: "1:2", style: { color: '"</div>' } })).error);
});

test("edit_node is gated by confirmation", async () => {
  const dir = fixture();
  const denied = makeTools({ outDir: dir, confirm: denyAll });
  assert.ok((await denied.handlers.edit_node({ slug: "index", nodeId: "1:2", style: { color: "#000" } })).error);
});

test("delete_node_style removes an entry", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const a = await handlers.edit_node({ slug: "index", nodeId: "1:2", style: { color: "#000" } });
  const d = await handlers.delete_node_style({ id: a.id });
  assert.equal(d.id, a.id);
  const stored = JSON.parse(readFileSync(join(dir, "nodeStyles.json"), "utf8"));
  assert.equal(stored.items.length, 0);
});

test("nodeStyles overlay survives a rebuild", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  await handlers.edit_node({ slug: "index", nodeId: "1:2", style: { color: "#ff0000" } });
  await buildSite(dir);
  const html = readFileSync(join(dir, "index.html"), "utf8");
  assert.ok(html.includes("color: #ff0000"));
});

// --- append_css / clear_css --------------------------------------------------

test("append_css persists and clear_css removes", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const a = await handlers.append_css({ css: ".nav-link:hover { color: #123 !important; }" });
  assert.equal(a.chars > 10, true);
  assert.ok((await handlers.append_css({ css: "</style>" })).error);
  assert.ok((await handlers.append_css({ css: "" })).error);
  const stored = JSON.parse(readFileSync(join(dir, "overrides.json"), "utf8"));
  assert.equal(stored.items.length, 1);
  const d = await handlers.clear_css({ id: a.id });
  assert.equal(d.id, a.id);
  assert.equal(JSON.parse(readFileSync(join(dir, "overrides.json"), "utf8")).items.length, 0);
});

test("append_css is appended to styles.css on rebuild", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  await handlers.append_css({ css: ".nav-link:hover { color: #123 !important; }" });
  await buildSite(dir);
  const css = readFileSync(join(dir, "styles.css"), "utf8");
  assert.ok(css.includes(".nav-link:hover { color: #123 !important; }"));
});

// --- createDeepSeekModel shape -------------------------------------------------

test("createDeepSeekModel returns a callable that hits the configured base URL", async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, opts });
    const body = JSON.parse(opts.body);
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const chunks = [
          `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`,
          `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`,
          `data: [DONE]\n\n`,
        ];
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return { ok: true, body: stream, text: async () => "" };
  };
  try {
    const model = createDeepSeekModel({ baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", apiKey: "k" });
    const res = await model([{ role: "user", content: "hi" }], [], null, null);
    assert.equal(res.content, "ok");
    assert.deepEqual(res.toolCalls, []);
    assert.equal(seen[0].url, "https://api.deepseek.com/chat/completions");
    assert.equal(seen[0].opts.headers.Authorization, "Bearer k");
    assert.equal(seen[0].opts.body.includes("deepseek-v4-flash"), true);
  } finally {
    globalThis.fetch = orig;
  }
});
