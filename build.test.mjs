// build.mjs 的字体自托管测试。
//
// 这组用例来自一次真实的用户报告:"could not fetch font Noto Sans JP:Regular"
// —— 那个 URL 其实一直是 200,失败是**偶发网络抖动**(字体 4–7MB),
// 而旧代码 `catch {}` 把真实原因吞了,还照样写出一条指向不存在文件的
// @font-face(浏览器 404 后静默退回系统字体)。这里把修正后的三条行为钉死:
//   1. 偶发失败要重试
//   2. 持续失败要**说明原因**且**不写出坏规则**
//   3. 已有文件不重复下载
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite } from "./build.mjs";

const FONT = { "Acme:Bold": { url: "/_woff/v2/Acme_1/Acme_1.woff2", weight: 700, italic: false } };

function fontFixture(fonts = FONT) {
  const dir = mkdtempSync(join(tmpdir(), "rep-font-"));
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
      fonts,
      nodeById: {
        "1:1": { id: "1:1", type: "FRAME", name: "Canvas", absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 300 }, children: ["1:2"] },
        "1:2": { id: "1:2", type: "TEXT", characters: "hi", absoluteBoundingBox: { x: 10, y: 10, width: 100, height: 20 }, style: { fontFamily: "Acme", fontSize: 16 } },
      },
    }),
  );
  return dir;
}

async function buildCapturingWarnings(dir) {
  const warns = [];
  const orig = console.warn;
  const origLog = console.log;
  console.warn = (...a) => warns.push(a.join(" "));
  console.log = () => {};
  try {
    await buildSite(dir);
  } finally {
    console.warn = orig;
    console.log = origLog;
  }
  return warns;
}

test("字体下载偶发失败会重试,成功后正常落盘", async () => {
  const dir = fontFixture();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new Error("socket hang up");
    return new Response(Buffer.from("FAKEWOFF"), { status: 200 });
  };
  const warns = await buildCapturingWarnings(dir);
  assert.equal(calls, 2, "第一次失败后应当重试");
  assert.deepEqual(warns, [], "重试成功就不该有告警");
  assert.ok(existsSync(join(dir, "fonts", "Acme_1.woff2")), "字体应落盘");
  // 字体 URL 带内容哈希查询串:字体文件名不是内容哈希(是 字体名_序号),
  // 内容变了名字不变,而静态托管的 max-age 很长 → 访客会一直用旧字体。
  assert.match(readFileSync(join(dir, "styles.css"), "utf8"), /src: url\(fonts\/Acme_1\.woff2\?v=[a-f0-9]{8}\)/, "应写出带版本串的 @font-face");
});

test("字体持续失败:说明真实原因,且不写出指向不存在文件的 @font-face", async () => {
  const dir = fontFixture();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("getaddrinfo ENOTFOUND example.figma.site");
  };
  const warns = await buildCapturingWarnings(dir);
  assert.equal(calls, 3, "应重试满 3 次");
  assert.ok(
    warns.some((w) => w.includes("ENOTFOUND")),
    `告警必须带真实原因(旧代码只留 "could not fetch"): ${JSON.stringify(warns)}`,
  );
  assert.ok(
    warns.some((w) => w.includes("重新生成")),
    "应给出可操作的建议",
  );
  const css = readFileSync(join(dir, "styles.css"), "utf8");
  assert.equal(/url\(fonts\/Acme_1\.woff2\)/.test(css), false, "不能引用不存在的字体文件");
  assert.equal(existsSync(join(dir, "fonts", "Acme_1.woff2")), false);
});

test("字体返回非 2xx 时告警带 HTTP 状态码", async () => {
  const dir = fontFixture();
  globalThis.fetch = async () => new Response("nope", { status: 404 });
  const warns = await buildCapturingWarnings(dir);
  assert.ok(warns.some((w) => w.includes("HTTP 404")), `应显示状态码: ${JSON.stringify(warns)}`);
  assert.equal(/url\(fonts\/Acme_1\.woff2\)/.test(readFileSync(join(dir, "styles.css"), "utf8")), false);
});

test("字体已存在时不重复下载(重建不浪费流量)", async () => {
  const dir = fontFixture();
  mkdirSync(join(dir, "fonts"), { recursive: true });
  writeFileSync(join(dir, "fonts", "Acme_1.woff2"), Buffer.from("CACHED"));
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("x", { status: 200 });
  };
  const warns = await buildCapturingWarnings(dir);
  assert.equal(calls, 0, "不应发起请求");
  assert.deepEqual(warns, []);
  assert.equal(readFileSync(join(dir, "fonts", "Acme_1.woff2"), "utf8"), "CACHED", "不能覆盖已有文件");
  assert.match(readFileSync(join(dir, "styles.css"), "utf8"), /src: url\(fonts\/Acme_1\.woff2\?v=[a-f0-9]{8}\)/, "仍然要写 @font-face(带版本串)");
});

test("零字节的残留文件会被重新下载", async () => {
  const dir = fontFixture();
  mkdirSync(join(dir, "fonts"), { recursive: true });
  writeFileSync(join(dir, "fonts", "Acme_1.woff2"), "");
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(Buffer.from("REAL"), { status: 200 });
  };
  await buildCapturingWarnings(dir);
  assert.equal(calls, 1, "上次失败留下的空文件应触发重下");
  assert.equal(readFileSync(join(dir, "fonts", "Acme_1.woff2"), "utf8"), "REAL");
});
