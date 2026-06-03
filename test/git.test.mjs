import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveScope } from "../scripts/lib/git.mjs";
import { tempRepo, write, git } from "./helpers.mjs";

test("working-tree: unstaged modification appears", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "one\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  write(dir, "a.txt", "one\ntwo\n");
  const r = resolveScope({ scope: "working-tree", cwd: dir });
  assert.equal(r.isEmpty, false);
  assert.match(r.text, /\+two/);
});

test("working-tree: staged file appears", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  write(dir, "b.txt", "new\n");
  git(dir, "add", "b.txt");
  const r = resolveScope({ scope: "working-tree", cwd: dir });
  assert.equal(r.isEmpty, false);
  assert.match(r.text, /b\.txt/);
});

test("working-tree: untracked file content appears", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  write(dir, "untracked.txt", "hello-untracked\n");
  const r = resolveScope({ scope: "working-tree", cwd: dir });
  assert.match(r.text, /untracked\.txt/);
  assert.match(r.text, /hello-untracked/);
});

test("working-tree: untracked filename with a trailing space is read correctly", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  write(dir, "spacey.txt ", "spacey-content\n"); // trailing space in the name
  const r = resolveScope({ scope: "working-tree", cwd: dir });
  // NUL-delimited ls-files + no trimming preserves the exact name and reads it.
  assert.match(r.text, /spacey\.txt/);
  assert.match(r.text, /spacey-content/);
});

test("working-tree: no-HEAD repo with staged file", () => {
  const dir = tempRepo();
  write(dir, "first.txt", "content\n");
  git(dir, "add", "first.txt");
  const r = resolveScope({ scope: "working-tree", cwd: dir });
  assert.equal(r.isEmpty, false);
  assert.match(r.text, /first\.txt/);
});

test("working-tree: no-HEAD repo captures staged + later unstaged edits", () => {
  const dir = tempRepo();
  write(dir, "f.txt", "line1\n");
  git(dir, "add", "f.txt");
  write(dir, "f.txt", "line1\nline2-unstaged\n"); // modify after staging, before any commit
  const r = resolveScope({ scope: "working-tree", cwd: dir });
  assert.equal(r.isEmpty, false);
  assert.match(r.text, /line1/);
  assert.match(r.text, /line2-unstaged/);
});

test("working-tree: untracked file containing backticks gets a longer fence", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  write(dir, "snippet.md", "```js\ncode-here\n```\n"); // content has triple backticks
  const r = resolveScope({ scope: "working-tree", cwd: dir });
  assert.match(r.text, /snippet\.md/);
  assert.match(r.text, /code-here/);
  assert.match(r.text, /````/); // fence is 4+ backticks so the inner ``` can't close it
});

test("size cap counts bytes, not characters, for multibyte content", () => {
  const dir = tempRepo();
  write(dir, "seed.txt", "x\n");
  git(dir, "add", "seed.txt");
  git(dir, "commit", "-q", "-m", "init");
  write(dir, "multi.txt", "é".repeat(5000)); // 5000 chars but ~10000 bytes (2 bytes each)
  const r = resolveScope({ scope: "working-tree", cwd: dir, maxBytes: 7000 });
  // Under character counting (~5000) this would NOT truncate; by bytes (~10000) it must.
  assert.equal(r.truncated, true);
});

test("size cap: assembled output never exceeds maxBytes", () => {
  const dir = tempRepo();
  write(dir, "seed.txt", "x\n");
  git(dir, "add", "seed.txt");
  git(dir, "commit", "-q", "-m", "init");
  for (let i = 0; i < 10; i++) write(dir, `f${i}.txt`, "y\n".repeat(1000)); // ~2 KB each
  const cap = 5000;
  const r = resolveScope({ scope: "working-tree", cwd: dir, maxBytes: cap });
  assert.equal(r.truncated, true);
  assert.ok(
    Buffer.byteLength(r.text, "utf8") <= cap,
    `assembled ${Buffer.byteLength(r.text, "utf8")} bytes exceeds cap ${cap}`
  );
});

test("size cap: truncated single oversized file stays within maxBytes", () => {
  const dir = tempRepo();
  write(dir, "seed.txt", "x\n");
  git(dir, "add", "seed.txt");
  git(dir, "commit", "-q", "-m", "init");
  write(dir, "huge.txt", "z\n".repeat(20000)); // ~40 KB single file
  const cap = 10000;
  const r = resolveScope({ scope: "working-tree", cwd: dir, maxBytes: cap });
  assert.equal(r.truncated, true);
  assert.ok(
    Buffer.byteLength(r.text, "utf8") <= cap,
    `assembled ${Buffer.byteLength(r.text, "utf8")} bytes exceeds cap ${cap}`
  );
});

test("working-tree: clean repo is empty", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  const r = resolveScope({ scope: "working-tree", cwd: dir });
  assert.equal(r.isEmpty, true);
});

test("branch: diff against detected base (main)", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "base\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "checkout", "-q", "-b", "feature");
  write(dir, "a.txt", "base\nfeature-line\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "feature");
  const r = resolveScope({ scope: "branch", cwd: dir });
  assert.equal(r.scopeLabel.includes("main"), true);
  assert.match(r.text, /\+feature-line/);
  assert.equal(r.fileCount, 1);
});

test("size cap truncates and records dropped files", () => {
  const dir = tempRepo();
  write(dir, "seed.txt", "x\n");
  git(dir, "add", "seed.txt");
  git(dir, "commit", "-q", "-m", "init");
  const big = "y\n".repeat(5000); // ~10 KB each
  for (let i = 0; i < 40; i++) write(dir, `f${i}.txt`, big);
  const r = resolveScope({ scope: "working-tree", cwd: dir, maxBytes: 20000 });
  assert.equal(r.truncated, true);
  assert.ok(r.droppedFiles.length > 0);
});

test("working-tree: untracked symlink is not dereferenced (no external leak)", { skip: process.platform === "win32" ? "symlink creation needs elevated privileges on Windows" : false }, () => {
  const dir = tempRepo();
  write(dir, "a.txt", "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  const ext = join(mkdtempSync(join(tmpdir(), "ext-")), "secret.txt");
  writeFileSync(ext, "EXTERNAL_SECRET\n");
  symlinkSync(ext, join(dir, "link.txt"));
  const r = resolveScope({ scope: "working-tree", cwd: dir });
  assert.match(r.text, /link\.txt/);
  assert.doesNotMatch(r.text, /EXTERNAL_SECRET/);
});

test("size cap still reviews a single oversized first file (no silent skip)", () => {
  const dir = tempRepo();
  write(dir, "seed.txt", "x\n");
  git(dir, "add", "seed.txt");
  git(dir, "commit", "-q", "-m", "init");
  write(dir, "huge.txt", "z\n".repeat(20000)); // ~40 KB single untracked file
  const r = resolveScope({ scope: "working-tree", cwd: dir, maxBytes: 10000 });
  assert.equal(r.isEmpty, false);
  assert.equal(r.truncated, true);
  assert.match(r.text, /huge\.txt/);
});

test("working-tree: untracked binary file is not inlined", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
  const r = resolveScope({ scope: "working-tree", cwd: dir });
  assert.match(r.text, /blob\.bin/);
  assert.match(r.text, /binary file omitted/);
  assert.doesNotMatch(r.text, /\x00/);
});

test("branch base detection skips the current branch when it equals HEAD", () => {
  const dir = tempRepo();
  // On 'main' with a commit; main === HEAD, so it must NOT be chosen as base.
  write(dir, "a.txt", "base\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "base");
  const r = resolveScope({ scope: "branch", cwd: dir });
  // No other base exists, so it falls back with the "no base branch detected" note.
  assert.match(r.scopeLabel, /no base branch detected/);
});
