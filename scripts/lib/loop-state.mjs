// Per-repo loop state (round counter + dismissed/attempted finding ids), stored
// under the OS temp dir keyed by a hash of the repo's git-root path. Kept out of
// the repo so it never shows up in diffs; survives context resets within the
// same machine.

import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { run } from "./process.mjs";

// Resolve the path the state is keyed on: the git root when inside a repo, so
// `state get/dismiss/attempt` behave identically no matter which subdirectory
// the command is run from. Falls back to the canonicalized cwd outside a repo.
// Exported for sibling state modules like gate.mjs.
export function repoKeyPath(cwd) {
  // Bound the git call: if it stalls (e.g. slow network FS), fall back to the
  // cwd-based key rather than hanging callers — notably the Stop-gate hook,
  // which calls this on every session end even when the gate is disabled.
  const top = run("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 });
  if (!top.error && top.code === 0 && top.stdout.trim()) {
    const root = top.stdout.trim();
    try { return realpathSync(root); } catch { return resolve(root); }
  }
  // Canonicalize so a symlinked path and its real path map to the same state
  // file (a spawned process's cwd is the realpath; resolve() alone keeps symlinks).
  try {
    return realpathSync(resolve(cwd));
  } catch {
    return resolve(cwd); // path may not exist yet
  }
}

function stateFile(cwd) {
  const key = createHash("sha256").update(repoKeyPath(cwd)).digest("hex").slice(0, 16);
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
    // POSIX-atomic fast path: rename overwrites the destination in place.
    renameSync(tmp, file);
  } catch (err) {
    // Windows: renameSync won't overwrite an existing destination, so updates
    // after the first one fail. Retry after removing the destination (loses
    // POSIX atomicity on Windows, but keeps state persistence working).
    try {
      rmSync(file, { force: true });
      renameSync(tmp, file);
    } catch (err2) {
      try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
      throw err2;
    }
  }
}

export function setRound(cwd, round) {
  const s = readState(cwd);
  s.round = round;
  writeState(cwd, s);
}

export function addDismissed(cwd, id) {
  const s = readState(cwd);
  if (!s.dismissed.includes(id)) s.dismissed.push(id);
  writeState(cwd, s);
}

export function addAttempted(cwd, id) {
  const s = readState(cwd);
  if (!s.attempted.includes(id)) s.attempted.push(id);
  writeState(cwd, s);
}

export function clearState(cwd) {
  try {
    rmSync(stateFile(cwd), { force: true });
  } catch {
    /* already gone */
  }
}
