# 数据后端 API 契约(v1)

生成的静态站点通过这份 API 持久化跨访客数据(词云采集、按钮投票、留言等),
部署在**你自己的 1Panel 服务器**上,一套后端服务所有站点。

- 状态: **已定稿,待实现**
- 版本: `v1`
- 部署形态: 单 Node 进程 + 单 SQLite 文件,由 1Panel 反向代理

---

## 0. 已确定的设计决策

| # | 决策 | 影响 |
|---|---|---|
| 1 | **不做先审后显** | 无 `status`/待审态;写入即公开可见。风控靠限流 + 管理端删除 |
| 2 | **数据永久保留** | 无 TTL、无自动清理;配额是唯一的增长闸门,备份更重要 |
| 3 | **域名白名单支持子域名通配** | `https://*.example.com` 匹配任意层级子域;**通配共享域名有风险,见 6.4** |
| 4 | **服务端不做投票去重** | 不按 IP/client 拦截重复写入;但**访客本人已提交过就无需再选**(客户端门控 + `client` 标识 + `mine` 查询) |

决策 4 带来一个新能力:**访客能读回自己提交的内容**。这是靠一个匿名 `client` 标识
(浏览器 localStorage 里的 UUID)实现的 —— 它不是安全机制,只是 UX 机制。

---

## 1. 术语与命名

| 名词 | 含义 | 示例 |
|---|---|---|
| `site` | 站点命名空间,由发布域名推导出的 slug | `tool-steam-65311718` |
| `collection` | 站点内的数据集合(等同"一张表") | `votes`、`guestbook` |
| `record` | 一条记录,`data` 是任意 JSON 对象 | `{ "choice": "A" }` |
| `client` | 访客匿名标识(UUID),用于读回自己的记录 | `5f3a1c2e-...` |
| `data-host` | 后端公网地址 | `https://data.example.com` |

**slug 推导规则**:取**完整 hostname**(仅去掉开头的 `www.`),然后 —— 小写、
非 `[a-z0-9-]` 替换为 `-`、连续 `-` 合并、首尾去 `-`、截断到 64 字符。

```
tool-steam-65311718.figma.site  →  tool-steam-65311718-figma-site
www.my-shop.com / my-shop.com   →  my-shop-com      (同一站点,同一命名空间)
a.b.example.com                 →  a-b-example-com
```

规则刻意**不依赖 Public Suffix List**、也不猜测"哪部分是域名"——只做纯字符串规范化,
因此任意域名下都确定且无碰撞。

- `site` / `collection`:`^[a-z0-9][a-z0-9-]{0,63}$`
- 字段名(用于 `stats` 白名单):`^[A-Za-z_][A-Za-z0-9_]{0,31}$`
- `client`:`^[A-Za-z0-9_-]{8,64}$`

---

## 2. 通用约定

### 2.1 基础

```
Base URL : https://<data-host>/api/v1
编码     : UTF-8
请求体   : application/json(仅 POST/PUT)
响应体   : application/json
```

### 2.2 响应信封

成功 `{ "ok": true, ... }`;失败:

```json
{ "ok": false, "error": { "code": "RATE_LIMITED", "message": "请求过于频繁,请稍后再试" } }
```

`message` 是**面向访客的中文提示**,注入的运行时可直接展示;`code` 供程序判断。

### 2.3 错误码

| HTTP | code | 含义 |
|---|---|---|
| 400 | `BAD_REQUEST` | JSON 非法 / `data` 不是对象 / 字段超限 |
| 403 | `ORIGIN_DENIED` | 来源不在该站点白名单内 |
| 404 | `SITE_NOT_FOUND` | `site` 未注册 |
| 404 | `COLLECTION_NOT_FOUND` | 集合不存在(读操作) |
| 405 | `METHOD_NOT_ALLOWED` | — |
| 413 | `PAYLOAD_TOO_LARGE` | `data` 超过 4 KB |
| 429 | `RATE_LIMITED` | 触发限流,带 `Retry-After` |
| 429 | `QUOTA_EXCEEDED` | 集合达到条数/字节上限 |
| 503 | `DISABLED` | 站点或集合被管理员停用 |
| 500 | `INTERNAL` | 服务内部错误 |

### 2.4 写请求约束(服务端强制)

| 约束 | 值 |
|---|---|
| `data` 必须是 JSON 对象 | 不允许数组/标量/`null` |
| `data` 顶层字段数 | ≤ 16 |
| `data` 序列化后大小 | ≤ 4 KB |
| 单个字符串值长度 | ≤ 500 字符 |
| 嵌套深度 | ≤ 3 |
| `client` | 可选;必须匹配 `^[A-Za-z0-9_-]{8,64}$` |

### 2.5 版本与兼容

- 路径带 `/v1`;破坏性变更走 `/v2`,旧版保留 ≥ 6 个月
- 响应**允许新增字段**,客户端必须忽略未知字段

---

## 3. 公开 API

供注入静态页面的运行时调用,无需密钥 —— **设计上假定任何人都能调用**。

### 3.1 追加记录

```
POST /api/v1/{site}/{collection}
```

```json
{
  "data": { "choice": "A" },
  "client": "5f3a1c2e-8b7d-4a91-9c3e-2f1d4b6a8c0e",
  "meta": { "page": "index" }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `data` | ✅ | 业务数据 |
| `client` | ❌ | 访客匿名标识;用来支持"读回自己的记录" |
| `meta` | ❌ | 页面标识等排查信息,不计入业务数据、不参与统计 |

响应 `201`:

```json
{ "ok": true, "id": 1024, "createdAt": "2026-10-09T03:12:45.123Z", "replaced": false }
```

- 集合**首次写入时自动创建**,默认 `mode: "append"`
- **不做去重**:重复写入一律新增(按决策 4,由前端门控)
- 当集合是 `mode: "single"`(见 4.2)时,同一 `client` 的旧记录被**替换**,
  响应 `replaced: true`;无 `client` 时退化为追加
- `client` 以 `sha256(站点盐 + client)` 存储,**不落原文**(见 5)

### 3.2 列出记录

```
GET /api/v1/{site}/{collection}?limit=20&order=desc&since=<ISO8601>&fields=choice
```

| 参数 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `limit` | 20 | 1–100 | 返回条数 |
| `order` | `desc` | `desc`\|`asc` | 按 `id` 排序 |
| `since` | — | ISO8601 | 只返回该时间之后创建的记录 |
| `fields` | — | 逗号分隔 | 只返回 `data` 中这些字段 |

响应 `200`:

```json
{
  "ok": true,
  "items": [ { "id": 1024, "data": { "choice": "A" }, "createdAt": "2026-10-09T03:12:45.123Z" } ],
  "total": 1234,
  "hasMore": true
}
```

**公开列表不返回 `client`**(避免泄露他人标识)。

### 3.3 查询"我的记录"（决策 4 的核心）

```
GET /api/v1/{site}/{collection}/mine?client=<uuid>&limit=20
```

响应同 3.2。用于回答"我提交过了吗?":

```json
{ "ok": true, "items": [], "total": 0, "hasMore": false }
```

- 无记录 → 前端展示选择/提交界面
- 有记录 → 前端展示"你已提交"并隐藏/禁用提交控件,必要时回显内容
- 仅返回**该 `client` 自己的**记录;`client` 猜中别人的标识是可能的,
  但它不是安全边界(数据本来就公开),只是 UX 机制

### 3.4 字段聚合(投票 / 词云的核心)

```
GET /api/v1/{site}/{collection}/stats?field=choice&limit=10&since=<ISO8601>
```

| 参数 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `field` | **必填** | — | 按 `data` 的哪个字段分组;过白名单校验 |
| `limit` | 10 | 1–100 | 返回桶数 |
| `since` | — | ISO8601 | 统计窗口起点 |

响应 `200`:

```json
{
  "ok": true,
  "field": "choice",
  "total": 1234,
  "buckets": [ { "key": "A", "count": 700 }, { "key": "B", "count": 534 } ]
}
```

- 按 `count` 降序,同数按 `key` 升序 ⇒ **结果稳定**(同输入同输出)
- 缺该字段的记录归入 `key: null`
- `total` 是参与统计的记录数(受 `since` 影响)

> 词云 `field=text&limit=40`、投票 `field=choice&limit=10` 都用这一个接口。

### 3.5 健康检查

```
GET /api/v1/health
```

```json
{ "ok": true, "version": "1.0.0", "uptimeSec": 86400 }
```

供软件「测试连接」使用,无鉴权、无限流。

---

## 4. 管理 API

供软件**发布时注册站点**、以及你日常**查看/清理/风控**使用。

### 4.1 鉴权

```
Authorization: Bearer <adminToken>
```

`adminToken` 由后端首次启动生成并写入 `data/config.json`(同时打印到日志);
软件端存入现有 `safeStorage` 加密配置(与 1Panel API Key 同级)。

### 4.2 注册 / 更新站点(幂等)

```
PUT /api/v1/admin/sites/{site}
```

```json
{
  "origins": ["https://tool-steam-65311718.figma.site", "https://*.tool-steam.example.com"],
  "note": "医院导览站",
  "quota": { "maxRecordsPerCollection": 100000, "maxBytesPerCollection": 52428800 },
  "collections": {
    "votes": { "mode": "append", "writeFields": ["choice"] },
    "profile": { "mode": "single", "writeFields": ["name", "avatar"] }
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `origins` | ✅ | 允许的来源,支持 `https://*.example.com` 通配(规则见 6.4) |
| `collections` | ❌ | 集合声明;未声明的集合在首次写入时按 `mode: "append"` 自动创建 |
| `mode` | ❌ | `append`(默认)/ `single`(每 client 一条,后写覆盖) |
| `writeFields` | ❌ | 只允许写入这些字段,其他字段被丢弃(可选收紧) |

响应 `200`:

```json
{ "ok": true, "site": { "site": "tool-steam-65311718", "origins": ["..."], "createdAt": "..." } }
```

- **写入要求站点已注册**(未注册 `404 SITE_NOT_FOUND`),避免命名空间被占用
- 软件每次发布成功后自动调用,域名变化时同步更新 `origins`
- 同名重复调用 = 更新,不报错

### 4.3 站点管理

```
GET    /api/v1/admin/sites                      列出站点(含每站条数/字节)
DELETE /api/v1/admin/sites/{site}               删除站点及其全部数据
POST   /api/v1/admin/sites/{site}/disable       停用(所有公开接口返回 503)
POST   /api/v1/admin/sites/{site}/enable        恢复
```

### 4.4 集合管理

```
GET    /api/v1/admin/{site}/collections
PATCH  /api/v1/admin/{site}/{collection}        改 mode / writeFields / disabled
DELETE /api/v1/admin/{site}/{collection}        清空集合
```

### 4.5 记录管理

```
GET    /api/v1/admin/{site}/{collection}?limit=100&offset=0
DELETE /api/v1/admin/{site}/{collection}/{id}   删除单条(封禁某条留言)
GET    /api/v1/admin/stats                      全站概览
```

管理端列表额外返回 `meta` 与 `clientHash`,便于风控定位。

---

## 5. 数据模型(SQLite)

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE sites (
  slug        TEXT PRIMARY KEY,
  origins     TEXT NOT NULL,             -- JSON 数组
  note        TEXT,
  quota       TEXT,                      -- JSON 或 NULL
  salt        TEXT NOT NULL,             -- 每站点独立,用于 client 哈希
  disabled    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE collections (
  site        TEXT NOT NULL,
  name        TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'append',   -- append | single
  write_fields TEXT,                            -- JSON 数组或 NULL
  count       INTEGER NOT NULL DEFAULT 0,       -- 冗余计数
  bytes       INTEGER NOT NULL DEFAULT 0,
  disabled    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (site, name)
);

CREATE TABLE records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site        TEXT NOT NULL,
  collection  TEXT NOT NULL,
  data        TEXT NOT NULL,             -- JSON 对象
  meta        TEXT,                      -- JSON 或 NULL
  client_hash TEXT,                      -- sha256(站点盐 + client),不存原文
  ip_hash     TEXT,                      -- 加盐哈希,不存明文 IP
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_records_list   ON records (site, collection, id DESC);
CREATE INDEX idx_records_client ON records (site, collection, client_hash);
```

**`stats` 实现要点**

```sql
SELECT json_extract(data, ?) AS k, COUNT(*) AS n
FROM records
WHERE site = ? AND collection = ? [AND created_at >= ?]
GROUP BY k
ORDER BY n DESC, k ASC
LIMIT ?;
```

`json_extract` 的路径**必须作为绑定参数传入**,字段名先过白名单正则 —— 否则是 SQL 注入。

**`mode: "single"` 的写入**在单个事务内:

```sql
DELETE FROM records WHERE site=? AND collection=? AND client_hash=?;
INSERT INTO records (...) VALUES (...);
```

---

## 6. 限流、配额与风控

### 6.1 限流(滑动窗口)

| 接口 | 按站点 | 按 IP 哈希 |
|---|---|---|
| `POST /{site}/{collection}` | 60 / 分钟 | 20 / 分钟 |
| `GET  /{site}/{collection}` | 600 / 分钟 | 120 / 分钟 |
| `GET  /{site}/{collection}/mine` | 120 / 分钟 | 40 / 分钟 |
| `GET  /{site}/{collection}/stats` | 300 / 分钟 | 60 / 分钟 |

超限 `429` + `Retry-After: <秒>`。IP 哈希用**每日轮换的盐**(当天有效、跨天不可关联);
`client_hash` 用**每站点固定盐**(必须跨天可匹配)。

### 6.2 配额(**永久保留下的唯一增长闸门**)

- 每集合默认:10 万条 / 50 MB(站点级可覆盖)
- 达到上限 → `429 QUOTA_EXCEEDED`,**绝不静默丢数据**
- 无 TTL、无自动清理(按决策 2),因此必须:
  - 管理端能看到每集合的条数/字节
  - 定期备份 `data.sqlite`
  - 需要时人工清空(4.4)

> ⚠️ 永久保留 + 无审批 + 公开写入 = **磁盘只会涨**。配额告警应作为运维项。

### 6.3 安全模型 —— 必须理解的边界

| 能防住 | 防不住 |
|---|---|
| 其他网站盗用你的后端(Origin 白名单) | 任何人直接 `curl` 你的接口 |
| 未注册的 slug 写入 | 复制页面里的 slug 灌数据 |
| 超大 payload、超频调用 | 分布式慢速灌水 |
| 事后删除单条/清空集合 | 清除 localStorage 后重复投票(决策 4 已接受) |

**写入接口本质上公开**。防护只有「限流 + 配额 + 事后清理 + 停用开关」,
不存在鉴权。因此:**不要存敏感数据**,所有记录任何人可读。

### 6.4 CORS 与来源通配

- `Access-Control-Allow-Origin`:仅当请求 `Origin` 命中该站点 `origins` 时**回显**
- `Access-Control-Allow-Methods`: `GET, POST, OPTIONS`
- `Access-Control-Allow-Headers`: `Content-Type`
- **不启用** `Access-Control-Allow-Credentials`(全程无 Cookie)
- 必须正确响应 `OPTIONS` 预检

**匹配规则(按决策 3)**

| 模式 | 匹配 | 不匹配 |
|---|---|---|
| `https://a.example.com` | 仅该来源 | `https://b.example.com` |
| `https://*.example.com` | `https://a.example.com`、`https://a.b.example.com` | `https://example.com`(**裸域不匹配,需单独列**) |
| 协议 | 必须完全一致(一律 `https`) | — |
| 端口 | 显式写了才校验 | — |

> 🔴 **通配的风险**:`https://*.figma.site` 会放行**所有** Figma 站点,
> 等于把后端开放给全世界。软件在遇到通配时应**明确警告并二次确认**;
> 只在你确实拥有整个域名时才用通配。

---

## 7. 页面侧运行时契约

构建时 `databind.mjs` 注入的运行时按下面的方式工作。

```html
<script>window.__DATA_API__ = "https://data.example.com/api/v1";</script>
```

### 7.0 站点 slug 由浏览器自己推导(重要)

**页面不需要被写死站点名** —— 它从自己所在的域名推导,规则与第 1 节完全一致:

```js
function slugify(host) {
  return String(host || "")
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");        // 截断后可能留下尾部 "-"
}
var Site = slugify(location.hostname);
```

已验证的样本:

| hostname | slug |
|---|---|
| `tool-steam-65311718.figma.site` | `tool-steam-65311718-figma-site` |
| `www.my-shop.com` / `my-shop.com` | `my-shop-com`(两者一致) |
| `WWW.Example.COM` | `example-com` |
| `shop.example.com:8080` | `shop-example-com-8080` |
| `""`(`file://` 预览) | `""` → 运行时**跳过网络请求**,只显示 `fallback` |

这样做的好处:

| 好处 | 说明 |
|---|---|
| **零构建配置** | 构建时只需知道后端地址,不需要知道将来发布到哪个域名 |
| **一包多域** | 同一份产物发布到 `a.com` / `b.com`,各自成为独立命名空间,无需重新构建 |
| **与发布注册天然一致** | 软件在发布时对同一个域名跑同一个 `slugify`,注册出的 slug 必然相同 |

⚠️ **这个函数必须与服务端、软件端三处完全一致** —— 它是命名空间的唯一来源,
不一致会导致"页面找不到自己的数据"。实现时应放在共享模块里并加单元测试
(同一批域名样本,三处输出必须相同)。

本地预览(`file://`)没有 hostname → slug 为空 → 运行时跳过网络请求、
直接展示 `fallback` 静态内容(不报错)。

### 7.1 匿名标识

```js
// 每个站点一个 key，避免跨站关联
var KEY = "__dc_" + Site;
var client = localStorage.getItem(KEY);
if (!client) {
  client = crypto.randomUUID();          // 回退: 随机 16 字节 hex
  localStorage.setItem(KEY, client);
}
```

`localStorage` 是**按来源隔离**的,所以这个标识不会跨站跟踪 —— 这一点要在隐私说明里写明。

### 7.2 "已提交则不再要求提交"(决策 4)

```js
// 1) 先看自己有没有提交过
const mine = await fetch(`${API}/${Site}/${Coll}/mine?client=${client}`).then(r => r.json());
if (mine.items.length) {
  renderSubmitted(mine.items[0].data);   // 回显自己的内容
  // 隐藏/禁用提交控件，不再询问
  return;
}
// 2) 没提交过 → 展示选择/提交界面
```

### 7.3 读取聚合(投票条 / 词云)

```js
const r = await fetch(`${API}/${Site}/votes/stats?field=choice&limit=10`).then(r => r.json());
// r.buckets → [{key, count}] → 渲染占比条
// 词云: buckets → words: [{ text: b.key, weight: b.count }]
//       复用现有 window.renderWordCloud(canvas, layout)
```

### 7.4 写入

```js
await fetch(`${API}/${Site}/votes`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ data: { choice: "A" }, client, meta: { page: "index" } }),
});
```

### 7.5 优雅降级(必须实现)

1. 构建时把 `fallback` 静态数据写进 HTML → 首屏立即可见
2. 运行时拉取;成功则替换,**失败保留 fallback**
3. 写失败时展示 `error.message`(已是中文),不阻塞页面其他交互
4. `localStorage` 不可用(隐私模式)→ 退化为"每次都可提交",不报错

### 7.6 轮询

- 默认 `refreshMs: 10000`,且**仅在标签页可见时**轮询(`visibilitychange`)
- 写成功后立即刷新一次
- 严禁无上限 `setInterval`

---

## 8. 部署拓扑(1Panel)

```
1Panel 服务器
├─ OpenResty
│   ├─ tool-steam-....figma.site   → 静态站点(已发布)
│   └─ data.example.com            → 反向代理 → 127.0.0.1:3210
│
└─ data-api(systemd 或 1Panel Node 环境托管,单进程)
    ├─ server.mjs
    └─ /opt/data-api/data/{config.json, data.sqlite}
```

- **必须单进程**(SQLite 写串行化的前提),`Restart=always`
- `data.example.com` 的证书用本工具已有的那条链路申请(1Panel 申请证书 + 启用 HTTPS)
- 备份:WAL 模式下用 `sqlite3 data.sqlite ".backup out.sqlite"`,**不要直接复制文件**

### 8.1 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3210` | 监听端口 |
| `DATA_DIR` | `./data` | SQLite 与配置目录 |
| `TRUST_PROXY` | `1` | 反代后必须开(读取 `X-Forwarded-For`) |
| `LOG_LEVEL` | `info` | — |

### 8.2 SQLite 驱动

**使用 Node 内置的 `node:sqlite`**(已实测):Node 24 无需任何开关,`DatabaseSync`
的 `prepare/run/all/get` 与 `json_extract` 的**绑定路径参数**都可用。

- ✅ **零运行时依赖** —— 部署只需 Node 与几个 `.mjs` 文件
- ⚠️ 会打印 `ExperimentalWarning`,启动脚本里可用 `--no-warnings=ExperimentalWarning` 抑制
- ⚠️ 它是实验特性,升级 Node 前先在测试环境跑一遍;SQLite **文件格式**是稳定的,
  风险只在 API 层

### 8.3 软件侧需要配置什么

**需要,但只有两项,且一次性**:

| 配置项 | 必填 | 存放 | 用途 | 是否进入生成的页面 |
|---|---|---|---|---|
| 后端地址 `baseUrl` | ✅ | 软件配置(明文) | 构建时注入 `__DATA_API__`;发布时注册站点 | ✅ 是(公开信息) |
| Admin Token | ✅ | 软件配置(**safeStorage 加密**) | 发布时注册站点 + 管理操作 | ❌ **绝不**注入页面 |
| 站点 slug | ❌ | — | **不需要配置**,见 7.0 | ✅ 由运行时推导 |

- **UI 位置**:与现有 1Panel 发布设置同一处,新增「数据后端」分组
  (地址 + Admin Token + 测试连接按钮)
- **Admin Token 来源**:后端首次启动时打印到日志,并写入 `data/config.json`
- **未配置时**:整个功能关闭,构建不注入任何脚本,行为与现在完全一致
  (纯增量,不影响已有流程)
- **测试连接**:调 `GET /api/v1/health` + 一次 `GET /admin/sites` 验证 token

> 🔴 **Admin Token 绝对不能写进生成的页面**。它只存在于软件配置里;
> 页面拿到的只有公开的后端地址和数据接口本身。

---

## 9. 示例

```bash
# 健康检查
curl https://data.example.com/api/v1/health

# 注册站点(管理端,含集合声明)
curl -X PUT https://data.example.com/api/v1/admin/sites/tool-steam-65311718 \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"origins":["https://tool-steam-65311718.figma.site"],
       "collections":{"votes":{"mode":"append"},"profile":{"mode":"single"}}}'

# 投票(带 client)
curl -X POST https://data.example.com/api/v1/tool-steam-65311718/votes \
  -H "Content-Type: application/json" \
  -H "Origin: https://tool-steam-65311718.figma.site" \
  -d '{"data":{"choice":"A"},"client":"5f3a1c2e-8b7d-4a91-9c3e-2f1d4b6a8c0e"}'

# 我提交过吗?
curl "https://data.example.com/api/v1/tool-steam-65311718/votes/mine?client=5f3a1c2e-8b7d-4a91-9c3e-2f1d4b6a8c0e"

# 看票数
curl "https://data.example.com/api/v1/tool-steam-65311718/votes/stats?field=choice&limit=10"
```

---

## 10. 与现有工具链的衔接

| 环节 | 改动 |
|---|---|
| 新增 `databind.mjs` | 对齐 `wordcloud.mjs`:纯函数生成注入片段 + 浏览器运行时(含 7.1–7.6) |
| 新增 `databinds.json` | 与 `wordclouds.json` 同级、同生命周期的 overlay 文件 |
| 新增 AI 工具 `bind_data` | 写 `databinds.json`,走现有"确认后应用"流程 |
| `build.mjs` | 消费 `databinds.json`,注入 `__DATA_API__` / `__DATA_SITE__` |
| `publish.mjs` | 发布成功后 `PUT /admin/sites/{site}` 注册/更新来源与集合声明 |
| GUI 设置 | 新增「数据后端」分组:地址 + Admin Token + 测试连接 |

---

## 11. 风险与边界

| 风险 | 说明 | 缓解 |
|---|---|---|
| 🔴 **公开写入可被刷** | 静态页面无秘密 | 限流 + 配额 + 停用开关 + 管理端删除 |
| 🔴 **永久保留 + 无审批** | 磁盘只涨;垃圾内容立即公开 | 配额告警、定期备份、人工清理 |
| 🟠 **通配来源过宽** | `https://*.figma.site` 会放行所有 Figma 站点 | 软件二次确认 + 文档警示 |
| 🟠 **`client` 是持久标识** | localStorage UUID + 永久保留 = 可关联的访客标识 | 按站隔离、服务端只存哈希;隐私说明需提及 |
| 🟠 **单点故障** | 后端挂 → 所有站点动态功能失效 | 必须实现 7.5 优雅降级 |
| 🟡 **clear localStorage 可重复投票** | 决策 4 已接受 | 管理端可识别异常量级 |
| 🟡 **AI 生成客户端脚本** | 等于给 AI XSS 能力 | **坚持结构化 `bind_data`**,不让 AI 手写任意脚本 |
