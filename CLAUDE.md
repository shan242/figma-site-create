# Figma Sites → Static Replica

Turn any **published** `*.figma.site` site into a pixel-faithful static HTML/CSS site.
Paste a URL → run the pipeline → a self-contained folder of `<slug>.html` + `styles.css`
that reproduces the live site's layout, text, images, links, and fonts.

This document is the operating manual for Claude Code. It contains everything needed
to run the tool, debug a scrape, and reason about fidelity for long-tail sites.

## What it does

The three-stage pipeline lives in this folder (`replicate/`):

1. **`node scrape.mjs <url> [--out <dir>]`** — download the published site's content:
   every page's node JSON + HTML `<title>`, all images/SVGs, into `data/`, `assets/`,
   and a `manifest.json`. Default out dir is `replica-out/`.
2. **`node build.mjs [--out <dir>]`** — render `data/*.json` into `<slug>.html` +
   `styles.css`, downloading and self-hosting any non-Google font.
3. **`node verify.mjs <url> <outfile>`** — drive headless Chrome over CDP, capture
   every leaf text element's computed style, and diff live vs local. Use it to prove
   fidelity (see "Verification" below).

```bash
node scrape.mjs https://example.figma.site/
node build.mjs
# open replica-out/ (index.html + the slug pages)
```

## How published Figma Sites works (why the scrapes look the way they do)

Everything is versioned by a **site build hash** (a UUID):

- The home page HTML embeds it: `<script src="/_json/<uuid>/_index.json">`.
- Every page shares that same hash. Content for path `/foo` lives at
  `/_json/<hash>/foo.json`; home is `_index.json`; a page's `<title>` is in the
  plain HTML at `<origin><path>`.
- `_index.json` (and each page json) has the shape:
  `{ roots, nodeById, assetIdToGuid, guidToUrl, fonts, assets, siteSettings }`.
- **`guidToUrl`** maps every root node id → site path (`{"/0:3": "/", "1:223": "/history--culture", ...}`).
  One fetch yields full page discovery — no crawling needed.
- **`fonts`** = `{ "Family:Style": { weight, italic, url } }`. `url` is a site-relative
  woff2 path under `/_woff/v2/...` (only for families Google Fonts doesn't serve).
- **`assets`** = `{ hash: { type: "PAINT_ASSET"|"GENERATED_ASSET", url: "<hash>.png|.svg" } }`.
  Files are served at `/_assets/v11/<hash>.<ext>`. **A `.png`-named asset may actually be
  JPEG bytes** — always sniff magic bytes before writing.

URL validation: only `https://<name>.figma.site/...` is accepted.
- `figma.com/site/...` returns an unrelated landing page, not the site — it is **not
  resolvable** to the published host. Reject it with guidance (ask for the published URL).
- `figma.com/design/...` needs the Figma REST API, not this scraper.

## Rendering rules (from `lib.mjs`, proven pixel-faithful)

These are the non-obvious decisions; don't "fix" them without a live-site comparison.

- **Positioning**: every node is an absolutely-positioned box inside `.canvas`
  (a FRAME/WEBPAGE node), `left/top/width/height` rounded from `absoluteBoundingBox`.
- **Fluid canvas (matches the live site's adaptive behavior)**: `.canvas` renders
  `width:100%; min-width:{design width}px` (live: `min-width:max(100%,1440px)`), so
  the page fills the viewport and only clips below the design width. The body
  background is set to the canvas color (live: `body:has([data-breakpoint-id])`)
  with `overflow-x:hidden` to swallow the min-width overflow. A node that moves
  with the canvas **centre** renders `left: calc(50% ± offpx)` where
  `off = designLeft - W/2` — at the design width this evaluates to `designLeft`
  exactly, so nothing moves on a 1440 viewport, but the node stays centered as the
  viewport grows. "Moves with the centre" means the node is CENTER-constrained
  **or sits inside a CENTER-constrained ancestor frame** (`hasCenteredAncestor`):
  the live site NESTS content inside its centred frame, so an auto-layout child
  with no constraints of its own (e.g. a hero heading) still shifts with the
  viewport. Using plain px for those drifted them left of the centered frame on
  viewports wider than the design width. SCALE nodes keep their own path.
- **`constraints.horizontal === "SCALE"` nodes reflow with the viewport**: the
  live site positions such nodes as a **percentage of the design width**, so they
  stretch as the canvas fills a wider viewport (the alias-grid site is all-SCALE
  and its full-width banners/hero stretch 1440→1920; isabella is all-CENTER).
  `lib.mjs` re-expresses the final `left`/`width` (after any SVG natural-size
  offset) as `left: X%; width: W%`. **Vertical stays at design px** — the live
  container keeps its design height, so a SCALE/SCALE node only widens, never
  grows taller; text inside a widened box re-wraps (font-size is unchanged, so
  box height stays the same). At the design width the percentages resolve to the
  design px exactly, so SCALE builds are unchanged on a 1440 viewport.
- **INSTANCE 的子树必须显式展开**(`expandInstances`)——这是最容易漏掉的一块。
  发布数据里 INSTANCE 的 `children` 是**复合 id**:`"I18:1039;18:990"`,而
  `nodeById` 里**没有**这些键(实测整页 0 个键以 `I` 开头、0 个含 `;`)。
  直接照 `children` 走,`collectNodes` 到实例就断,**实例内容整块消失**——
  lily2026new 的画廊轮播就是这样:卡片底色渲染出来了,里面的图片、文字、
  左右箭头全空白。
  复合 id 的后半段就是主组件里的原始节点,所以按 **`实例原点 − 主组件原点`**
  整棵子树平移即可还原(实测 12 个子节点全部精确落在各自实例框内)。
  还原出的节点登记为合成 id `<实例id>~<原始id>` 并挂回实例的 `children`,
  于是 `collectAll` / `renderNode` / `parentOf` / `linkHref` 全都不用改。
  两个必须守住的点:
  - **幂等**:子节点已存在的实例要跳过,否则每次构建都会再复制一遍;
  - **构件本身不动**:组件定义区的原件坐标保持原样,不能跟着平移。
  `ai.mjs` 的 `pageTextOf` 用同一个函数,所以 AI 看到的合成 id 与构建产物完全
  一致 —— 它据此用 `edit_node` 写的覆盖,重建后能对上。
  仍未实现:轮播的**点击换图**是 Figma 的 `SWAP_STATE` 变体交互
  (`navigationType: "SWAP_STATE"` + `stateGroupContext` 指向组件集),
  静态复刻只渲染默认变体,箭头点了不会换。
- **`data-node-id` 要覆盖到 TEXT**:所有会产出元素的类型都要带,漏一个就会让
  `bind_data` 的 `target` 定位不到那个节点。TEXT 的 `wrapOpen` 曾经漏掉,
  表现为"文字内容在、但按节点 id 查不到"。属性一律排在 `style` **之后**。
- **Text**: `font-family` uses **single quotes** (`'Inter', system-ui, sans-serif`).
  The whole style attr is double-quoted, so a double quote inside `font-family`
  breaks the attribute and **silently drops every inline style** on that element.
  `line-height` is `normal` by default, **but a FIXED `lineHeightUnit:"PIXELS"`
  node renders `line-height: <lineHeightPx>px`** — the live site honors it and
  dropping it mis-positioned the 70px "39%" stat. `white-space: pre-wrap`,
  `word-break: break-word`, `overflow: visible`.
- **Scroll frames**: a `FRAME` with `overflowDirection` (`HORIZONTAL_SCROLLING` /
  `VERTICAL_SCROLLING`) renders as an `overflow-x/overflow-y: auto` container whose
  children are positioned relative to the frame — the timeline's 2288px-wide image
  inside a 1228px frame pans horizontally instead of being clipped into the viewport.
- **Frames paint their fills**: a `FRAME` renders a div whenever it has a
  `overflowDirection` (scroll container, above) **or a visible fill** — e.g.
  `hero-right-image-container` (a FRAME with an IMAGE fill) and the frosted
  `card-*` frames (white at 0.7 opacity + corner radius). Skipping plain frames
  dropped the hero image and the card glass backgrounds. Frames with neither are
  pure layout and render nothing; a non-scroll frame's children are still emitted
  by the flat loop (not nested inside it).
- **Rich text**: `characterStyleOverrides` + `styleOverrideTable` split a text node
  into inline `<span style="font-weight:/font-size:">` runs (`textRuns()`).
- **Multi-paragraph text**: split on `\n` into stacked `<p style="display:block;
  white-space:pre-wrap; line-height:normal; margin:0">` blocks with no gap; blank
  lines become `<p>&#8203;</p>` (zero-width space preserves the line).
- **Links & nav state are data-driven, not page-derived**:
  - A node becomes `<a>` when it — or the GROUP wrapping it — has
    `ON_CLICK` / `INTERNAL_NODE` / `NAVIGATE` with a `connectionURL`. Figma puts the
    interaction on the **group** that wraps a button's background + label (not on the
    label), so `linkHref()` walks the ancestor chain via the page's `parentOf` map;
    a node that has interactions of its own owns its click and never inherits.
    `linkHref()` maps the live path (`/history--culture`) to the local file via the
    manifest. The live site renders each interactive node as an anchor, so besides
    text, a `RECTANGLE`/`IMAGE` with a target renders as an `<a>` carrying its fill,
    and an interactive `SVG` renders as an anchor-wrapped `<img>` — that restores the
    pill buttons and next/arrow hotspots that carry no interaction of their own.
  - The "active" nav item is the node whose `style.textDecoration === "UNDERLINE"`
    (rendered underline + Extra Bold in the design). Do NOT compute it from "which
    page are we on" — the design data is the source of truth. Some pages have zero
    nav links at all.
  - The shared stylesheet adds **no hover underline** (`.nav-link` is only
    `text-decoration: none`) — the live site's global CSS is `a{text-decoration:none}`
    with no `:hover` text-decoration anywhere. Don't re-add a `.nav-link:hover`
    rule; a button that looks underlined on hover in a local build is a bug.
- **Images**: `RECTANGLE`/`IMAGE` become background-image divs (`cover`/`center`).
  Mask-group images carry their asset in `node.hash`, not in fills — check `node.hash`
  when `fills` has no imageRef. Vector icons (SVG node) become `<img>` of a generated
  `.svg` asset. **`IMAGE` and `SVG` nodes carry no CSS fill or border**: the exporter
  bakes their fill, stroke, and shadow into the asset bytes (the dashed ocean ellipses
  ship as PNGs with the dashed ring drawn in; the page-6 curves and page-28 dots are
  SVGs whose stroke is baked in). The live site paints no CSS on them — adding a
  fill/border put a solid square behind circles, curves, and dots.
- **SVG assets render at Figma's `isolatedAbsoluteRenderBounds`, not the design box**:
  the exporter bakes effects (drop-shadow gutters) into the SVG **or** crops it to the
  drawing (the page-5 triangle polygon ships as a 46×36 asset inside a 64×53 design
  box), so the asset size ≠ `absoluteBoundingBox` in both directions. The live site
  places the `<img>` at Figma's own isolated render bounds (a 256×376 card ships as a
  276×396 SVG — shadow gutter; a cropped vector sits at the content box). `lib.mjs`
  uses `node.isolatedAbsoluteRenderBounds` when it differs from the bbox (fallback:
  `svgGeometry` parses the asset's width/height + min content point). **Rotated
  vectors** (`isNodeRotated` on `relativeTransform`) are rendered at natural size,
  positioned on the isolated render bounds, with Figma's rotation applied as a CSS
  `transform: matrix(a, c, b, d, 0, 0)` around the **design-box (bbox) center** (the
  asset's own center is offset by its baked shadow gutter) — the 90°
  Horizontal/Vertical toggle renders vertical, and page-6's ~8° curves get their
  subtle tilt. Also, SVG `<img>`s never carry a `background-color` from `node.fills` —
  the vector's fill/opacity is baked into the asset; painting the fill as a background
  turned a transparent triangle into a square.
- **Lines**: an SVG node with `isLine` becomes a 1px `<div>` (not `<hr>`).
- **No renderer-side effects/shadows** — a deliberate replica choice. The renderer adds
  no CSS box-shadow or filter; the only shadows that appear are ones Figma baked into
  the asset bytes (see the SVG natural-size rule above). (The old soft CSS box-shadow
  on `.canvas` was dropped with the fluid canvas: on a full-width element it drew a
  shadow around the viewport edges, unlike the live site.)
- **Word clouds may sit below the canvas**: `apply_wordcloud` only clamps
  horizontally (width ≤ canvas width, left ≥ 0); `top`/`height` may extend past
  the canvas bottom, and `build.mjs` grows the `.canvas` height to cover the
  lowest cloud so the page background reaches it. Don't re-add a vertical clamp —
  "below the content" is a valid placement, and a silent clamp was the old bug
  that made the AI retry in a loop.
- **CJK**: if any page has CJK glyphs, append `'Noto Sans SC', 'Noto Sans JP'` to the
  font stack and add them (weights 400/500) to the Google Fonts link so mixed
  Chinese/English text matches the live render.

## Font handling

- `GOOGLE_FONTS` (Inter, Inria Sans, Noto Sans SC/JP, Roboto, …) → one Google Fonts
  `<link>`, built from the union of `(family, weight)` across all pages.
- Any other family → **self-host**: download its woff2 from `fonts[name].url` into
  `fonts/` and emit `@font-face` (exact family base-name + weight) into `styles.css`.
  The download **retries 3× with backoff and reports the real reason**: the failure
  mode is a transient drop on a 4–7 MB file (Noto Sans SC/JP), not a missing URL —
  the same URL is 200 on the next attempt. Two rules learned the hard way:
  - a font that never landed must **not** get a `@font-face` rule (the browser would
    404 it and silently fall back, hiding the problem);
  - `catch {}` with a generic "could not fetch" made this bug undiagnosable.
  A site whose fonts all failed still builds — it just uses the fallback stack.
- **Known cosmetic quirk (accepted, not a bug)**: live computed `font-family` values
  carry weight suffixes ("Inter:Medium", "Inria Sans:Bold") and some named-bold faces
  compute `font-weight: 400` while local computes 700. Both render the same bold font —
  treat as a non-diff in verification.

## Publishing to 1Panel + HTTPS

`publish.mjs` deploys the built folder to a 1Panel static site and can then make
`https://<domain>` work. Auth is a per-request HMAC (`md5("1panel" + apiKey +
timestamp)`) in the `1Panel-Token`/`1Panel-Timestamp` headers; the API prefix is
probed (`/api/v2`, falling back to `/api/v1`); a business failure arrives as
**HTTP 200 with `code != 200`**, which `panelFetch` raises.

**The app never stores DNS or CA credentials.** The panel owns them; the app only
lists what is already configured and passes the resulting ids:

- `POST /websites/acme/search` → ACME accounts (`listAcmeAccounts`)
- `POST /websites/dns/search` → DNS accounts (`listDnsAccounts`)
- `POST /websites/ssl/search` → certificates (`listSsls`, `findSslByDomain`)

Applying for a certificate needs **three** things, and `provider` is the
**validation method**, not the CA:

| field | meaning |
|---|---|
| `acmeAccountId` | which CA account signs (Let's Encrypt / ZeroSSL / …) |
| `provider` | `dnsAccount` (panel writes the TXT through the DNS account's API), `dnsManual` (user adds the TXT), `http` (CA fetches port 80), `selfSigned` |
| `dnsAccountId` | the DNS account, required only for `provider: "dnsAccount"` |

`ensureHttps` orchestrates: reuse a certificate already covering the domain →
otherwise create the record with the selected accounts → poll → bind and enable
with `POST /websites/{websiteId}/https` (`{ type: "existed", websiteSSLId,
enable: true, httpConfig }`), carrying the site's existing `SSLProtocol`/
`algorithm` through so the panel's TLS defaults survive. It is **idempotent** —
an already-enabled site on the same certificate is skipped.

**Certificate issuance is asynchronous — poll the record's `status`, never its
`expireDate`.** Two traps, both confirmed in the 1Panel backend:

- `POST /websites/ssl` with `apply: true` runs the ACME order in a **goroutine**
  and returns immediately, so the certificate does not exist yet when create
  returns.
- The backend seeds `ExpireDate: time.Now()` at creation and only overwrites it
  with the real `cert.NotAfter` after issuance, so an `expireDate` near "now"
  proves nothing. Trusting it made the app enable HTTPS a second after applying
  and the panel answered `服务错误: 证书文件异常，请检查证书状态！`.

The status machine is `init` → `applying` → `ready`, with `applyError`/`error`
on failure (`sslLooksIssued` also falls back to a PEM body or a genuinely future
expiry for panels that omit `status`). `pollSslUntilIssued` waits for `ready`,
fails fast on `applyError` with the panel's `message`, and `enableHttpsResilient`
retries the bind a few times with backoff for the window where the record reads
ready but nginx has not picked the files up yet.

`provider: "dnsManual"` is **not** driven from here: the panel's manual flow
waits on a human adding the TXT record, so `ensureHttps` creates the record and
returns `pendingManual: true`, telling the user to finish in the panel. The next
publish finds the issued certificate and just binds it.

The GUI reads the accounts with `publish:https-options` and renders dropdowns only
(see the "申请并启用 HTTPS" block in `renderer/index.html`) — no credential fields.

## 数据绑定(bind_data / databind.mjs)

让生成的静态页面具备**跨访客持久化**能力:投票、实时词云、留言、参与人数。
后端是独立部署的 `data-api/`(见 `docs/data-api.md`),页面通过 `bind_data`
声明式接入 —— **AI 不写浏览器脚本**,只产出 spec,注入由 `databind.mjs` 负责,
所以不存在"AI 生成任意 JS"的攻击面。

数据流与词云完全同构:

```
AI: bind_data(...)  →  databinds.json  →  build.mjs  →  databind.mjs 注入
   (apply_wordcloud → wordclouds.json → cloudInjection 是同一套模式)
```

- **`data-node-id`**:`lib.mjs` 给每个渲染出的元素带上 Figma 节点 id ——
  这是"点这个按钮就是投票"能定位到元素的前提。属性放在 `style` **之后**,
  既有 HTML 断言的前缀不受影响。
- **站点命名空间由浏览器自己推导**:`slugify(location.hostname)`。构建时**不需要**
  知道将来发布到哪个域名,同一份产物发到多个域名各自成为独立命名空间。
  这个函数必须与 `data-api/slug.mjs`、`publish.mjs` 的 `slugifySite` **逐字符一致**
  —— `databind.test.mjs` 用同一批样本同时比对三处。
- **实时词云的布局跑在浏览器里**(词是加载后才到的,没法在构建期排布)。
  `wordcloud.mjs` 用 `Function.prototype.toString()` 导出 `layoutRuntime`,
  `databind.test.mjs` 求值后与 `layoutWordCloud()` 比对,保证两份永不漂移。
- **后端地址**:构建时从 `--data-api` 或 `REPLICA_DATA_API` 取;GUI 把它(读自已保存的
  「数据后端」设置)传给每次 build,**包括 AI 自动重建那一次** —— 否则一次 bind_data
  改动的重建会丢掉运行时,页面静默失去动态能力。未配置时整段脚本不注入,
  与纯静态完全一致。
- **优雅降级是硬要求**:`fallback` 先画,后端不可用时保留它,绝不白屏;
  写失败只在角落提示,不阻塞页面其他交互。
- **"投过就不用再投"**:运行时用 localStorage 的匿名 UUID(`__dc_<site>`,按站点隔离)
  查 `/{site}/{collection}/mine`;有记录就回显并禁用提交。服务端**不做去重**(按设计),
  清掉 localStorage 即可重投 —— 已知且接受的边界。`options.mode:"single"` 时后端
  对同一 client 后写覆盖前写,适合"每个人的个人内容"。
  ⚠️ `refresh()` 成功回调**不能**清空提示:否则刚显示的"已提交"会被立刻擦掉,
  访客以为没提交成功(首次实现踩过,`databind-e2e.mjs` 现在钉住这一条)。
- **Admin Token 绝不进生成的页面**:页面只拿到公开的后端地址。

验证分两层:`databind.test.mjs` 覆盖纯函数(slug 三处一致、布局等价、注入转义),
`databind-e2e.mjs` 用 headless Chrome 打真实后端跑通读/写/去重全链路
(需要 `DA_TOKEN`,依赖外网与本机 Chrome,所以不进 CI)。

## 图片理解(view_image / list_images)

让 AI **看懂**页面里的位图(地图、图表、截图文字),而不只是改它们的 CSS。

**关键约束(决定了实现形态)**:DeepSeek 的图像理解只接受 JPEG/PNG/GIF/WebP,
且**图片只能出现在 `user` 消息里** —— `system`/`assistant` 带图返回 400,而工具
结果是 `role:"tool"` 消息,同样不能带图。所以:

- `view_image` **不通过返回值传图**。它只把图片推进 `makeTools` 内部的
  `pendingImages` 队列,返回一句纯文本;
- `runAgent` 在工具轮结束后调 `tools.takePendingImages()`,补一条
  **`user` 消息**(`content` 为块数组:一个 text + N 个 image_url)把图交给模型。
  取走即清空,避免同一张图被重复发送浪费 token。

这和"AI 不写浏览器脚本"是同一个思路:**能力由框架提供,模型只做声明**。

- `list_images(slug)` 先列出页面上的图片节点(nodeId / 名称 / 尺寸 / 资源文件 /
  能否被模型读取)。`read_page_text` 的 `all` 看不出哪个节点带图片填充,所以需要它。
- `view_image({slug, nodeId})` 或 `view_image({path})`,可选 `detail`
  (`low` 缩到 512×512 更省 token / `original` 看细节 / 默认 `auto`)。
- 格式按**文件内容**嗅探(`sniffImageMime`),不看扩展名 —— assets 里 `.png`
  可能是 JPEG 字节。单图上限 32MB(API 硬限制)。
- SVG 是矢量,模型**看不了**,`list_images` 会标 `readable:false`。

⚠️ **多模态是模型能力,不是代码能补的**:纯文本模型收到图片会 400,客户端会把
这条错误翻译成"请在设置里换一个多模态模型(deepseek-v4-flash 或 deepseek-flash)",
而不是抛一串 API 术语。因为图片进的是**同一个会话**,一次对话里只能用一个模型 ——
想要看图就必须让主模型是多模态的。本项目实测 `deepseek-v4-flash` 与 `deepseek-flash`
都能接收图片,所以默认模型无需改动。

`vision-check.mjs` 是独立实测脚本(要 API Key,不进 CI):同一个模型名打一遍、
把图片发过去,直接看他能不能描述出来、以及哪个模型名该填进设置。

## Packaging & CI

`.github/workflows/build.yml` builds the Electron GUI (`electron/`) on three
runners and uploads one artifact per platform:

| job | runner | args | artifact |
|---|---|---|---|
| `windows-x64` | `windows-latest` | `--win` | `FigmaSiteReplica-1.0.0-portable.exe` + `-setup.exe` |
| `macos-arm64` | `macos-latest` | `--mac --arm64` | `FigmaSiteReplica-1.0.0-arm64.dmg` / `.zip` |
| `macos-x64` | `macos-latest` | `--mac --x64` | `FigmaSiteReplica-1.0.0-x64.dmg` / `.zip` |

**Both macOS builds run on the arm64 runner.** `macos-latest` is macOS arm64, and
the x64 macOS images (`macos-*-intel`, `*-large`) are GitHub *larger* runners — a
separate, billed class. Cross-compiling is safe and free here because the app has
`dependencies: {}` and no native modules (no `gypfile`/`.node`), so electron-builder
just downloads Electron's prebuilt `darwin-x64` binary and repackages it. Two traps
worth remembering:

- `dmg-builder` picks its helper with **`process.arch`** (the host), not the target
  arch (`dmg-builder/out/dmgUtil.js`), so producing an x64 DMG on arm64 needs no
  Rosetta.
- `@electron/rebuild` for `arch=x64` is a no-op only because there are no native
  modules. Adding one turns this into a real cross-build that needs the x64 toolchain.

The macOS job verifies the result with `lipo -archs`, so a silent fallback to the
host architecture fails the build instead of shipping the wrong binary.

**Artifacts are unsigned** (`CSC_IDENTITY_AUTO_DISCOVERY: "false"`), so the CI log
shows `skipped macOS application code signing`. Consequences: Windows shows a
SmartScreen warning, and macOS reports the app as damaged on first launch — the user
must right-click → Open or run `xattr -cr <app>`. Removing that entirely needs an
Apple Developer ID ($99/yr) and notarization; ad-hoc signing alone only softens it.

Electron 43 requires macOS 12 or newer, on both architectures.

## Verification

`node verify.mjs <live-url> <out.json>` captures computed styles of leaf text nodes;
run it for the live site, run it for the local `file://...html`, then diff the JSON.
Acceptable diffs: the font-family weight-suffix quirk above; and a live font-weight 400
vs local 700 when the face is a named bold (Inria Sans Bold). Any other computed-style
difference means the local build diverged — investigate before calling it done.

Note: verify skips elements that contain child elements (span/p children are not
leaf-captured). If a paragraph seems "missing" from a capture, check whether it
contains rich-text spans — that's a capture artifact, not a rendering bug.

## Gotchas / long-tail sites

- **Unpublished site** → the home HTML has no `/_json/<uuid>/`; `scrape.mjs` fails
  with a clear message. Publish in Figma first.
- **No `guidToUrl`** → `scrape.mjs` falls back to BFS over nav `interactions`.
- **Missing assets** → tried under every extension; some hashes genuinely 404.
  `scrape.mjs` **retries transient errors on every candidate extension** (not just
  the first) and **verifies every referenced hash landed on disk**. Three traps
  fixed after a real "asset … not found" report:
  - the site's `url` field **sometimes has no extension at all** (`VIDEO_ASSET`),
    and `url.split(".").pop()` then returns the whole hash, producing a guaranteed
    404 — `extOfAsset()` now falls back to `format`/`type` and only accepts known
    extensions;
  - the collection loop used to `set(node.hash, null)`, **clobbering the extension
    the assets table already knew**, so every referenced asset was guessed as `.png`
    first and svg/video survived only via the alt probe;
  - the alt probe had **no retry**, so one connection reset killed the asset for
    good even though the same URL returns 200 moments later.
  Reporting separates three situations, because conflating them sends people
  chasing a bug that isn't there: a referenced asset that truly failed; one that
  failed but **was already on disk from a previous scrape** (reused — the page is
  fine); and an asset **no page references** (the assets table lists everything
  the site ships, used or not).
- **Scrape failures look new but usually aren't**: transient CDN resets have always
  happened. Before the retry + integrity check landed (`7cf376c`), a failed asset
  was dropped **silently**, so the only symptom was a blank image much later. If a
  scrape reports failures now, re-run before assuming a regression — the same URL
  failing and then succeeding is the observed pattern.
- **Rare node types** (vectors, groups with effects) → skipped by `renderNode`; the
  replica renders what the proven path handles. Extend `lib.mjs`, not `build.mjs`.
- **New font families** → add to `GOOGLE_FONTS` only if Google Fonts serves them;
  otherwise the self-host path handles them automatically.
- If the site has pages the scrape didn't discover, its `guidToUrl` may be sparse —
  the fallback crawler covers that.

## One-shot from a URL

```bash
cd replicate
node scrape.mjs https://isabella2026.figma.site/ --out /tmp/rep
node build.mjs --out /tmp/rep
node verify.mjs https://isabella2026.figma.site/ /tmp/live-index.json
node verify.mjs "file:///tmp/rep/index.html" /tmp/local-index.json
# diff the two json captures; only the accepted cosmetic diffs may differ
```
