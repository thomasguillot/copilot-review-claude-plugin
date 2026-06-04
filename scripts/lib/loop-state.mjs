// Per-repo loop state (round counter + dismissed-finding keys), stored under the
// OS temp dir keyed by a hash of the repo's absolute path. Kept out of the repo
// so it never shows up in diffs; survives context resets within the same machine.

import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";

function stateFile(cwd) {
  // Canonicalize so a symlinked path and its real path map to the same state
  // file (a spawned process's cwd is the realpath; resolve() alone keeps symlinks).
  let canonical;
  try {
    canonical = realpathSync(resolve(cwd));
  } catch {
    canonical = resolve(cwd); // path may not exist yet
  }
  const key = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const dir = join(tmpdir(), "copilot-review-loop");
  return join(dir, `${key}.json`);
}

export function readState(cwd) {
  try {
    const data = JSON.parse(readFileSync(stateFile(cwd), "utf8"));
    return {
      round: Number.isInteger(data.round) ? data.round : 0,
      dismissed: Array.isArray(data.dismissed) ? data.dismissed : [],
      attempted: Array.isArray(data.attempted) ? data.attempted : []
    };
  } catch {
    return { round: 0, dismissed: [], attempted: [] };
  }
}

function writeState(cwd, state) {
  const file = stateFile(cwd);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), "utf8");
  try {
    renameSync(tmp, file);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

export function setRound(cwd, round) {
  const s = readState(cwd);
  s.round = round;
  writeState(cwd, s);
}

export function addDismissed(cwd, key) {
  const s = readState(cwd);
  if (!s.dismissed.includes(key)) s.dismissed.push(key);
  writeState(cwd, s);
}

export function addAttempted(cwd, key) {
  const s = readState(cwd);
  if (!s.attempted.includes(key)) s.attempted.push(key);
  writeState(cwd, s);
}

export function clearState(cwd) {
  try {
    rmSync(stateFile(cwd), { force: true });
  } catch {
    /* already gone */
  }
}
