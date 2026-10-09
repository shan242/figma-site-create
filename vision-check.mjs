// vision-check.mjs — 实测「哪个模型能看图」以及「它到底看没看懂」。
//
//   $env:DEEPSEEK_API_KEY="sk-..."; node vision-check.mjs <图片路径> [提示词]
//
// 为什么不放进 *.test.mjs:它要真实 API Key 与外网,不适合 CI。
//
// 背景(api-docs.deepseek.com/zh-cn/guides/vision):
//   图片理解通过标准 OpenAI 兼容的 content 块数组传入,图片**只能出现在 user 消息**里
//   (system/assistant 带图返回 400);支持 JPEG/PNG/GIF/WebP,单图 ≤32MB。
//   文档称多模态模型名为 deepseek-flash;旧名 deepseek-v4-flash-vision-exp 已下线。
//   而应用默认配置的是 deepseek-v4-flash —— 所以本脚本把两个名字都打一遍,
//   直接告诉你该填哪个。
import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { sniffImageMime } from "./ai.mjs";

const KEY = process.env.DEEPSEEK_API_KEY || process.argv[5];
const BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const imagePath = process.argv[2];
const prompt = process.argv[3] || "这张图片里有什么?如果是地图,说明是哪个地区的地图。用中文简短回答。";
const MODELS = (process.env.VISION_MODELS || "deepseek-v4-flash,deepseek-flash").split(",").map((s) => s.trim()).filter(Boolean);

if (!KEY) {
  console.error("缺少 API Key。用法: $env:DEEPSEEK_API_KEY=\"sk-...\"; node vision-check.mjs <图片>");
  process.exit(2);
}
if (!imagePath || !existsSync(imagePath)) {
  console.error(`图片不存在: ${imagePath}`);
  process.exit(2);
}

const buf = readFileSync(imagePath);
const mime = sniffImageMime(buf);
if (!mime) {
  console.error(`不是模型支持的图片格式(仅 JPEG/PNG/GIF/WebP): ${basename(imagePath)}`);
  process.exit(2);
}
const mb = buf.length / 1048576;
console.log(`图片: ${basename(imagePath)}  ${mime}  ${mb.toFixed(2)} MB`);
if (buf.length > 32 * 1024 * 1024) {
  console.error("超过 32MB 上限,模型无法接收");
  process.exit(2);
}
console.log("");

const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;

async function ask(model) {
  const body = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: dataUrl, detail: "auto" } },
        ],
      },
    ],
  };
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const ms = Date.now() - t0;
  if (!res.ok) return { ok: false, status: res.status, detail: text.slice(0, 300), ms };
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, status: res.status, detail: text.slice(0, 300), ms };
  }
  return { ok: true, text: json.choices?.[0]?.message?.content ?? "(空响应)", usage: json.usage, ms };
}

let anyVision = false;
for (const model of MODELS) {
  process.stdout.write(`—— 模型 ${model} ——\n`);
  try {
    const r = await ask(model);
    if (r.ok) {
      anyVision = true;
      console.log(`  ✅ 接受图片并作答(${r.ms}ms)`);
      console.log(`  模型回答: ${String(r.text).trim().slice(0, 400)}`);
      if (r.usage) console.log(`  token: ${JSON.stringify(r.usage)}`);
    } else {
      const imageRelated = /image|vision|multimodal|多模态|图片/i.test(r.detail);
      console.log(`  ✗ HTTP ${r.status}${imageRelated ? "(与图片相关)" : ""}`);
      console.log(`    ${r.detail.replace(/\s+/g, " ").slice(0, 220)}`);
    }
  } catch (e) {
    console.log(`  ✗ 请求失败: ${e.message}`);
  }
  console.log("");
}

if (anyVision) {
  console.log("结论:至少有一个模型能看图。把应用设置里的「模型」改成上面显示 ✅ 的那个即可。");
} else {
  console.log("结论:这两个模型名都没能接收图片。请到 platform.deepseek.com 确认当前多模态模型的名称。");
}
