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
import { layoutRuntime } from "./wordcloud.mjs";

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
export const clientRuntime = `(function () {
"use strict";
var API = window.__DATA_API__;
if (!API) { return; }

${SLUG_SOURCE}

var Site = slugify(location.hostname);
if (!Site) { return; }             /* file:// 预览:保留 fallback,不发请求 */

${layoutRuntime}

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
var LS = "__dc_" + Site, client = null;
try { client = localStorage.getItem(LS); } catch (e) { client = null; }
if (!client) {
  client = newClientId();
  try { localStorage.setItem(LS, client); } catch (e) {}
}

/* ---------- HTTP ---------- */
function api(path, opts) {
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

function note(root, text, cls) {
  var n = root.querySelector(".db-note");
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

  function paint(data) {
    if (!data) { return; }
    if (spec.kind === "bar" && data.buckets) { renderBar(root, spec, data.buckets, data.total || 0); }
    else if (spec.kind === "counter") { renderCounter(root, spec, data.total || 0); }
    else if (spec.kind === "list" && data.items) { renderList(root, spec, data.items); }
    else if (spec.kind === "wordcloud" && data.buckets) { renderWordcloud(root, spec, data.buckets); }
  }

  function refresh() {
    var q;
    if (spec.kind === "list") { q = "?limit=" + (read.limit || 20); }
    else if (spec.kind === "counter") { q = "?field=" + encodeURIComponent(read.groupBy || "id") + "&limit=1"; }
    else { q = "/stats?field=" + encodeURIComponent(read.groupBy || "value") + "&limit=" + (read.limit || 10); }
    var url = spec.kind === "list" ? path + q : path + q;
    return api(url).then(function (d) {
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
    note(root, (spec.options && spec.options.done) || "已提交", "db-ok");
    refresh();
  }

  function submit(el, value) {
    if (busy || submitted) { return; }
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

  // 点击式写入:绑到某个 Figma 节点(例如一个按钮)
  if (write && write.target) {
    var target = document.querySelector('[data-node-id="' + write.target + '"]');
    if (target) {
      target.style.cursor = "pointer";
      target.addEventListener("click", function () { submit(target); });
    }
  }

  // 启动:先问"我提交过吗",再决定是否要求提交
  var boot = write && write.client !== false
    ? api(path + "/mine?client=" + encodeURIComponent(client))
        .then(function (d) {
          if (d.items && d.items.length) {
            submitted = true;
            note(root, (spec.options && spec.options.done) || "你已提交", "db-ok");
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
})();`;

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
