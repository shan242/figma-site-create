# data-api — 生成的静态站点的数据后端

给工具生成的静态站点提供 **词云采集 / 按钮投票 / 留言** 等跨访客持久化能力。
一套后端服务所有站点,自己部署在 1Panel 服务器上。

- 接口契约:[../docs/data-api.md](../docs/data-api.md)
- 形态:**单 Node 进程 + 单 SQLite 文件**,零运行时依赖
- 存储:`node:sqlite`(Node 内置)

本文以你的实际域名举例:

| 角色 | 域名 |
|---|---|
| 后端 | `data.scopetest.net` |
| 发布的站点 | `scopetest.net`、`didsdi.com` … |

---

## 1. 要求

| 项 | 要求 |
|---|---|
| Node | **≥ 24**(`node:sqlite` 无需开关);22.5–23 需要 `--experimental-sqlite` |
| 系统 | Linux(1Panel 服务器),systemd |
| 端口 | 本机一个空闲端口(默认 3210),**不直接对外** |
| 反代 | 1Panel 的 OpenResty,把 `data.scopetest.net` 指到 `127.0.0.1:3210` |

> **单进程是硬要求**:SQLite 的写串行化依赖它。不要 PM2 cluster、不要多实例。

---

## 2. 安装

### 2.1 上传代码

把 `data-api/` 整个目录放到服务器,例如 `/opt/data-api`:

```bash
sudo mkdir -p /opt/data-api
# 从你本地 rsync / scp 上去,或用 git
sudo rsync -av --exclude node_modules ./data-api/ root@<server>:/opt/data-api/
```

没有 `node_modules` —— 运行时零依赖。

### 2.2 建专用用户与数据目录

```bash
sudo useradd --system --home /opt/data-api --shell /usr/sbin/nologin dataapi
sudo mkdir -p /opt/data-api/data
sudo chown -R dataapi:dataapi /opt/data-api
```

### 2.3 装 systemd 单元并启动

```bash
sudo cp /opt/data-api/deploy/data-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now data-api
sudo systemctl status data-api --no-pager
```

**首次启动会打印 Admin Token**(只打印这一次,之后可从 `data/config.json` 读):

```bash
sudo journalctl -u data-api -n 30 --no-pager
```

```
────────────────────────────────────────────────────────────
 首次启动,已生成管理令牌(Admin Token)
 把它填进软件「发布设置 → 数据后端」,此后不再需要:

   a3f9....(64 位 hex)

 该令牌只应保存在软件端,绝不能写进生成的网页。
────────────────────────────────────────────────────────────
```

随时取回:

```bash
sudo cat /opt/data-api/data/config.json | grep adminToken
```

### 2.4 本机自测

```bash
curl -s http://127.0.0.1:3210/api/v1/health
# {"ok":true,"version":"1.0.0","uptimeSec":12}
```

---

## 3. 1Panel 反向代理 + HTTPS

### 3.1 解析

把 `data.scopetest.net` 的 A 记录指向这台服务器。

### 3.2 建站(反代)

1Panel →「网站」→「创建网站」→ **反向代理**

| 项 | 值 |
|---|---|
| 主域名 | `data.scopetest.net` |
| 代理地址 | `http://127.0.0.1:3210` |

> 用「运行环境/反向代理」而不是「静态网站」,否则 1Panel 会在站点根目录找文件。

### 3.3 申请证书并启用 HTTPS

1Panel →「网站」→ 该站点 →「SSL」:

1. **申请证书**(Let's Encrypt,自动 DNS 验证即可,你已配好 DNS 账号)
2. 签发完成后**启用 HTTPS**,建议选「**HTTP → HTTPS 跳转**」

> 这套流程与本工具 GUI 里的「申请并启用 HTTPS」是同一件事,手在面板里做也行。

### 3.4 验证公网可达

```bash
curl -s https://data.scopetest.net/api/v1/health
```

### 3.5 nginx 必须透传真实 IP

限流按 IP 计数,反代后必须让后端拿到访客真实地址。1Panel 的反代默认会带
`X-Forwarded-For`;确认配置里有:

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header Host $host;
```

后端已默认 `TRUST_PROXY=1`,会读取 `X-Forwarded-For` 的第一段。
**若发现所有访客被算成同一个 IP(一两个人就触发限流),先查这里。**

---

## 4. 软件侧配置

「发布设置 → 数据后端」:

| 项 | 值 |
|---|---|
| 后端地址 | `https://data.scopetest.net` |
| Admin Token | 上面那串 64 位 hex |

点「测试连接」应返回成功。

之后发布任何站点时,软件会自动:

1. 按发布域名算出 slug(`scopetest.net` → `scopetest-net`)
2. `PUT /api/v1/admin/sites/{slug}` 注册来源白名单

**你不必手动注册站点。**

---

## 5. 配置项(环境变量)

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3210` | 监听端口 |
| `DATA_DIR` | `./data` | SQLite 与 config.json 的目录 |
| `TRUST_PROXY` | `1` | 反代后必须为 1;直连时设 `0` |
| `LOG_LEVEL` | `info` | `silent` 可关闭全部日志 |

改完 `systemctl daemon-reload && systemctl restart data-api`。

---

## 6. 运维

### 6.1 备份(**永久保留策略下尤其重要**)

WAL 模式下**不要直接复制** `data.sqlite` —— 会拿到不一致的快照。用 SQLite 的
在线备份:

```bash
sudo -u dataapi sqlite3 /opt/data-api/data/data.sqlite \
  ".backup '/opt/data-api/data/backup-$(date +%F).sqlite'"
```

若服务器没有 `sqlite3` CLI,可临时停服后复制三个文件
(`data.sqlite`、`-wal`、`-shm`)。

建议加一条 cron / 1Panel 计划任务做每日备份并异地留存。

### 6.2 查看用量

```bash
TOKEN=$(sudo python3 -c "import json;print(json.load(open('/opt/data-api/data/config.json'))['adminToken'])")
curl -s -H "Authorization: Bearer $TOKEN" https://data.scopetest.net/api/v1/admin/stats
# {"ok":true,"sites":2,"collections":3,"records":1234,"bytes":45678}
```

### 6.3 删除垃圾数据

```bash
# 列出某集合(带 id、clientHash,便于定位)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://data.scopetest.net/api/v1/admin/didsdi-com/votes?limit=50"

# 删单条
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" \
  https://data.scopetest.net/api/v1/admin/didsdi-com/votes/123

# 清空集合
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" \
  https://data.scopetest.net/api/v1/admin/didsdi-com/votes

# 停用整个站点(公开接口立即返回 503)
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  https://data.scopetest.net/api/v1/admin/sites/didsdi-com/disable
```

### 6.4 配额

默认每集合 **10 万条 / 50 MB**。达到上限时写入返回 `429 QUOTA_EXCEEDED`,
**不会静默丢数据**。注册时可以覆盖:

```bash
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  https://data.scopetest.net/api/v1/admin/sites/didsdi-com \
  -d '{"origins":["https://didsdi.com"],
       "quota":{"maxRecordsPerCollection":500000,"maxBytesPerCollection":209715200}}'
```

> ⚠️ 决策 ② 是**永久保留、无自动清理**。磁盘只会涨,所以请:
> 定期看 `admin/stats`、设置磁盘告警、保留备份。

---

## 7. 安全须知(务必读一遍)

| 能防住 | 防不住 |
|---|---|
| 其他网站盗用你的后端(来源白名单) | 任何人直接 `curl` 你的接口 |
| 未注册 slug 的写入 | 复制页面里的 slug 灌数据 |
| 超大 payload、超频调用 | 分布式慢速灌水 |
| 事后删单条 / 清空 / 停用 | 清除 localStorage 后重复投票(已接受) |

- **写入接口本质上是公开的** —— 防护只有「限流 + 配额 + 事后清理 + 停用开关」
- 🔴 **Admin Token 绝不能进生成的网页**,只存在软件配置里
- ⚠️ **来源白名单慎用通配**:`https://*.figma.site` 会放行**所有** Figma 站点,
  等于把后端开放给全世界。只在你确实拥有整个域名时才用通配

---

## 8. 排障

| 现象 | 排查 |
|---|---|
| `systemctl status` 起不来 | `journalctl -u data-api -n 50`;多为 Node 版本 < 22.5 |
| 页面控制台 `blocked by CORS policy` | 站点没注册,或注册的 origins 与实际域名不符。`GET /admin/sites` 核对 |
| 一两个人就触发 429 | nginx 没透传 `X-Forwarded-For`,所有访客算同一 IP |
| 写入返回 404 `SITE_NOT_FOUND` | 该域名还没在软件里发布过,或 slug 对不上(检查域名是否带 `www.` 差异) |
| 写入返回 503 | 站点或集合被停用,检查 `admin/sites` 的 `disabled` |
| 数据没涨但也没报错 | 前端拿的是 fallback;看浏览器网络面板确认请求是否发出 |

---

## 9. 本地开发

```bash
cd data-api
node server.mjs              # http://127.0.0.1:3210
node --test test/*.test.mjs  # 36 个契约用例
```

本地起服务时 `TRUST_PROXY=0`(没有反代),否则 `X-Forwarded-For` 是伪造的。
