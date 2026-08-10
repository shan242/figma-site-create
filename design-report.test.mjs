import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeDesign, renderMarkdown, generateDesignReport } from "./design-report.mjs";

// One page with: a white canvas, two text sizes, two buttons (primary blue),
// a horizontal 2-card row, and one stroked input. Enough to exercise every
// report section.
function pageData() {
  return {
    roots: ["1:1"],
    nodeById: {
      "1:1": { id: "1:1", type: "FRAME", name: "Canvas", absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 }, fills: [{ type: "SOLID", visible: true, opacity: 1, color: { r: 1, g: 1, b: 1 } }], children: ["1:2", "1:3", "1:4", "1:5", "1:6", "1:9"] },
      "1:2": { id: "1:2", type: "TEXT", characters: "Title", style: { fontFamily: "Inter", fontSize: 32, fontStyle: "Bold" }, fills: [{ type: "SOLID", visible: true, opacity: 1, color: { r: 0.07, g: 0.07, b: 0.07 } }], absoluteBoundingBox: { x: 40, y: 40, width: 200, height: 40 } },
      "1:3": { id: "1:3", type: "TEXT", characters: "Body text", style: { fontFamily: "Inter", fontSize: 16, fontStyle: "Regular" }, fills: [{ type: "SOLID", visible: true, opacity: 1, color: { r: 0.27, g: 0.27, b: 0.27 } }], absoluteBoundingBox: { x: 40, y: 100, width: 200, height: 20 } },
      "1:4": { id: "1:4", type: "RECTANGLE", name: "Button", absoluteBoundingBox: { x: 40, y: 200, width: 120, height: 48 }, cornerRadius: 8, fills: [{ type: "SOLID", visible: true, opacity: 1, color: { r: 0.1, g: 0.45, b: 0.91 } }], children: ["1:4t"], interactions: [{ event: { interactionType: "ON_CLICK" } }] },
      "1:4t": { id: "1:4t", type: "TEXT", characters: "Go", style: { fontFamily: "Inter", fontSize: 16 }, fills: [{ type: "SOLID", visible: true, opacity: 1, color: { r: 1, g: 1, b: 1 } }], absoluteBoundingBox: { x: 80, y: 212, width: 30, height: 20 } },
      "1:5": { id: "1:5", type: "RECTANGLE", name: "Button2", absoluteBoundingBox: { x: 200, y: 200, width: 120, height: 48 }, cornerRadius: 8, fills: [{ type: "SOLID", visible: true, opacity: 1, color: { r: 0.1, g: 0.45, b: 0.91 } }], children: ["1:5t"] },
      "1:5t": { id: "1:5t", type: "TEXT", characters: "Next", style: { fontFamily: "Inter", fontSize: 16 }, fills: [{ type: "SOLID", visible: true, opacity: 1, color: { r: 1, g: 1, b: 1 } }], absoluteBoundingBox: { x: 240, y: 212, width: 40, height: 20 } },
      "1:6": { id: "1:6", type: "FRAME", name: "Row", layoutMode: "HORIZONTAL", primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", itemSpacing: 20, paddingX: 24, paddingY: 24, absoluteBoundingBox: { x: 40, y: 300, width: 660, height: 200 }, children: ["1:7", "1:8"] },
      "1:7": { id: "1:7", type: "RECTANGLE", name: "Card1", absoluteBoundingBox: { x: 40, y: 300, width: 300, height: 200 }, cornerRadius: 12, fills: [{ type: "SOLID", visible: true, opacity: 1, color: { r: 0.95, g: 0.95, b: 0.95 } }], effects: [{ type: "DROP_SHADOW", offset: { x: 0, y: 4 }, radius: 8, color: { r: 0, g: 0, b: 0, a: 0.1 } }] },
      "1:8": { id: "1:8", type: "RECTANGLE", name: "Card2", absoluteBoundingBox: { x: 360, y: 300, width: 300, height: 200 }, cornerRadius: 12, fills: [{ type: "SOLID", visible: true, opacity: 1, color: { r: 0.95, g: 0.95, b: 0.95 } }] },
      "1:9": { id: "1:9", type: "RECTANGLE", name: "Input", absoluteBoundingBox: { x: 40, y: 550, width: 240, height: 40 }, cornerRadius: 4, strokes: [{ type: "SOLID", visible: true, color: { r: 0.6, g: 0.6, b: 0.6 } }] },
    },
  };
}

const report = () => analyzeDesign([pageData()]);

test("analyzeDesign classifies colors by frequency", () => {
  const r = report();
  assert.equal(r.colors.background, "#ffffff");
  assert.equal(r.colors.primary.hex, "#1a73e8");
  assert.ok(r.colors.solidTop.some((x) => x.hex === "#1a73e8"));
  assert.ok(r.colors.textTop.some((x) => x.hex === "#121212"));
  assert.ok(r.colors.strokeTop.some((x) => x.hex === "#999999"));
});

test("analyzeDesign builds a sorted, deduped type ladder", () => {
  const r = report();
  assert.deepEqual(r.typography.sizes.map((s) => s.px), [16, 32]);
  assert.ok(r.typography.weights.some((w) => w.weight === 400));
  assert.ok(r.typography.weights.some((w) => w.weight === 700)); // Bold
  assert.ok(r.typography.families.some((f) => f.name === "Inter"));
  assert.match(r.typography.lineHeight, /normal/);
});

test("analyzeDesign captures layout patterns and spacing", () => {
  const r = report();
  assert.equal(r.layout.containers.horizontal, 1);
  assert.ok(r.layout.columns.some((c) => c.columns === 2));
  assert.ok(r.layout.cardWidths.some((w) => w.px === 300));
  assert.ok(r.spacing.itemSpacing.some((s) => s.px === 20));
  assert.ok(r.spacing.paddingX.some((s) => s.px === 24));
  assert.ok(r.layout.primaryAlign.some((a) => a.value === "MIN"));
});

test("analyzeDesign classifies components by heuristic", () => {
  const r = report();
  assert.equal(r.components.buttons.count, 2);
  assert.equal(r.components.buttons.typicalHeight, 48);
  assert.equal(r.components.buttons.typicalRadius, 8);
  assert.ok(r.components.buttons.fills.some((f) => f.hex === "#1a73e8"));
  assert.equal(r.components.cards.count, 2);
  assert.equal(r.components.cards.typicalWidth, 300);
  assert.equal(r.components.inputs.count, 1);
  assert.equal(r.components.inputs.typicalHeight, 40);
});

test("analyzeDesign records shadows as design-reference only", () => {
  const r = report();
  assert.equal(r.shadows.length, 1);
  assert.equal(r.shadows[0].type, "drop");
  assert.equal(r.shadows[0].blur, 8);
});

test("renderMarkdown emits every section", () => {
  const md = renderMarkdown(report());
  assert.ok(md.includes("设计报告"));
  assert.ok(md.includes("背景色: #ffffff"));
  assert.ok(md.includes("## 布局模式"));
  assert.ok(md.includes("### 按钮"));
  assert.ok(md.includes("### 卡片"));
  assert.ok(md.includes("### 输入框"));
  assert.ok(md.includes("hover 说明"));
});

test("generateDesignReport writes markdown and json", () => {
  const dir = mkdtempSync(join(tmpdir(), "rep-report-"));
  generateDesignReport([pageData()], dir);
  assert.ok(existsSync(join(dir, "design-report.md")));
  assert.ok(existsSync(join(dir, "design-report.json")));
  const json = JSON.parse(readFileSync(join(dir, "design-report.json"), "utf8"));
  assert.equal(json.colors.background, "#ffffff");
});
