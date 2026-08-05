// license-server.mjs — Machine-code license server (zero-dep, single file).
//
// Run it on your server:   node license-server.mjs serve --port 8123
// Manage it from the shell:
//   node license-server.mjs list                # machines that have contacted
//   node license-server.mjs block <machineCode> # revoke a machine
//   node license-server.mjs unblock <machineCode>
//   node license-server.mjs add <machineCode> [note]
//
// Every check from a client is recorded (a code never seen before becomes an
// active license). `block` flips a code so the next check answers ok:false,
// which makes the GUI show its generic error. Storage is a JSON file.

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { createServer } from "node:http";

const DEFAULT_FILE = "licenses.json";
const DEFAULT_PORT = 8123;

// --- Pure core (operates on a store object; IO-free, unit-testable) ----------

export function newStore() {
  return { machines: {} };
}

// Record a machine and answer whether it may run. Never-seen codes are allowed
// (open by default — the operator revokes via block). A blocked code fails.
export function checkMachine(store, machineCode) {
  const now = new Date().toISOString();
  const m = store.machines[machineCode];
  if (m && m.status === "blocked") return { ok: false, reason: "blocked" };
  if (m) {
    m.lastSeen = now;
  } else {
    store.machines[machineCode] = { note: "", status: "active", firstSeen: now, lastSeen: now };
  }
  return { ok: true };
}

export function blockMachine(store, machineCode) {
  const now = new Date().toISOString();
  const m = store.machines[machineCode] || { note: "", firstSeen: now };
  m.status = "blocked";
  m.lastSeen = now;
  store.machines[machineCode] = m;
}

export function unblockMachine(store, machineCode) {
  const now = new Date().toISOString();
  const m = store.machines[machineCode] || { note: "", firstSeen: now };
  m.status = "active";
  m.lastSeen = now;
  store.machines[machineCode] = m;
}

export function addMachine(store, machineCode, note = "") {
  const now = new Date().toISOString();
  const m = store.machines[machineCode] || { status: "active", firstSeen: now };
  m.status = "active";
  m.note = note;
  m.lastSeen = now;
  store.machines[machineCode] = m;
}

export function listMachines(store) {
  return Object.entries(store.machines)
    .map(([machineCode, m]) => ({ machineCode, ...m }))
    .sort((a, b) => (a.firstSeen < b.firstSeen ? -1 : 1));
}

// --- File persistence (atomic write via tmp + rename) ------------------------

export function readStore(file) {
  if (!existsSync(file)) return newStore();
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    if (s && typeof s === "object" && s.machines) return s;
  } catch (e) {
    console.error(`无法读取 ${file}(${e.message}),以空库启动`);
  }
  return newStore();
}

export function writeStore(file, store) {
  writeFileSync(`${file}.tmp`, JSON.stringify(store, null, 2));
  renameSync(`${file}.tmp`, file);
}

// --- HTTP server --------------------------------------------------------------

export function startServer({ port = DEFAULT_PORT, host = "0.0.0.0", file = DEFAULT_FILE, onStart } = {}) {
  const server = createServer(async (req, res) => {
    const respond = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/license/health") {
        return respond(200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/license/check") {
        // Re-read per request so an external `block` (separate CLI process)
        // takes effect immediately, not only after a server restart.
        const store = readStore(file);
        let body = "";
        for await (const chunk of req) body += chunk;
        const { machineCode } = JSON.parse(body || "{}");
        if (!machineCode || typeof machineCode !== "string") {
          return respond(400, { ok: false, reason: "missing machineCode" });
        }
        const r = checkMachine(store, machineCode);
        writeStore(file, store);
        return respond(200, r);
      }
      respond(404, { ok: false, reason: "not found" });
    } catch (e) {
      respond(500, { ok: false, reason: e.message });
    }
  });
  server.listen(port, host, () => onStart?.(server.address().port, file));
  return server;
}

// --- CLI ---------------------------------------------------------------------

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const file = argValue(argv, "--file") || DEFAULT_FILE;
  if (cmd === "serve") {
    const port = Number(argValue(argv, "--port")) || DEFAULT_PORT;
    startServer({
      port,
      file,
      onStart: (p, f) => console.log(`license server listening on :${p}(store ${f})`),
    });
    return;
  }
  const store = readStore(file);
  switch (cmd) {
    case "list":
      for (const m of listMachines(store)) {
        console.log(`${m.status === "blocked" ? "✗" : "✓"} ${m.machineCode}  ${m.note || "(无备注)"}  首见 ${m.firstSeen}`);
      }
      console.log(`共 ${Object.keys(store.machines).length} 台机器`);
      break;
    case "block": {
      if (!argv[1]) return console.error("用法:node license-server.mjs block <机器码>");
      blockMachine(store, argv[1]);
      writeStore(file, store);
      console.log(`已封禁 ${argv[1]}`);
      break;
    }
    case "unblock": {
      if (!argv[1]) return console.error("用法:node license-server.mjs unblock <机器码>");
      unblockMachine(store, argv[1]);
      writeStore(file, store);
      console.log(`已解封 ${argv[1]}`);
      break;
    }
    case "add": {
      if (!argv[1]) return console.error("用法:node license-server.mjs add <机器码> [备注]");
      addMachine(store, argv[1], argv[2] || "");
      writeStore(file, store);
      console.log(`已登记 ${argv[1]}`);
      break;
    }
    default:
      console.log(
        "用法:\n  serve [--port 8123] [--file licenses.json]\n  list [--file licenses.json]\n  block <机器码> [--file licenses.json]\n  unblock <机器码> [--file licenses.json]\n  add <机器码> [备注] [--file licenses.json]",
      );
  }
}

if (process.argv[1] && process.argv[1].endsWith("license-server.mjs")) {
  main();
}
