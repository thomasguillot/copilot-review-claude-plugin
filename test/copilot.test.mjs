import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildReviewPrompt,
  getAuthStatus,
  cleanCopilotOutput,
  buildReviewArgs,
  runReview,
  probeAuth
} from "../scripts/lib/copilot.mjs";

const STUB = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bin", "copilot");

function tmpTemplate(content) {
  const p = join(mkdtempSync(join(tmpdir(), "tmpl-")), "review.md");
  writeFileSync(p, content);
  return p;
}

test("buildReviewPrompt substitutes scope and diff", () => {
  const tpl = tmpTemplate("Scope: {{SCOPE}}\nDiff:\n{{DIFF}}");
  const out = buildReviewPrompt({ diff: "DIFFBODY", scopeLabel: "working tree", templatePath: tpl });
  assert.match(out, /Scope: working tree/);
  assert.match(out, /DIFFBODY/);
  assert.equal(out.includes("{{"), false);
});

test("getAuthStatus detects env var credentials", () => {
  const r = getAuthStatus({ env: { COPILOT_GITHUB_TOKEN: "abc" }, skipGh: true });
  assert.equal(r.likelyAuthed, true);
  assert.deepEqual(r.sources, ["COPILOT_GITHUB_TOKEN"]);
});

test("getAuthStatus reports nothing detected when env empty", () => {
  const r = getAuthStatus({ env: {}, skipGh: true });
  assert.equal(r.likelyAuthed, false);
  assert.equal(r.sources.length, 0);
});

test("cleanCopilotOutput trims surrounding blank lines", () => {
  assert.equal(cleanCopilotOutput("\n\n## Summary\nok\n\n"), "## Summary\nok");
});

test("runReview returns cleaned stub output", () => {
  const r = runReview({ cwd: process.cwd(), prompt: "review please", copilotBin: STUB });
  assert.equal(r.ok, true);
  assert.match(r.output, /## Summary/);
  assert.match(r.output, /example finding from stub/);
});

test("runReview reports failure when binary missing", () => {
  const r = runReview({ cwd: process.cwd(), prompt: "x", copilotBin: "definitely-not-real-xyz" });
  assert.equal(r.ok, false);
  assert.match(r.detail, /Could not run/);
});

test("probeAuth succeeds against stub READY reply", () => {
  const r = probeAuth({ cwd: process.cwd(), copilotBin: STUB });
  assert.equal(r.ok, true);
});

test("buildReviewArgs denies write and shell tools (review-only)", () => {
  const args = buildReviewArgs({ prompt: "p" });
  assert.ok(args.includes("--no-color"));
  assert.ok(args.includes("--deny-tool"));
  assert.ok(args.includes("write"));
  assert.ok(args.includes("shell"));
});

test("buildReviewArgs appends model when provided", () => {
  const args = buildReviewArgs({ prompt: "p", model: "gpt-x" });
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("gpt-x"));
});
