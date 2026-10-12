// 打包完整性检查。
//
// 起因:新加的 electron/config-merge.cjs 没有写进 package.json 的 build.files
// 白名单,于是**没被打进 asar** —— 本地测试全绿、CI 构建也 success,
// 但用户装上 macOS 版一启动就 `Cannot find module './config-merge.cjs'`。
//
// electron-builder 的 files 是**白名单**:新文件默认不包含。这个测试把
// "main.js / preload.js 里 require 的本地模块"与白名单对一遍,让漏文件在
// 本地(以及 CI 里一旦跑测试)就暴露,而不是等用户装完打开。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const dir = __dirname;
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const patterns = pkg.build?.files || [];

// 把 electron-builder 的 files 通配转成判断函数。只支持我们实际用到的形态:
// 精确文件名、`dir/**`、`*.ext`
function included(rel) {
  return patterns.some((p) => {
    if (p === rel) return true;
    if (p.endsWith("/**")) return rel.startsWith(p.slice(0, -2)); // "renderer/**" → "renderer/"
    if (p.startsWith("*.")) return rel.endsWith(p.slice(1)) && !rel.includes("/");
    return false;
  });
}

// 去掉注释再找 require —— 否则注释里写一句 require("./x") 就会被误报
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

// 抓 require("./xxx") / require('./xxx') 这类**本地**依赖(不含 node_modules 与内置)
function requiresIn(src) {
  const out = new Set();
  for (const m of stripComments(src).matchAll(/require\(\s*["'](\.[^"']+)["']\s*\)/g)) out.add(m[1]);
  return [...out];
}

function localRequires(file) {
  return requiresIn(readFileSync(join(dir, file), "utf8"));
}

test("main.js / preload.js 里 require 的本地模块都在打包白名单里", () => {
  const files = ["main.js", "preload.js"];
  const missing = [];
  for (const f of files) {
    for (const req of localRequires(f)) {
      const rel = req.replace(/^\.\//, "");
      assert.ok(existsSync(join(dir, rel)), `${f} require 的 ${rel} 在源码里就不存在`);
      if (!included(rel)) missing.push(`${f} → ${rel}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `这些文件会被 require 但不在 build.files 白名单里,打包后启动即崩:\n  ${missing.join("\n  ")}\n` +
      `当前白名单: ${JSON.stringify(patterns)}`,
  );
});

test("worker.cjs 把 main.js 用到的导出都提供了", () => {
  // main.js 从 worker.cjs 解构出来的名字,worker 里必须都有
  const src = readFileSync(join(dir, "main.js"), "utf8");
  const m = /const \{([^}]+)\} = require\("\.\/worker\.cjs"\)/.exec(src);
  assert.ok(m, "没找到 main.js 里对 worker.cjs 的解构");
  const wanted = m[1]
    .split(",")
    .map((s) => s.trim().split(":")[0].trim()) // `machineCode: computeMachineCode` → machineCode
    .filter(Boolean);
  const worker = require("./worker.cjs");
  const absent = wanted.filter((k) => typeof worker[k] !== "function");
  assert.deepEqual(absent, [], `worker.cjs 缺少导出: ${absent.join(", ")}`);
});

test("打包白名单覆盖运行时需要的文件", () => {
  for (const rel of ["main.js", "preload.js", "worker.cjs"]) {
    assert.ok(included(rel), `${rel} 必须被打包`);
  }
  // renderer 是目录通配
  assert.ok(included("renderer/index.html"), "renderer/** 要覆盖 index.html");
  assert.ok(included("renderer/renderer.js"), "renderer/** 要覆盖 renderer.js");
});

test("自检:检测器真的能发现漏掉的文件", () => {
  // 否则上面的断言可能因为 included() 恒真而毫无意义
  assert.equal(included("config-merge.cjs"), false, "它不在白名单里(改为打进 worker.cjs 了)");
  assert.equal(included("whatever.cjs"), false);
  assert.equal(included("renderer/nope.js"), true, "renderer/** 下的都算打包");
  assert.equal(included("scripts/build.mjs"), false);
});

test("自检:原始那个 bug(main.js require 一个不在白名单的 .cjs)会被抓出来", () => {
  // 复刻出错那一版 main.js 的关键一行
  const broken = `
const { applyConfigPatch } = require("./config-merge.cjs");
const { runAgent } = require("./worker.cjs");
`;
  const found = requiresIn(broken).map((r) => r.replace(/^\.\//, ""));
  assert.deepEqual(found, ["config-merge.cjs", "worker.cjs"]);
  const missing = found.filter((r) => !included(r));
  assert.deepEqual(missing, ["config-merge.cjs"], "必须报出 config-merge.cjs 没被打包");
});

test("自检:注释掉的 require 不算数", () => {
  const src = `
// 不要 require("./config-merge.cjs"):说明为什么
/* require("./also-not-real.cjs"); */
const a = require("./worker.cjs");
`;
  assert.deepEqual(requiresIn(src), ["./worker.cjs"]);
});
