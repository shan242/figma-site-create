// databind.mjs — 数据绑定:把页面上的元素接到数据后端。
//
// 结构与 wordcloud.mjs 对齐,同样分两半:
//   - databindInjection()  纯 Node:把一条绑定渲染成 HTML(带 data-spec)
//   - clientRuntime        浏览器运行时:读 spec、拉数据、渲染、写回
//   build.mjs 每页注入一次运行时,每条绑定只是一个带 spec 的 div。
//
// 三条硬约束:
//   1. 运行时里**不能出现反引号或 ${** —— 它被内联进 <script>(与 cloudInjection 同理)
//   2. slugify 必须与 data-api/slug.mjs、软件端逐字符一致(databind.test.mjs 钉住)
//   3. 后端不可用时必须保留 fallback 静态内容,绝不白屏
import { layoutRuntime, clientScript } from "./wordcloud.mjs";

// 注入到 <script> 里的源码会**一字不差地发给每个访客**,所以注释必须剥掉:
// 它们既占体积(实测一次泄漏 756 个中文字符、运行时从 ~9KB 涨到 16KB),
// 又会把内部说明暴露在 view-source 里(还是中文,出现在英文站点的源码中)。
// 只剥**整行** `//` 注释和 `/* */` 块 —— 行尾的 `//` 不动,因为正则/除法里的
// `//` 需要完整的词法状态机才能区分,为几句注释不值得冒改坏代码的风险。
export function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

// 与 data-api/slug.mjs 的同名函数保持一致(databind.test.mjs 逐样本比对)。
export const slugRuntimeSource = `function slugify(host) {
  return String(host || "")
    .toLowerCase()
    .replace(/^www\\./, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}`;
const SLUG_SOURCE = slugRuntimeSource;

// --- 浏览器运行时 ------------------------------------------------------------
// 每页只注入一次。扫描 .databind,读 data-spec,渲染并接线。
export const clientRuntime = stripComments(`(function () {
"use strict";
var API = window.__DATA_API__;

${SLUG_SOURCE}

// 能不能联网,而不是"能不能渲染"。两件事必须分开:
//   · 没有 API(构建时没配数据后端)→ 不联网;
//   · 没有 Site(用 file:// 直接打开本地文件时 location.hostname 是空的)
//     → 不知道往哪个命名空间写,也不联网。
// **但两种情况都要把 fallback 画出来。** 旧代码在这里直接 return,结果
// file:// 预览时连 fallback 都没有 —— 页面上那块是空的,用户看到的就是
// "词云不能用"(实测:coco figma2 的 .databind 容器存在、db-body 全空,
// 变量都还在但一个字都没画)。优雅降级的要求是"绝不白屏",不是"绝不联网"。
var Site = slugify(location.hostname);
var ONLINE = !!(API && Site);

${layoutRuntime}

// 真正的画布渲染器(window.renderWordCloud)。**必须内联** ——
// layoutRuntime 只算出 layout,renderWordcloud() 靠 window.renderWordCloud 落笔。
// 这里漏掉它,canvas 就永远停在 300x150 的默认尺寸、一个字都不画,
// 而代码看起来一切正常(实测:coco figma2 的词云宿主在、canvas 在、就是空的)。
${clientScript}

/* ---------- 匿名访客标识(按站点隔离,localStorage) ---------- */
function newClientId() {
  try {
    if (window.crypto && crypto.randomUUID) { return crypto.randomUUID(); }
    if (window.crypto && crypto.getRandomValues) {
      var a = new Uint8Array(16); crypto.getRandomValues(a);
      var s = "";
      for (var i = 0; i < 16; i++) { s += ("0" + a[i].toString(16)).slice(-2); }
      return s;
    }
  } catch (e) {}
  return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}
var LS = "__dc_" + (Site || "local"), client = null;
try { client = localStorage.getItem(LS); } catch (e) { client = null; }
if (!client) {
  client = newClientId();
  try { localStorage.setItem(LS, client); } catch (e) {}
}

/* ---------- 本地模拟 ----------
   用 file:// 打开(或没配后端)时,不联网,改用 localStorage 当后端:
   同样的路径、同样的读写语义,所以上面所有渲染/提交代码一行都不用改。
   这样**本地能完整走一遍词云/投票/留言**,发布到域名后自动切到真后端 ——
   同一份产物、同一个 path,判断只看 location.protocol,构建时不需要任何开关。
   数据存在 __dl__<path> 下,清掉 localStorage 就等于重置模拟数据。 */
var LOCAL = !ONLINE;
function localKey(path) { return "__dl__" + path; }
function localLoad(path) {
  try { var raw = localStorage.getItem(localKey(path)); return raw ? JSON.parse(raw) : []; }
  catch (e) { return []; }
}
function localSave(path, rows) {
  try { localStorage.setItem(localKey(path), JSON.stringify(rows)); } catch (e) {}
}
function localApi(path, opts) {
  var method = (opts && opts.method) || "GET";
  try {
    if (method === "POST") {
      var rows = localLoad(path);
      var d = (opts.body && opts.body.data) || {};
      d.__client = (opts.body && opts.body.client) || "local";
      d.__at = Date.now();
      rows.push(d);
      localSave(path, rows);
      return Promise.resolve({ ok: true });
    }
    if (path.indexOf("/mine") >= 0) {
      var m = /client=([^&]+)/.exec(path);
      var want = m ? decodeURIComponent(m[1]) : "";
      var mine = localLoad(path.split("/mine")[0]).filter(function (r) { return r.__client === want; });
      return Promise.resolve({ ok: true, items: mine.map(function (r) { return { data: r }; }) });
    }
    if (path.indexOf("/stats") >= 0) {
      var base = path.split("/stats")[0];
      var fld = /field=([^&]+)/.exec(path);
      var field = fld ? decodeURIComponent(fld[1]) : "value";
      var lim = /limit=(\d+)/.exec(path);
      var limit = lim ? Number(lim[1]) : 10;
      var counts = {};
      var all = localLoad(base);
      for (var i = 0; i < all.length; i++) {
        var k = String(all[i][field] === undefined || all[i][field] === null ? "" : all[i][field]);
        if (!k) { continue; }
        counts[k] = (counts[k] || 0) + 1;
      }
      var buckets = Object.keys(counts).map(function (k) { return { key: k, count: counts[k] }; })
        .sort(function (a, b) { return b.count - a.count; }).slice(0, limit);
      return Promise.resolve({ ok: true, field: field, total: all.length, buckets: buckets });
    }
    // 计数:任何字段的条数
    var f2 = /field=([^&]+)/.exec(path);
    var rows2 = localLoad(path.split("?")[0]);
    return Promise.resolve({ ok: true, total: rows2.length, field: f2 ? decodeURIComponent(f2[1]) : "id" });
  } catch (e) {
    return Promise.reject(new Error("本地模拟失败:" + e.message));
  }
}

/* ---------- 请求去重 ----------
   同一页可能有几十条绑定指向**同一个 collection**(实测 kulangsu.site:25 条 databind
   全绑 voices),每条都自己发一次 /mine,页面一加载就是 25 个请求 —— 用户会看到
   刷屏而且可能触发限速。这里按 URL 共享:
     · 正在飞的请求 → 复用同一个 Promise(并发合并);
     · 已完成的结果 → 在 TTL 内直接复用(避免轮询时重复打)。
   写操作(POST)不合并 —— 每次点击都必须真的发出去。 */
var INFLIGHT = {}, CACHE = {}, TTL = 4000;
function apiShared(path, opts) {
  var method = (opts && opts.method) || "GET";
  if (method !== "GET") { return api(path, opts); }
  var now = Date.now();
  if (CACHE[path] && now - CACHE[path].at < TTL) { return Promise.resolve(CACHE[path].v); }
  if (INFLIGHT[path]) { return INFLIGHT[path]; }
  var p = api(path, opts).then(function (v) {
    CACHE[path] = { at: Date.now(), v: v };
    delete INFLIGHT[path];
    return v;
  }, function (e) {
    delete INFLIGHT[path];
    throw e;
  });
  INFLIGHT[path] = p;
  return p;
}

/* ---------- HTTP ---------- */
function api(path, opts) {
  if (LOCAL) { return localApi(path, opts); }
  var init = { method: (opts && opts.method) || "GET", headers: {} };
  if (opts && opts.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  return fetch(API + path, init).then(function (r) {
    return r.json().catch(function () { return null; }).then(function (data) {
      if (!r.ok || !data || data.ok === false) {
        var m = (data && data.error && data.error.message) || ("请求失败(" + r.status + ")");
        var err = new Error(m);
        err.code = data && data.error && data.error.code;
        throw err;
      }
      return data;
    });
  });
}

function esc(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ---------- 渲染 ---------- */
function body(root) { return root.querySelector(".db-body"); }

function renderBar(root, spec, buckets, total) {
  var max = 1;
  for (var i = 0; i < buckets.length; i++) { if (buckets[i].count > max) { max = buckets[i].count; } }
  var html = "";
  for (var j = 0; j < buckets.length; j++) {
    var b = buckets[j];
    var pct = max ? Math.round((b.count / max) * 100) : 0;
    var share = total ? Math.round((b.count / total) * 100) : 0;
    html += '<div class="db-row"><div class="db-label">' + esc(b.key === null ? "(未选)" : b.key) + "</div>" +
      '<div class="db-track"><div class="db-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="db-count">' + b.count + (spec.options && spec.options.showShare ? " (" + share + "%)" : "") + "</div></div>";
  }
  if (!html) { html = '<div class="db-empty">' + esc((spec.options && spec.options.empty) || "暂无数据") + "</div>"; }
  body(root).innerHTML = html;
}

function renderCounter(root, spec, total) {
  body(root).innerHTML = '<div class="db-num">' + total + '<span class="db-unit">' + esc((spec.options && spec.options.unit) || "") + "</span></div>";
}

function renderList(root, spec, items) {
  var html = "";
  for (var i = 0; i < items.length; i++) {
    var d = items[i].data || {};
    var parts = [];
    for (var k in d) { if (Object.prototype.hasOwnProperty.call(d, k)) { parts.push(esc(d[k])); } }
    html += '<div class="db-item">' + parts.join(" · ") + "</div>";
  }
  if (!html) { html = '<div class="db-empty">' + esc((spec.options && spec.options.empty) || "暂无内容") + "</div>"; }
  body(root).innerHTML = html;
}

var CLOUDS = [];
function renderWordcloud(root, spec, buckets) {
  // **没有数据时画 fallback,不要画空的。**
  // 这是"词云不显示"的真正原因:boot 时先按 spec.fallback 画好了(全部选项
  // 按最小字号铺开,让访客看得到可以点什么),紧接着 refresh() 拿到空数组,
  // 又把一个**空布局**画上去 —— canvas 被清空,页面上就是一块空白。
  // 线上同理:还没有人投票时,词云是空的而不是"待投票的选项"。
  if ((!buckets || !buckets.length) && spec.fallback && spec.fallback.buckets && spec.fallback.buckets.length) {
    buckets = spec.fallback.buckets;
  } else if (buckets && buckets.length && spec.fallback && spec.fallback.buckets && spec.fallback.buckets.length) {
    // **把票数和选项表合并。**
    // 后端 /stats 只返回**有票的**桶,于是投了 3 项就只画 3 个词 —— 而问卷要的是
    // "看到各个选项的统计":没被投过的选项也应该在,只是停在最小字号、最浅的颜色。
    // 以 fallback 的选项表为准,把实时票数贴上去,谁多谁大、谁多谁深由渲染器排序决定。
    var counts = {};
    for (var b = 0; b < buckets.length; b++) { counts[String(buckets[b].key)] = buckets[b].count; }
    var merged = [];
    for (var f = 0; f < spec.fallback.buckets.length; f++) {
      var k = String(spec.fallback.buckets[f].key);
      merged.push({ key: k, count: counts[k] !== undefined ? counts[k] : 0 });
    }
    for (var c in counts) {
      var known = false;
      for (var m = 0; m < merged.length; m++) { if (merged[m].key === c) { known = true; break; } }
      if (!known) merged.push({ key: c, count: counts[c] });
    }
    buckets = merged;
  }
  var words = [];
  for (var i = 0; i < buckets.length; i++) { words.push({ text: String(buckets[i].key === null ? "" : buckets[i].key), weight: buckets[i].count }); }
  var holder = body(root);
  var canvas = holder.querySelector("canvas");
  if (!canvas) {
    holder.innerHTML = "<canvas></canvas>";
    canvas = holder.querySelector("canvas");
  }
  var rect = holder.getBoundingClientRect();
  var layout = layoutWordCloud(words, {
    width: Math.max(1, Math.round(spec.rect.width)),
    height: Math.max(1, Math.round(spec.rect.height)),
    colors: spec.options && spec.options.colors,
    maxFont: spec.options && spec.options.maxFont,
    minFont: spec.options && spec.options.minFont,
    maxWords: spec.options && spec.options.maxWords,
    fontFamily: spec.options && spec.options.fontFamily
  });
  if (window.renderWordCloud) { window.renderWordCloud(canvas, layout); }
}

// "已提交"那行提示的文案。返回 null = **一句话都不显示**。
// options.done 显式给空串就是"不要提示" —— 旧写法 done || "你已提交" 里空串是
// falsy,想关掉的人反而会拿到默认文案(用户报的"已提交字样删不掉"就是这个)。
function doneText(spec) {
  var d = spec.options && spec.options.done;
  if (d === undefined) { return "你已提交"; }
  return d ? String(d) : null;
}

function note(root, text, cls) {  var n = root.querySelector(".db-note");
  if (!n) { n = document.createElement("div"); n.className = "db-note"; root.appendChild(n); }
  n.textContent = text || "";
  n.className = "db-note" + (cls ? " " + cls : "");
}

/* ---------- 一条绑定 ---------- */
function initOne(root) {
  var spec;
  try { spec = JSON.parse(root.getAttribute("data-spec")); } catch (e) { return; }
  if (!spec || !spec.collection) { return; }

  var path = "/" + encodeURIComponent(Site) + "/" + encodeURIComponent(spec.collection);
  var read = spec.read || {};
  var write = spec.write || null;
  var submitted = false, busy = false, timer = null;

  // 1) 先画 fallback —— 首屏立刻有内容,后端挂了也不白屏
  paint((spec.fallback && spec.fallback.data) || spec.fallback || null);

  // 本地(file://)时 ONLINE 是 false,但**不退出** —— api() 会走 localApi(),
  // 用 localStorage 当后端,读写语义完全一样,所以本地能走一遍完整流程
  // (投票 → 词云长大 → 留言),发布后同一份产物自动切到真后端。
  // 只标一个类供样式区分,不再写"本地预览"之类的话 —— 本地和线上应当长得一样。
  // 本地(file://)时 ONLINE 是 false,但**不退出** —— api() 会走 localApi(),
  // 用 localStorage 当后端,读写语义完全一样,所以本地能走一遍完整流程
  // (投票 → 词云长大 → 留言),发布后同一份产物自动切到真后端。
  //
  // ⚠️ **不要在页面上加"本地预览"之类的标记。** 用户明确要求过删掉这类字样:
  // 本地和线上应当长得一模一样,否则每次预览都在看一个线上不存在的页面。
  // 需要让人知道"这是模拟数据"时,写到控制台 —— 开发者看得到,访客看不到。
  if (LOCAL) {
    root.classList.add("db-local");
    if (window.console && console.info && !window.__dbLocalNotice) {
      window.__dbLocalNotice = true;
      console.info("[replica] 本地模拟数据(localStorage);发布后自动改用后端。");
    }
  }

  function paint(data) {
    if (!data) { return; }
    if (spec.kind === "bar" && data.buckets) { renderBar(root, spec, data.buckets, data.total || 0); }
    else if (spec.kind === "counter") { renderCounter(root, spec, data.total || 0); }
    else if (spec.kind === "list" && data.items) { renderList(root, spec, data.items); }
    else if (spec.kind === "wordcloud" && data.buckets) { renderWordcloud(root, spec, data.buckets); }
  }

  function refresh() {
    // action 只负责把点击接到后端,不读也不画 —— 不必去轮询
    if (spec.kind === "action") { return Promise.resolve(); }
    var q;
    if (spec.kind === "list") { q = "?limit=" + (read.limit || 20); }
    else if (spec.kind === "counter") { q = "?field=" + encodeURIComponent(read.groupBy || "id") + "&limit=1"; }
    else { q = "/stats?field=" + encodeURIComponent(read.groupBy || "value") + "&limit=" + (read.limit || 10); }
    var url = spec.kind === "list" ? path + q : path + q;
    // apiShared:25 条绑定指向同一个 collection 时,轮询也只真的打一次
    return apiShared(url).then(function (d) {
      if (spec.kind === "list") { paint({ items: d.items }); }
      else if (spec.kind === "counter") { renderCounter(root, spec, d.total || 0); }
      else { paint({ buckets: d.buckets, total: d.total }); }
      // 只有"还没提交"时才清空提示 —— 否则 refresh 会把刚显示的"已提交"擦掉,
      // 访客会以为自己没提交成功(初次实现就踩了这个坑)。
      if (!submitted) { note(root, ""); }
    }).catch(function (e) {
      // 保留 fallback,只在角落说明
      note(root, e.message || "", "db-err");
    });
  }

  /* --- 写入:已提交过就不再要求提交 --- */
  function payload(el) {
    var d = {}, v = write.value;
    if (v === undefined || v === null) { v = el ? (el.textContent || "").trim() : ""; }
    d[write.field] = v;
    return d;
  }

  function afterSubmit() {
    submitted = true;
    markSubmitted();
    // options.done 显式给空串 = **不要任何提示**(不只是用默认值兜底)。
    // 旧写法是 options.done || "你已提交",空串是 falsy,想关掉提示的人反而
    // 会拿到默认文案 —— 用户报的"已提交字样删不掉"就是这个。
    if (doneText(spec) !== null) { note(root, doneText(spec), "db-ok"); }
    refresh();
  }

  // 状态用属性表达,**不要靠提示文字或类名**。
  // 踩过的坑:样式里用 .db-note.db-ok 判断"已提交",一旦把提示关掉(用户要求),
  // 那个类就不再出现,依赖它的 reveal 规则永远不触发 —— 结果就是
  // "Answer the three questions above…" 提交后也不消失。
  // 现在 data-db-state="submitted" 由运行时保证设置,与要不要显示提示无关。
  function markSubmitted(instant) {
    root.setAttribute("data-db-state", "submitted");
    // **必须用 setProperty(..., "important")。**
    // 线上实测:AI 给这个词云面板写了"松手后极慢回退"的动画,过渡时长是
    // **100000s(27 小时)** —— 揭示用的透明度变化要跑 27 小时才能到 1,所以
    // 刷新后看到的是 opacity 0.0003 这种中途值,点一下 Submit 触发重绘才跳到 1。
    // 普通内联样式(style.opacity = "1")会被带 !important 的样式表规则压过去,
    // 只有带 important 的内联声明才能稳赢 —— 这也是排查时最容易漏的一点:
    // "内联样式优先级最高"只在对方没有 !important 时才成立。
    var b = root.querySelector(".db-body");
    if (b) {
      b.style.setProperty("opacity", "1", "important");
      b.style.setProperty("transform", "none", "important");
      if (instant) { b.style.setProperty("transition", "none", "important"); }
    }
    var host = root.closest(".canvas") || document;
    host.setAttribute("data-db-any-submitted", "1");
    // **把"提交后才揭示"的那些绑定也打开。**
    // 这件事原来靠 AI 写一段 CSS(用 [data-db-any-submitted] 选择器把 opacity 提到 1),实测
    // 它写的规则常常**一条都没命中**(选择器里的引号、优先级、后面的覆盖…),
    // 结果就是"提交了也不展开",而页面上又看不出哪里错。
    // 现在由运行时直接管:带 options.reveal:"submit" 的绑定在初始化时被藏起来,
    // 这里统一揭开 —— 用 important,免得被样式表里更特异的规则压回去。
    var all = host.querySelectorAll('.databind');
    for (var i = 0; i < all.length; i++) {
      var s = null;
      try { s = JSON.parse(all[i].getAttribute("data-spec") || "null"); } catch (e) { s = null; }
      if (!s || !s.options || s.options.reveal !== "submit") continue;
      var bb = all[i].querySelector(".db-body");
      if (bb) {
        bb.style.setProperty("opacity", "1", "important");
        bb.style.setProperty("transform", "none", "important");
      }
      all[i].style.setProperty("pointer-events", "auto", "important");
    }
  }

  function submit(el, value) {
    // **拒绝的时候必须说话**。旧代码是 if (busy || submitted) return; —— 静默的。
    // 每条绑定只允许投一次,再点就毫无反应,用户看到的是"点了没提交成功"
    // (实测反馈:"有些提交并没有成功提交")。现在明确说明,并且把"还没发完"
    // 和"已经投过"分开报 —— 前者是等待,后者是规则。
    if (busy) { note(root, (spec.options && spec.options.sending) || "发送中…", "db-wait"); return; }
    // 每个访客能投几次:once(默认,每项一次)/ many(可重复投)/ single(可改主意,后写覆盖前写)
    var per = (spec.options && spec.options.perVisitor) || "once";
    if (submitted && per === "once") { note(root, (spec.options && spec.options.already) || "这一项你已经投过了", "db-ok"); return; }
    busy = true;
    var body2 = { data: value !== undefined ? value : payload(el), client: client };
    api(path, { method: "POST", body: body2 })
      .then(function () { afterSubmit(); })
      .catch(function (e) { note(root, e.message || "提交失败", "db-err"); })
      .then(function () { busy = false; });
  }

  // 表单式写入:在矩形内渲染 input + 按钮(词云采集用)
  if (write && write.input) {
    var form = document.createElement("div");
    form.className = "db-form";
    form.innerHTML = '<input class="db-input" maxlength="' + (write.maxLength || 40) + '" placeholder="' + esc(write.placeholder || "") + '" />' +
      '<button class="db-btn" type="button">' + esc(write.button || "提交") + "</button>";
    root.appendChild(form);
    var input = form.querySelector(".db-input");
    var btn = form.querySelector(".db-btn");
    var go = function () {
      var v = (input.value || "").trim();
      if (!v) { return; }
      var d = {}; d[write.field] = v;
      submit(null, d);
      input.value = "";
    };
    btn.addEventListener("click", go);
    input.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { go(); } });
  }

  // 选项的"胶囊"是**另一个平级节点**,不是祖先。
  // 实测:这个页面的所有节点都平铺在 .canvas 里,选项文字的 parentElement
  // 直接就是画布 —— 所以"往上找有背景的那层"会命中画布、把整页压暗。
  // 唯一的正确做法是由数据说明是哪个节点:options.highlight = "<节点 id>"。
  function markHighlight(spec, target, on) {
    var ids = spec.options && spec.options.highlight;
    if (!ids) return;
    if (typeof ids === "string") ids = [ids];
    var list = [];
    for (var a = 0; a < ids.length; a++) { if (ids[a]) list.push(ids[a]); }
    if (!list.length) return;
    for (var i = 0; i < list.length; i++) {
      var el = document.querySelector('[data-node-id="' + list[i] + '"]');
      if (!el) continue;
      var stillOn = false;
      if (!on) {
        // 取消时:还有别的选项选着同一个胶囊就别恢复
        var sel = (window.__dbSel && window.__dbSel[spec.collection]) || [];
        for (var s = 0; s < sel.length; s++) {
          var oh = sel[s] && sel[s].highlight;
          if (!oh) continue;
          var olist = typeof oh === "string" ? [oh] : oh;
          for (var q = 0; q < olist.length; q++) { if (olist[q] === list[i]) stillOn = true; }
        }
      }
      if (on || !stillOn) {
        if (on) {
          el.setAttribute("data-db-selected", "1");
          el.style.setProperty("filter", "brightness(0.45)", "important");
        } else {
          el.removeAttribute("data-db-selected");
          el.style.removeProperty("filter");
        }
      }
    }
  }

  // 把所有选中的选项一次性提交(每个选项一条记录,后端 /stats?groupBy= 才能按词计数)
  function submitAllSelected(list) {
    if (busy) { note(root, (spec.options && spec.options.sending) || "发送中…", "db-wait"); return; }
    busy = true;
    // 每个选项一条:词云是按字段值分桶统计的,合成一条只会算成一个词
    var jobs = [];
    for (var i = 0; i < list.length; i++) {
      var pick = list[i] || {};
      // value 在选中时就存好了,不依赖此刻的 DOM 结构
      var v = pick.value !== undefined && pick.value !== null && pick.value !== ""
        ? pick.value
        : (pick.el ? (pick.el.textContent || "").trim() : "");
      if (!v) continue;
      var d = {};
      d[write.field] = v;
      jobs.push(api(path, { method: "POST", body: { data: d, client: client } }));
    }
    if (!jobs.length) { busy = false; note(root, "没有可提交的选项", "db-err"); return; }
    Promise.all(jobs)
      .then(function () { afterSubmit(); })
      .catch(function (e) { note(root, e.message || "提交失败", "db-err"); })
      .then(function () { busy = false; });
  }

  // 点击式写入:绑到某个 Figma 节点(例如一个按钮)
  if (write && write.target) {
    var target = document.querySelector('[data-node-id="' + write.target + '"]');
    if (target) {
      target.style.cursor = "pointer";
      // **保证它能被点到。** 实测最常见的"点了没反应"就是这条节点被 CSS 设了
      // pointer-events: none(有时还是它自己的容器继承来的),或者被后面渲染的透明
      // 容器盖住 —— 而写绑定的人从数据里完全看不出来。既然它是这条绑定的点击目标,
      // 就由运行时把它钉成可点,不指望样式表配合。
      target.style.setProperty("pointer-events", "auto", "important");
      target.style.setProperty("position", target.style.position || "relative", "important");
      target.style.setProperty("z-index", "3", "important");
      // **两种点击语义** —— 问卷式"先选再提交"要求它们分开:
      //  · options.defer:点一下只是**选中**(打上 data-db-selected,由 CSS 变深),
      //    **不写后端**。访客可以反复改主意。
      //  · write.submitAll:这才是"提交" —— 把**所有已选中项**一次性写进去,
      //    然后才揭示结果。
      // 早先只有"点了就写",于是没有"提交"这一步,词云在点第一个选项时就出结果了,
      // 而用户要的是**点 submit 之后才生成词云**。
      if (spec.options && spec.options.defer) {
        target.addEventListener("click", function () {
          var sel = window.__dbSel || (window.__dbSel = {});
          var list = sel[spec.collection] || (sel[spec.collection] = []);
          var i = -1;
          for (var k = 0; k < list.length; k++) { if (list[k].el === target) { i = k; break; } }
          if (i >= 0) {
            list.splice(i, 1);
            target.removeAttribute("data-db-selected");
            target.style.removeProperty("filter");
            markHighlight(spec, target, false);
          }
          else {
            // **连值一起存** —— 提交时直接用这个值。
            // 早先只存 DOM 元素、提交时读 el.textContent,而选项节点的文字往往在
            // **子节点**里,于是 textContent 可能是空串 → 提交时一个都写不出去,
            // 页面上只显示"没有可提交的选项"。存值就没有这个猜测。
            list.push({ el: target, value: write.value !== undefined && write.value !== null ? write.value : (target.textContent || "").trim(), highlight: (spec.options && spec.options.highlight) || null });
            target.setAttribute("data-db-selected", "1");
            // **只给这个节点自己加 filter,绝不往上爬。**
            // 实测踩坑:这个页面里所有节点都是**平铺在 .canvas 里**的,
            // 选项文字的 parentElement 直接就是 .canvas(1440x5800、带底色)。
            // 早先"顺着祖先找有背景的那层"于是第一层就爬到了画布,
            // 给 .canvas 加 filter: brightness → **整个页面变暗**。
            // filter 会作用到整棵子树,所以"往上找一层"在这套平铺结构里永远不安全。
            // 要变深的**另一个元素**(胶囊)必须由数据指明 —— 那是 options.highlight 的事。
            target.setAttribute("data-db-selected", "1");
            target.style.setProperty("filter", "brightness(0.45)", "important");
            markHighlight(spec, target, true);
          }
          note(root, "");
        });
      } else if (write.submitAll) {
        target.addEventListener("click", function () {
          var sel = window.__dbSel || (window.__dbSel = {});
          var list = (sel[spec.collection] || []).slice();
          if (!list.length) { note(root, (spec.options && spec.options.none) || "请先选一选上面的选项", "db-err"); return; }
          submitAllSelected(list);
        });
      } else {
        target.addEventListener("click", function () { submit(target); });
      }
    }
  }

  // **"提交后才揭示"的绑定:一开始就藏起来。**
  // 由运行时直接做,不依赖 AI 写 CSS —— 它写的揭示规则实测经常一条都不命中,
  // 于是"没提交也看得见结果"。藏起来是这里的默认,markSubmitted 会统一打开。
  var revealOnSubmit = !!(spec.options && spec.options.reveal === "submit");
  if (revealOnSubmit) {
    var rb = body(root);
    if (rb) {
      rb.style.setProperty("opacity", "0", "important");
      rb.style.setProperty("transform", "none", "important");
      rb.style.setProperty("transition", "opacity .35s ease", "important");
    }
  }

  // 启动:先问"我提交过吗",再决定是否要求提交。
  // 用 apiShared —— 同页 25 条绑定指向同一个 collection 时,这里只会真的发一次。
  var boot = write && write.client !== false
    ? apiShared(path + "/mine?client=" + encodeURIComponent(client))
        .then(function (d) {
          if (d.items && d.items.length) {
            submitted = true;
            // instant=true:这是"刷新后恢复",要立刻可见,不走过渡
            // (视口外的过渡跑不完,会停在 0.0003 那种中途值)
            markSubmitted(true);
            var t = doneText(spec);
            if (t !== null) { note(root, t, "db-ok"); }
          }
        })
        .catch(function () {})
    : Promise.resolve();

  boot.then(refresh).then(function () {
    var ms = read.refreshMs || 0;
    if (ms > 0) {
      timer = setInterval(function () {
        if (document.visibilityState === "visible") { refresh(); }
      }, ms);
    }
  });
}

function boot() {
  var nodes = document.querySelectorAll(".databind");
  for (var i = 0; i < nodes.length; i++) { initOne(nodes[i]); }
}
if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", boot); }
else { boot(); }
})();`);

// --- 注入 -------------------------------------------------------------------

const escAttr = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// 一条绑定 = 一个绝对定位的 div,spec 放在 data-spec 里由运行时消费。
// 点击式绑定(绑到已有节点)时容器不吃事件,避免挡住下面的 Figma 按钮。
export function databindInjection(item, { canvasWidth } = {}) {
  const r = item.rect;
  const left = Math.round(r.left);
  const top = Math.round(r.top);
  const w = Math.round(r.width);
  const h = Math.round(r.height);
  let leftCss = `${left}px`;
  let wCss = `${w}px`;
  if (canvasWidth != null && w >= canvasWidth) {
    leftCss = "0";
    wCss = "100%";
  } else if (canvasWidth != null && Math.abs(left + w / 2 - canvasWidth / 2) <= 1) {
    leftCss = `calc(50% - ${w / 2}px)`;
  }
  const isClick = !!(item.write && item.write.target);
  const pointer = isClick ? "pointer-events:none;" : "";
  const spec = JSON.stringify(item);
  return `  <div class="databind" data-spec="${escAttr(spec)}" style="position:absolute;left:${leftCss};top:${top}px;width:${wCss};height:${h}px;${pointer}">
    <div class="db-body"></div>
  </div>`;
}

// 每页注入一次:后端地址 + 运行时。apiBase 为空则整段不注入(功能关闭)。
export function databindHead(apiBase, { hasBindings }) {
  if (!hasBindings || !apiBase) return "";
  const safe = String(apiBase).replace(/</g, "\\u003c");
  return `  <script>window.__DATA_API__ = ${JSON.stringify(safe)};</script>
  <script>${clientRuntime}</script>`;
}
