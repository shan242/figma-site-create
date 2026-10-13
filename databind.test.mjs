// databind 的单元测试。
//
// 浏览器运行时无法在 Node 里跑真实 DOM,所以这里覆盖三件最容易出错、
// 又完全可测的事:
//   1. 注入的 slugify 与后端/软件端**逐字符一致**(命名空间错一点就全错)
//   2. 注入的词云布局运行时与 layoutWordCloud() 结果**完全一致**
//   3. 注入的 HTML 转义正确(spec 里的引号/尖括号不能破坏属性或脚本)
// 真实的浏览器行为放在 databind.e2e.test.mjs(headless Chrome)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { slugRuntimeSource, clientRuntime, databindInjection, databindHead } from "./databind.mjs";
import { layoutWordCloud, layoutRuntime } from "./wordcloud.mjs";
// 后端的同名实现 —— 浏览器/后端/软件端三处必须一致。
import { slugify as serverSlugify } from "./data-api/slug.mjs";

// 直接求值**注入用的源码片段** —— 这正是浏览器里会执行的那两段。
function evalSources() {
  const fn = new Function(`${slugRuntimeSource}\n${layoutRuntime}\nreturn { slugify: slugify, layoutWordCloud: layoutWordCloud };`);
  return fn();
}

test("注入的 slugify 与后端 data-api/slug.mjs 逐样本一致", () => {
  const { slugify } = evalSources();
  const hosts = [
    "didsdi.com",
    "scopetest.net",
    "data.scopetest.net",
    "tool-steam-65311718.figma.site",
    "www.my-shop.com",
    "my-shop.com",
    "a.b.example.com",
    "WWW.Example.COM",
    "shop.example.com:8080",
    "127.0.0.1",
    "",
    "!!!",
    "x".repeat(90) + ".com",
  ];
  for (const h of hosts) {
    // 后端与浏览器两端必须完全一致 —— 命名空间错一个字符,页面就找不到自己的数据。
    assert.equal(slugify(h), serverSlugify(h), `浏览器 vs 后端 slugify(${JSON.stringify(h)})`);
  }
});

test("注入的词云布局运行时与 layoutWordCloud 结果完全一致", () => {
  const { layoutWordCloud: injected } = evalSources();
  const words = [
    { text: "效率", weight: 90 },
    { text: "体验", weight: 70 },
    { text: "hospital", weight: 55 },
    { text: "导航", weight: 40 },
    { text: "care", weight: 20 },
    { text: "...", weight: 5 }, // 纯标点应被过滤
  ];
  const opts = { width: 420, height: 260, maxFont: 44, minFont: 11 };
  assert.deepEqual(injected(words, opts), layoutWordCloud(words, opts), "实时词云与构建期词云必须同源同结果");
});

test("运行时必须内联 window.renderWordCloud,否则画布永远是空的", () => {
  // 实测事故(coco figma2):词云宿主在、canvas 在、数据结构全对,就是一个像素都不画。
  // 根因是 databind.mjs 只内联了 layoutRuntime(算布局),漏了 wordcloud.mjs 的
  // clientScript(真正落笔的 window.renderWordCloud)—— renderWordcloud() 里那句
  // `if (window.renderWordCloud)` 于是静默跳过,canvas 停在 300x150 默认尺寸。
  // 这种"什么错都不报、只是不显示"的漏注入最难查,所以钉住它。
  assert.match(clientRuntime, /window\.renderWordCloud\s*=/, "运行时里必须定义 renderWordCloud");
});

test("离线(没后端 / file:// 预览)时也要画 fallback,不能提前 return", () => {
  // 旧代码 `if (!Site) return;` 在画 fallback 之前就退出 —— file:// 下
  // location.hostname 是空的,于是整块是空的。优雅降级的要求是"绝不白屏",
  // 不是"绝不联网":联网与否只该关掉请求,不该关掉渲染。
  assert.match(clientRuntime, /var ONLINE = !!\(API && Site\)/, "用开关而不是提前 return");
  assert.equal(/if \(!Site\) \{ return; \}/.test(clientRuntime), false, "不能再提前 return");
  const paintIdx = clientRuntime.indexOf("先画 fallback");
  const gateIdx = clientRuntime.indexOf("if (!ONLINE) { return; }");
  assert.ok(paintIdx >= 0 && gateIdx >= 0, "两处都要在");
  assert.ok(paintIdx < gateIdx, "必须先画 fallback,再判断要不要联网");
});

test("词云布局:权重全为 0 也要铺出全部选项(不是空布局)", () => {
  // 实时词云的 fallback 在"还没人投票"时每个桶的 count 都是 0。正确表现是把
  // 全部选项按最小字号铺出来让访客看得到能点什么。旧条件 `.filter(w => w.weight > 0)`
  // 把它们全部丢掉 → ranked 为空 → 空布局 → 画布一个像素都不画。
  const words = ["Landmarks", "Photographs", "Architecture", "Tickets"].map((text) => ({ text, weight: 0 }));
  const layout = layoutWordCloud(words, { width: 1180, height: 440, minFont: 14, maxFont: 58 });
  assert.equal(layout.items.length, 4, "4 个词一个都不能少");
  for (const it of layout.items) {
    assert.equal(it.size, 14, "权重全 0 时一律用最小字号");
    assert.ok(Number.isFinite(it.x) && Number.isFinite(it.y), "坐标必须是有限数,不能是 NaN");
  }
});

test("词云布局:负权重仍然丢弃(只有 0 是合法的)", () => {
  const layout = layoutWordCloud([{ text: "ok", weight: 5 }, { text: "bad", weight: -1 }], { width: 400, height: 300 });
  assert.deepEqual(layout.items.map((i) => i.text), ["ok"]);
});

test("词云布局:混合权重时 0 分的词用最小字号,不是 NaN", () => {
  const layout = layoutWordCloud(
    [{ text: "hot", weight: 100 }, { text: "cold", weight: 0 }],
    { width: 600, height: 400, minFont: 12, maxFont: 48 },
  );
  const cold = layout.items.find((i) => i.text === "cold");
  assert.ok(cold, "0 分的词也要出现");
  assert.equal(cold.size, 12);
  assert.equal(layout.items.find((i) => i.text === "hot").size, 48);
});

test("运行时源码语法有效(构造 Function 不抛)", () => {
  assert.doesNotThrow(() => new Function(clientRuntime));
  assert.match(clientRuntime, /function slugify/);
  assert.match(clientRuntime, /function layoutWordCloud/);
});

test("运行时里不含会破坏内联 <script> 的序列", () => {
  // </script> 会提前闭合标签;反引号/${ 只在 databind.mjs 自己的模板里危险。
  assert.equal(/<\/script/i.test(clientRuntime), false, "运行时不得包含 </script");
});

test("databindInjection 输出带 data-spec 的绝对定位 div", () => {
  const html = databindInjection(
    {
      id: "b1",
      slug: "index",
      collection: "votes",
      kind: "bar",
      rect: { left: 100, top: 200, width: 300, height: 120 },
      read: { groupBy: "choice" },
      fallback: { buckets: [{ key: "A", count: 3 }] },
    },
    { canvasWidth: 1440 },
  );
  assert.match(html, /class="databind"/);
  assert.match(html, /position:absolute/);
  assert.match(html, /left:100px/);
  assert.match(html, /top:200px/);
  assert.match(html, /width:300px/);
  assert.match(html, /height:120px/);
  assert.match(html, /<div class="db-body"><\/div>/);
  // spec 必须能原样解析回来
  const m = /data-spec="([^"]*)"/.exec(html);
  assert.ok(m, "有 data-spec");
  const spec = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
  assert.equal(spec.collection, "votes");
  assert.deepEqual(spec.fallback.buckets, [{ key: "A", count: 3 }]);
});

test("spec 里的引号/尖括号被转义,不会破坏属性", () => {
  const html = databindInjection({
    id: "b1",
    slug: "index",
    collection: "x",
    kind: "list",
    rect: { left: 0, top: 0, width: 10, height: 10 },
    fallback: { items: [{ data: { t: '</div><script>alert(1)</script>"' } }] },
  });
  assert.equal(html.includes("<script>alert(1)</script>"), false, "不得注入可执行脚本");
  assert.match(html, /&lt;script&gt;/);
  const m = /data-spec="([^"]*)"/.exec(html);
  assert.ok(m, "属性没有被引号提前截断");
});

test("点击式绑定的容器不吃事件(否则挡住下面的 Figma 按钮)", () => {
  const base = { id: "b", slug: "index", collection: "votes", kind: "bar", rect: { left: 0, top: 0, width: 10, height: 10 } };
  const click = databindInjection({ ...base, write: { event: "click", target: "1:2", field: "choice" } });
  assert.match(click, /pointer-events:none/);
  const form = databindInjection({ ...base, write: { input: true, field: "text" } });
  assert.equal(/pointer-events:none/.test(form), false, "表单式绑定要能点");
});

test("宽矩形铺满 / 居中矩形跟随居中(与词云同一套规则)", () => {
  const wide = databindInjection({ id: "b", slug: "i", collection: "c", kind: "bar", rect: { left: 0, top: 0, width: 1440, height: 50 } }, { canvasWidth: 1440 });
  assert.match(wide, /left:0;top:0px;width:100%/);
  const mid = databindInjection({ id: "b", slug: "i", collection: "c", kind: "bar", rect: { left: 570, top: 10, width: 300, height: 50 } }, { canvasWidth: 1440 });
  assert.match(mid, /left:calc\(50% - 150px\)/);
});

test("databindHead 只在有绑定且配了后端时才注入", () => {
  assert.equal(databindHead("", { hasBindings: true }), "", "没配后端 → 不注入");
  assert.equal(databindHead("https://api.example.com", { hasBindings: false }), "", "没绑定 → 不注入");
  const h = databindHead("https://data.scopetest.net/api/v1", { hasBindings: true });
  assert.match(h, /window\.__DATA_API__ = "https:\/\/data\.scopetest\.net\/api\/v1"/);
  assert.match(h, /function slugify/);
  assert.match(h, /\.databind/);
});

test("databindHead 里的后端地址做了防脚本逃逸", () => {
  const h = databindHead('https://x/"><script>alert(1)</script>', { hasBindings: true });
  assert.equal(h.includes("<script>alert(1)</script>"), false);
});
