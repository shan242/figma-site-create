// license.mjs — Machine-code licensing (the "honest-user" deterrent).
//
// The app derives a stable device fingerprint (machine code) from hardware and
// sends it to the built-in license server on every check. The server
// auto-records codes it sees and lets the operator block any of them; a blocked
// machine gets ok:false back and the GUI shows a generic error. No keys, no
// tokens, nothing for the user to configure — deliberately simple, only deters
// casual sharing.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";

// Built into the app — users never see or configure this. Change it here when
// the license server moves; esbuild bakes it into worker.cjs on build.
export const LICENSE_SERVER_URL = "https://figma.hexyan.site";

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000, windowsHide: true }).trim();
  } catch {
    return "";
  }
}

function readFile(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

// Stable per-machine identifier, derived from hardware so it survives reboots.
// Falls back to a hash of host/user when no hardware ID is available (cloned
// images, containers) — stable per machine, just less unique.
export function machineCode() {
  let raw = "";
  const platform = os.platform();
  if (platform === "win32") {
    raw = run("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_ComputerSystemProduct).UUID"]);
    if (!raw) raw = run("wmic", ["csproduct", "get", "UUID"]);
  } else if (platform === "darwin") {
    const io = run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    raw = io.match(/IOPlatformUUID.*=.*"([^"]+)"/)?.[1] || "";
  } else {
    raw = readFile("/etc/machine-id") || readFile("/var/lib/dbus/machine-id");
  }
  if (!raw || /^0+$/.test(raw)) {
    raw = `${os.hostname()}|${os.userInfo().username}|${platform}`;
  }
  return createHash("sha256").update(raw).digest("hex").slice(0, 16).toUpperCase();
}

// Ask the license server whether this machine may run. The server records the
// code on first sight and replies ok:false once the operator blocks it.
//
// Only an explicit block from a healthy server returns ok:false. A non-2xx
// response (server down, wrong URL, proxy 502) throws instead, so the caller
// keeps its last state — a network blip must not look like a revocation.
export async function checkLicense({ serverUrl = LICENSE_SERVER_URL, machineCode }) {
  const res = await fetch(`${String(serverUrl).trim().replace(/\/+$/, "")}/license/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machineCode }),
  });
  if (!res.ok) throw new Error(`license check http ${res.status}`);
  const data = await res.json();
  return { ok: data?.ok === true, reason: data?.ok ? undefined : data?.reason || "denied" };
}
