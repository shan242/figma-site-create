import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutWordCloud, extractKeywordsLocal, measureText, cloudInjection } from "./wordcloud.mjs";

test("layout is deterministic for the same input", () => {
  const words = [{ text: "旅行", weight: 90 }, { text: "culture", weight: 60 }, { text: "history", weight: 40 }];
  const a = layoutWordCloud(words, { width: 400, height: 300 });
  const b = layoutWordCloud(words, { width: 400, height: 300 });
  assert.deepEqual(a, b);
  assert.equal(a.items.length, 3);
});

test("every placed word stays inside the rect", () => {
  const words = [];
  for (let i = 0; i < 40; i++) words.push({ text: `word-${i}`, weight: 100 - i });
  const { items, width, height } = layoutWordCloud(words, { width: 300, height: 200, minFont: 10, maxFont: 36 });
  for (const it of items) {
    assert.ok(it.x >= 0 && it.y >= 0, `${it.text} negative origin`);
    assert.ok(it.x + measureText(it.text, it.size) <= width, `${it.text} overflows right`);
    assert.ok(it.y + it.size <= height, `${it.text} overflows bottom`);
  }
});

test("no overlaps between placed words", () => {
  const words = [];
  for (let i = 0; i < 30; i++) words.push({ text: `单词${i}`, weight: 90 - i });
  const { items } = layoutWordCloud(words, { width: 500, height: 400, minFont: 12, maxFont: 44 });
  const boxes = items.map((it) => ({ x: it.x, y: it.y, w: it.w, h: it.size + 4 }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, `${items[i].text} overlaps ${items[j].text}`);
    }
  }
});

test("bigger weight gets bigger font", () => {
  const words = [{ text: "big", weight: 100 }, { text: "small", weight: 10 }];
  const { items } = layoutWordCloud(words, { width: 400, height: 300, minFont: 12, maxFont: 48 });
  const big = items.find((i) => i.text === "big");
  const small = items.find((i) => i.text === "small");
  assert.ok(big.size > small.size);
});

test("filters punctuation-only and empty words", () => {
  const { items } = layoutWordCloud(
    [{ text: "!!!", weight: 90 }, { text: "", weight: 80 }, { text: "ok", weight: 50 }],
    { width: 300, height: 200 },
  );
  assert.deepEqual(items.map((i) => i.text), ["ok"]);
});

test("empty input yields empty layout", () => {
  const { items } = layoutWordCloud([], { width: 300, height: 200 });
  assert.deepEqual(items, []);
});

test("CJK measure wider than latin", () => {
  assert.ok(measureText("中文词云测试", 20) > measureText("abcdefgh", 20));
});

test("extractKeywordsLocal returns top latin + cjk bigrams", () => {
  const text = "travel travel travel culture history history history history";
  const kw = extractKeywordsLocal(text);
  assert.ok(kw.length > 0);
  const top = kw[0];
  assert.equal(top.text, "history");
  assert.ok(top.weight >= kw[kw.length - 1].weight);
  const cjk = extractKeywordsLocal("人工智能人工智能人工智能旅行旅行");
  assert.ok(cjk.some((k) => k.text.length === 2));
});

test("cloudInjection emits escaped json (no </script> breakout)", () => {
  const html = cloudInjection(
    { rect: { left: 10, top: 20, width: 300, height: 200 }, spec: { words: [{ text: "</script><b>x</b>", weight: 50 }] } },
    { width: 300, height: 200, fontFamily: "'Noto Sans SC', sans-serif" },
  );
  assert.ok(html.includes('class="wordcloud"'));
  assert.ok(!html.includes("</script><b>"), "word text must not break out of the script tag");
  assert.ok(html.includes("renderWordCloud"));
});

test("cloudInjection is deterministic", () => {
  const item = { rect: { left: 5, top: 5, width: 200, height: 150 }, spec: { words: [{ text: "a", weight: 50 }] } };
  const a = cloudInjection(item, { width: 200, height: 150, fontFamily: "sans-serif" });
  const b = cloudInjection(item, { width: 200, height: 150, fontFamily: "sans-serif" });
  assert.equal(a, b);
});
