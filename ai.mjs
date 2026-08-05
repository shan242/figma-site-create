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
- 放置词云:调用 apply_wordcloud。slug 来自 list_pages;rect 是画布坐标系内的矩形 {left,top,width,height};spec.words 是从页面文本提炼的关键词,weight 1-100(越高字越大);spec.colors 选与页面配色协调的颜色;不要超过矩形区域。
- 修改页面文本:调用 edit_text(slug, nodeId, 以及 text/fontSize/fontWeight/color 中至少一个)。nodeId 来自 read_page_text 返回的 all 列表中 type=TEXT 的节点;color 用 #RRGGBB。持久保存,重新生成后仍在。
- 修改任意节点(文本/图片/矩形)的样式:调用 edit_node(slug, nodeId, style)。style 是原始 CSS 属性对象,如 {color:'#ff0000','font-size':'24px'};nodeId 来自 read_page_text 的 all 列表。持久保存,重新生成后仍在。
- 全站全局样式:调用 append_css(css),会追加到 styles.css 末尾,作用于所有页面。
- 需要大改页面结构时,可以用 write_file 改写生成的 *.html(也可以写 data/ 下的页面数据)。改写 *.html 后,系统会在每次重新生成后把你改的内容自动套回去(记录在 file-locks.json),所以是持久的。
- 注意:对同一个页面,要么用 edit_text / edit_node / apply_wordcloud 这类覆盖层工具改,要么用 write_file 整体改写 HTML,不要混用——整体改写会把该页覆盖层的改动盖掉。append_css 与 write_file 改 styles.css 同理。
- 不要改写 manifest.json、wordclouds.json、edits.json、nodeStyles.json、overrides.json、file-locks.json(它们是构建元数据或覆盖层来源,直接改会破坏一致性)。
- 修改类工具成功后,系统会自动重新生成页面,你一般无需调用 run_build;如确需立即重建可调用。
- 用中文回答;完成后的回复要简短说明改了什么。`;

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

export async function runAgent({ messages, model, tools, onEvent, config, maxTurns = 20 }) {
  const history = [{ role: "system", content: SYSTEM_PROMPT }, ...messages];
  let finalText = "";
  for (let turn = 0; turn < maxTurns; turn++) {
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
  onEvent?.({ type: "done", text: finalText, turnCount: maxTurns });
  return { text: finalText, turnCount: maxTurns };
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
  return "完成";
}

// --- Tools -------------------------------------------------------------------

// Build metadata / overlay sources the AI must not rewrite directly: touching
// them corrupts the build or bypasses the dedicated overlay tools. Everything
// else under the out dir (generated *.html, styles.css, data/**, aux files) is
// writable.
const WRITE_DENY = ["manifest.json", "wordclouds.json", "edits.json", "file-locks.json", "nodeStyles.json", "overrides.json"];

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
      // Clamp to the page canvas so a bad rect can't overlay outside it.
      const cw = cb?.width ?? rect.width;
      const ch = cb?.height ?? rect.height;
      const r = {
        left: Math.max(0, Math.min(rect.left, cw - Math.min(rect.width, cw))),
        top: Math.max(0, Math.min(rect.top, ch - Math.min(rect.height, ch))),
        width: Math.min(Math.max(1, rect.width), cw),
        height: Math.min(Math.max(1, rect.height), ch),
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
        description: "在输出目录写入/覆盖一个文件(可写生成的 *.html、styles.css、data/ 下文件;不能改 manifest.json、wordclouds.json、edits.json、file-locks.json)。改写 *.html / styles.css 会记录到 file-locks.json,重新生成后仍保留。会请求用户确认",
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
        name: "run_build",
        description: "重新生成所有静态页面(把 wordclouds.json 与 edits.json 的改动渲染进 HTML)",
        parameters: { type: "object", properties: {} },
      },
    },
  ];

  return { handlers, schemas, root };
}
