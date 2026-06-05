import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGateEnabled, setGateEnabled } from "../scripts/lib/gate.mjs";
import { tempRepo } from "./helpers.mjs";

function freshRepo() {
  return mkdtempSync(join(tmpdir(), "gate-repo-"));
}

test("isGateEnabled defaults to false for a repo with no gate state", () => {
  const dir = freshRepo();
  assert.equal(isGateEnabled(dir), false);
});

test("setGateEnabled(true) persists and is read back as enabled", () => {
  const dir = freshRepo();
  setGateEnabled(dir, true);
  assert.equal(isGateEnabled(dir), true);
});

test("setGateEnabled(false) disables a previously enabled gate", () => {
  const dir = freshRepo();
  setGateEnabled(dir, true);
  setGateEnabled(dir, false);
  assert.equal(isGateEnabled(dir), false);
});

test("gate state for two different repos is independent", () => {
  const a = freshRepo();
  const b = freshRepo();
  setGateEnabled(a, true);
  assert.equal(isGateEnabled(a), true);
  assert.equal(isGateEnabled(b), false);
});

test("gate flag is keyed by git root: a subdirectory shares the repo-root flag", () => {
  const root = tempRepo();
  const sub = join(root, "packages", "inner");
  mkdirSync(sub, { recursive: true });
  setGateEnabled(root, true);
  assert.equal(isGateEnabled(sub), true);
  setGateEnabled(root, false);
});

test("a non-boolean enabled value reads back as disabled (only true === true enables)", () => {
  const dir = freshRepo();
  setGateEnabled(dir, "yes"); // anything not === true must store/normalize to false
  assert.equal(isGateEnabled(dir), false);
});
