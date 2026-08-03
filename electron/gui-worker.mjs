// gui-worker.mjs — Bundle entry for the Electron main process. esbuild inlines
// scrape.mjs/build.mjs/lib.mjs into worker.cjs so the GUI can run the whole
// pipeline in-process with no external Node.
import { scrapeSite } from "../scrape.mjs";
import { buildSite } from "../build.mjs";

export { scrapeSite, buildSite };
