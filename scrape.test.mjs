// 抓取阶段的纯函数测试 —— 主要是资源扩展名推导。
//
// 起因:lily2026new 的抓取报告了两个 "asset ... not found"。实测发现同一 URL
// 会时而 200、时而 fetch failed(连接重置),而代码里有两处把偶发失败放大成永久失败:
//   1. `url.split(".").pop()` 对**没有扩展名**的 url(VIDEO_ASSET)会返回整个 hash,
//      拼出一个必然 404 的 URL;
//   2. 收集阶段用 `set(n.hash, null)` 覆盖掉 assets 表里已知的扩展名,
//      于是每个被引用的资源都先按 .png 去猜。
import { test } from "node:test";
import assert from "node:assert/strict";
import { extOfAsset } from "./scrape.mjs";

test("extOfAsset:url 带扩展名时直接用它", () => {
  assert.equal(extOfAsset({ url: "abc.svg" }), "svg");
  assert.equal(extOfAsset({ url: "abc.PNG" }), "png");
  assert.equal(extOfAsset({ url: "abc.jpg" }), "jpg");
  assert.equal(extOfAsset({ url: "abc.webp" }), "webp");
  assert.equal(extOfAsset({ url: "abc.mp4" }), "mp4");
});

test("extOfAsset:url 没有扩展名时不能把 hash 当扩展名", () => {
  // 这正是线上那个 VIDEO_ASSET 的形态:url 就是裸 hash,
  // 旧代码会请求 .../<hash>.<hash> —— 必然 404。
  const hash = "30d9d3a016fc1ef8444dbf3bb9c714895e728298";
  const ext = extOfAsset({ url: hash, type: "VIDEO_ASSET", size: { x: 1280, y: 720 } });
  assert.equal(ext, "mp4", "视频资源应猜到 mp4");
  assert.equal(ext.includes(hash), false, "绝不能把 hash 当成扩展名");
});

test("extOfAsset:退回 format 字段", () => {
  assert.equal(extOfAsset({ url: "noext", format: "SVG" }), "svg");
  assert.equal(extOfAsset({ url: "noext", format: "PNG" }), "png");
  assert.equal(extOfAsset({ url: "noext", format: "JPG" }), "jpg");
  assert.equal(extOfAsset({ url: "noext", format: "WEBP" }), "webp");
});

test("extOfAsset:兜底与异常输入", () => {
  assert.equal(extOfAsset({ url: "noext", type: "PAINT_ASSET" }), "png", "未知则按 png 猜");
  assert.equal(extOfAsset({}), "png");
  assert.equal(extOfAsset(null), "png");
  assert.equal(extOfAsset({ url: "a.unknownext" }), "png", "不认识的扩展名不能直接用");
  // 点在目录里(v1.2/x)时 lastIndexOf 之后不是扩展名
  assert.equal(extOfAsset({ url: "/_woff/v1.2/font" }), "png");
});
