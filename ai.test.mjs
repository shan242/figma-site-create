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
  for (const p of ["manifest.json", "wordclouds.json", "edits.json", "file-locks.json", "nodeStyles.json", "overrides.json"]) {
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

test("write_file is gated by confirmation", async () => {
  const dir = fixture();
  const denied = makeTools({ outDir: dir, confirm: denyAll });
  assert.ok((await denied.handlers.write_file({ path: "note.txt", content: "hi" })).error);
  const allowed = makeTools({ outDir: dir, confirm: allowAll });
  const r = await allowed.handlers.write_file({ path: "note.txt", content: "hi" });
  assert.equal(r.path, "note.txt");
  assert.equal(readFileSync(join(dir, "note.txt"), "utf8"), "hi");
});

test("apply_wordcloud clamps rect to the canvas and persists", async () => {
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
