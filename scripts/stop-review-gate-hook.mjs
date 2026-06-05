#!/usr/bin/env node
// Optional stop-time review gate (default OFF). Always registered via
// hooks/hooks.json, but no-ops unless the gate has been enabled for this repo
// with `/copilot-review:setup --enable-review-gate`. When enabled and Copilot is
// available, it runs a single-shot `loop-review`; if the changes aren't clean it
// blocks the session from ending and hands off to `/copilot-review:loop`. It
// never edits code — Claude fixes, stops again, and the gate re-reviews.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { run, binaryAvailable } from "./lib/process.mjs";
import { isGateEnabled } from "./lib/gate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const COMPANION = join(here, "copilot-companion.mjs");
// Kept safely BELOW the Stop hook's own timeout in hooks.json (900s) so this
// process has headroom to emit the block decision before Claude Code kills the
// hook — otherwise a timeout would silently fail OPEN. Overridable via env for tests.
const REVIEW_TIMEOUT_MS = Number(process.env.COPILOT_REVIEW_GATE_TIMEOUT_MS) || 12 * 60 * 1000;
const DISABLE_HINT = "run /copilot-review:setup --disable-review-gate to turn off this gate";

function readHookInput() {
  try {
    const raw = readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function emitBlock(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
}

function note(message) {
  if (message) process.stderr.write(message + "\n");
}

function describeFinding(f) {
  const loc = f && f.file ? ` (${f.file}:${f.line_start ?? "?"})` : "";
  const sev = f && f.severity ? f.severity : "?";
  const title = f && f.title ? f.title : "(untitled finding)";
  return `- [${sev}] ${title}${loc}`;
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Default off: do nothing unless explicitly enabled for this repo.
  if (!isGateEnabled(cwd)) return;

  // Never trap a session when the reviewer isn't even installed.
  const avail = binaryAvailable("copilot", ["--version"], { cwd });
  if (!avail.available) {
    note(`Copilot review gate is enabled but Copilot is unavailable (${avail.detail}). Run /copilot-review:setup, or ${DISABLE_HINT}.`);
    return;
  }

  // The gate always reviews the WORKING TREE (a flag overrides any scope set in
  // .copilot-review.json), matching the documented "reviews your working-tree
  // changes" behavior and avoiding a clean-tree session being blocked on a
  // committed branch diff.
  // NOTE (known limitation): the timeout bounds this companion process; a hung
  // `copilot` grandchild may briefly outlive it (pre-existing in the /loop and
  // /review paths too). The block decision is still emitted correctly.
  const res = run(process.execPath, [COMPANION, "loop-review", "--scope", "working-tree"], { cwd, timeout: REVIEW_TIMEOUT_MS });

  if (res.error || res.signal) {
    const timedOut = Boolean(res.signal) || res.error?.code === "ETIMEDOUT";
    const why = timedOut
      ? `the review timed out or was killed${res.signal ? ` (signal ${res.signal})` : ""}`
      : `the review could not run (${res.error.code ?? res.error.message})`;
    emitBlock(`Copilot review gate: ${why}. Run /copilot-review:loop to review and fix, or ${DISABLE_HINT}.`);
    return;
  }

  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout || "").trim() || "the review could not complete";
    emitBlock(`Copilot review gate: ${detail}. Run /copilot-review:loop to review and fix, or ${DISABLE_HINT}.`);
    return;
  }

  // Defense-in-depth: a `loop-review` that exits 0 always prints valid JSON, so
  // this catch only guards against a future companion change. Block (fail-closed)
  // rather than silently allow if that invariant ever breaks.
  let result;
  try {
    result = JSON.parse(res.stdout);
  } catch {
    emitBlock(`Copilot review gate: the review returned unexpected output. Run /copilot-review:loop to review and fix, or ${DISABLE_HINT}.`);
    return;
  }

  if (result.clean) return; // allow the stop

  const blocking = Array.isArray(result.blocking) ? result.blocking : [];
  const list = blocking.map(describeFinding).join("\n");
  const count = blocking.length;
  emitBlock(
    `Copilot review gate: ${count} blocking finding(s) must be resolved before this session can end:\n${list}\n\n` +
    `Run /copilot-review:loop to fix them (or dismiss them there), or ${DISABLE_HINT}.`
  );
}

try {
  main();
} catch (error) {
  // A gate failure must not hard-crash the Stop hook; surface and allow the stop.
  note(`Copilot review gate error: ${error instanceof Error ? error.message : String(error)}`);
}
