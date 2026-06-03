import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReviewPrompt, getAuthStatus, cleanCopilotOutput } from "../scripts/lib/copilot.mjs";

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
