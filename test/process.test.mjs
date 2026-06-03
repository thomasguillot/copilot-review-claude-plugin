import { test } from "node:test";
import assert from "node:assert/strict";
import { run, binaryAvailable } from "../scripts/lib/process.mjs";

test("run captures stdout and exit code", () => {
  const res = run("node", ["--version"]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /^v\d+\./);
  assert.equal(res.error, null);
});

test("run reports ENOENT via error, not throw", () => {
  const res = run("definitely-not-a-real-binary-xyz", ["--nope"]);
  assert.ok(res.error, "expected an error object");
});

test("binaryAvailable true for node", () => {
  const res = binaryAvailable("node", ["--version"]);
  assert.equal(res.available, true);
  assert.match(res.detail, /v\d+\./);
});

test("binaryAvailable false for missing binary", () => {
  const res = binaryAvailable("definitely-not-a-real-binary-xyz");
  assert.equal(res.available, false);
});

test("binaryAvailable strips CR from CRLF version output", () => {
  const res = binaryAvailable("node", ["-e", "process.stdout.write('v1.2.3\\r\\nextra\\r\\n')"]);
  assert.equal(res.available, true);
  assert.equal(res.detail, "v1.2.3");
});

test("run captures non-zero exit code", () => {
  const res = run("node", ["-e", "process.exit(42)"]);
  assert.equal(res.code, 42);
  assert.equal(res.error, null);
});
