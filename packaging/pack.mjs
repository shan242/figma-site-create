// pack.mjs — Build a Windows single-executable (Node SEA) from the replicate
// pipeline's source scripts.
//
//   node packaging/pack.mjs [--name replicate]
//
// Bundles cli.mjs + scrape.mjs + build.mjs + lib.mjs into one self-contained
// .exe (no Node install needed on the target machine), written to
// ../packaged/<name>.exe. Uses the esbuild binary already present in the
// parent project's pnpm store and postject (installed in this folder).
//
// Windows specifics handled here:
//   - node.exe carries an OpenJS Foundation Authenticode signature, which
//     must be removed before the SEA blob can be injected (postject refuses
//     signed binaries). We strip the PE certificate table directly instead of
//     requiring the Windows SDK signtool.
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const REPO = join(SRC, "..");
const OUT_DIR = join(SRC, "packaged");
const TMP = join(HERE, ".sea");

const name = process.argv.includes("--name") ? process.argv[process.argv.indexOf("--name") + 1] : "replicate";

// --- Locate tools ----------------------------------------------------------

function findEsbuild() {
  // Prefer the esbuild shipped with tsup in the parent project's pnpm store.
  const candidates = [
    process.env.ESBUILD,
    join(REPO, "node_modules", ".pnpm", "@esbuild+win32-x64@0.27.3", "node_modules", "@esbuild", "win32-x64", "esbuild.exe"),
    join(REPO, "node_modules", "esbuild", "bin", "esbuild.exe"),
    join(REPO, "node_modules", "tsup", "node_modules", ".bin", "esbuild.cmd"),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`esbuild not found. Set ESBUILD to the esbuild binary path (tried: ${candidates.join(", ")})`);
}

const ESBUILD = findEsbuild();
const POSTJECT = join(HERE, "node_modules", "postject", "dist", "cli.js");
const NODE_EXE = process.execPath;
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

if (!existsSync(POSTJECT)) throw new Error(`postject not found at ${POSTJECT}. Run "npm i" in ${HERE}.`);
console.log(`▸ esbuild   ${ESBUILD}`);
console.log(`▸ node      ${NODE_EXE} (${basename(NODE_EXE)})`);

// --- Strip the Authenticode certificate table from a PE file ---------------
// The certificate data is the last certSize bytes of the file (aligned to 8);
// the optional header's data directory entry 4 holds its offset+size. Zero the
// entry and truncate. Replaces "signtool remove /s" without the Windows SDK.
function stripPeSignature(buf) {
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.toString("latin1", peOff, peOff + 4) !== "PE\0\0") throw new Error("not a PE file");
  const opt = peOff + 24;
  const magic = buf.readUInt16LE(opt);
  const dd = magic === 0x10b ? opt + 96 : magic === 0x20b ? opt + 112 : null;
  if (!dd) throw new Error(`unsupported PE optional-header magic 0x${magic.toString(16)}`);
  const cert = dd + 4 * 8; // data directory index 4 = certificate table
  const off = buf.readUInt32LE(cert);
  const size = buf.readUInt32LE(cert + 4);
  if (!size) return buf;
  if (off + size > buf.length) throw new Error(`certificate table ${off}+${size} exceeds file size ${buf.length}`);
  const trimmed = buf.subarray(0, off);
  trimmed.writeUInt32LE(0, cert);
  trimmed.writeUInt32LE(0, cert + 4);
  return trimmed;
}

// --- Build ----------------------------------------------------------------

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

// CommonJS output: Node SEA loads its embedded main via the CJS entry path, so
// ESM output would be misdetected and fail (as of Node 24).
const bundled = join(TMP, "cli.cjs");
let r = spawnSync(ESBUILD, [join(SRC, "cli.mjs"), "--bundle", "--format=cjs", "--platform=node", "--target=node20", `--outfile=${bundled}`], { stdio: "inherit", encoding: "utf8" });
if (r.status !== 0) throw new Error("esbuild bundle failed");

writeFileSync(join(TMP, "sea-config.json"), JSON.stringify({ main: "cli.cjs", output: "sea-prep.blob", disableExperimentalSEAWarning: true }, null, 2));

// Node >= 22.5 accepts both spellings; the experimental name is the stable one.
for (const flag of ["--experimental-sea-config", "--sea-config"]) {
  r = spawnSync(process.execPath, [flag, join(TMP, "sea-config.json")], { cwd: TMP, stdio: "inherit", encoding: "utf8" });
  if (r.status === 0) break;
  if (flag === "--sea-config") throw new Error("could not generate SEA blob");
}

const exe = join(OUT_DIR, `${name}.exe`);
copyFileSync(NODE_EXE, exe);
writeFileSync(exe, stripPeSignature(readFileSync(exe)));

r = spawnSync(process.execPath, [POSTJECT, exe, "NODE_SEA_BLOB", join(TMP, "sea-prep.blob"), "--sentinel-fuse", FUSE], { stdio: "inherit", encoding: "utf8" });
if (r.status !== 0) throw new Error("postject injection failed");

rmSync(TMP, { recursive: true, force: true });
console.log(`\n✅ ${name}.exe built → ${exe}`);
