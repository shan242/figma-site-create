import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSSE, runAgent, makeTools, createDeepSeekModel, sniffImageMime, rectOverlap, overlayCollisions, estimateTextHeight, auditCss, pruneToolResult, PRUNE_DEFAULTS, formatSelfCheck, SELF_CHECK_MAX, offloadOldImages, canonicalArgs, repeatReminder, buildSystemPrompt, PROMPT_SECTIONS, trimChatHistory, loadChatHistory, saveChatHistory, CHAT_HISTORY_FILE } from "./ai.mjs";
import { setPageProbe } from "./pageprobe.mjs";
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

test("parseSSE:keep-alive 块给出 tick(连接活着),但不产生内容", async () => {
  const events = [];
  for await (const e of parseSSE([`data: {"choices":[]}\n\n`, `data: {"choices":[{"delta":{"content":"x"}}]}\n\n`])) events.push(e);
  assert.deepEqual(events, [{ type: "tick" }, { type: "content", text: "x" }]);
});

test("parseSSE:reasoning_content 不能被丢掉(否则长思考=假死)", async () => {
  const events = [];
  const chunks = [
    `data: {"choices":[{"delta":{"reasoning_content":"让我想想"}}]}\n\n`,
    `data: {"choices":[{"delta":{"reasoning_content":"……"}}]}\n\n`,
    `data: {"choices":[{"delta":{"content":"答案"}}]}\n\n`,
    `data: [DONE]\n\n`,
  ];
  for await (const e of parseSSE(chunks)) events.push(e);
  // 关键:只吐 reasoning 的块必须产生事件,消费端才会重置空闲计时器。
  // 之前这些块解析出零个事件,模型思考超过 120 秒就被当成超时杀掉。
  assert.deepEqual(events, [
    { type: "reasoning", text: "让我想想" },
    { type: "reasoning", text: "……" },
    { type: "content", text: "答案" },
  ]);
});

test("parseSSE:只有 usage 的收尾块也算活着", async () => {
  const events = [];
  for await (const e of parseSSE([`data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":1}}\n\n`])) events.push(e);
  assert.deepEqual(events, [{ type: "finish", finishReason: "stop" }]);
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

// --- 强制自检 ------------------------------------------------------------------
// 模型说"改好了"就结束 —— 而页面上是什么样它并不知道。check_page 明明查得出来,
// 却从来没被自动调用过。现在:改过东西就必须过一遍它,有问题不许结束。

const checkTools = (problemsByCall) => {
  let call = 0;
  return {
    schemas: [],
    handlers: {
      list_pages: async () => ({ pages: [{ slug: "index" }] }),
      write_file: async () => ({ path: "index.html", slug: "index", locked: true }),
      check_page: async () => ({ slug: "index", ok: false, problems: problemsByCall[Math.min(call++, problemsByCall.length - 1)] }),
    },
  };
};

test("自检:改过东西且有 problems → 不许结束,把问题回灌给模型", async () => {
  const events = [];
  const seen = [];
  const model = async (history) => {
    seen.push(history.length);
    // 第 1 轮:模型要求写文件;之后每一轮都说"我做完了"
    return seen.length === 1
      ? { content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "index.html", content: "x" } }] }
      : { content: "改好了", toolCalls: [] };
  };
  const r = await runAgent({
    messages: [{ role: "user", content: "改一下" }],
    model,
    tools: checkTools([["词云一个像素都没画"], []]), // 第一次有问题,第二次干净
    onEvent: (e) => events.push(e),
    config: {},
  });
  // selfChecks 数的是**检查次数**:第一次不合格 + 回轮后第二次通过 = 2
  assert.equal(r.selfChecks, 2, "第一次不合格,回轮后第二次通过");
  assert.ok(events.some((e) => e.type === "self_check_failed"), "要报出自检没过");
  assert.ok(events.some((e) => e.type === "self_check_passed"), "第二次要报过");
  assert.equal(r.text, "改好了");
});

test("自检:页面干净就直接结束,不多跑一轮", async () => {
  const events = [];
  let calls = 0;
  const model = async () =>
    (++calls === 1
      ? { content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "index.html", content: "x" } }] }
      : { content: "done", toolCalls: [] });
  const r = await runAgent({
    messages: [{ role: "user", content: "改一下" }],
    model,
    tools: checkTools([[]]),
    onEvent: (e) => events.push(e),
    config: {},
  });
  assert.equal(r.selfChecks, 1);
  assert.equal(events.some((e) => e.type === "self_check_failed"), false, "干净就不该报失败");
});

test("自检:只是读文件就不要自检(省掉一次浏览器渲染)", async () => {
  const events = [];
  let calls = 0;
  const model = async () =>
    (++calls === 1
      ? { content: "", toolCalls: [{ id: "c1", name: "list_pages", arguments: {} }] }
      : { content: "看完了", toolCalls: [] });
  const r = await runAgent({
    messages: [{ role: "user", content: "看看" }],
    model,
    tools: checkTools([["不该被看到"]]),
    onEvent: (e) => events.push(e),
    config: {},
  });
  assert.equal(r.selfChecks || 0, 0, "没写过东西就不自检");
  assert.equal(events.some((e) => e.type === "self_check"), false);
});

test("自检:一直不干净也会停,不会无限打转", async () => {
  const events = [];
  const model = async (history) => {
    // 第一次写,之后永远说做完;check_page 永远有问题
    const wrote = history.some((m) => m.role === "tool");
    return wrote ? { content: "做完了", toolCalls: [] } : { content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "index.html", content: "x" } }] };
  };
  const r = await runAgent({
    messages: [{ role: "user", content: "改" }],
    model,
    tools: checkTools([["永远的毛病"]]),
    onEvent: (e) => events.push(e),
    config: {},
  });
  assert.equal(r.selfChecks, SELF_CHECK_MAX, `最多自检 ${SELF_CHECK_MAX} 次`);
  assert.equal(r.text, "做完了", "到上限后允许结束,不能把用户卡死");
});

test("自检:config.selfCheck=false 可以关掉", async () => {
  let calls = 0;
  const model = async () =>
    (++calls === 1
      ? { content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "index.html", content: "x" } }] }
      : { content: "done", toolCalls: [] });
  const r = await runAgent({
    messages: [{ role: "user", content: "改" }],
    model,
    tools: checkTools([["毛病"]]),
    config: { selfCheck: false },
  });
  assert.equal(r.selfChecks || 0, 0);
});

test("formatSelfCheck:说清是程序渲染后看到的,并允许模型说明误报", () => {
  const msg = formatSelfCheck([{ slug: "index", problems: ["词云没画", "opacity 是 0"] }]);
  assert.match(msg, /【index】/);
  assert.match(msg, /词云没画/);
  assert.match(msg, /opacity 是 0/);
  assert.match(msg, /有意为之/, "要允许模型判定某条是误报,否则会把有意的设计也判成错");
});

test("自检:必须先重建再检查(否则看到的是上一次的页面)", async () => {
  // check_page 渲染的是**构建产物**,而模型改的是覆盖层 JSON。
  // 不先重建就检查,"还没生效"会被误判成"没问题" —— 那一轮自检就白做了。
  const order = [];
  let calls = 0;
  const model = async () =>
    (++calls === 1
      ? { content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "index.html", content: "x" } }] }
      : { content: "done", toolCalls: [] });
  const r = await runAgent({
    messages: [{ role: "user", content: "改" }],
    model,
    tools: {
      schemas: [],
      handlers: {
        write_file: async () => ({ path: "index.html", slug: "index" }),
        check_page: async () => { order.push("check"); return { slug: "index", ok: true, problems: [] }; },
      },
      build: async () => { order.push("build"); },
    },
    config: {},
  });
  assert.deepEqual(order, ["build", "check"], `顺序必须是先构建后检查,实际: ${JSON.stringify(order)}`);
  assert.equal(r.selfChecks, 1);
});

test("自检:重建失败要当成问题回灌,不能当成检查通过", async () => {
  let calls = 0;
  const model = async () =>
    (++calls === 1
      ? { content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "index.html", content: "x" } }] }
      : { content: "done", toolCalls: [] });
  const events = [];
  await runAgent({
    messages: [{ role: "user", content: "改" }],
    model,
    tools: {
      schemas: [],
      handlers: {
        write_file: async () => ({ path: "index.html", slug: "index" }),
        check_page: async () => ({ slug: "index", ok: true, problems: [] }),
      },
      build: async () => { throw new Error("磁盘满了"); },
    },
    onEvent: (e) => events.push(e),
    config: {},
  });
  assert.ok(events.some((e) => e.type === "self_check_failed"), "重建失败也要报自检没过");
});

// --- 图片卸载 ------------------------------------------------------------------
// view_image 的图只能作为 user 消息送达,而那条消息带着完整 base64 进 history 后
// **本轮后续每一轮都重发**。剪枝对它无效(base64 在 image_url 块里,不是字符串字段)。

const imgBlock = (label, kb) => ({ type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(kb * 1024) }, __label: label });
const imgHistory = (labels) => [{ role: "user", content: [{ type: "text", text: "看图" }, ...labels.map((l) => imgBlock(l, 1))] }];

test("图片卸载:没超预算就完全不动", () => {
  const h = imgHistory(["a.png", "b.png"]);
  const before = JSON.stringify(h);
  assert.equal(offloadOldImages(h), 0);
  assert.equal(JSON.stringify(h), before, "不该改任何东西");
});

test("图片卸载:超张数时卸最老的,保留最新的", () => {
  const h = imgHistory(["a.png", "b.png", "c.png", "d.png", "e.png", "f.png"]);
  const n = offloadOldImages(h);
  assert.equal(n, 2, "6 张 → 卸 2 张 (上限 4)");
  const blocks = h[0].content.slice(1);
  assert.equal(blocks[0].type, "text", "最老的变成了占位符");
  assert.match(blocks[0].text, /a\.png/, "占位符要说出是哪张图");
  assert.match(blocks[0].text, /重新调用 view_image/, "要告诉模型怎么再看");
  assert.equal(blocks[blocks.length - 1].type, "image_url", "最新的必须保留");
  assert.equal(blocks[blocks.length - 1].__label, "f.png");
});

test("图片卸载:按字节数卸(一张巨图也能触发)", () => {
  // 2 张各 5MB → 超 6MB 预算,但要保留最新的一张
  const h = [{ role: "user", content: [{ type: "text", text: "看图" }, imgBlock("big1.png", 5120), imgBlock("big2.png", 5120)] }];
  const n = offloadOldImages(h);
  assert.equal(n, 1, "卸掉最老那张");
  assert.equal(h[0].content[1].type, "text");
  assert.equal(h[0].content[2].type, "image_url", "最新那张绝不能卸");
});

test("图片卸载:永远保留最后一张,哪怕只有它且它超预算", () => {
  const h = [{ role: "user", content: [{ type: "text", text: "看图" }, imgBlock("huge.png", 20000)] }];
  assert.equal(offloadOldImages(h), 0, "只剩一张时不许卸 —— 全卸等于让模型凭空回答");
  assert.equal(h[0].content[1].type, "image_url");
});

test("图片卸载:runAgent 在发请求前会卸,并报出事件", async () => {
  // 第一次请求后塞一堆图,模拟 view_image 的回灌
  const events = [];
  let turn = 0;
  const model = async (history) => {
    turn++;
    if (turn === 1) {
      // 手动往 history 里塞 6 张图(等价于 view_image 补的那条 user 消息)
      history.push({ role: "user", content: [{ type: "text", text: "看图" }, ...["a", "b", "c", "d", "e", "f"].map((l) => imgBlock(l + ".png", 1))] });
      return { content: "", toolCalls: [{ id: "c1", name: "list_pages", arguments: {} }] };
    }
    return { content: "好了", toolCalls: [] };
  };
  await runAgent({
    messages: [{ role: "user", content: "看图" }],
    model,
    tools: toolsFixture,
    onEvent: (e) => events.push(e),
    config: {},
  });
  assert.ok(events.some((e) => e.type === "images_offloaded" && e.count === 2), `应卸载 2 张: ${JSON.stringify(events.filter((e) => e.type === "images_offloaded"))}`);
});

test("canonicalArgs:键序不同要算同一次调用", () => {
  // 不按 key 排序的话 {a,b} 和 {b,a} 会被当成两次不同调用,循环就漏检了
  assert.equal(canonicalArgs({ slug: "index", nodeId: "1:2" }), canonicalArgs({ nodeId: "1:2", slug: "index" }));
  assert.equal(canonicalArgs({ a: { y: 1, x: 2 } }), canonicalArgs({ a: { x: 2, y: 1 } }), "嵌套也要排序");
  assert.notEqual(canonicalArgs({ a: 1 }), canonicalArgs({ a: 2 }), "值不同就是不同调用");
  assert.equal(canonicalArgs(undefined), "{}");
});

test("repeatReminder:5 次以后要点名工具和参数,并明确说别再发", () => {
  const gentle = repeatReminder("edit_text", 3, "{}");
  assert.match(gentle, /3 次/);
  assert.match(gentle, /不要原样再发一次/);
  const firm = repeatReminder("edit_text", 5, '{"nodeId":"9:9"}');
  assert.match(firm, /edit_text/, "要点名工具");
  assert.match(firm, /9:9/, "要点名参数");
  assert.match(firm, /不要再用这组参数调用这个工具/);
  assert.match(firm, /列举工具/, "要给出出路,不能只说别做");
});

test("循环检测:同一个调用连着 3 次会注入提醒(键序不同也算同一次)", async () => {
  const events = [];
  let turn = 0;
  const model = async () => {
    turn++;
    if (turn <= 4) return { content: "", toolCalls: [{ id: `c${turn}`, name: "list_pages", arguments: { a: 1, b: 2 } }] };
    if (turn === 5) return { content: "", toolCalls: [{ id: "c5", name: "list_pages", arguments: { b: 2, a: 1 } }] };
    return { content: "停", toolCalls: [] };
  };
  await runAgent({
    messages: [{ role: "user", content: "go" }],
    model,
    tools: { schemas: [], handlers: { list_pages: async () => ({ pages: [] }) } },
    onEvent: (e) => events.push(e),
    config: {},
    maxTurns: 8,
  });
  const reps = events.filter((e) => e.type === "repeat_detected");
  assert.deepEqual(reps.map((r) => r.count), [3, 5], `第 3、5 次各提醒一次: ${JSON.stringify(reps)}`);
});

test("循环检测:失败的调用也计数(对着被拒的调用反复敲最该打断)", async () => {
  const events = [];
  let turn = 0;
  const model = async () => {
    turn++;
    if (turn <= 3) return { content: "", toolCalls: [{ id: `c${turn}`, name: "boom", arguments: {} }] };
    return { content: "停", toolCalls: [] };
  };
  await runAgent({
    messages: [{ role: "user", content: "go" }],
    model,
    tools: { schemas: [], handlers: { boom: async () => { throw new Error("永远失败"); } } },
    onEvent: (e) => events.push(e),
    config: {},
    maxTurns: 6,
  });
  assert.ok(events.some((e) => e.type === "repeat_detected" && e.count === 3), "失败的调用第 3 次也要提醒");
});

test("循环检测:不同参数不算重复", async () => {
  const events = [];
  let turn = 0;
  const model = async () => {
    turn++;
    if (turn <= 4) return { content: "", toolCalls: [{ id: `c${turn}`, name: "list_pages", arguments: { n: turn } }] };
    return { content: "停", toolCalls: [] };
  };
  await runAgent({
    messages: [{ role: "user", content: "go" }],
    model,
    tools: { schemas: [], handlers: { list_pages: async () => ({ pages: [] }) } },
    onEvent: (e) => events.push(e),
    config: {},
    maxTurns: 6,
  });
  assert.equal(events.some((e) => e.type === "repeat_detected"), false, "参数各不相同就不该报循环");
});

test("trimChatHistory:永远保住第一条用户消息(那是任务本身)", () => {
  const list = [{ role: "user", content: "给首页加词云" }];
  for (let i = 0; i < 40; i++) {
    list.push({ role: "assistant", content: `第 ${i} 轮回复` });
    list.push({ role: "user", content: `再改一点 ${i}` });
  }
  const t = trimChatHistory(list, { maxMessages: 6 });
  assert.equal(t.length, 6);
  assert.equal(t[0].content, "给首页加词云", "最初的需求必须还在");
  assert.equal(t[t.length - 1].content, "再改一点 39", "最近的也要在");
});

test("trimChatHistory:按总长度裁剪,同样保住第一条", () => {
  const list = [
    { role: "user", content: "最初的需求" },
    ...Array.from({ length: 20 }, (_, i) => ({ role: "assistant", content: "x".repeat(5000) + i })),
  ];
  const t = trimChatHistory(list, { maxChars: 12000 });
  assert.equal(t[0].content, "最初的需求");
  assert.ok(t.length < 20, "要真的裁掉一些");
});

test("trimChatHistory:空内容与坏数据要被过滤掉", () => {
  const t = trimChatHistory([{ role: "user", content: "ok" }, { role: "assistant", content: "   " }, null, { role: "user" }]);
  assert.deepEqual(t.map((m) => m.content), ["ok"]);
  assert.deepEqual(trimChatHistory(null), []);
});

test("会话历史:写盘后能读回来(关掉程序不失忆)", () => {
  const dir = fixture();
  saveChatHistory(dir, [{ role: "user", content: "你好" }, { role: "assistant", content: "在的" }]);
  assert.equal(existsSync(join(dir, CHAT_HISTORY_FILE)), true, "要落盘");
  const back = loadChatHistory(dir);
  assert.equal(back.length, 2);
  assert.equal(back[0].content, "你好");
});

test("会话历史:文件不存在或损坏都返回空,不能让程序起不来", () => {
  const dir = fixture();
  assert.deepEqual(loadChatHistory(dir), [], "没有文件就是空");
  writeFileSync(join(dir, CHAT_HISTORY_FILE), "{ 这不是 JSON");
  assert.deepEqual(loadChatHistory(dir), [], "损坏也返回空而不是抛");
  writeFileSync(join(dir, CHAT_HISTORY_FILE), JSON.stringify([{ role: "user", content: "x" }]));
  assert.equal(loadChatHistory(dir).length, 1, "也兼容直接是数组的老形状");
});

test("buildSystemPrompt:关键规则一条都不能丢", () => {
  const p = buildSystemPrompt(null);
  // 每条都是"删掉了会出事故"的规则,列在这里防止重构时无声丢失
  const must = [
    "apply_wordcloud", "bind_data", "list_images", "insert_video", "set_video_options",
    "edit_text", "edit_node", "append_css", "get_standard", "design-report.md", "write_file",
    "manifest.json", "不要靠节点名字猜", "list_overlays", "list_history", "warnings 或 problems",
    "6850", "!important", "过渡时长不超过", "pointer-events", "data-*", "run_build", "用中文回答",
  ];
  const missing = must.filter((k) => !p.includes(k));
  assert.deepEqual(missing, [], `这些规则丢了: ${missing.join(", ")}`);
});

test("buildSystemPrompt:有小标题,模型能按标题跳读", () => {
  const p = buildSystemPrompt(null);
  for (const h of ["## 基本规则", "## 词云", "## 数据绑定", "## 看图", "## 插入视频", "## CSS 硬规矩", "## 警告必须处理"]) {
    assert.equal(p.includes(h), true, `缺小标题: ${h}`);
  }
});

test("buildSystemPrompt:工具不存在时它那一节不出现", () => {
  const few = buildSystemPrompt(new Set(["read_file", "list_pages"]));
  assert.equal(few.includes("apply_wordcloud"), false, "没有 apply_wordcloud 就不该提它");
  assert.equal(few.includes("insert_video"), false);
  assert.equal(few.includes("## 宽度自适应"), false, "get_standard 不在,那节也不该出现");
  assert.equal(few.includes("## 基本规则"), true, "通用规则仍在");
  assert.equal(few.includes("用中文回答"), true);
  assert.ok(few.length < buildSystemPrompt(null).length, "少了工具就该更短");
});

test("buildSystemPrompt:CSS 规矩那节不许混进 warnings 的文字(曾经粘连过)", () => {
  // 真实事故:一次编辑把"warnings 必须处理"的续行粘到了 CSS 规矩最后一条后面,
  // 于是那条规则后半截变成了讲警告的话 —— 模型读到的是残缺规则。
  const p = buildSystemPrompt(null);
  const cssStart = p.indexOf("## CSS 硬规矩");
  const warnStart = p.indexOf("## 警告必须处理");
  assert.ok(cssStart > 0 && warnStart > 0, "两节都要在");
  const cssSection = p.slice(cssStart, warnStart > cssStart ? warnStart : undefined);
  assert.equal(cssSection.includes("程序代替你的眼睛"), false, "CSS 节里不该有 warnings 的说明");
  assert.match(cssSection, /状态用 data-\* 属性表达[\s\S]*整个状态机就断了/, "data-* 那条要完整");
});

test("buildSystemPrompt:顺序由 order 决定,id 唯一", () => {
  const p = buildSystemPrompt(null);
  const at = (h) => p.indexOf(h);
  assert.ok(at("## 基本规则") < at("## 词云"), "基本规则在最前");
  assert.ok(at("## 词云") < at("## 数据绑定"));
  assert.ok(at("## CSS 硬规矩") < at("## 回复"), "回复永远在最后");
  const orders = PROMPT_SECTIONS.map((s) => s.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), "PROMPT_SECTIONS 必须按 order 声明");
  const ids = PROMPT_SECTIONS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "id 不能重复");
});

test("runAgent:schema 里没有的工具,提示词里也不提它", async () => {
  let seen = null;
  const r = await runAgent({
    messages: [{ role: "user", content: "hi" }],
    model: async (history) => {
      seen = history[0].content;
      return { content: "好", toolCalls: [] };
    },
    tools: { schemas: [{ function: { name: "read_file" } }], handlers: {} },
    config: {},
  });
  assert.equal(r.text, "好");
  assert.equal(seen.includes("read_file"), true, "存在的工具要提");
  assert.equal(seen.includes("apply_wordcloud"), false, "不存在的工具不要提");
});

test("runAgent surfaces a model exception as an error event", async () => {  const events = [];
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
        "1:1": { id: "1:1", type: "FRAME", name: "Canvas", absoluteBoundingBox: { x: 0, y: 0, width: 500, height: 400 }, children: ["1:2", "1:9"] },
        "1:2": { id: "1:2", type: "TEXT", characters: "hello world hello travel", absoluteBoundingBox: { x: 20, y: 20, width: 100, height: 20 } },
      // 设计自带的 VIDEO 填充(实测 germanschoolhistories 的 2:1915 就是这样)
      "1:9": { id: "1:9", type: "RECTANGLE", name: "lily网站视频 2", absoluteBoundingBox: { x: 0, y: 0, width: 760, height: 427 },
        fills: [{ type: "VIDEO", videoRef: "deadbeef", muted: true, showControls: false, autoplay: true, mediaLoop: true }] },
      },
    }),
  );
  return dir;
}

const allowAll = async () => true;
const denyAll = async () => false;

// --- 插入视频(insert_video / delete_video) -----------------------------------
// 起因:工具集里没有「插入媒体」,AI 只能建议用 write_file 整体改写 HTML,
// 而首页 600+ 节点、read_file 会截断,凭半份内容写回会把后半页整段弄丢。

// fixture + 一个**不可达**的节点(组件定义区的原件:在 nodeById 里、有坐标,
// 但永远不会被渲染 —— 之前 read_page_text 会把它列给 AI,AI 选中后"操作成功"却毫无效果)
function videoFixture() {
  const dir = fixture();
  const p = join(dir, "data", "index.json");
  const d = JSON.parse(readFileSync(p, "utf8"));
  d.nodeById["9:9"] = {
    id: "9:9",
    type: "RECTANGLE",
    name: "ghost",
    absoluteBoundingBox: { x: 300, y: 300, width: 200, height: 100 },
  };
  d.nodeById["1:3"] = {
    id: "1:3",
    type: "RECTANGLE",
    name: "slot",
    absoluteBoundingBox: { x: 10, y: 200, width: 320, height: 180 },
  };
  d.nodeById["1:1"].children.push("1:3");
  writeFileSync(p, JSON.stringify(d));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", "real-clip.mp4"), Buffer.from([0, 0, 0, 0x20]));
  writeFileSync(join(dir, "assets", "cover.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
  return dir;
}

test("insert_video:目录里一个视频都没有时明确让用户先放进去", async () => {
  const dir = videoFixture();
  rmSync(join(dir, "assets", "real-clip.mp4")); // 只剩 cover.jpg,不是媒体
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.insert_video({ slug: "index", nodeId: "1:3", src: "assets/nope.mp4" });
  assert.ok(r.error, "没有可用视频时必须报错");
  assert.match(String(r.hint || ""), /没有找到任何视频文件/, "要告诉用户先把视频放进去");
  assert.equal(existsSync(join(dir, "videos.json")), false, "不该写入任何记录");
});

test("insert_video:中文名对不上时自动改用真实文件,不回头问用户", async () => {
  const dir = videoFixture();
  // 复刻真实事故:磁盘上是乱码名,用户按原名字调用。
  // "lily网站视频_副本.mp4" → "lily缃戠珯瑙嗛_鍓湰.mp4":ASCII 前缀和扩展名保留,
  // 但汉字数量变了(长度 15 → 17),所以判据不能是长度。
  const bad = "lily缃戠珯瑙嗛_鍓湰.mp4";
  renameSync(join(dir, "assets", "real-clip.mp4"), join(dir, "assets", bad));
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.insert_video({ slug: "index", nodeId: "1:3", src: "assets/lily网站视频_副本.mp4" });
  // 关键:**不再报错**。文件名是输入的问题,不该让程序卡死(实测来回两轮都插不进去)
  assert.equal(r.error, undefined, `不该报错,实际: ${r.error}`);
  assert.equal(r.src, `assets/${bad}`, "要用磁盘上真实的文件名");
  assert.match(String(r.note || ""), /错误编码/, "要说明发生了替换");
  // 覆盖层里记的也必须是真实名字,否则构建出来是 404
  const saved = JSON.parse(readFileSync(join(dir, "videos.json"), "utf8"));
  assert.equal(saved.items[0].src, `assets/${bad}`);
});

test("insert_video:候选不止一个且前缀对不上时,仍然报错让人来判断", async () => {
  const dir = videoFixture();
  writeFileSync(join(dir, "assets", "another-long-name.mp4"), Buffer.from([0, 0, 0, 0x20]));
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.insert_video({ slug: "index", nodeId: "1:3", src: "assets/nope.mp4" });
  assert.ok(r.error, "前缀对不上就不能乱猜 —— 插错视频比多问一句更糟");
  assert.match(String(r.hint || ""), /another-long-name\.mp4/, "但要列出全部候选让模型自己判断");
  assert.equal(existsSync(join(dir, "videos.json")), false, "不该写入任何记录");
});

test("insert_video:拒绝组件定义区的幽灵节点", async () => {
  const dir = videoFixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.insert_video({ slug: "index", nodeId: "9:9", src: "assets/real-clip.mp4" });
  assert.ok(r.error, "不可达节点必须拒绝 —— 否则插了也永远看不见");
  assert.match(r.error, /不在页面上|永远不会被渲染/);
  assert.match(String(r.hint || ""), /1:3/, "应提示页面上可用的矩形");
});

test("insert_video:正常插入并落盘", async () => {
  const dir = videoFixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.insert_video({ slug: "index", nodeId: "1:3", src: "assets/real-clip.mp4", poster: "assets/cover.jpg", loop: true });
  assert.ok(!r.error, `不该报错: ${r.error}`);
  assert.equal(r.src, "assets/real-clip.mp4");
  const saved = JSON.parse(readFileSync(join(dir, "videos.json"), "utf8"));
  assert.equal(saved.items.length, 1);
  assert.equal(saved.items[0].nodeId, "1:3");
  assert.equal(saved.items[0].loop, true);
  assert.equal(saved.items[0].controls, true, "默认显示控件");
  // 默认**不静音**。旧行为是 `muted !== false` —— 没传就静音,于是每个插入的视频
  // 都变哑巴,而没人要求过(实测 2026101203:文件有音轨、93 秒,页面上没声音)。
  assert.equal(saved.items[0].muted, false, "没人要求静音就不该静音");
});

test("insert_video:要声音与要自动播放不能兼得;同一节点重复插入只留一条", async () => {
  const dir = videoFixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  // 同时要 autoplay 和 muted:false —— 浏览器一律拦截带声音的自动播放,
  // 所以必须摘掉一个;这里摘 autoplay,并且要**说明**,不能悄悄改。
  const a = await handlers.insert_video({ slug: "index", nodeId: "1:3", src: "assets/real-clip.mp4", autoplay: true, muted: false });
  assert.equal(a.autoplay, false, "有声音时不能自动播放");
  assert.equal(a.muted, false, "要声音就真的给声音");
  await handlers.insert_video({ slug: "index", nodeId: "1:3", src: "assets/real-clip.mp4" });
  const saved = JSON.parse(readFileSync(join(dir, "videos.json"), "utf8"));
  assert.equal(saved.items.filter((i) => i.nodeId === "1:3").length, 1, "同一节点只能有一条");
});

test("insert_video:缺少参数与非法路径", async () => {
  const dir = videoFixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  assert.ok((await handlers.insert_video({ slug: "index", nodeId: "1:3" })).error, "缺 src 要报错");
  assert.ok((await handlers.insert_video({ slug: "nope", nodeId: "1:3", src: "assets/real-clip.mp4" })).error, "页面不存在要报错");
  assert.ok((await handlers.insert_video({ slug: "index", nodeId: "nope", src: "assets/real-clip.mp4" })).error, "节点不存在要报错");
  assert.ok((await handlers.insert_video({ slug: "index", nodeId: "1:3", src: "../../outside.mp4" })).error, "路径逃逸要挡住");
  assert.ok((await handlers.insert_video({ slug: "index", nodeId: "1:3", src: "assets/real-clip.mp4", poster: "assets/nope.jpg" })).error, "封面不存在要报错");
});

test("insert_video:http(s) 直链不需要文件存在", async () => {
  const dir = videoFixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.insert_video({ slug: "index", nodeId: "1:3", src: "https://cdn.example.com/a.mp4" });
  assert.ok(!r.error, `直链应当接受: ${r.error}`);
  assert.equal(r.src, "https://cdn.example.com/a.mp4");
});

test("insert_video:用户拒绝时不落盘", async () => {
  const dir = videoFixture();
  const { handlers } = makeTools({ outDir: dir, confirm: denyAll });
  const r = await handlers.insert_video({ slug: "index", nodeId: "1:3", src: "assets/real-clip.mp4" });
  assert.ok(r.error);
  assert.equal(existsSync(join(dir, "videos.json")), false, "拒绝后不该写文件");
});

test("delete_video:按 id 或 nodeId 都能删", async () => {
  const dir = videoFixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.insert_video({ slug: "index", nodeId: "1:3", src: "assets/real-clip.mp4" });
  assert.ok((await handlers.delete_video({ id: r.id })).id, "按 id 删");
  const r2 = await handlers.insert_video({ slug: "index", nodeId: "1:3", src: "assets/real-clip.mp4" });
  const byNode = await handlers.delete_video({ id: "1:3" });
  assert.equal(byNode.id, r2.id, "按 nodeId 也要能删");
  assert.equal(JSON.parse(readFileSync(join(dir, "videos.json"), "utf8")).items.length, 0);
  assert.ok((await handlers.delete_video({ id: "nope" })).error);
});

test("视频:read_page_text 不再把不可达的节点列给 AI", async () => {
  const dir = videoFixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.read_page_text({ slug: "index" });
  const ids = r.all.map((n) => n.id);
  assert.ok(ids.includes("1:3"), "可达节点要在列表里");
  assert.equal(ids.includes("9:9"), false, "组件定义区的幽灵节点不能列出来 —— AI 选了它只会白忙");
});

test("videos.json 在 write_file 的禁写名单里", async () => {
  const dir = videoFixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.write_file({ path: "videos.json", content: "{}" });
  assert.ok(r.error, "必须拒绝直接改写 videos.json");
});

test("tools reject path traversal", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.write_file({ path: "../escape.txt", content: "x" });
  assert.ok(r.error, "traversal must be blocked");});

test("write_file refuses metadata / overlay files", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  for (const p of ["manifest.json", "wordclouds.json", "databinds.json", "edits.json", "file-locks.json", "nodeStyles.json", "overrides.json", "design-report.md", "design-report.json"]) {
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
  // 锁里存的是对象:内容 + **改动前那份生成物的哈希**。
  // 存哈希是为了重新拉取设计后能发现"底稿变了",不再拿旧副本静默盖掉新设计。
  assert.equal(locks.files["styles.css"].content, "body { color: red }");
  assert.equal(locks.files["index.html"].content, "<html><body>AI 版</body></html>");
  // fixture 里一开始没有 index.html,所以改动前是"不存在"
  assert.equal(locks.files["index.html"].baseHash, null, "文件原本不存在时没有底稿可对");
  assert.ok(!("data/index.json" in locks.files));
});

test("锁:设计重新拉取后**不能**用旧副本盖掉新设计(问题 4)", async () => {
  // 这是用户报的"设计改了拉取后无法更新":旧实现无条件把 AI 的整份文件写回,
  // 还打印 ✓ re-applied,看起来像成功 —— 新设计**静默消失**。
  // 真实时序:构建产出底稿 → AI 改它(记下底稿哈希)→ 再构建比对哈希。
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  await buildSite(dir); // 产出底稿 G
  const G = readFileSync(join(dir, "index.html"), "utf8");
  await handlers.write_file({ path: "index.html", content: G.replace("hello world", "AI 改过的") + "<!--ai-->" });
  const locks0 = JSON.parse(readFileSync(join(dir, "file-locks.json"), "utf8"));
  assert.ok(locks0.files["index.html"].baseHash, "要记下底稿哈希");

  // 设计没变 → 重新构建产出的还是 G → 套回
  await buildSite(dir);
  assert.equal(readFileSync(join(dir, "index.html"), "utf8").includes("<!--ai-->"), true, "底稿没变就该套回 AI 的改动");

  // 模拟"重新拉取了设计":底稿变了 → **不能覆盖**
  const data = JSON.parse(readFileSync(join(dir, "data", "index.json"), "utf8"));
  data.nodeById["1:2"].characters = "全新拉取的设计文本";
  writeFileSync(join(dir, "data", "index.json"), JSON.stringify(data));
  await buildSite(dir);
  const after = readFileSync(join(dir, "index.html"), "utf8");
  assert.equal(after.includes("全新拉取的设计文本"), true, `新设计必须保住,实际: ${after.slice(0, 200)}`);
  // AI 的改动不能丢 —— 还在锁里,等它重新应用
  const locks1 = JSON.parse(readFileSync(join(dir, "file-locks.json"), "utf8"));
  assert.equal(locks1.files["index.html"].content.includes("<!--ai-->"), true, "AI 的改动仍完整保留");
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

// --- list_overlays / 投票规则 --------------------------------------------------

test("list_overlays:列出这页已放过什么,并指出重叠", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  assert.deepEqual((await handlers.list_overlays({ slug: "index" })).databinds, [], "一开始什么都没有");
  // 放两条**完全重叠**的绑定 —— 这正是真实事故里的样子
  const rect = { left: 50, top: 6850, width: 1180, height: 440 };
  await handlers.bind_data({ slug: "index", rect, collection: "voices", kind: "wordcloud", read: { groupBy: "text" }, fallback: { buckets: [] } });
  await handlers.bind_data({ slug: "index", rect, collection: "votes", kind: "bar", read: { groupBy: "choice" }, fallback: { buckets: [] } });
  const r = await handlers.list_overlays({ slug: "index" });
  assert.equal(r.databinds.length, 2);
  assert.ok(Array.isArray(r.overlaps) && r.overlaps.length === 1, `应指出重叠: ${JSON.stringify(r.overlaps)}`);
  assert.match(r.warn, /叠在一起/);
});

test("bind_data:perVisitor 落到 spec 里,默认 once", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const rect = { left: 0, top: 0, width: 100, height: 40 };
  const a = await handlers.bind_data({ slug: "index", rect, collection: "votes", kind: "counter", fallback: { total: 0 } });
  const bs = JSON.parse(readFileSync(join(dir, "databinds.json"), "utf8")).items;
  assert.equal(bs.find((i) => i.id === a.id).options.perVisitor, "once", "默认每一项一次");
  const b = await handlers.bind_data({ slug: "index", rect, collection: "words", kind: "counter", fallback: { total: 0 }, options: { perVisitor: "many" } });
  const bs2 = JSON.parse(readFileSync(join(dir, "databinds.json"), "utf8")).items;
  assert.equal(bs2.find((i) => i.id === b.id).options.perVisitor, "many");
  // 非法值退回 once,不要写个奇怪的进去
  const c = await handlers.bind_data({ slug: "index", rect, collection: "x", kind: "counter", fallback: { total: 0 }, options: { perVisitor: "whatever" } });
  const bs3 = JSON.parse(readFileSync(join(dir, "databinds.json"), "utf8")).items;
  assert.equal(bs3.find((i) => i.id === c.id).options.perVisitor, "once");
});

test("edit_node:height/width 直接给数字,并核对文字还放不放得下", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  // 文本节点 1:2:edit_text 会警告溢出,修的办法就是这个
  const a = await handlers.edit_node({ slug: "index", nodeId: "1:2", height: 400 });
  assert.ok(!a.error, `不该报错: ${a.error}`);
  const saved = JSON.parse(readFileSync(join(dir, "nodeStyles.json"), "utf8")).items;
  const ns = saved.find((i) => i.id === a.id);
  assert.equal(ns.style.height, "400px", "要自动补上单位");
  assert.match(String(a.note || ""), /估算/, "要顺带核对文字放不放得下");
  // width 一起给
  const b = await handlers.edit_node({ slug: "index", nodeId: "1:2", width: 320, style: { color: "#123456" } });
  const ns2 = JSON.parse(readFileSync(join(dir, "nodeStyles.json"), "utf8")).items.find((i) => i.id === b.id);
  assert.equal(ns2.style.width, "320px");
  assert.equal(ns2.style.color, "#123456", "style 和 width/height 要能一起用");
  // 非法值
  assert.match(String((await handlers.edit_node({ slug: "index", nodeId: "1:2", height: -5 })).error), /正数/);
  assert.match(String((await handlers.edit_node({ slug: "index", nodeId: "1:2", height: 99999 })).error), /太大/);
  assert.match(String((await handlers.edit_node({ slug: "index", nodeId: "1:2" })).error), /至少要提供/);
});

// --- 静默失败清零 --------------------------------------------------------------
// 发布数据里有一大块**组件定义区的原件**:nodeById 里有、坐标正常,却永远不渲染。
// 只查 nodeById 的话,这些工具都会"成功"返回而页面上什么都没变 ——
// 用户看到的是"AI 说改了但页面没变"。insert_video 早就有这道校验,其余几个漏了。

function ghostFixture() {
  const dir = mkdtempSync(join(tmpdir(), "rep-ghost-"));
  mkdirSync(join(dir, "data"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ liveBase: "https://e.figma.site", pages: [{ path: "/", slug: "index", file: "index.html", title: "H", json: "data/index.json" }] }));
  writeFileSync(join(dir, "data", "index.json"), JSON.stringify({
    roots: ["1:1"],
    nodeById: {
      "1:1": { id: "1:1", type: "FRAME", name: "Canvas", absoluteBoundingBox: { x: 0, y: 0, width: 500, height: 400 }, children: ["1:2"] },
      "1:2": { id: "1:2", type: "TEXT", name: "real", characters: "hi", absoluteBoundingBox: { x: 10, y: 10, width: 100, height: 20 } },
      // 幽灵:在 nodeById 里,但不在 roots 可达的树里
      "9:9": { id: "9:9", type: "TEXT", name: "ghost", characters: "never rendered", absoluteBoundingBox: { x: 300, y: 900, width: 100, height: 20 } },
    },
  }));
  return dir;
}

for (const [tool, args] of [
  ["edit_text", { text: "x" }],
  ["edit_node", { height: 100 }],
  ["set_video_options", { muted: false }],
]) {
  test(`${tool}:改永远不渲染的幽灵节点要说清楚,不能假装成功`, async () => {
    const dir = ghostFixture();
    const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
    const r = await handlers[tool]({ slug: "index", nodeId: "9:9", ...args });
    assert.ok(r.error, `必须报错,实际: ${JSON.stringify(r)}`);
    assert.match(r.error, /不在页面上|永远不会被渲染/, "要说清原因");
    assert.ok(r.hint, "要给出可用的替代节点");
    // 真实节点应当**过得了这道校验**。至于它本身能不能改是另一回事
    // (set_video_options 对没有视频的节点报错是正确的),所以只要求错误信息
    // 不是"幽灵节点"那一句。
    const ok = await handlers[tool]({ slug: "index", nodeId: "1:2", ...args });
    if (ok.error) assert.equal(/不在页面上|永远不会被渲染/.test(ok.error), false, `真实节点不该被当成幽灵节点: ${ok.error}`);
  });
}

test("bind_data:点击目标指向幽灵节点要拦住", async () => {
  const dir = ghostFixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.bind_data({ slug: "index", rect: { left: 0, top: 0, width: 10, height: 10 }, collection: "v", kind: "action", write: { target: "9:9", field: "text" } });
  assert.ok(r.error, "必须报错");
  assert.match(r.error, /不在页面上/);
});

// --- check_page ----------------------------------------------------------------
// 这个工具的价值全在"把渲染结果翻译成问题"这一步。真浏览器由 pageprobe 提供,
// 测试里换成一个假探针 —— 测的是翻译逻辑,不是浏览器。

test("check_page:把渲染结果里的问题逐条翻译出来", async () => {
  const dir = fixture();
  writeFileSync(join(dir, "index.html"), "<html></html>");
  setPageProbe(async () => ({
    value: {
      url: "file:///x",
      databinds: 25,
      states: { "(无)": 25 },
      // 一个像素没画 + 容器可见 → 是问题
      clouds: [
        { box: "1180x440", y: 6856, painted: 0, samples: 100, pct: 0, visible: true, opacity: 1 },
        // 容器不可见 → 这是揭示面板,不是问题(误报防护)
        { box: "400x200", y: 10, painted: 0, samples: 50, pct: 0, visible: false, opacity: 0 },
      ],
      hidden: [{ sel: "db-body", opacity: "0", node: "2157:500" }],
      slowTransition: [{ sel: "DIV", duration: "100000s" }, { sel: "DIV", duration: "100000s" }],
      blocked: [
        { tag: "video", muted: true, controls: false, autoplay: false, src: "a.mp4", pointerEvents: "none" },
      ],
      overlaps: [{ a: "1:2 hi", b: "1:3 yo", pct: 100 }],
    },
    errors: ["TypeError: x is not a function"],
  }));
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.check_page({ slug: "index" });
  assert.equal(r.ok, false);
  assert.equal(r.databinds, 25);
  const all = r.problems.join("\n");
  assert.match(all, /一个像素都没画/, "可见的空 canvas 要报");
  assert.match(all, /opacity 是 0/, "几乎透明的容器要报");
  assert.match(all, /100000s/, "超长过渡要报");
  assert.match(all, /pointer-events: none/, "控件被挡住要报");
  assert.match(all, /既静音、又没控件、又不自动播放/, "播不了的视频要报");
  assert.match(all, /文字叠在一起/, "文字重叠要报");
  assert.match(all, /JS 异常/, "页面抛错要报");
  // 同一条时长只报一次(几十个元素共用一条规则时,逐条列会把真问题淹掉)
  assert.equal(r.problems.filter((p) => /100000s/.test(p)).length, 1, "重复时长要去重");
  // 不可见的 canvas 只给"当前是隐藏的",不能说成"没画像素"
  assert.equal(r.problems.filter((p) => /400x200/.test(p) && /一个像素都没画/.test(p)).length, 0, "隐藏面板不该误报");
  setPageProbe(null);
});

test("check_page:没问题时 ok=true,并且不编造问题", async () => {
  const dir = fixture();
  writeFileSync(join(dir, "index.html"), "<html></html>");
  setPageProbe(async () => ({ value: { url: "file:///x", databinds: 3, states: { submitted: 3 }, clouds: [], hidden: [], slowTransition: [], blocked: [], overlaps: [] }, errors: [] }));
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.check_page({ slug: "index" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
  setPageProbe(null);
});

test("list_images:必须把视频也列出来,并带上 nodeId", async () => {
  // 实测事故:用户让 AI 给首页视频加声音,AI 想找一个能传给 set_video_options 的
  // nodeId。list_images 是"这页有什么媒体"的答案,但它只认 IMAGE 填充 ——
  // VIDEO 填充被完全跳过。AI 于是按节点**名字**挑了个叫"…视频 1"的矩形,
  // 失败后又连猜了 20 多个 id,全部落空;真正的视频是另一个名字几乎一样、
  // id 完全不同的节点(2:1915)。
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.list_images({ slug: "index" });
  assert.ok(!r.error, `不该报错: ${r.error}`);
  assert.ok(Array.isArray(r.videos), "要有一个 videos 列表");
  assert.equal(r.videos.length, 1, `应列出 1 个视频: ${JSON.stringify(r.videos)}`);
  assert.equal(r.videos[0].nodeId, "1:9", "要带 nodeId,否则 AI 只能猜");
  assert.equal(r.videos[0].via, "设计自带的 VIDEO 填充");
  assert.match(String(r.videoNote || ""), /不要按节点名字猜/, "要明确警告别靠名字猜");
  // 幽灵节点(组件定义区的原件)不该出现
  assert.equal(r.videos.some((v) => v.nodeId === "9:9"), false, "幽灵节点不该被列出");
});

// --- 工具结果剪枝 --------------------------------------------------------------
// 工具结果进 history 后永不清理,不剪的话长任务必然撑爆上下文。
// 借鉴 DSH 的 compaction-tool-result-pruner,但按字段剪 —— 砍断 JSON 字符串
// 会得到非法 JSON,模型想按字段读就废了。

test("pruneToolResult:短内容原样不动", () => {
  const r = { id: "a", slug: "index", count: 3 };
  assert.deepEqual(pruneToolResult(r), r);
  assert.equal(pruneToolResult("短"), "短");
});

test("pruneToolResult:长字符串保留头尾,总量显著变小,且仍是合法 JSON", () => {
  const long = "A".repeat(5000) + "中间会被裁掉" + "B".repeat(5000);
  const r = pruneToolResult({ text: long, keep: "ok" });
  assert.ok(r.text.length < long.length, "要变小");
  assert.match(r.text, /中间内容已裁剪/, "要有显式标记");
  assert.equal(r.text.startsWith("A".repeat(100)), true, "头部保留");
  assert.equal(r.text.endsWith("B".repeat(100)), true, "尾部保留");
  assert.equal(r.keep, "ok", "短字段不许动");
  // **仍然是合法 JSON** —— 这是与 DSH 做法不同的地方,也是最关键的一条
  const round = JSON.parse(JSON.stringify(r));
  assert.equal(typeof round.text, "string");
});

test("pruneToolResult:按 code point 切,不劈开代理对/不撕裂汉字", () => {
  // 每个 emoji 是 2 个 UTF-16 code unit,.slice 会把它们劈成乱码。
  // 4000 个 emoji ≈ 8000 code unit ≈ 4000 code point,要跨过 4096 的头界。
  const s = "🎓".repeat(3000) + "x" + "🌏".repeat(3000);
  const r = pruneToolResult({ text: s });
  // 剪完不该出现替换字符(劈开代理对的典型症状)
  assert.equal(r.text.includes("\uFFFD"), false, "不能出现乱码");
  // 头尾都该是完整的 emoji
  assert.equal(r.text.startsWith("🎓"), true);
  assert.equal(r.text.endsWith("🌏"), true);
});

test("pruneToolResult:超长数组保留前若干项并说明省略了多少", () => {
  const r = pruneToolResult({ all: Array.from({ length: 200 }, (_, i) => ({ id: `${i}`, type: "TEXT" })) });
  assert.ok(r.all.length < 200, "要变短");
  assert.equal(r.all.length, 41, "保留 40 项 + 1 条说明");
  assert.match(String(r.all[40]), /省略 160 项,共 200 项/);
  assert.equal(r.all[0].id, "0", "顺序不能变");
});

test("pruneToolResult:剪完没变小就宁可不动", () => {
  const r = { a: 1, b: "x" };
  assert.deepEqual(pruneToolResult(r), r);
  // 恰好卡在阈值上的不剪
  const exact = "z".repeat(PRUNE_DEFAULTS.thresholdChars);
  assert.equal(pruneToolResult({ t: exact }).t, exact, "等于阈值不剪");
});

// --- 覆盖层快照 / 回滚 --------------------------------------------------------
// 覆盖层是 AI 改动的唯一事实来源,一次写坏就没有退路。这一轮我用脚本清 CSS 时
// 按 } 切块删规则,把按钮样式整块删掉了,最后靠文件旁边的 .bak 才救回来 ——
// 那不该靠运气。

test("每次改覆盖层前都会存一份快照,并且能回滚", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  // 第一次改动 → 存的快照是"什么都没有"的初始状态(那也是有效的回滚目标)
  await handlers.append_css({ id: "css-1", css: ".a { color: red; }" });
  assert.ok((await handlers.list_history({})).steps.length >= 1, "改完应该有快照");

  // 第二次改动 → 又存一份,内容是"只有 css-1"的状态
  await handlers.append_css({ id: "css-2", css: ".b { color: blue; }" });
  assert.equal(JSON.parse(readFileSync(join(dir, "overrides.json"), "utf8")).items.length, 2, "两条都在");
  // 最新的那份快照 = 加 css-2 之前的状态
  const beforeCss2 = (await handlers.list_history({})).steps[0].id;

  // 回到那份 → css-2 应该没了,css-1 还在
  const r = await handlers.restore_history({ id: beforeCss2 });
  assert.ok(!r.error, `回滚失败: ${r.error}`);
  const after = JSON.parse(readFileSync(join(dir, "overrides.json"), "utf8"));
  assert.equal(after.items.length, 1, "回滚后只剩第一条");
  assert.equal(after.items[0].id, "css-1");
});

test("restore_history:回滚本身也可逆(会先存当前状态)", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  await handlers.append_css({ id: "css-1", css: ".a{}" });
  const s1 = (await handlers.list_history({})).steps[0].id;
  await handlers.append_css({ id: "css-2", css: ".b{}" });
  await handlers.restore_history({ id: s1 });
  // 回滚后 history 里应该多出一份 before-restore
  const steps = (await handlers.list_history({})).steps;
  assert.ok(steps.some((s) => s.label === "before-restore"), "回滚前要自动存一份,否则回滚不可逆");
});

test("restore_history:快照 id 不存在时给出可用的列表", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  await handlers.append_css({ id: "css-1", css: ".a{}" });
  const r = await handlers.restore_history({ id: "not-a-real-step" });
  assert.match(String(r.error), /没有这个快照/);
  assert.ok(r.hint, "要提示有哪些可用,否则 AI 只能瞎猜");
});

// --- CSS 体检 -----------------------------------------------------------------
// 这一整轮"样式不生效/看不见/点不动"的问题**全部**出在 AI 手写的 CSS 上,
// 而且都是浏览器不报错的那些。下面每条都对应一个真实事故。

test("auditCss:坐标字符串匹配要被点名", () => {
  const r = auditCss('.canvas .databind[style*="6850"] .db-body { opacity: 1; }');
  assert.equal(r.length, 1);
  assert.equal(r[0].rule, "style-attr-match");
  assert.match(r[0].message, /data-node-id/, "要给出替代方案,不能只说不行");
});

test("auditCss:!important 过量要报警,少量不报", () => {
  assert.deepEqual(auditCss(".a { color: red !important; }"), [], "一两个是正常的");
  const many = Array.from({ length: 30 }, (_, i) => `.a${i} { color: red !important; }`).join("\n");
  const r = auditCss(many);
  assert.equal(r.length, 1);
  assert.equal(r[0].rule, "important-count");
});

test("auditCss:超长 transition 是 error(100000s 那次事故)", () => {
  // 实测:AI 写了 transition: opacity 100000s —— 27 小时。揭示动画永远跑不完,
  // 刷新后词云不显示,用户报"得再点一次 Submit 才出来"。
  const r = auditCss(".db-body { opacity: 0; transition: opacity 100000s ease; }");
  assert.equal(r.length, 1);
  assert.equal(r[0].rule, "transition-too-long");
  assert.equal(r[0].level, "error", "这条会让功能看起来坏掉,必须是 error");
  assert.deepEqual(auditCss(".x { transition: opacity .45s ease; }"), [], "正常时长不该报");
});

test("auditCss:video 上的 pointer-events:none 是 error(控件点不动)", () => {
  const r = auditCss(".replica-video { pointer-events: none; }");
  assert.equal(r.length, 1);
  assert.equal(r[0].rule, "video-pointer-events");
  assert.equal(r[0].level, "error");
  // 不碰 video 的 pointer-events 是正常的
  assert.deepEqual(auditCss(".databind { pointer-events: none; }"), []);
});

test("auditCss:真实那份 AI CSS 的每一类问题都能认出来", () => {
  const css = [
    '.canvas [style*="6850"] { opacity: 1 !important; }',
    ...Array.from({ length: 30 }, (_, i) => `.n${i} { left: 100px !important; }`),
    ".v { pointer-events: none; }",
    "@media all { .v { transition: opacity 45s; } }",
    ".v { } /* video 相关 */",
  ].join("\n");
  const rules = auditCss(css).map((w) => w.rule).sort();
  assert.ok(rules.includes("style-attr-match"));
  assert.ok(rules.includes("important-count"));
  assert.ok(rules.includes("transition-too-long"));
});

test("append_css 会返回体检结果", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.append_css({ css: '.x[style*="6850"] { opacity: 1 !important; }' });
  assert.ok(!r.error, `不该报错: ${r.error}`);
  assert.ok(Array.isArray(r.warnings) && r.warnings.length, "要给出 warnings");
  assert.ok(r.warnings.some((w) => w.includes("style-attr-match")), JSON.stringify(r.warnings));
});

// --- 重叠 / 溢出的提醒 ------------------------------------------------------
// 实测事故(coco figma2):26 条 databind 里有两条 counter 的矩形完全重叠,
// 页面上两行字叠着,用户的描述是"词云生成之后提示内容不会消失"。
// AI 看不到页面,覆盖层又是它自己加的(发布数据里没有),所以必须由程序提醒。

test("rectOverlap:完全重叠 = 100%,贴边不算", () => {
  const a = { left: 0, top: 0, width: 400, height: 26 };
  assert.equal(rectOverlap(a, { ...a }), 1);
  assert.equal(rectOverlap(a, { left: 400, top: 0, width: 400, height: 26 }), 0, "紧挨着不算重叠");
  assert.ok(rectOverlap(a, { left: 380, top: 0, width: 400, height: 26 }) < 0.06, "只擦到 20px 的边,比例很小");
});

test("overlayCollisions:同一位置的第二条绑定要被点名", () => {
  const existing = [
    { id: "db-1", kind: "counter", slug: "index", rect: { left: 502, top: 6792, width: 400, height: 26 } },
    { id: "wc-1", kind: "wordcloud", slug: "index", rect: { left: 112, top: 6850, width: 1180, height: 440 } },
  ];
  const hits = overlayCollisions({ left: 502, top: 6792, width: 400, height: 26 }, existing);
  assert.equal(hits.length, 1, "只有 db-1 重叠");
  assert.equal(hits[0].id, "db-1");
  assert.equal(hits[0].overlap, 100);
  // 挪到没内容的地方就不该报
  assert.deepEqual(overlayCollisions({ left: 100, top: 100, width: 200, height: 60 }, existing), []);
});

test("overlayCollisions:轻微擦边(低于 25%)不打扰用户", () => {
  const existing = [{ id: "x", kind: "bar", rect: { left: 0, top: 0, width: 100, height: 100 } }];
  // 重叠 10x10 = 10%
  assert.deepEqual(overlayCollisions({ left: 90, top: 90, width: 100, height: 100 }, existing), []);
});

test("estimateTextHeight:汉字按 1em、拉丁按 0.5em 估算", () => {
  // 宽度 100px、字号 10px:一行放 10 个汉字 或 20 个拉丁字母
  assert.equal(estimateTextHeight("汉字十个字", { width: 100, fontSize: 10, lineHeight: 20 }), 20);
  assert.equal(estimateTextHeight("a".repeat(20), { width: 100, fontSize: 10, lineHeight: 20 }), 20);
  assert.equal(estimateTextHeight("a".repeat(40), { width: 100, fontSize: 10, lineHeight: 20 }), 40, "40 个字母 = 2 行");
  // 换行符强制分行,空行也算一行
  assert.equal(estimateTextHeight("a\n\nb", { width: 100, fontSize: 10, lineHeight: 20 }), 60);
});

test("read_file can read files inside the dir", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.read_file({ path: "manifest.json" });
  assert.ok(r.content.includes("Test"));
});

test("read_file:还没有词云时读 wordclouds.json 返回空,不是错误", async () => {
  // 实际事故:加词云时 AI 先 read_file('wordclouds.json') 探现状,拿到的却是
  // 「文件不存在」,于是以为出了问题、回头问用户或反复重试,词云一直没加上。
  // 覆盖层文件在"还没添加过"时本来就不存在 —— 这是初始状态,不是故障。
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.read_file({ path: "wordclouds.json" });
  assert.equal(r.error, undefined, "不该报错");
  assert.equal(r.missing, true, "要标明文件还不存在");
  assert.deepEqual(JSON.parse(r.content), { version: 1, items: [] }, "给出空结构");
  assert.match(r.note, /不是错误/, "要说明这是正常初始状态");
  assert.match(r.note, /apply_wordcloud/, "要指出该用哪个工具添加");
});

test("read_file:路径确实写错时仍然报错(保护不能一起丢掉)", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.read_file({ path: "not-a-real-file.json" });
  assert.match(String(r.error), /文件不存在/);
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
  // An interactive SVG anchors its FULL bbox (the nav hotspots are tiny empty
  // SVGs inside huge hit areas), so the <a> carries the position style and the
  // <img> is stretched inside it — not `<a href><img …` back to back.
  assert.ok(
    /<a href="page-5\.html" style="[^"]*"[^>]*><img src="assets\/bb33cc44\.svg"/.test(html),
    "interactive SVG renders as an anchor-wrapped img",
  );
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
  const img = /<img src="assets\/aa11bb22\.svg" alt="" style="([^"]+)"[^>]*\/>/.exec(html);
  assert.ok(img, "SVG node rendered as an img referencing its asset");
  assert.match(html, /data-node-id="1:2"/, "元素带上 Figma 节点 id(bind_data 的定位依据)");
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

// --- bind_data / delete_databind -------------------------------------------

test("bind_data:点击式投票绑定写入 databinds.json", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.bind_data({
    slug: "index",
    rect: { left: 10, top: 20, width: 300, height: 120 },
    collection: "votes",
    kind: "bar",
    read: { groupBy: "choice", limit: 10 },
    write: { target: "1:2", field: "choice", value: "A" },
    fallback: { buckets: [{ key: "A", count: 0 }], total: 0 },
  });
  assert.ok(r.id, JSON.stringify(r));
  assert.equal(r.mode, "点击节点 1:2 提交");
  const stored = JSON.parse(readFileSync(join(dir, "databinds.json"), "utf8"));
  assert.equal(stored.items.length, 1);
  const item = stored.items[0];
  assert.equal(item.collection, "votes");
  assert.equal(item.kind, "bar");
  assert.deepEqual(item.rect, { left: 10, top: 20, width: 300, height: 120 });
  assert.equal(item.write.target, "1:2");
  assert.equal(item.write.value, "A");
});

test("bind_data:输入式词云采集(自动生成输入框)", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.bind_data({
    slug: "index",
    rect: { left: 0, top: 0, width: 400, height: 300 },
    collection: "words",
    kind: "wordcloud",
    read: { groupBy: "text", limit: 40 },
    write: { input: true, field: "text", placeholder: "写一个词" },
  });
  assert.equal(r.mode, "访客输入后提交");
  const item = JSON.parse(readFileSync(join(dir, "databinds.json"), "utf8")).items[0];
  assert.equal(item.write.input, true);
  assert.equal(item.write.maxLength, 40, "默认长度上限");
  assert.equal(item.write.button, "提交");
});

test("bind_data 的写入式绑定会更新同 id 的旧条目", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const base = { slug: "index", rect: { left: 0, top: 0, width: 100, height: 50 }, collection: "votes", kind: "bar", read: { groupBy: "choice" } };
  const a = await handlers.bind_data({ ...base, write: { target: "1:2", field: "choice", value: "A" } });
  const b = await handlers.bind_data({ ...base, id: a.id, write: { target: "1:2", field: "choice", value: "B" } });
  assert.ok(b.id, JSON.stringify(b));
  assert.equal(b.id, a.id);
  const items = JSON.parse(readFileSync(join(dir, "databinds.json"), "utf8")).items;
  assert.equal(items.length, 1, "同 id 应覆盖而不是追加");
  assert.equal(items[0].write.value, "B");
});

test("bind_data 拒绝非法输入", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const rect = { left: 0, top: 0, width: 100, height: 50 };
  const cases = [
    [{ slug: "nope", rect, collection: "votes", kind: "bar", read: { groupBy: "choice" } }, /没有这个页面/],
    [{ slug: "index", rect, collection: "Bad Name", kind: "bar", read: { groupBy: "choice" } }, /collection/],
    [{ slug: "index", rect, collection: "votes", kind: "pie", read: { groupBy: "choice" } }, /kind/],
    [{ slug: "index", rect: { left: 0, top: 0, width: 100 }, collection: "votes", kind: "bar" }, /rect/],
    [{ slug: "index", rect, collection: "votes", kind: "bar" }, /groupBy/],
    [{ slug: "index", rect, collection: "votes", kind: "bar", read: { groupBy: "choice" }, write: { field: "choice" } }, /target.*input|input/],
    [{ slug: "index", rect, collection: "votes", kind: "bar", read: { groupBy: "choice" }, write: { target: "9:9", field: "choice" } }, /没有节点/],
    [{ slug: "index", rect, collection: "votes", kind: "bar", read: { groupBy: "choice" }, write: { target: "1:2", field: "bad field" } }, /write\.field/],
  ];
  for (const [args, re] of cases) {
    const r = await handlers.bind_data(args);
    assert.ok(r.error, `应报错: ${JSON.stringify(args).slice(0, 80)}`);
    assert.match(r.error, re);
  }
  // 一条都不该落盘
  assert.equal(existsSync(join(dir, "databinds.json")), false);
});

test("bind_data 横向夹进画布、纵向允许低于画布(与词云同规则)", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.bind_data({
    slug: "index",
    rect: { left: 9999, top: 800, width: 400, height: 200 },
    collection: "words",
    kind: "counter",
  });
  const item = JSON.parse(readFileSync(join(dir, "databinds.json"), "utf8")).items[0];
  assert.ok(item.rect.left + item.rect.width <= 500, "不超出画布宽度");
  assert.equal(item.rect.top, 800, "纵向不被夹取:可以放在内容下方");
  assert.ok(r.id);
});

test("bind_data 被拒绝时不落盘", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: async () => false });
  const r = await handlers.bind_data({ slug: "index", rect: { left: 0, top: 0, width: 10, height: 10 }, collection: "votes", kind: "counter" });
  assert.match(r.error, /拒绝/);
  assert.equal(existsSync(join(dir, "databinds.json")), false);
});

test("delete_databind 删除条目", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const a = await handlers.bind_data({ slug: "index", rect: { left: 0, top: 0, width: 10, height: 10 }, collection: "votes", kind: "counter" });
  const d = await handlers.delete_databind({ id: a.id });
  assert.equal(d.id, a.id);
  assert.equal(JSON.parse(readFileSync(join(dir, "databinds.json"), "utf8")).items.length, 0);
  assert.ok((await handlers.delete_databind({ id: "nope" })).error);
});

test("databinds.json 在 write_file 的禁写名单里", async () => {
  const dir = fixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.write_file({ path: "databinds.json", content: "{}" });
  assert.ok(r.error, "必须拒绝直接改写 databinds.json");
});

// --- 图片理解(view_image / list_images) --------------------------------------
// DeepSeek 的图像理解:只接受 JPEG/PNG/GIF/WebP,且**图片只能出现在 user 消息里**
// (system/assistant 带图 400;工具结果是 role:"tool",同样不能带)。所以图片必须
// 由 runAgent 补一条 user 消息送达 —— 这组测试就是钉住这一点。

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function imageFixture() {
  const dir = mkdtempSync(join(tmpdir(), "rep-img-"));
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
  writeFileSync(
    join(dir, "data", "index.json"),
    JSON.stringify({
      roots: ["1:1"],
      nodeById: {
        "1:1": { id: "1:1", type: "FRAME", name: "Canvas", absoluteBoundingBox: { x: 0, y: 0, width: 800, height: 600 }, children: ["1:2", "1:3"] },
        // 一张位图(可被模型理解)
        "1:2": {
          id: "1:2",
          type: "RECTANGLE",
          name: "世界地图",
          absoluteBoundingBox: { x: 10, y: 10, width: 400, height: 300 },
          fills: [{ type: "IMAGE", visible: true, imageRef: "deadbeef" }],
        },
        // 一个矢量图标(不能"看图",只能读源码)
        "1:3": { id: "1:3", type: "SVG", name: "icon", hash: "cafe0001", absoluteBoundingBox: { x: 10, y: 400, width: 24, height: 24 } },
      },
    }),
  );
  writeFileSync(join(dir, "assets", "deadbeef.png"), Buffer.from(PNG_1x1, "base64"));
  writeFileSync(join(dir, "assets", "cafe0001.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"></svg>');
  return dir;
}

test("sniffImageMime 按文件内容判格式(不看扩展名)", () => {
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), "image/jpeg");
  assert.equal(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), "image/png");
  assert.equal(sniffImageMime(Buffer.from(`GIF89a${"0".repeat(6)}`)), "image/gif");
  assert.equal(sniffImageMime(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])), "image/webp");
  assert.equal(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null, "SVG 不是模型支持的图片");
  assert.equal(sniffImageMime(Buffer.alloc(4)), null, "太短");
});

test("list_images 列出图片节点,并标出能否被模型读取", async () => {
  const dir = imageFixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  const r = await handlers.list_images({ slug: "index" });
  assert.equal(r.count, 2);
  const map = Object.fromEntries(r.images.map((i) => [i.nodeId, i]));
  assert.equal(map["1:2"].name, "世界地图");
  assert.equal(map["1:2"].readable, true, "PNG 应可读");
  assert.equal(map["1:2"].w, 400);
  assert.equal(map["1:3"].readable, false, "SVG 不能被模型看图");
  assert.ok((await handlers.list_images({ slug: "nope" })).error);
});

test("view_image 把图放进待发队列,而不是塞进工具返回值", async () => {
  const dir = imageFixture();
  const tools = makeTools({ outDir: dir, confirm: allowAll });
  const r = await tools.handlers.view_image({ slug: "index", nodeId: "1:2" });
  assert.equal(r.queued, true);
  assert.equal(r.mime, "image/png");
  assert.equal(JSON.stringify(r).includes("base64"), false, "工具返回值里不能带图片数据");

  const imgs = tools.takePendingImages();
  assert.equal(imgs.length, 1);
  assert.match(imgs[0].dataUrl, /^data:image\/png;base64,/);
  assert.equal(imgs[0].detail, "auto", "默认 detail=auto");
  assert.deepEqual(tools.takePendingImages(), [], "取走即清空,避免重复发送");
});

test("view_image 支持 path、detail,并拒绝非法输入", async () => {
  const dir = imageFixture();
  const { handlers } = makeTools({ outDir: dir, confirm: allowAll });
  assert.equal((await handlers.view_image({ path: "assets/deadbeef.png", detail: "low" })).detail, "low");
  assert.ok((await handlers.view_image({ slug: "index", nodeId: "1:3" })).error, "SVG 节点应被拒绝");
  assert.ok((await handlers.view_image({ slug: "index", nodeId: "nope" })).error);
  assert.ok((await handlers.view_image({ slug: "nope", nodeId: "1:2" })).error);
  assert.ok((await handlers.view_image({ path: "assets/missing.png" })).error);
  assert.ok((await handlers.view_image({})).error, "必须给出 path 或 slug+nodeId");
  assert.ok((await handlers.view_image({ path: "../outside.png" })).error, "路径逃逸要被挡住");
});

test("runAgent 把 view_image 的图片作为 user 消息发给模型", async () => {
  const dir = imageFixture();
  const tools = makeTools({ outDir: dir, confirm: allowAll });
  const seen = [];
  const model = async (messages) => {
    seen.push(JSON.parse(JSON.stringify(messages)));
    if (seen.length === 1) {
      return { content: "", toolCalls: [{ id: "c1", name: "view_image", arguments: { slug: "index", nodeId: "1:2" } }] };
    }
    return { content: "我看到一张世界地图", toolCalls: [] };
  };
  const res = await runAgent({ messages: [{ role: "user", content: "看看这张图" }], model, tools, config: {}, maxTurns: 3 });
  assert.equal(res.text, "我看到一张世界地图");
  assert.equal(seen.length, 2, "第一轮请求工具,第二轮带图再问");

  const second = seen[1];
  const imgMsg = second.find((m) => m.role === "user" && Array.isArray(m.content));
  assert.ok(imgMsg, "必须补一条带图片的 user 消息");
  const block = imgMsg.content.find((b) => b.type === "image_url");
  assert.ok(block, "user 消息里要有 image_url 块");
  assert.match(block.image_url.url, /^data:image\/png;base64,/);

  // 关键约束:图片只能出现在 user 消息里,别处带上会被 API 400
  for (const m of second) {
    if (m.role === "user") continue;
    assert.equal(String(m.content ?? "").includes("image_url"), false, `${m.role} 消息不能带图片`);
  }
  // 工具结果本身必须是纯文本
  const toolMsg = second.find((m) => m.role === "tool");
  assert.ok(toolMsg && typeof toolMsg.content === "string", "工具结果必须是字符串");
});

test("runAgent 在 view_image 失败时不追加图片消息", async () => {
  const dir = imageFixture();
  const tools = makeTools({ outDir: dir, confirm: allowAll });
  const seen = [];
  const model = async (messages) => {
    seen.push(JSON.parse(JSON.stringify(messages)));
    if (seen.length === 1) {
      return { content: "", toolCalls: [{ id: "c1", name: "view_image", arguments: { slug: "index", nodeId: "1:3" } }] };
    }
    return { content: "好的", toolCalls: [] };
  };
  await runAgent({ messages: [{ role: "user", content: "看图" }], model, tools, config: {}, maxTurns: 3 });
  assert.equal(seen[1].some((m) => Array.isArray(m.content) && JSON.stringify(m.content).includes("image_url")), false);
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
  assert.ok((await handlers.edit_node({ slug: "index", nodeId: "99:99", style: { color: "#000" } })).error);
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

// --- 超时:首字节与空闲分开 ---------------------------------------------------
// 起因:用户反馈"每次任务没完成就报取消或者超时"。两个根因:
//   1) 一个 120 秒计时器同时管着"等模型开口"和"流卡住" —— 长 prompt(系统提示词 +
//      工具结果)下首次响应本来就慢,正常的长思考被当成超时杀掉;
//   2) 只吐 reasoning_content 的块解析出零个事件,空闲计时器不会被重置。
// 另外"已取消"和"超时"原来共用一句文案,用户分不清发生了什么。

// 假流必须模拟「被 abort 时 body 报错结束」:真实的 fetch 被 abort 后 body 会
// 报错,for await 随之抛出;假流若不这样,读取会永远挂着,测试直接卡死。
function stubStream(setup) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    let ctrl;
    const stream = new ReadableStream({ start(c) { ctrl = c; setup(c); } });
    if (opts?.signal) {
      // 真实 fetch 被 abort 时 body 抛的是 AbortError(name === "AbortError"),
      // 不是普通 Error —— 假流必须一致,否则测到的是另一种分支。
      const onAbort = () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        try { ctrl.error(err); } catch {}
      };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort);
    }
    return { ok: true, body: stream, text: async () => "" };
  };
  return () => { globalThis.fetch = orig; };
}

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const enc = new TextEncoder();

test("超时:流开始后长时间无输出 → 报'输出中断',而不是笼统的'取消或超时'", async () => {
  // 先正常给一个 chunk,然后挂住不动
  const restore = stubStream((c) => c.enqueue(enc.encode(sse({ choices: [{ delta: { content: "a" } }] }))));
  try {
    const model = createDeepSeekModel({ baseUrl: "https://x", model: "m", apiKey: "k", firstByteTimeoutMs: 5000, idleTimeoutMs: 120 });
    await assert.rejects(
      () => model([{ role: "user", content: "hi" }], [], null, null),
      (e) => {
        assert.match(e.message, /输出中断/, `实际: ${e.message}`);
        assert.equal(/已取消或超时/.test(e.message), false, "不该再是笼统文案");
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("超时:首字节预算比空闲预算宽松(长 prompt 首次响应慢是正常的)", async () => {
  // 首字节等 200ms,空闲只有 120ms:首字节预算 5000ms 下应当成功
  const restore = stubStream((c) => {
    setTimeout(() => {
      c.enqueue(enc.encode(sse({ choices: [{ delta: { content: "ok" } }] })));
      c.enqueue(enc.encode(sse({ choices: [{ delta: {}, finish_reason: "stop" }] })));
      c.close();
    }, 200);
  });
  try {
    const model = createDeepSeekModel({ baseUrl: "https://x", model: "m", apiKey: "k", firstByteTimeoutMs: 5000, idleTimeoutMs: 120 });
    const res = await model([{ role: "user", content: "hi" }], [], null, null);
    assert.equal(res.content, "ok", "首字节慢不该被空闲预算杀掉");
  } finally {
    restore();
  }
});

test("超时:首字节预算用尽时报'等待模型响应',并带上已等待时间", async () => {
  const restore = stubStream(() => { /* 什么都不发,一直挂着 */ });
  try {
    const model = createDeepSeekModel({ baseUrl: "https://x", model: "m", apiKey: "k", firstByteTimeoutMs: 150, idleTimeoutMs: 5000 });
    await assert.rejects(
      () => model([{ role: "user", content: "hi" }], [], null, null),
      (e) => {
        assert.match(e.message, /等待模型响应/, `实际: ${e.message}`);
        assert.match(e.message, /已等待 \d+ 秒/, "要告诉用户等了多久");
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("超时:用户主动取消 → 明确报'已取消',不是超时", async () => {
  const restore = stubStream(() => { /* 挂着 */ });
  try {
    const ac = new AbortController();
    const model = createDeepSeekModel({ baseUrl: "https://x", model: "m", apiKey: "k", firstByteTimeoutMs: 10000, idleTimeoutMs: 10000 });
    setTimeout(() => ac.abort(), 80);
    await assert.rejects(
      () => model([{ role: "user", content: "hi" }], [], ac.signal, null),
      (e) => {
        assert.equal(e.message, "已取消", `实际: ${e.message}`);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("超时:reasoning 事件会重置空闲计时器(长思考不再被误杀)", async () => {
  // 每 60ms 来一个 reasoning 块,持续 300ms;空闲预算只有 150ms。
  // 若 reasoning 不重置计时器,这里必然超时 —— 这正是用户遇到的"任务没完成就报超时"。
  const restore = stubStream(async (c) => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 60));
      c.enqueue(enc.encode(sse({ choices: [{ delta: { reasoning_content: "think" } }] })));
    }
    c.enqueue(enc.encode(sse({ choices: [{ delta: { content: "done" } }] })));
    c.enqueue(enc.encode(sse({ choices: [{ delta: {}, finish_reason: "stop" }] })));
    c.close();
  });
  try {
    const seen = [];
    const model = createDeepSeekModel({ baseUrl: "https://x", model: "m", apiKey: "k", firstByteTimeoutMs: 5000, idleTimeoutMs: 150 });
    const res = await model([{ role: "user", content: "hi" }], [], null, (e) => seen.push(e));
    assert.equal(res.content, "done");
    assert.ok(seen.some((e) => e.type === "reasoning"), "思考事件要转发给界面");
  } finally {
    restore();
  }
});
