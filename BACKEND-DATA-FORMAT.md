# 数据后端传输格式（data-api 协议）

> 这份文档描述**生成的页面**、**发布程序**与**数据后端**之间传输的每一个字段。
> 它由客户端代码（`replicate/databind.mjs`、`replicate/publish.mjs`）反推而来，
> 是后端必须满足的**契约**。实现后端时逐条对照即可。
>
> 本文只描述**线上形态**；本地 `file://` 预览用的是 `localStorage` 模拟，
> 但**读写语义与线上完全一致**（`localApi()` 就是这份协议的一份参考实现）。

---

## 1. 三个标识符

| 名字 | 含义 | 由谁推导 | 规则 |
|---|---|---|---|
| `site` | 站点命名空间 | **浏览器自己**，从 `location.hostname` | `slugify(hostname)` |
| `collection` | 集合（一个表格） | 构建期的 `databinds.json` | 只允许 `[a-z0-9-]`，由 `bind_data` 传入 |
| `client` | 匿名访客标识 | 浏览器，存 `localStorage` | UUID 字符串，按站点隔离 |

**`slugify` 必须逐字符一致**（后端 `data-api/slug.mjs`、发布程序 `publish.mjs` 的
`slugifySite`、页面里的 `databind.mjs` 三处）。`databind.test.mjs` 用同一批样本
同时比对三处，任何一处漂移都会让页面读到别人的数据。

```
slugify("kulangsu.site")               → "kulangsu-site"
slugify("www.kulangsu.site")           → "kulangsu-site"
slugify("creme-zipper-06745257.figma.site") → "creme-zipper-06745257-figma-site"
```

要点：小写、非字母数字折成 `-`、连续 `-` 压成一个、首尾 `-` 去掉、
**截断到 64 字符**（截断后再去一次尾部 `-`）。`www.` 前缀**先**剥掉。
逐字符实现：

```js
function slugify(host) {
  return String(host || "")
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}
```

> 站点命名空间由**浏览器**推导，不由构建期注入。
> 好处：同一份产物发到多个域名，各自成为独立命名空间，构建时不需要知道将来发到哪。

---

## 2. 公共响应信封

**所有**响应都是 JSON，都带 `ok`：

```jsonc
// 成功
{ "ok": true, /* …响应自己的字段… */ }

// 失败
{ "ok": false, "error": { "code": "SITE_NOT_FOUND", "message": "站点未注册" } }
```

**客户端判定失败的条件**（`databind.mjs` 的 `api()`）：

```
HTTP 状态非 2xx   → 失败
响应体不是 JSON   → 失败（当 null 处理）
data.ok === false → 失败
```

失败时**必须**给 `error.message` —— 客户端把它直接显示给访客 ✓
（`error.code` 会挂到 `Error.code` 上，供程序判断）。

> ⚠️ **HTTP 200 + `ok:false` 也是失败。** 后端可以这么返回业务错误
> （发布程序 `dataFetch()` 同样按这条判定）。

---

## 3. 页面 → 后端（公开接口，无鉴权）

所有路径都以 `{API}` 为前缀，`API` 形如 `https://data.scopetest.net/api/v1`
（构建时由 `--data-api` 或 `REPLICA_DATA_API` 注入到页面的 `window.__DATA_API__`）。

下面用 `P = {API}/{site}/{collection}` 简写。

### 3.1 写入一条记录

```http
POST {P}
Content-Type: application/json

{
  "data":   { "choice": "Lamp-Lighting Ritual", "note": "很震撼" },
  "client": "8f3c1a2e-…"
}
```

**响应**

```jsonc
{ "ok": true, "id": "可选;记录 id,客户端目前不读" }
```

**字段约束**

| 字段 | 必填 | 约束 |
|---|---|---|
| `data` | **是** | **扁平 JSON 对象**。键 = 字段名，值 = 字符串/数字/布尔 |
| `client` | 否 | 匿名访客 id；缺省时后端应自行分配或记为 `null`。**不要**用它做去重（见 §6） |

**`data` 必须是扁平的** —— 后端按字段名分桶统计（`/stats?field=X`），
嵌套对象没法当桶的键。客户端只会写**一层**键值对。

**值建议用字符串。** 统计时后端要把值**转成字符串**当键：
数字 `4` 和字符串 `"4"` 会落进同一个桶，但布尔 `true` 会变成 `"true"` ——
如果同一个人有时写 `true` 有时写 `"true"`，桶会合并不出问题，
但**同一语义请始终用同一种类型**，否则前端显示会出现 `4` 和 `"4"` 两个桶。

**空值**：值为 `null` 或 `undefined` 的键，后端应当**保留记录但跳过统计**
（`localApi` 的行为：`k` 为空串则 `continue`，不计入任何桶）。

### 3.2 列出记录

```http
GET {P}?limit=20
```

```jsonc
{ "ok": true, "items": [ { "data": { "choice": "…" }, "client": "…", "at": 1730000000000 } ] }
```

客户端只读 `items[].data`（`kind:"list"` 的渲染用它）。

### 3.3 查"这个访客提交过什么"

```http
GET {P}/mine?client={client}
```

```jsonc
{ "ok": true, "items": [ { "data": { "choice": "…" } } ] }
```

- **有记录 = 这个访客提交过** → 页面据此回显并禁用再次提交（`perVisitor:"once"`）。
- 客户端**只看 `items` 是否非空**，不关心内容。
- `client` 需要 URL 编码。

> **性能要求（重要）**：同一页可能有几十条绑定指向**同一个 collection**。
> 客户端已按 URL 做并发合并 + 4 秒 TTL 复用，但后端仍应当让这个接口**足够便宜**
> —— 实测 kokangsu.site 一页 25 条绑定，未去重时页面加载会打 25 次。

### 3.4 统计（词云 / 柱状图的数据源）

```http
GET {P}/stats?field={字段名}&limit=12
```

```jsonc
{
  "ok": true,
  "field": "choice",
  "total": 37,
  "buckets": [
    { "key": "Lamp-Lighting Ritual", "count": 6 },
    { "key": "Building Ancestral Halls", "count": 5 }
  ]
}
```

**字段语义（逐条都有前端依赖）**

| 字段 | 含义 | 约束 |
|---|---|---|
| `field` | 回显查询的字段名 | 不校验也可以，但建议回显 |
| `total` | **该 collection 的**记录总数 | **不是** buckets 的 count 之和。柱状图用 `count/total` 算占比 |
| `buckets[]` | `{key, count}` | **按 count 降序** |
| `key` | 字段的**字符串**值 | 可以是 `null`（前端显示"(未选)"） |
| `count` | 正整数 | |

**三条硬约束**

1. **必须按 `count` 降序返回。** 客户端**不再排序** —— 它把 buckets 直接交给
   布局/渲染。词云按数组顺序决定字号与颜色深浅（第 1 个拿 `colors[0]`，
   也就是最深的那一档）。顺序错了，词云会"投得越多颜色越浅"。
2. **`limit` 必须生效**，并且是"取**最多的** N 个"而不是"前 N 行"。
3. **只返回有票的桶。** 票数为 0 的选项**不要**返回 —— 前端用
   `databinds` 里的 `fallback.buckets`（全 0 的选项表）与它**合并**，
   自己补上"还没人投的选项"。后端如果返回 0 票的桶，会与合并逻辑打架。

### 3.5 计数（参与人数）

```http
GET {P}?field=id&limit=1
```

```jsonc
{ "ok": true, "total": 37, "field": "id" }
```

`kind:"counter"` 用 `total`。注意这与 §3.4 的 `/stats` 是**两个不同路径**：
带 `/stats` 走分桶，不带的走总数。

---

## 4. 发布程序 → 后端（管理接口，需鉴权）

鉴权：`Authorization: Bearer {adminToken}`。
**Admin Token 绝不进生成的页面** —— 页面只拿到公开的后端地址。

### 4.1 健康检查

```http
GET {API}/health
```
```jsonc
{ "ok": true, "version": "1.2.0" }
```

### 4.2 列出站点

```http
GET {API}/admin/sites
```
```jsonc
{ "ok": true, "sites": [ { "site": "kulangsu-site", "origins": ["https://kulangsu.site"] } ] }
```

### 4.3 注册 / 更新站点（幂等）

```http
PUT {API}/admin/sites/{site}
Content-Type: application/json

{
  "origins": [ "https://kulangsu.site", "https://www.kulangsu.site" ],
  "collections": {
    "voices":        { "mode": "append" },
    "q1-understand": { "mode": "single" }
  }
}
```

```jsonc
{ "ok": true, "site": { "origins": ["https://kulangsu.site", "…"] } }
```

**`origins`** —— 域名白名单。后端对**不在白名单里的 `Origin` 请求必须拒绝**
（CORS 与业务两层都要）。发布程序默认只放行该域名及其 `www` 变体，
**不自动加通配** —— 通配共享托管域（`*.figma.site`）等于把后端开放给全世界。

**`collections[].mode`**

| mode | 语义 |
|---|---|
| `append` | 每次提交都是**新的一条记录**（默认）。投票/问卷用这个 |
| `single` | 同一 `client` 的记录**后写覆盖前写**。适合"每个人的个人内容" |

> 同一个集合被多处绑定时，取**更严格**的那个（有一处要 `single` 就整体 `single`）。

**后端对未注册站点一律回 `SITE_NOT_FOUND`。** 页面上这只表现为
"投票点了没反应"，所以发布程序在**上传之前**就会提醒。

---

## 5. 构建产物：`databinds.json`

后端不读它，但后端的**集合声明**和页面的**读取方式**都由它推导。
写后端时用它对照"页面会怎么查"：

```jsonc
{
  "version": 1,
  "items": [
    {
      "id": "q1-cloud",
      "slug": "chapter-4",
      "collection": "q1-understand",
      "kind": "wordcloud",                  // wordcloud | bar | counter | list | action
      "rect": { "left": 130, "top": 1765, "width": 1180, "height": 540 },
      "read": { "groupBy": "choice", "limit": 12, "refreshMs": 8000 },
      "options": {
        "colors": ["#3a2609", "…"],         // 深 → 浅；第 1 名拿 colors[0]
        "maxFont": 30, "minFont": 12, "maxWords": 12,
        "reveal": "submit",                 // 提交前藏着，提交后展开
        "empty": "还没有人提交…", "done": ""
      },
      "fallback": {                          // 后端不可用时画这个
        "buckets": [ { "key": "Lamp-Lighting Ritual", "count": 0 }, "…" ],
        "total": 0
      }
    },
    {
      "id": "q1-submit",
      "collection": "q1-understand",
      "kind": "action",                      // 只写不读
      "write": { "event": "click", "target": "40:2389", "field": "choice", "submitAll": true }
    }
  ]
}
```

**`kind` 与后端的关系**

| kind | 读的接口 | 写的接口 |
|---|---|---|
| `wordcloud` / `bar` | `GET /stats?field={read.groupBy}&limit={read.limit}` | — |
| `counter` | `GET ?field={read.groupBy}&limit=1` | — |
| `list` | `GET ?limit={read.limit}` | — |
| `action` | **不读**（不轮询） | `POST` |

**`write.field` 必须与 `read.groupBy` 是同一个字段名** —— 否则各写各的，
统计永远读不到票。这是最常见的配置错误。

**`fallback` 的 `count` 必须全 0。** 它是"还没有任何人投票"时的样子；
填了非 0 的数字，访客在后端不可用（以及本地预览）时看到的是**编造的统计结果**。

---

## 6. 明确**不做**的事（后端不要实现）

| 事情 | 为什么 |
|---|---|
| **按 `client` 去重** | 去重是**前端**的职责：它查 `/mine` 决定要不要拦。服务端不做去重（按设计）—— 清掉 `localStorage` 即可重投，这是**已知且接受**的边界 |
| **在 `data` 里塞 `__client` / `__at`** | 那是**本地模拟**的实现细节（`localApi` 把元数据混在记录里）。线上记录应当是 `data` + 独立的元数据字段 |
| **鉴权公开接口** | 页面是静态的，任何人可访问。公开接口**故意无鉴权**，靠 `origins` 白名单限定来源 |
| **返回 0 票的桶** | 见 §3.4 第 3 条 |

---

## 7. 本地模拟（`localApi`）—— 协议的参考实现

`file://` 打开时 `location.hostname` 是空的，`ONLINE` 为 false，客户端改走
`localStorage`。**它不是另一套逻辑**，而是这份协议的一份最小实现，
可以用来核对后端行为：

```
POST  {P}                     → 往 localStorage["__dl__{P}"] 追加 {…data, __client, __at}
GET   {P}/mine?client=X       → 过滤 __client === X，包成 {ok, items:[{data}]}
GET   {P}/stats?field=F&limit=N → 按 F 的值分桶、count 降序、切前 N，返回 {ok, field, total, buckets}
GET   {P}?field=F&limit=1     → {ok, total, field}
```

语义要点与线上一致：**空值不计入桶**、**buckets 按 count 降序**、
**`total` 是全部记录数**。

> 本地与线上**必须长得一模一样** —— 所以页面上**不要**出现"本地预览"之类的标记。
> 要提示就写控制台。

**本地模拟与线上的一处历史差异（已修）**：`kind:"list"` 读的是 `items`，
而 `localApi` 早先那一支只返回 `total`/`field` —— 于是 `file://` 打开时列表
**永远是空的**，线上却是好的。现在按"带 `limit` 走列表、带 `field` 走计数"
区分，与上面两个不同路径对应。**后端实现时请照本文的 §3.2 / §3.5，
不要照本地模拟的分支条件。**

---

## 8. 一次完整往返（照这个测后端）

```
1. 访客打开 https://kulangsu.site/chapter-4.html
   → GET  /api/v1/kulangsu-site/q1-understand/mine?client=8f3c1a2e-…
   ← { ok:true, items:[] }                        （没投过）

2. 页面立刻问统计
   → GET  /api/v1/kulangsu-site/q1-understand/stats?field=choice&limit=12
   ← { ok:true, field:"choice", total:0, buckets:[] }
   → 前端把 buckets 与自己 fallback 的 12 个选项合并 → 12 个词全按最小字号铺开

3. 访客点选 3 个选项（只打 data-db-selected，**不写后端**），点 Submit
   → POST /api/v1/kulangsu-site/q1-understand   { data:{choice:"Lamp-Lighting Ritual"}, client:"…" }
   → POST /api/v1/kulangsu-site/q1-understand   { data:{choice:"Building Ancestral Halls"},  client:"…" }
   → POST /api/v1/kulangsu-site/q1-understand   { data:{choice:"Stealing White Radishes"},   client:"…" }
   ← { ok:true }  ×3
   （**每个选项一条记录**。合成一条只会被算成一个词）

4. 提交成功 → 页面展开词云，立刻再问一次统计
   → GET  /api/v1/kulangsu-site/q1-understand/stats?field=choice&limit=12
   ← { ok:true, total:3, buckets:[
         { key:"Lamp-Lighting Ritual",   count:1 },
         { key:"Building Ancestral Halls", count:1 },
         { key:"Stealing White Radishes",  count:1 } ] }

5. 访客刷新页面
   → GET  …/mine?client=8f3c1a2e-…   ← { ok:true, items:[{data:{…}},{…},{…}] }
   → 非空 ⇒ 已提交 ⇒ 词云**直接展开**，且不再要求提交
```

---

## 9. 实现后端时的检查清单

- [ ] `slugify` 与 `databind.mjs` / `publish.mjs` 三处逐字符一致
- [ ] 所有响应形如 `{ok:true,…}` / `{ok:false,error:{code,message}}`
- [ ] `/stats` 的 buckets **按 count 降序**、**只含有票的桶**、`limit` 取最多的 N 个
- [ ] `/stats` 的 `total` 是**集合总记录数**，不是 buckets 之和
- [ ] POST 的 `data` 按**字段名**分桶统计；空值不计入桶
- [ ] `/mine` 只按 `client` 过滤，**不做去重**
- [ ] `origins` 白名单之外一律拒绝（CORS 与业务两层）
- [ ] 未注册站点回 `SITE_NOT_FOUND`
- [ ] 公开接口**无鉴权**；管理接口要 `Bearer {adminToken}`
- [ ] 支持 `collections[].mode` 的 `append` / `single`
- [ ] 字符集 UTF-8；中文键值原样存取（`encodeURIComponent` 由客户端负责）
