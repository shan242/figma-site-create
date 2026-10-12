// 配置合并规则的测试。
//
// 起因:用户说"数据后端已经配置好了",但配置文件里两个字段都是空的。
// 根因是保存时会把空值原样写回 —— 而发布设置的表单里 token 框**永远是空的**
// (get 接口只回 hasToken 不回 token),所以随便打开发布设置点一次保存,
// 数据后端配置就被清空了。用户看到的是"我明明配了,却没生效"。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { applyConfigPatch, keepIfEmpty } = require("./config-merge.cjs");

const base = () => ({
  apiKey: "enc-ai",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  recentDirs: ["D:/a"],
  publish: {
    baseUrl: "http://64.83.29.108:27446/",
    apiKey: "enc-panel",
    domain: "betweenchoices.org",
    alias: "",
    groupID: 1,
    https: { enabled: true, method: "dnsAccount", acmeAccountId: 2, dnsAccountId: 2, sslId: 6, httpConfig: "HTTPToHTTPS", hsts: false },
    dataApi: { baseUrl: "https://data.scopetest.net", adminToken: "tok-abc" },
  },
  machineCode: "DC61556F8BFE889D",
});

test("keepIfEmpty:空值保留旧值,非空则覆盖", () => {
  assert.equal(keepIfEmpty("", "old"), "old");
  assert.equal(keepIfEmpty(undefined, "old"), "old");
  assert.equal(keepIfEmpty(null, "old"), "old");
  assert.equal(keepIfEmpty("   ", "old"), "old");
  assert.equal(keepIfEmpty("new", "old"), "new");
  assert.equal(keepIfEmpty("", ""), "");
});

test("保存发布设置(表单 token 为空)不会清空数据后端配置", () => {
  const prev = base();
  // 渲染进程实际发出来的形状:token 框是空的(get 只回 hasToken),baseUrl 也来自表单
  const patch = {
    publish: {
      baseUrl: "http://64.83.29.108:27446/",
      domain: "betweenchoices.org",
      alias: "",
      groupID: 1,
      apiKey: "",
      https: { enabled: true, method: "dnsAccount", acmeAccountId: 2, dnsAccountId: 2, sslId: 6, httpConfig: "HTTPToHTTPS", hsts: false },
      dataApi: { baseUrl: "https://data.scopetest.net", adminToken: "" },
    },
  };
  const out = applyConfigPatch(prev, patch);
  assert.equal(out.publish.dataApi.baseUrl, "https://data.scopetest.net", "baseUrl 不能丢");
  assert.equal(out.publish.dataApi.adminToken, "tok-abc", "token 空 = 保持旧的");
  assert.equal(out.publish.apiKey, "enc-panel", "1Panel key 同理");
  assert.equal(out.apiKey, "enc-ai", "AI key 不受影响");
});

test("baseUrl 为空时不会被删掉(旧代码用 || undefined,JSON.stringify 会直接丢键)", () => {
  const prev = base();
  const out = applyConfigPatch(prev, { publish: { dataApi: { baseUrl: "", adminToken: "" } } });
  assert.equal(out.publish.dataApi.baseUrl, "https://data.scopetest.net");
  // 序列化一遍,确认键真的还在
  const round = JSON.parse(JSON.stringify(out));
  assert.ok("baseUrl" in round.publish.dataApi, "序列化后键必须还在");
  assert.equal(round.publish.dataApi.adminToken, "tok-abc");
});

test("深合并:补丁里没提到的字段不能凭空消失", () => {
  const prev = base();
  // 只提交了一部分字段 —— 浅合并会把 https.sslId、machineCode 等整块替换掉
  const out = applyConfigPatch(prev, { publish: { dataApi: { baseUrl: "https://new.example" } } });
  assert.equal(out.publish.https.sslId, 6, "https 子对象要深合并");
  assert.equal(out.publish.https.enabled, true);
  assert.equal(out.machineCode, "DC61556F8BFE889D", "顶层未提到的键要保留");
  assert.deepEqual(out.recentDirs, ["D:/a"]);
});

test("用户重新输入的值永远优先", () => {
  const prev = base();
  const out = applyConfigPatch(prev, {
    apiKey: "new-ai",
    publish: { baseUrl: "http://new-panel/", domain: "new.com", apiKey: "new-panel", dataApi: { baseUrl: "https://data2.example", adminToken: "tok-new" } },
  });
  assert.equal(out.apiKey, "new-ai");
  assert.equal(out.publish.apiKey, "new-panel");
  assert.equal(out.publish.baseUrl, "http://new-panel/");
  assert.equal(out.publish.domain, "new.com");
  assert.equal(out.publish.dataApi.baseUrl, "https://data2.example");
  assert.equal(out.publish.dataApi.adminToken, "tok-new");
});

test("配置为空/损坏时也能安全合并", () => {
  assert.equal(applyConfigPatch(null, null).publish.dataApi.baseUrl, "");
  assert.equal(applyConfigPatch(undefined, { publish: { dataApi: { baseUrl: "https://x", adminToken: "t" } } }).publish.dataApi.adminToken, "t");
  assert.equal(applyConfigPatch({}, {}).publish.dataApi.baseUrl, "");
});
