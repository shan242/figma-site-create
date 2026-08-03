# Figma Sites → Static Replica

Replicate any **published** `*.figma.site` site as a plain static HTML/CSS site —
same layout, text, images, links, and fonts — with no build server and no Figma API.

Works by scraping the site's own content endpoints (`/_json/<hash>/*.json`,
`/_assets/v11/<hash>.*`, `/_woff/v2/...`), which the Figma Sites host generates for
every published site. Verified pixel-faithful against `isabella2026.figma.site`.

## Requirements

- Node.js 18+ (uses global `fetch`)
- Google Chrome installed at `C:/Program Files/Google/Chrome/Application/chrome.exe`
  (only needed for `verify.mjs`)

## Usage

```bash
# 1. Scrape the published site into replica-out/
node scrape.mjs https://example.figma.site/

# 2. Render data/*.json into *.html + styles.css
node build.mjs

# 3. (Optional) prove fidelity against the live site
node verify.mjs https://example.figma.site/ /tmp/live.json
node verify.mjs "file:///absolute/path/replica-out/index.html" /tmp/local.json
```

Output (`replica-out/` by default, override with `--out <dir>`):

```
replica-out/
  index.html              home page
  history--culture.html   one .html per site path (slug = path)
  styles.css              shared styles + self-hosted @font-face
  data/<slug>.json        per-page node JSON (intermediate)
  assets/<hash>.<ext>     images / SVGs
  fonts/<file>.woff2      self-hosted fonts for non-Google families
  manifest.json           page list + titles + site metadata
```

## Example

```bash
node scrape.mjs https://isabella2026.figma.site/ --out rep
node build.mjs --out rep
# → 4 pages, ~34 assets, self-hosted Inria Sans
```

## Supported inputs

- **`https://<name>.figma.site/...`** — published Figma Sites hosts. ✅
- `figma.com/site/...` — cannot be resolved to the published host; open the
  published site and copy its `*.figma.site` URL. ❌
- `figma.com/design/...` — Figma editor files need the REST API, not this tool. ❌

## Notes

- Rendering is **data-driven**: links and the active nav state come from the design's
  interaction/underline data, not from which page you're on. See `CLAUDE.md`.
- Effects/shadows from the design are not rendered (deliberate choice).
- For Claude Code: `CLAUDE.md` in this folder is the operating manual.
