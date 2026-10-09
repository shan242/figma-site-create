// slug.mjs — 站点命名空间的唯一来源。
//
// 这个函数必须在三处完全一致:服务端(本文件)、注入页面的浏览器运行时
// (databind.mjs)、软件端(publish.mjs 注册站点时)。不一致会导致"页面找不到
// 自己的数据",所以 test/slug.test.mjs 用同一批样本钉住行为。
//
// 规则刻意不依赖 Public Suffix List、也不猜"哪部分是域名" —— 纯字符串规范化,
// 任意域名下都确定且无碰撞:
//   tool-steam-65311718.figma.site → tool-steam-65311718-figma-site
//   www.my-shop.com / my-shop.com  → my-shop-com      (同一站点,同一命名空间)
//   ""                             → ""               (file:// 预览,调用方需跳过)

export function slugify(host) {
  return String(host || "")
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

export const SITE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const COLLECTION_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
export const CLIENT_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const isSite = (v) => typeof v === "string" && SITE_RE.test(v);
export const isCollection = (v) => typeof v === "string" && COLLECTION_RE.test(v);
export const isField = (v) => typeof v === "string" && FIELD_RE.test(v);
export const isClient = (v) => typeof v === "string" && CLIENT_RE.test(v);

// 来源匹配(契约 §6.4):
//   https://a.example.com   精确
//   https://*.example.com   匹配任意层级子域,但**不匹配裸域**
export function originAllowed(origin, patterns) {
  if (!origin || !Array.isArray(patterns)) return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const port = url.port ? `:${url.port}` : "";
  const scheme = url.protocol.replace(":", "");
  for (const raw of patterns) {
    const p = String(raw || "").trim();
    if (!p) continue;
    let pu;
    try {
      pu = new URL(p);
    } catch {
      continue;
    }
    // 协议必须一致(一律 https),端口显式写了才校验
    if (pu.protocol.replace(":", "") !== scheme) continue;
    const pPort = pu.port ? `:${pu.port}` : "";
    if (pPort && pPort !== port) continue;
    const pHost = pu.hostname.toLowerCase();
    if (pHost.startsWith("*.")) {
      const base = pHost.slice(2);
      if (host === base) continue; // 裸域不匹配,必须显式列出
      if (host.endsWith(`.${base}`)) return true;
    } else if (pHost === host) {
      return true;
    }
  }
  return false;
}

// 共享托管域清单:通配这些等于把后端开放给全世界(契约 §6.4 的红线)。
export const SHARED_HOST_SUFFIXES = [
  "figma.site",
  "vercel.app",
  "netlify.app",
  "github.io",
  "pages.dev",
  "workers.dev",
  "web.app",
  "firebaseapp.com",
  "herokuapp.com",
  "onrender.com",
  "glitch.me",
  "repl.co",
  "surge.sh",
];

// 通配是否覆盖了共享托管域 —— 软件端用它弹二次确认,服务端用它记警告。
export function wildcardOverSharedHost(patterns) {
  for (const raw of patterns || []) {
    let pu;
    try {
      pu = new URL(String(raw).trim());
    } catch {
      continue;
    }
    const h = pu.hostname.toLowerCase();
    if (!h.startsWith("*.")) continue;
    const base = h.slice(2);
    if (SHARED_HOST_SUFFIXES.some((s) => base === s || base.endsWith(`.${s}`))) return base;
  }
  return null;
}
