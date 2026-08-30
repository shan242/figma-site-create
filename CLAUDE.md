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
  with `overflow-x:hidden` to swallow the min-width overflow. A node whose
  `constraints.horizontal === "CENTER"` (Figma keeps its offset from the canvas
  center) renders `left: calc(50% ± offpx)` where `off = designLeft - W/2` — at the
  design width this evaluates to `designLeft` exactly, so nothing moves on a 1440
  viewport, but the node stays centered as the viewport grows.
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
- **Text**: `font-family` uses **single quotes** (`'Inter', system-ui, sans-serif`).
  The whole style attr is double-quoted, so a double quote inside `font-family`
  breaks the attribute and **silently drops every inline style** on that element.
  `line-height: normal` (Figma's `lineHeightPx` makes lines cramped). `white-space:
  pre-wrap`, `word-break: break-word`, `overflow: visible`.
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
  `.svg` asset. **`IMAGE` nodes are borderless**: the exporter bakes their stroke
  into the asset bytes (the dashed ocean ellipses ship as PNGs with the dashed ring
  drawn in), and the live site paints no CSS border on them — adding one put a solid
  square frame around the dashed circle.
- **SVG assets render at Figma's `isolatedAbsoluteRenderBounds`, not the design box**:
  the exporter bakes effects (drop-shadow gutters) into the SVG **or** crops it to the
  drawing (the page-5 triangle polygon ships as a 46×36 asset inside a 64×53 design
  box), so the asset size ≠ `absoluteBoundingBox` in both directions. The live site
  places the `<img>` at Figma's own isolated render bounds (a 256×376 card ships as a
  276×396 SVG — shadow gutter; a cropped vector sits at the content box). `lib.mjs`
  uses `node.isolatedAbsoluteRenderBounds` when it differs from the bbox (fallback:
  `svgGeometry` parses the asset's width/height + min content point). **Rotated
  vectors are excluded** (`isNodeRotated` on `relativeTransform`) — the live site
  renders those with a CSS transform inside the design box, which the static renderer
  doesn't replicate, so they keep the SVG-parse path. Also, SVG `<img>`s never carry a
  `background-color` from `node.fills` — the vector's fill/opacity is baked into the
  asset; painting the fill as a background turned a transparent triangle into a square.
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
- **Known cosmetic quirk (accepted, not a bug)**: live computed `font-family` values
  carry weight suffixes ("Inter:Medium", "Inria Sans:Bold") and some named-bold faces
  compute `font-weight: 400` while local computes 700. Both render the same bold font —
  treat as a non-diff in verification.

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
  `scrape.mjs` now **retries the primary extension on transient 5xx/timeout
  errors before probing alt extensions** (a dropped 6MB map would otherwise leave
  the built page white), and **verifies every referenced hash landed on disk**,
  warning loudly about stragglers. If an asset is still missing, re-scrape.
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
