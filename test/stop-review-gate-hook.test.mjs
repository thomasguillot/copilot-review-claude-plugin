import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, delimiter } from "node:path";
import { readFileSync } from "node:fs";
import { run } from "../scripts/lib/process.mjs";
import { tempRepo, write, git } from "./helpers.mjs";
import { setGateEnabled } from "../scripts/lib/gate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, "..", "scripts", "stop-review-gate-hook.mjs");
const STUB_DIR = join(here, "fixtures", "bin");

// Invoke the hook with the stub `copilot` on PATH and a hook-input JSON on stdin.
function hook(cwd, { stubMode, withStub = true, timeoutMs } = {}) {
  const path = withStub ? `${STUB_DIR}${delimiter}${process.env.PATH ?? ""}` : "/nonexistent-bin-dir";
  return run(process.execPath, [HOOK], {
    cwd,
    input: JSON.stringify({ cwd }),
    env: {
      ...process.env,
      PATH: path,
      ...(stubMode ? { COPILOT_STUB_MODE: stubMode } : {}),
      ...(timeoutMs ? { COPILOT_REVIEW_GATE_TIMEOUT_MS: String(timeoutMs) } : {})
    }
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

test("enabled gate + review times out: blocks with escape hatch", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "one\n");
  setGateEnabled(dir, true);
  const r = hook(dir, { stubMode: "sleep", timeoutMs: 200 });
  assert.equal(r.code, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /timed out or was killed/);
  assert.match(payload.reason, /disable-review-gate/);
});

test("hooks.json registers the Stop hook pointing at the gate script", () => {
  const manifest = JSON.parse(readFileSync(join(here, "..", "hooks", "hooks.json"), "utf8"));
  assert.ok(manifest.hooks && Array.isArray(manifest.hooks.Stop), "expected a Stop hook array");
  const cmds = manifest.hooks.Stop.flatMap((g) => g.hooks).map((h) => h.command);
  assert.ok(cmds.some((c) => /stop-review-gate-hook\.mjs/.test(c)), "Stop hook should run the gate script");
  assert.ok(cmds.some((c) => c.includes("${CLAUDE_PLUGIN_ROOT}")), "should reference CLAUDE_PLUGIN_ROOT");
});

test("gate review timeout default stays safely under the Stop hook timeout", () => {
  const src = readFileSync(join(here, "..", "scripts", "stop-review-gate-hook.mjs"), "utf8");
  const m = src.match(/\|\|\s*(\d+)\s*\*\s*60\s*\*\s*1000/);
  assert.ok(m, "expected an `N * 60 * 1000` review-timeout default in the hook");
  const internalSeconds = Number(m[1]) * 60;
  const manifest = JSON.parse(readFileSync(join(here, "..", "hooks", "hooks.json"), "utf8"));
  const hookTimeout = manifest.hooks.Stop.flatMap((g) => g.hooks).map((h) => h.timeout).find((t) => typeof t === "number");
  assert.ok(internalSeconds < hookTimeout, `internal review timeout (${internalSeconds}s) must be < the Stop hook timeout (${hookTimeout}s)`);
});

test("hooks.json Stop entries use the command-hook group shape", () => {
  const manifest = JSON.parse(readFileSync(join(here, "..", "hooks", "hooks.json"), "utf8"));
  assert.ok(Array.isArray(manifest.hooks.Stop) && manifest.hooks.Stop.length > 0);
  for (const group of manifest.hooks.Stop) {
    assert.ok(Array.isArray(group.hooks), "each Stop entry is a matcher group with a hooks array");
    for (const h of group.hooks) {
      assert.equal(h.type, "command");
      assert.equal(typeof h.command, "string");
      assert.ok(h.command.length > 0);
    }
  }
});

test("enabled gate forces working-tree scope, ignoring .copilot-review.json loop.scope=branch", () => {
  const dir = tempRepo();
  // Commit a change so a branch diff exists, but leave the WORKING TREE clean.
  write(dir, "a.txt", "one\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "c");
  write(dir, ".copilot-review.json", JSON.stringify({ loop: { scope: "branch" } }));
  git(dir, "add", ".copilot-review.json");
  git(dir, "commit", "-q", "-m", "cfg");
  setGateEnabled(dir, true);
  // Forced working-tree scope sees a clean tree => "nothing to review" => allow stop.
  // (Without the forced scope, branch scope on a repo whose HEAD==main has no
  // detectable base and loop-review would exit non-zero => an erroneous block.)
  const r = hook(dir, { stubMode: "json-findings" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "");
});
