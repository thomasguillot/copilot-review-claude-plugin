import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildReviewPrompt,
  getAuthStatus,
  cleanCopilotOutput,
  buildReviewArgs,
  runReview,
  probeAuth,
  probeSaysReady,
  parseStructuredReview
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

test("runReview rejects an oversized prompt instead of failing to spawn", () => {
  const big = "x".repeat(1_100_000); // exceeds the conservative argv limit on all platforms
  const r = runReview({ cwd: process.cwd(), prompt: big, copilotBin: STUB });
  assert.equal(r.ok, false);
  assert.match(r.detail, /too large/i);
});

test("probeAuth succeeds against stub READY reply", () => {
  const r = probeAuth({ cwd: process.cwd(), copilotBin: STUB });
  assert.equal(r.ok, true);
});

test("probeSaysReady accepts a standalone READY, rejects NOT READY", () => {
  assert.equal(probeSaysReady("READY"), true);
  assert.equal(probeSaysReady("ok\nREADY\n"), true);
  assert.equal(probeSaysReady("NOT READY"), false);
  assert.equal(probeSaysReady("already done"), false);
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

const JSON_TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts", "review-json.md");

test("json template instructs JSON-only output and keeps placeholders", () => {
  const tpl = readFileSync(JSON_TEMPLATE, "utf8");
  assert.match(tpl, /\{\{SCOPE\}\}/);
  assert.match(tpl, /\{\{DIFF\}\}/);
  assert.match(tpl, /JSON/);
  assert.match(tpl, /verdict/);
  assert.match(tpl, /findings/);
  assert.match(tpl, /only.*JSON|JSON only/i);
});

test("buildReviewPrompt substitutes into the json template", () => {
  const out = buildReviewPrompt({ diff: "DIFFBODY", scopeLabel: "working tree", templatePath: JSON_TEMPLATE });
  assert.match(out, /working tree/);
  assert.match(out, /DIFFBODY/);
  assert.equal(out.includes("{{"), false);
});

test("parseStructuredReview parses clean JSON", () => {
  const json = JSON.stringify({
    verdict: "approve", summary: "All good.", findings: [], next_steps: []
  });
  const r = parseStructuredReview(json);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.verdict, "approve");
});

test("parseStructuredReview strips code fences and leading prose", () => {
  const body = "Here is the review:\n```json\n" +
    JSON.stringify({ verdict: "approve", summary: "ok", findings: [], next_steps: [] }) +
    "\n```";
  const r = parseStructuredReview(body);
  assert.equal(r.ok, true, r.error);
});

test("parseStructuredReview rejects non-JSON", () => {
  const r = parseStructuredReview("I could not produce JSON, sorry.");
  assert.equal(r.ok, false);
  assert.match(r.error, /could not|parse|JSON/i);
});

test("parseStructuredReview rejects JSON that violates the contract", () => {
  const r = parseStructuredReview(JSON.stringify({ verdict: "maybe", summary: "x", findings: [], next_steps: [] }));
  assert.equal(r.ok, false);
  assert.match(r.error, /verdict/);
});

test("parseStructuredReview finds the object after brace-containing prose", () => {
  const body = 'The {severity} field matters. Here is the result: ' +
    JSON.stringify({ verdict: "approve", summary: "ok", findings: [], next_steps: [] });
  const r = parseStructuredReview(body);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.verdict, "approve");
});

test("parseStructuredReview reports a JSON parse failure for malformed braces", () => {
  const r = parseStructuredReview("{ verdict: approve, not valid json }");
  assert.equal(r.ok, false);
  assert.match(r.error, /parse|match|JSON/i);
});

test("parseStructuredReview asserts the parsed data shape on the fenced case", () => {
  const body = "```json\n" +
    JSON.stringify({ verdict: "needs-attention", summary: "x", findings: [
      { severity: "low", title: "t", body: "b", file: "f", line_start: 1, line_end: 1, confidence: 0.5, recommendation: "r" }
    ], next_steps: ["s"] }) +
    "\n```";
  const r = parseStructuredReview(body);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.findings.length, 1);
  assert.equal(r.data.findings[0].severity, "low");
});

test("parseStructuredReview handles braces inside a finding body string", () => {
  const r = parseStructuredReview(JSON.stringify({
    verdict: "needs-attention", summary: "ok",
    findings: [{ severity: "low", title: "t",
      body: "Use } to close and { to open",
      file: "f", line_start: 1, line_end: 1,
      confidence: 0.9, recommendation: "r" }],
    next_steps: []
  }));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.findings[0].body, "Use } to close and { to open");
});

test("parseStructuredReview rejects approve verdict with findings", () => {
  const r = parseStructuredReview(JSON.stringify({
    verdict: "approve", summary: "x",
    findings: [{ severity: "low", title: "t", body: "b", file: "f", line_start: 1, line_end: 1, confidence: 0.5, recommendation: "r" }],
    next_steps: []
  }));
  assert.equal(r.ok, false);
  assert.match(r.error, /inconsistent/i);
});

test("parseStructuredReview rejects needs-attention verdict with no findings", () => {
  const r = parseStructuredReview(JSON.stringify({
    verdict: "needs-attention", summary: "x", findings: [], next_steps: []
  }));
  assert.equal(r.ok, false);
  assert.match(r.error, /inconsistent/i);
});

test("parseStructuredReview rejects reversed finding line ranges", () => {
  const r = parseStructuredReview(JSON.stringify({
    verdict: "needs-attention", summary: "x",
    findings: [{ severity: "low", title: "t", body: "b", file: "f", line_start: 10, line_end: 4, confidence: 0.5, recommendation: "r" }],
    next_steps: []
  }));
  assert.equal(r.ok, false);
  assert.match(r.error, /range|line_end|line_start/i);
});

test("parseStructuredReview fails on multiple valid review objects (ambiguous)", () => {
  const a = JSON.stringify({ verdict: "approve", summary: "ok", findings: [], next_steps: [] });
  const b = JSON.stringify({ verdict: "needs-attention", summary: "real",
    findings: [{ severity: "high", title: "t", body: "b", file: "f", line_start: 1, line_end: 2, confidence: 0.9, recommendation: "r" }],
    next_steps: ["s"] });
  const r = parseStructuredReview(a + "\n\n" + b);
  assert.equal(r.ok, false);
  assert.match(r.error, /ambiguous/i);
});

test("parseStructuredReview still accepts a single valid object after prose", () => {
  const body = "Here is the review:\n" + JSON.stringify({
    verdict: "needs-attention", summary: "x",
    findings: [{ severity: "low", title: "t", body: "b", file: "f", line_start: 1, line_end: 1, confidence: 0.5, recommendation: "r" }],
    next_steps: []
  });
  const r = parseStructuredReview(body);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.verdict, "needs-attention");
});

test("parseStructuredReview does not accept a review nested inside an invalid object", () => {
  const nested = { verdict: "approve", summary: "ok", findings: [], next_steps: [] };
  const outer = { verdict: "approve", summary: "ok", findings: [], next_steps: [], example: nested };
  const r = parseStructuredReview(JSON.stringify(outer)); // outer fails (additionalProperties: "example")
  assert.equal(r.ok, false);
});
