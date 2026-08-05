// license.test.mjs — unit tests for the machine-code license scheme. Server
// logic is exercised on in-memory stores (functional core); the client check
// stubs globalThis.fetch like the other test files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machineCode, checkLicense, LICENSE_SERVER_URL } from "./license.mjs";
import { newStore, checkMachine, blockMachine, unblockMachine, addMachine, listMachines, readStore, writeStore, startServer } from "./license-server.mjs";

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

test("machineCode is stable and well-formed", () => {
  const a = machineCode();
  const b = machineCode();
  assert.equal(a, b);
  assert.match(a, /^[0-9A-F]{16}$/);
});

test("checkLicense posts the machine code to the built-in server by default", async () => {
  let got = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    got = { url, body: JSON.parse(opts.body) };
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const r = await checkLicense({ machineCode: "ABC" });
    assert.equal(r.ok, true);
    assert.ok(got.url.startsWith(LICENSE_SERVER_URL));
    assert.ok(got.url.endsWith("/license/check"));
    assert.equal(got.body.machineCode, "ABC");
    // trailing slash is stripped so the path doesn't double up
    assert.ok(!got.url.includes("//license"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("checkLicense surfaces an explicit block from a healthy server", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: false, reason: "blocked" }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    assert.deepEqual(await checkLicense({ machineCode: "ABC" }), { ok: false, reason: "blocked" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("checkLicense throws on http errors so the app keeps its last state", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("boom", { status: 502 });
  try {
    await assert.rejects(() => checkLicense({ machineCode: "ABC" }), /http 502/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("checkMachine auto-registers a never-seen code as active", () => {
  const store = newStore();
  assert.deepEqual(checkMachine(store, "CODE1"), { ok: true });
  assert.equal(store.machines.CODE1.status, "active");
  assert.ok(store.machines.CODE1.firstSeen && store.machines.CODE1.lastSeen);
});

test("blocked machines are rejected and unblock restores them", () => {
  const store = newStore();
  checkMachine(store, "CODE1");
  blockMachine(store, "CODE1");
  assert.deepEqual(checkMachine(store, "CODE1"), { ok: false, reason: "blocked" });
  unblockMachine(store, "CODE1");
  assert.deepEqual(checkMachine(store, "CODE1"), { ok: true });
});

test("blockMachine works on a code that never checked in", () => {
  const store = newStore();
  blockMachine(store, "GHOST");
  assert.deepEqual(checkMachine(store, "GHOST"), { ok: false, reason: "blocked" });
});

test("addMachine creates an active entry with a note", () => {
  const store = newStore();
  addMachine(store, "CODE2", "客户A");
  assert.equal(store.machines.CODE2.status, "active");
  assert.equal(store.machines.CODE2.note, "客户A");
  // add overwrites a blocked entry back to active
  blockMachine(store, "CODE2");
  addMachine(store, "CODE2", "客户A");
  assert.equal(store.machines.CODE2.status, "active");
});

test("listMachines is sorted by firstSeen", () => {
  const store = newStore();
  checkMachine(store, "OLD");
  checkMachine(store, "NEW");
  // coerce distinct firstSeen values so the order is deterministic
  store.machines.OLD.firstSeen = "2026-01-01T00:00:00.000Z";
  store.machines.NEW.firstSeen = "2026-02-01T00:00:00.000Z";
  const codes = listMachines(store).map((m) => m.machineCode);
  assert.deepEqual(codes, ["OLD", "NEW"]);
});

test("running server picks up an external CLI block on the next check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lic-e2e-"));
  const file = join(dir, "licenses.json");
  const { server, port } = await new Promise((resolve) => {
    const s = startServer({ port: 0, host: "127.0.0.1", file, onStart: (p) => resolve({ server: s, port: p }) });
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.deepEqual(await post(`${base}/license/check`, { machineCode: "LIVE1" }), { ok: true });
    // simulate `node license-server.mjs block LIVE1 --file <file>`
    const store = readStore(file);
    blockMachine(store, "LIVE1");
    writeStore(file, store);
    // the running server must see the edit without a restart
    assert.deepEqual(await post(`${base}/license/check`, { machineCode: "LIVE1" }), { ok: false, reason: "blocked" });
    assert.deepEqual(await post(`${base}/license/check`, { machineCode: "LIVE1" }), { ok: false, reason: "blocked" });
  } finally {
    server.close();
  }
});
