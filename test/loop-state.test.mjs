import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, setRound, addDismissed, addAttempted, clearState } from "../scripts/lib/loop-state.mjs";

function freshRepo() {
  return mkdtempSync(join(tmpdir(), "loop-state-repo-"));
}

test("readState returns a zeroed state for a repo with no prior state", () => {
  const dir = freshRepo();
  const s = readState(dir);
  assert.equal(s.round, 0);
  assert.deepEqual(s.dismissed, []);
});

test("setRound persists and is read back", () => {
  const dir = freshRepo();
  setRound(dir, 3);
  assert.equal(readState(dir).round, 3);
});

test("addDismissed accumulates unique keys", () => {
  const dir = freshRepo();
  addDismissed(dir, "k1");
  addDismissed(dir, "k1");
  addDismissed(dir, "k2");
  assert.deepEqual(readState(dir).dismissed.sort(), ["k1", "k2"]);
});

test("clearState resets round and dismissed", () => {
  const dir = freshRepo();
  setRound(dir, 5);
  addDismissed(dir, "k1");
  clearState(dir);
  const s = readState(dir);
  assert.equal(s.round, 0);
  assert.deepEqual(s.dismissed, []);
});

test("state for two different repos is independent", () => {
  const a = freshRepo();
  const b = freshRepo();
  setRound(a, 2);
  setRound(b, 7);
  assert.equal(readState(a).round, 2);
  assert.equal(readState(b).round, 7);
});

test("readState includes an empty attempted list by default", () => {
  const dir = freshRepo();
  assert.deepEqual(readState(dir).attempted, []);
});

test("addAttempted accumulates unique keys and is preserved across setRound", () => {
  const dir = freshRepo();
  addAttempted(dir, "k1");
  addAttempted(dir, "k1");
  setRound(dir, 2);
  const s = readState(dir);
  assert.deepEqual(s.attempted, ["k1"]);
  assert.equal(s.round, 2);
});

test("clearState resets attempted too", () => {
  const dir = freshRepo();
  addAttempted(dir, "k1");
  clearState(dir);
  assert.deepEqual(readState(dir).attempted, []);
});
