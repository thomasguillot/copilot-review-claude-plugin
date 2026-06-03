import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { run } from "../scripts/lib/process.mjs";

export function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "copilot-review-test-"));
  run("git", ["init", "-q"], { cwd: dir });
  run("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  run("git", ["config", "user.name", "Test"], { cwd: dir });
  run("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: dir });
  return dir;
}

export function write(dir, rel, content) {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

export function git(dir, ...args) {
  return run("git", args, { cwd: dir });
}
