import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, delimiter } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
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
  assert.match(r.stderr, /Invalid --scope/);
  assert.equal(r.stdout.trim(), "");
});

test("review rejects an unknown flag", () => {
  const dir = tempRepo();
  const r = companion(["review", "--scpoe", "branch"], dir);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown option/);
  assert.equal(r.stdout.trim(), "");
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
  assert.match(r.stderr, /Invalid --format/i);
  assert.equal(r.stdout.trim(), "");
});

test("unknown flags are still rejected", () => {
  const dir = tempRepo();
  const r = companion(["review", "--nope"], dir);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown option/i);
  assert.equal(r.stdout.trim(), "");
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

test("loop-config prints resolved JSON config with defaults", () => {
  const dir = tempRepo();
  const r = companion(["loop-config"], dir);
  assert.equal(r.code, 0);
  const cfg = JSON.parse(r.stdout);
  assert.equal(cfg.threshold, "all");
  assert.equal(cfg.minConfidence, 0.7);
  assert.equal(cfg.maxRounds, 6);
});

test("loop-config applies .copilot-review.json then flags", () => {
  const dir = tempRepo();
  write(dir, ".copilot-review.json", JSON.stringify({ loop: { maxRounds: 4, threshold: "high" } }));
  const r = companion(["loop-config", "--max-rounds", "8"], dir);
  assert.equal(r.code, 0);
  const cfg = JSON.parse(r.stdout);
  assert.equal(cfg.maxRounds, 8);
  assert.equal(cfg.threshold, "high");
});

test("loop-config takes scope from the config file when --scope is not passed", () => {
  const dir = tempRepo();
  write(dir, ".copilot-review.json", JSON.stringify({ loop: { scope: "branch" } }));
  const r = companion(["loop-config"], dir);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).scope, "branch"); // file value, not the working-tree flag default
});

test("loop-config lets an explicit --scope override the file", () => {
  const dir = tempRepo();
  write(dir, ".copilot-review.json", JSON.stringify({ loop: { scope: "branch" } }));
  const r = companion(["loop-config", "--scope", "working-tree"], dir);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).scope, "working-tree");
});

test("loop-config reports a config error on stderr with non-zero exit", () => {
  const dir = tempRepo();
  const r = companion(["loop-config", "--threshold", "nope"], dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /threshold/i);
  assert.equal(r.stdout.trim(), "");
});

test("loop-config rejects a non-numeric --max-rounds", () => {
  const dir = tempRepo();
  const r = companion(["loop-config", "--max-rounds", "abc"], dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /max-rounds/i);
  assert.equal(r.stdout.trim(), "");
});

test("loop-config rejects a non-numeric --min-confidence", () => {
  const dir = tempRepo();
  const r = companion(["loop-config", "--min-confidence", "abc"], dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /confidence/i);
  assert.equal(r.stdout.trim(), "");
});

import { addDismissed } from "../scripts/lib/loop-state.mjs";
import { findingId } from "../scripts/lib/loop.mjs";

function companionStdin(args, cwd, input, extraEnv = {}) {
  return run("node", [COMPANION, ...args], {
    cwd, input,
    env: { ...process.env, PATH: `${STUB_DIR}${delimiter}${process.env.PATH ?? ""}`, ...extraEnv }
  });
}

const REVIEW_FINDINGS = {
  verdict: "needs-attention", summary: "x",
  findings: [
    { severity: "high", title: "Real", body: "b", file: "a.txt", line_start: 2, line_end: 2, confidence: 0.9, recommendation: "r" },
    { severity: "low", title: "Noise", body: "b", file: "a.txt", line_start: 5, line_end: 5, confidence: 0.2, recommendation: "r" }
  ],
  next_steps: []
};

test("filter keeps high-confidence findings and drops low-confidence noise", () => {
  const dir = tempRepo();
  const r = companionStdin(["filter"], dir, JSON.stringify(REVIEW_FINDINGS));
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.clean, false);
  assert.equal(out.blocking.length, 1);
  assert.equal(out.blocking[0].title, "Real");
  assert.match(out.blocking[0].id, /^[0-9a-f]{12}$/, "each blocking finding carries its id");
  assert.equal(out.ignoredCount, 1);
});

test("filter reports clean when only low-confidence findings exist", () => {
  const dir = tempRepo();
  const onlyNoise = { verdict: "needs-attention", summary: "x",
    findings: [{ severity: "high", title: "N", body: "b", file: "a.txt", line_start: 1, line_end: 1, confidence: 0.3, recommendation: "r" }],
    next_steps: [] };
  const r = companionStdin(["filter"], dir, JSON.stringify(onlyNoise));
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).clean, true);
});

test("filter subtracts dismissed findings recorded in state", () => {
  const dir = tempRepo();
  const realId = findingId(REVIEW_FINDINGS.findings[0]); // the "Real" high-confidence finding
  addDismissed(dir, realId); // set state directly via the lib (Fix B canonicalizes inside stateFile)
  const r = companionStdin(["filter"], dir, JSON.stringify(REVIEW_FINDINGS));
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).clean, true); // Real dismissed, Noise below floor
});

test("filter errors on unparseable stdin", () => {
  const dir = tempRepo();
  const r = companionStdin(["filter"], dir, "not json");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /parse|json/i);
  assert.equal(r.stdout.trim(), "");
});

test("filter rejects valid-but-non-object stdin (e.g. null)", () => {
  const dir = tempRepo();
  const r = companionStdin(["filter"], dir, "null");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /review json object|expected/i);
  assert.equal(r.stdout.trim(), "");
});

test("state get returns zeroed state initially", () => {
  const dir = tempRepo();
  const r = companion(["state", "get"], dir);
  assert.equal(r.code, 0);
  const s = JSON.parse(r.stdout);
  assert.equal(s.round, 0);
  assert.deepEqual(s.dismissed, []);
});

test("state set-round and dismiss persist and round-trip", () => {
  const dir = tempRepo();
  companion(["state", "set-round", "2"], dir);
  companion(["state", "dismiss", "key-1"], dir);
  const r = companion(["state", "get"], dir);
  const s = JSON.parse(r.stdout);
  assert.equal(s.round, 2);
  assert.deepEqual(s.dismissed, ["key-1"]);
});

test("state dismiss preserves a key containing spaces (finding key shape)", () => {
  const dir = tempRepo();
  const key = "a.txt 2 2 Some Title";
  companion(["state", "dismiss", key], dir);
  assert.deepEqual(JSON.parse(companion(["state", "get"], dir).stdout).dismissed, [key]);
});

test("state clear resets everything", () => {
  const dir = tempRepo();
  companion(["state", "set-round", "3"], dir);
  companion(["state", "clear"], dir);
  assert.equal(JSON.parse(companion(["state", "get"], dir).stdout).round, 0);
});

test("state set-round rejects a non-integer", () => {
  const dir = tempRepo();
  const r = companion(["state", "set-round", "abc"], dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /integer/i);
});

test("state dismiss with no key errors on stderr", () => {
  const dir = tempRepo();
  const r = companion(["state", "dismiss"], dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /finding id/i);
  assert.equal(r.stdout.trim(), "");
});

test("state with no action prints usage and errors", () => {
  const dir = tempRepo();
  const r = companion(["state"], dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /usage/i);
});

test("state set-round with no value reports it clearly", () => {
  const dir = tempRepo();
  const r = companion(["state", "set-round"], dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no value/i);
});

test("state attempt records a key and state get reports it", () => {
  const dir = tempRepo();
  companion(["state", "attempt", "osc-key"], dir);
  assert.deepEqual(JSON.parse(companion(["state", "get"], dir).stdout).attempted, ["osc-key"]);
});

test("loop command exists with front-matter and references the subcommands", () => {
  const md = readFileSync(join(here, "..", "commands", "loop.md"), "utf8");
  assert.match(md, /^---/);
  assert.match(md, /allowed-tools:/);
  assert.match(md, /loop-config/);
  assert.match(md, /loop-review/);
  assert.match(md, /state/);
  assert.match(md, /attempt/);      // durable oscillation tracking
  assert.match(md, /\bid\b/);        // uses the opaque finding id
  assert.match(md, /round/i);
  assert.doesNotMatch(md, /\/tmp\//); // no hardcoded temp path
});

test("loop-review returns not-clean with id'd blocking findings (stub json-findings)", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "one\n");
  const r = companion(["loop-review"], dir, { COPILOT_STUB_MODE: "json-findings" });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.clean, false);
  assert.equal(out.blocking.length, 1);
  assert.match(out.blocking[0].id, /^[0-9a-f]{12}$/);
});

test("loop-review returns clean when the stub approves", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "one\n");
  const r = companion(["loop-review"], dir, { COPILOT_STUB_MODE: "json-clean" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).clean, true);
});

test("loop-review treats an empty working tree as clean", () => {
  const dir = tempRepo(); // no changes
  const r = companion(["loop-review"], dir, { COPILOT_STUB_MODE: "json-findings" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).clean, true);
});

test("loop-review subtracts a dismissed finding by id", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "one\n");
  // The stub json-findings finding:
  const stubFinding = { severity: "high", title: "Example", body: "Example finding from stub reviewer.", file: "a.txt", line_start: 2, line_end: 2, confidence: 0.9, recommendation: "Fix it." };
  addDismissed(dir, findingId(stubFinding));
  const r = companion(["loop-review"], dir, { COPILOT_STUB_MODE: "json-findings" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).clean, true);
});

test("loop-review on branch scope with no detectable base errors instead of reporting clean", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "base\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "base"); // on main; main === HEAD so no base is detected
  const r = companion(["loop-review", "--scope", "branch"], dir, { COPILOT_STUB_MODE: "json-clean" });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /base branch/i);
  assert.equal(r.stdout.trim(), "");
});

test("loop-review fails (non-zero, empty stdout) when the review is unparseable", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "one\n");
  const r = companion(["loop-review"], dir, { COPILOT_STUB_MODE: "json-malformed" });
  assert.notEqual(r.code, 0);
  assert.equal(r.stdout.trim(), "");
});

test("loop-review fails on a truncated diff instead of reviewing a partial", () => {
  const dir = tempRepo();
  write(dir, "seed.txt", "x\n");
  git(dir, "add", "seed.txt");
  git(dir, "commit", "-q", "-m", "init");
  const big = "y\n".repeat(10000); // ~20KB each
  for (let i = 0; i < 25; i++) write(dir, `f${i}.txt`, big); // exceeds the 200KB scope cap
  const r = companion(["loop-review"], dir, { COPILOT_STUB_MODE: "json-clean" });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /truncat/i);
  assert.equal(r.stdout.trim(), "");
});

test("loop-config finds .copilot-review.json at the repo root from a subdirectory", () => {
  const dir = tempRepo();
  write(dir, ".copilot-review.json", JSON.stringify({ loop: { maxRounds: 3 } }));
  const sub = join(dir, "nested", "deep");
  mkdirSync(sub, { recursive: true });
  const r = companion(["loop-config"], sub);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).maxRounds, 3);
});

test("review rejects loop-only flags (fail loud)", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "x\n");
  const r = companion(["review", "--threshold", "high"], dir);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /only valid for the loop/i);
  assert.equal(r.stdout.trim(), "");
});

test("setup rejects loop-only flags (fail loud)", () => {
  const dir = tempRepo();
  const r = companion(["setup", "--max-rounds", "3"], dir);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /only valid for the loop/i);
});

test("loop-review branch scope with no base errors even when there are uncommitted edits", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "base\n");
  git(dir, "add", "a.txt"); git(dir, "commit", "-q", "-m", "base"); // on main; main===HEAD → no base
  write(dir, "a.txt", "base\nuncommitted\n"); // uncommitted edit → diff HEAD is non-empty
  const r = companion(["loop-review", "--scope", "branch"], dir, { COPILOT_STUB_MODE: "json-clean" });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /base branch/i);
  assert.equal(r.stdout.trim(), "");
});

test("filter rejects a review object without a findings array", () => {
  const dir = tempRepo();
  const r = companionStdin(["filter"], dir, JSON.stringify({ verdict: "approve" }));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /findings/i);
  assert.equal(r.stdout.trim(), "");
});

test("loop-config does not read a .copilot-review.json from outside the git root", () => {
  // Parent dir holds a config; a git repo nested inside it must NOT pick it up.
  const parent = mkdtempSync(join(tmpdir(), "outside-"));
  write(parent, ".copilot-review.json", JSON.stringify({ loop: { maxRounds: 99 } }));
  const repo = join(parent, "repo");
  mkdirSync(repo, { recursive: true });
  run("git", ["init", "-q"], { cwd: repo });
  const r = companion(["loop-config"], repo);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).maxRounds, 6); // default, NOT 99 from the parent
});

test("loop-config returns a controlled error (not a stack trace) when .copilot-review.json is unreadable", () => {
  const dir = tempRepo();
  // A *directory* named .copilot-review.json makes readFileSync throw EISDIR.
  mkdirSync(join(dir, ".copilot-review.json"));
  const r = companion(["loop-config"], dir);
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.stderr, /at .*\.mjs:\d+/); // no raw stack frames
  assert.match(r.stderr, /\.copilot-review\.json/);
});
