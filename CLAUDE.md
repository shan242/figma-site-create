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
  - A text node becomes `<a>` **only** when `node.interactions` has
    `ON_CLICK` / `INTERNAL_NODE` / `NAVIGATE` with a `connectionURL`. `linkHref()`
    maps the live path (`/history--culture`) to the local file via the manifest.
  - The "active" nav item is the node whose `style.textDecoration === "UNDERLINE"`
    (rendered underline + Extra Bold in the design). Do NOT compute it from "which
    page are we on" — the design data is the source of truth. Some pages have zero
    nav links at all.
- **Images**: `RECTANGLE`/`IMAGE` become background-image divs (`cover`/`center`).
  Mask-group images carry their asset in `node.hash`, not in fills — check `node.hash`
  when `fills` has no imageRef. Vector icons (SVG node) become `<img>` of a generated
  `.svg` asset.
- **Lines**: an SVG node with `isLine` becomes a 1px `<div>` (not `<hr>`).
- **Effects/shadows are NOT rendered** — a deliberate replica choice. A Figma
  drop-shadow on the canvas is approximated by a soft CSS box-shadow on `.canvas`.
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
