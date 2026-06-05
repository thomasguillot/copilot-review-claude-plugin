import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, delimiter } from "node:path";
import { run } from "../scripts/lib/process.mjs";
import { tempRepo, write } from "./helpers.mjs";
import { setGateEnabled } from "../scripts/lib/gate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, "..", "scripts", "stop-review-gate-hook.mjs");
const STUB_DIR = join(here, "fixtures", "bin");

// Invoke the hook with the stub `copilot` on PATH and a hook-input JSON on stdin.
function hook(cwd, { stubMode, withStub = true } = {}) {
  const path = withStub ? `${STUB_DIR}${delimiter}${process.env.PATH ?? ""}` : "/nonexistent-bin-dir";
  return run(process.execPath, [HOOK], {
    cwd,
    input: JSON.stringify({ cwd }),
    env: { ...process.env, PATH: path, ...(stubMode ? { COPILOT_STUB_MODE: stubMode } : {}) }
  });
}

test("disabled gate: no decision emitted even when findings exist", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "one\n");
  const r = hook(dir, { stubMode: "json-findings" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "");
});

test("enabled gate + clean review: allows the stop (no block)", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "one\n");
  setGateEnabled(dir, true);
  const r = hook(dir, { stubMode: "json-clean" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "");
});

test("enabled gate + findings: blocks with finding details and hand-off guidance", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "one\n");
  setGateEnabled(dir, true);
  const r = hook(dir, { stubMode: "json-findings" });
  assert.equal(r.code, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /Example/);
  assert.match(payload.reason, /copilot-review:loop/);
  assert.match(payload.reason, /disable-review-gate/);
});

test("enabled gate + nothing to review: allows the stop", () => {
  const dir = tempRepo(); // no changes
  setGateEnabled(dir, true);
  const r = hook(dir, { stubMode: "json-findings" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "");
});

test("enabled gate + Copilot unavailable: notes it, does not block", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "one\n");
  setGateEnabled(dir, true);
  const r = hook(dir, { stubMode: "json-findings", withStub: false });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "");
  assert.match(r.stderr, /unavailable|not.*found|disable-review-gate/i);
});

test("enabled gate + unparseable review: blocks with an error reason + escape hatch", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "one\n");
  setGateEnabled(dir, true);
  const r = hook(dir, { stubMode: "json-malformed" });
  assert.equal(r.code, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /disable-review-gate/);
});

test("malformed hook stdin does not crash the hook", () => {
  const dir = tempRepo();
  const r = run(process.execPath, [HOOK], {
    cwd: dir,
    input: "not json",
    env: { ...process.env, PATH: `${STUB_DIR}${delimiter}${process.env.PATH ?? ""}` }
  });
  assert.equal(r.code, 0, r.stderr); // gate disabled for this dir → silent no-op
});
