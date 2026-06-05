import { test } from "node:test";
import assert from "node:assert/strict";
import { SEVERITY_RANK, findingKey, findingId, filterFindings, resolveLoopConfig } from "../scripts/lib/loop.mjs";

function f(overrides = {}) {
  return {
    severity: "high", title: "T", body: "B", file: "a.txt",
    line_start: 1, line_end: 1, confidence: 0.9, recommendation: "fix",
    ...overrides
  };
}

test("SEVERITY_RANK orders severities low<medium<high<critical", () => {
  assert.ok(SEVERITY_RANK.low < SEVERITY_RANK.medium);
  assert.ok(SEVERITY_RANK.medium < SEVERITY_RANK.high);
  assert.ok(SEVERITY_RANK.high < SEVERITY_RANK.critical);
});

test("findingKey is stable and distinguishes file/line/title", () => {
  assert.equal(findingKey(f()), findingKey(f()));
  assert.notEqual(findingKey(f()), findingKey(f({ file: "b.txt" })));
  assert.notEqual(findingKey(f()), findingKey(f({ line_start: 9 })));
  assert.notEqual(findingKey(f()), findingKey(f({ title: "Other" })));
});

test("filterFindings with threshold=all keeps everything above the confidence floor", () => {
  const findings = [f({ severity: "low", confidence: 0.9 }), f({ severity: "critical", confidence: 0.9 })];
  const r = filterFindings(findings, { threshold: "all", minConfidence: 0.7, dismissedIds: [] });
  assert.equal(r.blocking.length, 2);
  assert.equal(r.clean, false);
});

test("filterFindings drops findings below the confidence floor (as ignored)", () => {
  const findings = [f({ confidence: 0.5 }), f({ confidence: 0.95, title: "Keep" })];
  const r = filterFindings(findings, { threshold: "all", minConfidence: 0.7, dismissedIds: [] });
  assert.equal(r.blocking.length, 1);
  assert.equal(r.blocking[0].title, "Keep");
  assert.equal(r.ignored.length, 1);
});

test("filterFindings respects a severity threshold", () => {
  const findings = [f({ severity: "low" }), f({ severity: "high", title: "Hi" })];
  const r = filterFindings(findings, { threshold: "high", minConfidence: 0, dismissedIds: [] });
  assert.equal(r.blocking.length, 1);
  assert.equal(r.blocking[0].title, "Hi");
});

test("filterFindings subtracts dismissed findings", () => {
  const keep = f({ title: "Keep" });
  const drop = f({ title: "Drop" });
  const r = filterFindings([keep, drop], {
    threshold: "all", minConfidence: 0, dismissedIds: [findingId(drop)]
  });
  assert.equal(r.blocking.length, 1);
  assert.equal(r.blocking[0].title, "Keep");
  assert.equal(r.clean, false);
});

test("filterFindings reports clean when nothing blocks", () => {
  const r = filterFindings([f({ confidence: 0.1 })], { threshold: "all", minConfidence: 0.7, dismissedIds: [] });
  assert.equal(r.clean, true);
  assert.equal(r.blocking.length, 0);
});

test("resolveLoopConfig returns built-in defaults with no file or flags", () => {
  const c = resolveLoopConfig({ flags: {}, fileText: null });
  assert.deepEqual(c.config, {
    threshold: "all", minConfidence: 0.7, maxRounds: 6,
    scope: "working-tree", base: null, model: null
  });
  assert.equal(c.error, null);
});

test("resolveLoopConfig applies file values over defaults", () => {
  const fileText = JSON.stringify({ loop: { threshold: "high", maxRounds: 3, minConfidence: 0.5 } });
  const c = resolveLoopConfig({ flags: {}, fileText });
  assert.equal(c.config.threshold, "high");
  assert.equal(c.config.maxRounds, 3);
  assert.equal(c.config.minConfidence, 0.5);
});

test("resolveLoopConfig applies flags over file and defaults", () => {
  const fileText = JSON.stringify({ loop: { threshold: "high", maxRounds: 3 } });
  const c = resolveLoopConfig({ flags: { threshold: "critical", maxRounds: 9 }, fileText });
  assert.equal(c.config.threshold, "critical");
  assert.equal(c.config.maxRounds, 9);
});

test("resolveLoopConfig rejects an invalid threshold", () => {
  const c = resolveLoopConfig({ flags: { threshold: "huge" }, fileText: null });
  assert.match(c.error, /threshold/i);
});

test("resolveLoopConfig rejects an out-of-range min-confidence", () => {
  const c = resolveLoopConfig({ flags: { minConfidence: 1.5 }, fileText: null });
  assert.match(c.error, /confidence/i);
});

test("resolveLoopConfig rejects a non-positive max-rounds", () => {
  const c = resolveLoopConfig({ flags: { maxRounds: 0 }, fileText: null });
  assert.match(c.error, /max-rounds/i);
});

test("resolveLoopConfig tolerates malformed JSON file with a clear error", () => {
  const c = resolveLoopConfig({ flags: {}, fileText: "{ not json" });
  assert.match(c.error, /parse|json/i);
});

test("resolveLoopConfig keeps a falsy-but-valid minConfidence of 0 from a flag", () => {
  const c = resolveLoopConfig({ flags: { minConfidence: 0 }, fileText: null });
  assert.equal(c.error, null);
  assert.equal(c.config.minConfidence, 0);
});

test("resolveLoopConfig rejects an invalid scope", () => {
  const c = resolveLoopConfig({ flags: { scope: "global" }, fileText: null });
  assert.match(c.error, /scope/i);
});

test("findingId is hex, stable, and distinguishes findings", () => {
  assert.match(findingId(f()), /^[0-9a-f]{12}$/);
  assert.equal(findingId(f()), findingId(f()));
  assert.notEqual(findingId(f()), findingId(f({ title: "Other" })));
});

test("filterFindings attaches an id to each blocking finding", () => {
  const r = filterFindings([f()], { threshold: "all", minConfidence: 0 });
  assert.equal(r.blocking.length, 1);
  assert.match(r.blocking[0].id, /^[0-9a-f]{12}$/);
});

test("filterFindings treats an unknown severity as blocking (fail loud)", () => {
  const r = filterFindings([f({ severity: "bogus", confidence: 0.99 })], { threshold: "all", minConfidence: 0.7 });
  assert.equal(r.clean, false);
  assert.equal(r.blocking.length, 1);
});

test("resolveLoopConfig rejects NaN min-confidence", () => {
  const c = resolveLoopConfig({ flags: { minConfidence: NaN }, fileText: null });
  assert.match(c.error, /confidence/i);
});

test("resolveLoopConfig rejects a base ref starting with '-'", () => {
  const c = resolveLoopConfig({ flags: { base: "--output=/tmp/x" }, fileText: null });
  assert.equal(c.config, null);
  assert.match(c.error, /base/i);
});

test("resolveLoopConfig accepts a normal base ref", () => {
  const c = resolveLoopConfig({ flags: { base: "main" }, fileText: null });
  assert.equal(c.error, null);
  assert.equal(c.config.base, "main");
});
