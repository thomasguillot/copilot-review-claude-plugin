// Per-repo "stop review gate enabled?" flag, stored under the OS temp dir keyed
// by a hash of the repo's git-root path — the same keying scheme as the loop
// state, but in a SEPARATE file so `state clear` (run by /copilot-review:loop on
// every stop path) never resets the gate. Machine-local; never committed.

import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { repoKeyPath } from "./loop-state.mjs";

function gateFile(cwd) {
  const key = createHash("sha256").update(repoKeyPath(cwd)).digest("hex").slice(0, 16);
  return join(tmpdir(), "copilot-review-loop", `${key}.gate.json`);
}

export function isGateEnabled(cwd) {
  try {
    return JSON.parse(readFileSync(gateFile(cwd), "utf8")).enabled === true;
  } catch {
    return false;
  }
}

export function setGateEnabled(cwd, enabled) {
  const file = gateFile(cwd);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  // Normalize to a strict boolean so only an explicit `true` ever enables.
  writeFileSync(tmp, JSON.stringify({ enabled: enabled === true }), "utf8");
  try {
    // POSIX-atomic fast path: rename overwrites the destination in place.
    renameSync(tmp, file);
  } catch (err) {
    // Windows: renameSync won't overwrite an existing destination. Remove the
    // destination then retry (loses POSIX atomicity on Windows; keeps it working).
    try {
      rmSync(file, { force: true });
      renameSync(tmp, file);
    } catch (err2) {
      try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
      throw err2;
    }
  }
}
