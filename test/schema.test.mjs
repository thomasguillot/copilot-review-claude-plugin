import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validate } from "../scripts/lib/schema.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(here, "..", "schemas", "review-output.schema.json");

const CONTRACT = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));

function validReview(overrides = {}) {
  return {
    verdict: "needs-attention",
    summary: "One issue.",
    findings: [{
      severity: "high", title: "Bug", body: "Detail", file: "a.txt",
      line_start: 2, line_end: 2, confidence: 0.9, recommendation: "Fix it"
    }],
    next_steps: ["Fix the bug"],
    ...overrides
  };
}

test("contract schema is valid JSON with the expected top-level shape", () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["verdict", "summary", "findings", "next_steps"]);
  assert.deepEqual(schema.properties.verdict.enum, ["approve", "needs-attention"]);
  assert.equal(schema.properties.findings.type, "array");
  assert.deepEqual(
    schema.properties.findings.items.properties.severity.enum,
    ["critical", "high", "medium", "low"]
  );
});

test("validate accepts a conforming review", () => {
  const r = validate(validReview(), CONTRACT);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("validate accepts a clean review with empty findings", () => {
  const r = validate(validReview({ verdict: "approve", findings: [] }), CONTRACT);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("validate rejects a missing required field", () => {
  const bad = validReview();
  delete bad.summary;
  const r = validate(bad, CONTRACT);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /summary/);
});

test("validate rejects a bad enum value", () => {
  const r = validate(validReview({ verdict: "maybe" }), CONTRACT);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /verdict/);
});

test("validate rejects confidence out of range", () => {
  const bad = validReview();
  bad.findings[0].confidence = 2;
  const r = validate(bad, CONTRACT);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /confidence/);
});

test("validate rejects unexpected additional properties", () => {
  const r = validate(validReview({ extra: true }), CONTRACT);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /extra/);
});

test("validate rejects a non-object", () => {
  const r = validate("nope", CONTRACT);
  assert.equal(r.ok, false);
});

test("validate rejects a float where integer is required", () => {
  const bad = validReview();
  bad.findings[0].line_start = 1.5;
  const r = validate(bad, CONTRACT);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /line_start/);
});

test("validate rejects a missing required field inside a finding", () => {
  const bad = validReview();
  delete bad.findings[0].confidence;
  const r = validate(bad, CONTRACT);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /confidence/);
});

test("validate treats inherited (prototype) properties as missing, not present", () => {
  // All required fields live on the prototype; the object itself has no own props.
  const obj = Object.create(validReview());
  const r = validate(obj, CONTRACT);
  assert.equal(r.ok, false, "inherited required props must not satisfy 'required'");
});

test("validate flags an own property named like a prototype method as additional", () => {
  const r = validate(validReview({ toString: "x" }), CONTRACT);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /toString/);
});
