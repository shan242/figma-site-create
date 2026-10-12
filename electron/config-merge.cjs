// config-merge.cjs — 应用配置的合并规则(纯函数,便于单测)。
//
// 为什么单独抽出来:这里曾经有个"用户配好了、保存一次就没了"的坑。
// `publish-config:get` **只回 hasToken、不回 token**(避免把密钥送回渲染进程),
// 所以表单里的 token 框永远是空的;而保存时 `adminToken: da.adminToken` 会把空串
// 原样写回,`baseUrl: ... || undefined` 更会让 JSON.stringify 直接把这个键删掉。
// 结果就是:配好了数据后端,之后随便打开发布设置点一次保存,配置被清空 ——
// 用户看到的是"我明明配了,却没生效"。
//
// 规则和 `apiKey` 一致:**提交空值 = 保持已存的那个**。用户重新输入的值永远优先。

// 单个字符串字段:新值非空就用新的,否则保留旧的。
const keepIfEmpty = (next, prev) => {
  const s = typeof next === "string" ? next.trim() : next === undefined || next === null ? "" : String(next).trim();
  return s || (typeof prev === "string" ? prev : "") || "";
};

function applyConfigPatch(prev, patch) {
  const p = prev && typeof prev === "object" ? prev : {};
  const c = patch && typeof patch === "object" ? patch : {};
  const prevPub = p.publish || {};
  const nextPub = c.publish || {};
  const prevDa = prevPub.dataApi || {};
  const nextDa = nextPub.dataApi || {};

  const out = { ...p, ...c };

  // publish 走**深合并**:浅合并会让 cfg.publish 整体替换掉 prev.publish,
  // 于是没在补丁里出现的字段(比如 https.sslId)会凭空消失。
  out.publish = { ...prevPub, ...nextPub };
  out.publish.https = { ...(prevPub.https || {}), ...(nextPub.https || {}) };
  out.publish.dataApi = {
    baseUrl: keepIfEmpty(nextDa.baseUrl, prevDa.baseUrl),
    adminToken: keepIfEmpty(nextDa.adminToken, prevDa.adminToken),
  };
  // 1Panel 侧同样适用"空 = 保持":表单会预填这些值,但清空一次不该把它们抹掉。
  out.publish.baseUrl = keepIfEmpty(nextPub.baseUrl, prevPub.baseUrl);
  out.publish.domain = keepIfEmpty(nextPub.domain, prevPub.domain);
  if (nextPub.alias === undefined) out.publish.alias = prevPub.alias || "";
  else out.publish.alias = nextPub.alias;

  // 密钥:空 = 保持旧的(加密写入由调用方负责)
  if (!c.apiKey && p.apiKey) out.apiKey = p.apiKey;
  if (nextPub.apiKey === undefined || nextPub.apiKey === "") out.publish.apiKey = prevPub.apiKey || "";

  return out;
}

module.exports = { applyConfigPatch, keepIfEmpty };
