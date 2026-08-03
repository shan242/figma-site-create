// cli.mjs — Dispatcher for the packaged single-binary CLI (Node SEA).
//
// Bundled with scrape.mjs / build.mjs / lib.mjs into one self-contained
// executable so the tool runs on machines without Node installed:
//
//   replicate.exe scrape https://<name>.figma.site/ [--out <dir>]
//   replicate.exe build [--out <dir>]
//
// SEA executables surface the subcommand at argv[1] (there is no script path),
// while `node cli.mjs <command>` puts it at argv[2]. Normalize argv to the
// latter shape before delegating, so the imported mains parse their own args
// identically in both modes.
import { main as scrapeMain } from "./scrape.mjs";
import { main as buildMain } from "./build.mjs";

const [exe, a] = process.argv;
const isSea = a === "scrape" || a === "build";
const command = isSea ? a : process.argv[2];
const rest = isSea ? process.argv.slice(2) : process.argv.slice(3);
process.argv = [exe, "replicate", ...rest];

async function run() {
  if (command === "scrape") {
    await scrapeMain();
  } else if (command === "build") {
    await buildMain();
  } else {
    console.error(`Usage: replicate <scrape|build> [args]

  scrape <url> [--out <dir>]   download a published *.figma.site site
  build   [--out <dir>]        render scraped data into static HTML/CSS`);
    process.exit(1);
  }
}
run().catch((e) => { console.error(e); process.exit(1); });
