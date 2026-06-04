import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, delimiter } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { run } from "../scripts/lib/process.mjs";
import { tempRepo, write, git } from "./helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const COMPANION = join(here, "..", "scripts", "copilot-companion.mjs");
const STUB_DIR = join(here, "fixtures", "bin");

// Run the companion with the stub `copilot` on PATH.
function companion(args, cwd, extraEnv = {}) {
  return run("node", [COMPANION, ...args], {
    cwd,
    env: { ...process.env, PATH: `${STUB_DIR}${delimiter}${process.env.PATH ?? ""}`, ...extraEnv }
  });
}

test("setup reports copilot detected", () => {
  const dir = tempRepo();
  const r = companion(["setup"], dir, { COPILOT_GITHUB_TOKEN: "", GH_TOKEN: "", GITHUB_TOKEN: "" });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /copilot detected/i);
});

test("setup detects env credentials", () => {
  const dir = tempRepo();
  const r = companion(["setup"], dir, { COPILOT_GITHUB_TOKEN: "abc" });
  assert.match(r.stdout, /Credentials detected/);
});

test("setup --probe verifies via stub", () => {
  const dir = tempRepo();
  const r = companion(["setup", "--probe"], dir);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Auth verified/);
});

test("review on a change returns stub findings", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  write(dir, "a.txt", "x\ny\n");
  const r = companion(["review"], dir);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /## Summary/);
});

test("review on a clean repo says nothing to review", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  const r = companion(["review"], dir);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /[Nn]othing to review/);
});

test("review streams large output without truncation", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  write(dir, "a.txt", "x\nBIGOUTPUT\n");
  const r = companion(["review"], dir);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.length > 64 * 1024, `expected >64KB of stdout, got ${r.stdout.length}`);
  assert.match(r.stdout, /LINE 2000/); // last line present => nothing truncated
});

test("review truncation notice caps the dropped-files list", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  const big = "y\n".repeat(10000); // ~20 KB each
  for (let i = 0; i < 25; i++) write(dir, `f${i}.txt`, big); // ~500 KB total, exceeds the 200 KB cap
  const r = companion(["review"], dir);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /truncated/);
  assert.match(r.stdout, /and \d+ more/); // list capped, remainder summarized
});

test("review --scope branch with no detectable base gives a hint", () => {
  const dir = tempRepo();
  // Move to a branch name that won't be auto-detected, with no main/master/remote.
  git(dir, "symbolic-ref", "HEAD", "refs/heads/develop");
  write(dir, "a.txt", "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  const r = companion(["review", "--scope", "branch"], dir);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Could not detect a base branch|--base/);
});

test("review --scope branch with an invalid base errors clearly", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  const r = companion(["review", "--scope", "branch", "--base", "no-such-ref-xyz"], dir);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Cannot review|Could not diff against base/);
});

test("review with an invalid --scope value fails fast", () => {
  const dir = tempRepo();
  const r = companion(["review", "--scope", "brnach"], dir);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /Invalid --scope/);
});

test("review rejects an unknown flag", () => {
  const dir = tempRepo();
  const r = companion(["review", "--scpoe", "branch"], dir);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /Unknown option/);
});

test("review outside a git repository errors instead of reporting clean", () => {
  const dir = mkdtempSync(join(tmpdir(), "nogit-"));
  const r = companion(["review"], dir);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Cannot review|git diff failed|not a git/i);
});

test("review strips surrounding quotes from a flag value", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  // Quoted base ref: quotes must be stripped so the error names the bare ref.
  const r = companion(["review", "--scope", "branch", "--base", '"no-such-ref-xyz"'], dir);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /no-such-ref-xyz/);
  assert.doesNotMatch(r.stdout, /"no-such-ref-xyz"/); // quotes were stripped
});

test("stub still verifies auth via READY even when a JSON mode is set", () => {
  const dir = tempRepo();
  const r = companion(["setup", "--probe"], dir, { COPILOT_STUB_MODE: "json-findings" });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Auth verified/);
});

test("review rejects an invalid --format value", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "one\n");
  const r = companion(["review", "--format", "xml"], dir);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /Invalid --format/i);
});

test("unknown flags are still rejected", () => {
  const dir = tempRepo();
  const r = companion(["review", "--nope"], dir);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /Unknown option/i);
});

test("review --format json emits validated JSON with findings", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "one\n");
  const r = companion(["review", "--format", "json"], dir, { COPILOT_STUB_MODE: "json-findings" });
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.verdict, "needs-attention");
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].severity, "high");
});

test("review --json (shorthand) emits a clean approve verdict", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "one\n");
  const r = companion(["review", "--json"], dir, { COPILOT_STUB_MODE: "json-clean" });
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.verdict, "approve");
  assert.deepEqual(parsed.findings, []);
});

test("review --format json retries once then fails loudly on malformed output", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "one\n");
  const callsFile = join(mkdtempSync(join(tmpdir(), "calls-")), "calls.log");
  const r = companion(["review", "--format", "json"], dir, {
    COPILOT_STUB_MODE: "json-malformed",
    COPILOT_STUB_CALLS: callsFile
  });
  assert.notEqual(r.code, 0);
  assert.equal(r.stdout.trim(), "", "stdout must stay empty on failure so JSON.parse is only attempted on success");
  assert.match(r.stderr, /could not|parse|contract|valid/i);
  const calls = readFileSync(callsFile, "utf8").trim().split("\n").length;
  assert.equal(calls, 2, "should call copilot twice: initial + one retry");
});

test("review markdown path is unchanged (default format)", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "one\n");
  const r = companion(["review"], dir);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /## Summary/);
});

test("review --format json makes exactly one call on a clean success", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "one\n");
  const callsFile = join(mkdtempSync(join(tmpdir(), "calls-ok-")), "calls.log");
  const r = companion(["review", "--format", "json"], dir, {
    COPILOT_STUB_MODE: "json-findings",
    COPILOT_STUB_CALLS: callsFile
  });
  assert.equal(r.code, 0);
  const calls = readFileSync(callsFile, "utf8").trim().split("\n").length;
  assert.equal(calls, 1, "a successful structured review must not trigger a retry");
});

test("review --format json on a clean tree emits a valid clean approve object", () => {
  const dir = tempRepo(); // no changes written → empty scope
  const r = companion(["review", "--format", "json"], dir);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.stdout); // must be pure JSON
  assert.equal(parsed.verdict, "approve");
  assert.deepEqual(parsed.findings, []);
});

test("review (markdown) on a clean tree still prints the plain nothing-to-review message", () => {
  const dir = tempRepo();
  const r = companion(["review"], dir);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /[Nn]othing to review/);
});

test("review --format=json (equals form) is accepted", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "one\n");
  const r = companion(["review", "--format=json"], dir, { COPILOT_STUB_MODE: "json-clean" });
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.verdict, "approve");
});

test("review --format json fails (no partial JSON) when the diff is truncated", () => {
  const dir = tempRepo();
  // resolveScope uses maxBytes=200000 (200 KB). Write untracked files totalling
  // well above that cap (~500 KB) so scope.truncated is guaranteed to be true.
  const big = "y\n".repeat(10000); // ~20 KB each
  for (let i = 0; i < 25; i++) write(dir, `big${i}.txt`, big);
  const r = companion(["review", "--format", "json"], dir, { COPILOT_STUB_MODE: "json-clean" });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /truncat/i);
  assert.equal(r.stdout.trim(), "", "must not emit any JSON on a truncated diff");
});
