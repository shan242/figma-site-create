// slugify / 来源匹配 的规则测试。
// slugify 是命名空间的唯一来源,服务端 / 软件端 / 浏览器运行时三处必须一致,
// 所以这里用固定样本把行为钉死。
import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, SITE_RE, originAllowed, wildcardOverSharedHost } from "../slug.mjs";

test("slugify 样本(与 docs/data-api.md §7.0 表格一致)", () => {
  const cases = [
    ["tool-steam-65311718.figma.site", "tool-steam-65311718-figma-site"],
    ["www.my-shop.com", "my-shop-com"],
    ["my-shop.com", "my-shop-com"],
    ["a.b.example.com", "a-b-example-com"],
    ["WWW.Example.COM", "example-com"],
    ["shop.example.com:8080", "shop-example-com-8080"],
    ["didsdi.com", "didsdi-com"],
    ["data.scopetest.net", "data-scopetest-net"],
    ["scopetest.net", "scopetest-net"],
  ];
  for (const [input, want] of cases) {
    assert.equal(slugify(input), want, `${input} 应得到 ${want}`);
  }
});

test("slugify 输出始终满足 SITE_RE,除非规范化后为空", () => {
  const inputs = ["x".repeat(80) + ".com", "!!!", "a--b", "-lead", "trail-", "Ünïcödé.com", ""];
  for (const i of inputs) {
    const s = slugify(i);
    // 空结果(空输入 / 全是非法字符)调用方必须跳过,不能拿去请求
    if (!s) {
      assert.ok(i === "" || !/[a-z0-9]/i.test(i), `${JSON.stringify(i)} 不该得到空 slug`);
      continue;
    }
    assert.ok(SITE_RE.test(s), `${JSON.stringify(i)} → ${JSON.stringify(s)} 不满足 SITE_RE`);
  }
  assert.equal(slugify(""), "", "空输入 → 空 slug(file:// 预览)");
  assert.equal(slugify("!!!"), "", "纯符号 → 空 slug");
});

test("www 与裸域视为同一站点,不同站点互相隔离", () => {
  assert.equal(slugify("www.a.com"), slugify("a.com"));
  assert.notEqual(slugify("a.com"), slugify("b.com"));
  assert.notEqual(slugify("a.example.com"), slugify("a.other.com"));
});

test("originAllowed:精确匹配", () => {
  const p = ["https://didsdi.com"];
  assert.equal(originAllowed("https://didsdi.com", p), true);
  assert.equal(originAllowed("https://www.didsdi.com", p), false);
  assert.equal(originAllowed("http://didsdi.com", p), false);
  assert.equal(originAllowed("", p), false);
  assert.equal(originAllowed("https://didsdi.com", []), false);
});

test("originAllowed:通配匹配多级子域、不匹配裸域", () => {
  const p = ["https://*.example.com"];
  assert.equal(originAllowed("https://a.example.com", p), true);
  assert.equal(originAllowed("https://a.b.example.com", p), true);
  assert.equal(originAllowed("https://example.com", p), false, "裸域需显式列出");
  assert.equal(originAllowed("https://notexample.com", p), false);
  assert.equal(originAllowed("https://example.com.evil.com", p), false);
});

test("originAllowed:端口显式写了才校验", () => {
  assert.equal(originAllowed("https://a.com:8443", ["https://a.com"]), true);
  assert.equal(originAllowed("https://a.com:8443", ["https://a.com:8443"]), true);
  assert.equal(originAllowed("https://a.com", ["https://a.com:8443"]), false);
});

test("wildcardOverSharedHost 认出危险通配", () => {
  assert.equal(wildcardOverSharedHost(["https://*.figma.site"]), "figma.site");
  assert.equal(wildcardOverSharedHost(["https://*.vercel.app"]), "vercel.app");
  assert.equal(wildcardOverSharedHost(["https://*.example.com"]), null);
  assert.equal(wildcardOverSharedHost(["https://didsdi.com"]), null);
  assert.equal(wildcardOverSharedHost(["garbage"]), null);
});
