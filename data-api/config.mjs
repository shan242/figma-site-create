// config.mjs — 后端配置。首次启动生成 adminToken 与 IP 哈希主盐。
//
// adminToken 只在软件端保存(safeStorage 加密),**绝不下发给浏览器**。
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "config.json";

export function loadConfig(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, FILE);
  let cfg = {};
  if (existsSync(file)) {
    try {
      cfg = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`${file} 解析失败: ${e.message}`);
    }
  }
  let changed = false;
  if (!cfg.adminToken) {
    cfg.adminToken = randomBytes(32).toString("hex");
    changed = true;
  }
  if (!cfg.ipSalt) {
    cfg.ipSalt = randomBytes(32).toString("hex");
    changed = true;
  }
  if (cfg.version === undefined) {
    cfg.version = 1;
    changed = true;
  }
  if (changed) {
    writeFileSync(`${file}.tmp`, JSON.stringify(cfg, null, 2));
    renameSync(`${file}.tmp`, file);
  }
  return { ...cfg, dataDir, configFile: file };
}
