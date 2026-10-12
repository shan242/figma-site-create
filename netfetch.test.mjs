// netfetch 的测试:确认抓取用的 fetch 可以被替换成 Electron 的 net.fetch,
// 并且在 CLI 下(没有 Electron)安全回退到全局 fetch。
//
// 背景:Node 的 fetch 不读 Windows 系统代理(系统代理只写在注册表里),
// 于是开着 VPN(代理模式)时"浏览器能打开 figma.site、程序拉不到"。
// 实测直连 10.6 秒超时,同一时刻 net.fetch 2.5 秒拿到 200。
import { test } from "node:test";
import assert from "node:assert/strict";
import { httpFetch, setFetch, usingNetFetch } from "./netfetch.mjs";

test("默认用全局 fetch(CLI 场景)", async () => {
  setFetch(null);
  assert.equal(usingNetFetch(), false);

  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, opts });
    return new Response("ok", { status: 200 });
  };
  try {
    const r = await httpFetch("https://example.com/x", { redirect: "follow" });
    assert.equal(await r.text(), "ok");
    assert.equal(seen[0].url, "https://example.com/x");
    assert.equal(seen[0].opts.redirect, "follow", "选项必须原样透传");
  } finally {
    globalThis.fetch = real;
  }
});

test("注入后走注入的实现,不再碰全局 fetch", async () => {
  let globalCalled = false;
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    globalCalled = true;
    return new Response("global", { status: 200 });
  };
  const calls = [];
  try {
    setFetch(async (url, opts) => {
      calls.push({ url, opts });
      return new Response("injected", { status: 200 });
    });
    assert.equal(usingNetFetch(), true);

    const r = await httpFetch("https://figma.site/x", { redirect: "follow" });
    assert.equal(await r.text(), "injected");
    assert.equal(globalCalled, false, "注入后不应再落到全局 fetch");
    assert.equal(calls[0].url, "https://figma.site/x");
    assert.equal(calls[0].opts.redirect, "follow");
  } finally {
    setFetch(null);
    globalThis.fetch = real;
  }
});

test("传非函数视为复位(注入失败时安全回退)", () => {
  setFetch(async () => new Response("x"));
  assert.equal(usingNetFetch(), true);
  for (const bad of [null, undefined, 0, "", {}, []]) {
    setFetch(bad);
    assert.equal(usingNetFetch(), false, `${JSON.stringify(bad)} 应复位`);
  }
});

test("二进制读取可用(抓图走的是 arrayBuffer)", async () => {
  setFetch(async () => new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200 }));
  try {
    const res = await httpFetch("https://figma.site/a.png");
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, 4);
    assert.equal(buf[0], 0x89);
  } finally {
    setFetch(null);
  }
});

test("错误与状态码原样透传(抓取靠 res.ok / status 判断)", async () => {
  setFetch(async () => new Response("nope", { status: 404, statusText: "Not Found" }));
  try {
    const res = await httpFetch("https://figma.site/missing");
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
  } finally {
    setFetch(null);
  }
});
