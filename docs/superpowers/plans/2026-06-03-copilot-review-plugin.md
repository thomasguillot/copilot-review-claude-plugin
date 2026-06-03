# copilot-review Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an MIT-licensed Claude Code plugin (`copilot-review`) that delegates code review of the current git changes to the GitHub Copilot CLI and returns the findings, with a setup command that verifies install + auth without storing secrets.

**Architecture:** A thin Node "companion" script (`scripts/copilot-companion.mjs`) does deterministic work — compute the git diff for a scope, build a reviewer prompt, shell out to `copilot -p` (no tools, review-only), clean and return output. Two slash commands (`/copilot-review:setup`, `/copilot-review:review`) invoke the companion and relay output verbatim. The repo doubles as a one-plugin marketplace.

**Tech Stack:** Node.js ≥18 ESM (`.mjs`), built-in `node:test` test runner (no deps), `git`, the `@github/copilot` CLI. Markdown command + prompt files.

---

## File Structure

```
copilot-review-claude-plugin/
├── .claude-plugin/
│   ├── plugin.json                  ← plugin manifest (name: copilot-review)
│   └── marketplace.json             ← one-plugin marketplace (source: "./")
├── commands/
│   ├── setup.md                     ← /copilot-review:setup
│   └── review.md                    ← /copilot-review:review
├── scripts/
│   ├── copilot-companion.mjs        ← CLI entry: `setup` | `review`
│   └── lib/
│       ├── process.mjs              ← run() + binaryAvailable()
│       ├── git.mjs                  ← resolveScope() diff computation
│       └── copilot.mjs              ← prompt build, auth status, runReview, probeAuth
├── prompts/
│   └── review.md                    ← reviewer instruction template
├── test/
│   ├── helpers.mjs                  ← tempRepo() + write()
│   ├── fixtures/bin/copilot         ← executable stub copilot for tests
│   ├── process.test.mjs
│   ├── git.test.mjs
│   ├── copilot.test.mjs
│   └── companion.test.mjs
├── package.json
├── .gitignore
├── README.md
├── LICENSE                          ← MIT
└── CHANGELOG.md
```

**Shared interfaces (defined once, used throughout):**

- `process.mjs`: `run(cmd, args=[], opts={})` → `{ code, stdout, stderr, error }`; `binaryAvailable(cmd, args=["--version"], opts={})` → `{ available, detail }`
- `git.mjs`: `resolveScope({ scope="working-tree", base=null, cwd, maxBytes=200000 })` → `{ text, fileCount, truncated, droppedFiles, isEmpty, scopeLabel }`
- `copilot.mjs`: `buildReviewPrompt({ diff, scopeLabel, templatePath })` → `string`; `getAuthStatus({ env=process.env, skipGh=false })` → `{ likelyAuthed, sources, ghHint, detail }`; `cleanCopilotOutput(stdout)` → `string`; `runReview({ cwd, prompt, model=null, copilotBin="copilot" })` → `{ ok, detail, output }`; `probeAuth({ cwd, copilotBin="copilot" })` → `{ ok, detail }`

---

## Task 1: Repo scaffold (package.json, gitignore, LICENSE, CHANGELOG, README stub)

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `LICENSE`
- Create: `CHANGELOG.md`
- Create: `README.md`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "copilot-review-claude-plugin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Use GitHub Copilot from Claude Code to review your code changes.",
  "scripts": {
    "test": "node --test"
  },
  "engines": {
    "node": ">=18"
  },
  "license": "MIT",
  "author": "Thomas Guillot (https://github.com/thomasguillot)"
}
```

- [ ] **Step 2: Create `.gitignore`**

```gitignore
node_modules/
*.log
.DS_Store
```

- [ ] **Step 3: Create `LICENSE` (MIT)**

```
MIT License

Copyright (c) 2026 Thomas Guillot

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 4: Create `CHANGELOG.md`**

```markdown
# Changelog

## 0.1.0 — unreleased

- Initial release: `/copilot-review:setup` and `/copilot-review:review`.
```

- [ ] **Step 5: Create `README.md` (stub — finalized in Task 9)**

```markdown
# copilot-review

A Claude Code plugin that uses the GitHub Copilot CLI as a code reviewer.

_Documentation in progress — see `docs/superpowers/specs/` for the design._
```

- [ ] **Step 6: Verify the test runner works with no tests yet**

Run: `cd ~/Sites/copilot-review-claude-plugin && npm test`
Expected: exits 0 (node prints `tests 0` / `pass 0`; no failure).

- [ ] **Step 7: Commit**

```bash
cd ~/Sites/copilot-review-claude-plugin
git add package.json .gitignore LICENSE CHANGELOG.md README.md
git commit -m "chore: scaffold repo (package.json, MIT license, gitignore, changelog, readme stub)"
```

---

## Task 2: Plugin + marketplace manifests

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`

- [ ] **Step 1: Create `.claude-plugin/plugin.json`**

```json
{
  "name": "copilot-review",
  "version": "0.1.0",
  "description": "Use GitHub Copilot from Claude Code to review your code changes.",
  "author": {
    "name": "Thomas Guillot",
    "url": "https://github.com/thomasguillot"
  }
}
```

- [ ] **Step 2: Create `.claude-plugin/marketplace.json`**

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "copilot-review",
  "description": "GitHub Copilot as a code reviewer for Claude Code.",
  "owner": {
    "name": "Thomas Guillot",
    "url": "https://github.com/thomasguillot"
  },
  "plugins": [
    {
      "name": "copilot-review",
      "description": "Use GitHub Copilot from Claude Code to review your code changes.",
      "author": { "name": "Thomas Guillot" },
      "category": "development",
      "source": "./",
      "homepage": "https://github.com/thomasguillot/copilot-review-claude-plugin"
    }
  ]
}
```

- [ ] **Step 3: Verify both files are valid JSON**

Run: `cd ~/Sites/copilot-review-claude-plugin && node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json','utf8')); JSON.parse(require('fs').readFileSync('.claude-plugin/marketplace.json','utf8')); console.log('valid')"`
Expected: prints `valid`.

- [ ] **Step 4: Commit**

```bash
cd ~/Sites/copilot-review-claude-plugin
git add .claude-plugin
git commit -m "feat: add plugin and marketplace manifests"
```

---

## Task 3: `lib/process.mjs` — process helpers (TDD)

**Files:**
- Create: `scripts/lib/process.mjs`
- Test: `test/process.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/process.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Sites/copilot-review-claude-plugin && node --test test/process.test.mjs`
Expected: FAIL — cannot find module `../scripts/lib/process.mjs`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/lib/process.mjs`:

```js
import { spawnSync } from "node:child_process";

export function run(cmd, args = [], opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input,
    encoding: "utf8",
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    env: opts.env ?? process.env
  });
  return {
    code: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error ?? null
  };
}

export function binaryAvailable(cmd, args = ["--version"], opts = {}) {
  const res = run(cmd, args, opts);
  if (res.error) {
    return { available: false, detail: `${cmd} not found (${res.error.code ?? res.error.message})` };
  }
  if (res.code !== 0) {
    return { available: false, detail: `${cmd} exited ${res.code}: ${(res.stderr || res.stdout).trim()}` };
  }
  return { available: true, detail: (res.stdout || res.stderr).trim().split("\n")[0] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Sites/copilot-review-claude-plugin && node --test test/process.test.mjs`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/Sites/copilot-review-claude-plugin
git add scripts/lib/process.mjs test/process.test.mjs
git commit -m "feat: add process helpers (run, binaryAvailable)"
```

---

## Task 4: `lib/git.mjs` — scope/diff computation (TDD)

**Files:**
- Create: `test/helpers.mjs`
- Create: `scripts/lib/git.mjs`
- Test: `test/git.test.mjs`

- [ ] **Step 1: Create the test helper**

Create `test/helpers.mjs`:

```js
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
```

- [ ] **Step 2: Write the failing tests**

Create `test/git.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
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

test("working-tree: no-HEAD repo with staged file", () => {
  const dir = tempRepo();
  write(dir, "first.txt", "content\n");
  git(dir, "add", "first.txt");
  const r = resolveScope({ scope: "working-tree", cwd: dir });
  assert.equal(r.isEmpty, false);
  assert.match(r.text, /first\.txt/);
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ~/Sites/copilot-review-claude-plugin && node --test test/git.test.mjs`
Expected: FAIL — cannot find module `../scripts/lib/git.mjs`.

- [ ] **Step 4: Write minimal implementation**

Create `scripts/lib/git.mjs`:

```js
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./process.mjs";

function hasHead(cwd) {
  return run("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd }).code === 0;
}

function detectBase(cwd) {
  for (const ref of ["main", "master", "origin/HEAD"]) {
    if (run("git", ["rev-parse", "--verify", "--quiet", ref], { cwd }).code === 0) {
      return ref;
    }
  }
  return "HEAD";
}

function splitDiffSegments(diffText) {
  if (!diffText || !diffText.trim()) return [];
  const parts = diffText.split(/(?=^diff --git )/m).filter((s) => s.trim());
  return parts.map((text) => {
    const m = text.match(/^diff --git a\/.+? b\/(.+)$/m);
    return { path: m ? m[1] : "unknown", text };
  });
}

function untrackedSegments(cwd) {
  const res = run("git", ["ls-files", "--others", "--exclude-standard"], { cwd });
  const files = res.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  return files.map((rel) => {
    let content;
    try {
      content = readFileSync(join(cwd, rel), "utf8");
    } catch {
      content = "<unreadable>";
    }
    return { path: rel, text: `### New file: ${rel}\n\`\`\`\n${content}\n\`\`\`\n` };
  });
}

function assembleSegments(segments, maxBytes) {
  let text = "";
  const droppedFiles = [];
  let truncated = false;
  for (const seg of segments) {
    if (!truncated && text.length + seg.text.length <= maxBytes) {
      text += seg.text + "\n";
    } else {
      truncated = true;
      droppedFiles.push(seg.path);
    }
  }
  return { text: text.trim(), truncated, droppedFiles };
}

export function resolveScope({ scope = "working-tree", base = null, cwd = process.cwd(), maxBytes = 200000 } = {}) {
  let segments = [];
  let scopeLabel;

  if (scope === "branch") {
    const ref = base || detectBase(cwd);
    scopeLabel = `branch diff (${ref}...HEAD)`;
    const d = run("git", ["diff", `${ref}...HEAD`], { cwd });
    segments = splitDiffSegments(d.stdout);
  } else {
    scopeLabel = "working tree (uncommitted changes)";
    const trackedDiff = hasHead(cwd)
      ? run("git", ["diff", "HEAD"], { cwd }).stdout
      : run("git", ["diff", "--cached"], { cwd }).stdout;
    segments = [...splitDiffSegments(trackedDiff), ...untrackedSegments(cwd)];
  }

  const { text, truncated, droppedFiles } = assembleSegments(segments, maxBytes);
  return {
    text,
    fileCount: segments.length,
    truncated,
    droppedFiles,
    isEmpty: segments.length === 0,
    scopeLabel
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/Sites/copilot-review-claude-plugin && node --test test/git.test.mjs`
Expected: PASS — 7 tests.

- [ ] **Step 6: Commit**

```bash
cd ~/Sites/copilot-review-claude-plugin
git add scripts/lib/git.mjs test/helpers.mjs test/git.test.mjs
git commit -m "feat: add git scope/diff computation (working-tree + branch, size cap)"
```

---

## Task 5: `prompts/review.md` + prompt build / auth status / output cleaning (TDD)

**Files:**
- Create: `prompts/review.md`
- Create: `scripts/lib/copilot.mjs`
- Test: `test/copilot.test.mjs`

- [ ] **Step 1: Create the reviewer prompt template**

Create `prompts/review.md`:

```markdown
You are a senior software engineer performing a focused code review.

Review ONLY the changes in the diff below. Do not run any commands and do not
assume access to files beyond what the diff shows. Focus on correctness bugs,
security issues, data loss, broken error handling, and clear maintainability
problems. Ignore pure style nits unless they cause real risk.

Scope under review: {{SCOPE}}

Respond in GitHub-flavored markdown using exactly this structure, omitting any
severity section that has no findings:

## Summary
<one or two sentences on the overall risk>

## High
- `path:line` — <the issue and why it matters>

## Medium
- `path:line` — <the issue and why it matters>

## Low
- `path:line` — <the issue and why it matters>

If you find no issues at all, respond with exactly: `No issues found.`

--- BEGIN DIFF ---
{{DIFF}}
--- END DIFF ---
```

- [ ] **Step 2: Write the failing tests**

Create `test/copilot.test.mjs`:

```js
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ~/Sites/copilot-review-claude-plugin && node --test test/copilot.test.mjs`
Expected: FAIL — cannot find module `../scripts/lib/copilot.mjs`.

- [ ] **Step 4: Write minimal implementation (this step's functions only)**

Create `scripts/lib/copilot.mjs`:

```js
import { readFileSync } from "node:fs";
import { run } from "./process.mjs";

const AUTH_ENV_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];

export function buildReviewPrompt({ diff, scopeLabel, templatePath }) {
  const tmpl = readFileSync(templatePath, "utf8");
  return tmpl.replaceAll("{{SCOPE}}", scopeLabel).replaceAll("{{DIFF}}", diff);
}

export function getAuthStatus({ env = process.env, skipGh = false } = {}) {
  const sources = AUTH_ENV_VARS.filter((v) => env[v] && String(env[v]).trim());
  let ghHint = null;
  if (!skipGh) {
    const gh = run("gh", ["auth", "status"], { env });
    if (!gh.error && gh.code === 0) ghHint = "gh CLI is authenticated";
  }
  const likelyAuthed = sources.length > 0 || ghHint !== null;
  return {
    likelyAuthed,
    sources,
    ghHint,
    detail: likelyAuthed
      ? `Credentials detected: ${[...sources, ghHint].filter(Boolean).join(", ")}`
      : "No credentials detected from env vars or gh. The Copilot CLI may still have a stored login — run setup with --probe to confirm."
  };
}

export function cleanCopilotOutput(stdout) {
  return String(stdout ?? "").replace(/\r\n/g, "\n").trim();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/Sites/copilot-review-claude-plugin && node --test test/copilot.test.mjs`
Expected: PASS — 4 tests.

- [ ] **Step 6: Commit**

```bash
cd ~/Sites/copilot-review-claude-plugin
git add prompts/review.md scripts/lib/copilot.mjs test/copilot.test.mjs
git commit -m "feat: add reviewer prompt template, prompt builder, auth status, output cleaning"
```

---

## Task 6: Stub `copilot` bin + `runReview` / `probeAuth` (TDD)

**Files:**
- Create: `test/fixtures/bin/copilot`
- Modify: `scripts/lib/copilot.mjs` (add `runReview`, `probeAuth`)
- Modify: `test/copilot.test.mjs` (add tests)

- [ ] **Step 1: Create the executable stub copilot**

Create `test/fixtures/bin/copilot`:

```bash
#!/usr/bin/env bash
# Fake GitHub Copilot CLI for tests. Mimics the subset we use.
case "$1" in
  --version)
    echo "copilot/1.0.59 (fake test stub)"
    exit 0
    ;;
esac

args="$*"
if [[ "$args" == *"READY"* ]]; then
  echo "READY"
  exit 0
fi

cat <<'EOF'
## Summary
One potential issue found in the diff.

## High
- `a.txt:2` — example finding from stub reviewer.
EOF
exit 0
```

- [ ] **Step 2: Make the stub executable**

Run: `cd ~/Sites/copilot-review-claude-plugin && chmod +x test/fixtures/bin/copilot && ./test/fixtures/bin/copilot --version`
Expected: prints `copilot/1.0.59 (fake test stub)`.

- [ ] **Step 3: Write the failing tests**

Append to `test/copilot.test.mjs`:

```js
import { runReview, probeAuth } from "../scripts/lib/copilot.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join as pjoin } from "node:path";

const STUB = pjoin(dirname(fileURLToPath(import.meta.url)), "fixtures", "bin", "copilot");

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
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd ~/Sites/copilot-review-claude-plugin && node --test test/copilot.test.mjs`
Expected: FAIL — `runReview`/`probeAuth` are not exported.

- [ ] **Step 5: Add the implementation**

Append to `scripts/lib/copilot.mjs`:

```js
export function runReview({ cwd, prompt, model = null, copilotBin = "copilot" }) {
  const args = ["-p", prompt, "--no-color"];
  if (model) args.push("--model", model);
  const res = run(copilotBin, args, { cwd });
  if (res.error) {
    return { ok: false, detail: `Could not run ${copilotBin}: ${res.error.code ?? res.error.message}`, output: "" };
  }
  if (res.code !== 0) {
    return {
      ok: false,
      detail: (res.stderr || "").trim() || `${copilotBin} exited ${res.code}`,
      output: cleanCopilotOutput(res.stdout)
    };
  }
  return { ok: true, detail: null, output: cleanCopilotOutput(res.stdout) };
}

export function probeAuth({ cwd, copilotBin = "copilot" }) {
  const res = run(copilotBin, ["-p", "Reply with exactly: READY", "--no-color"], { cwd });
  if (res.error) {
    return { ok: false, detail: `Could not run ${copilotBin}: ${res.error.code ?? res.error.message}` };
  }
  if (res.code === 0 && String(res.stdout).toUpperCase().includes("READY")) {
    return { ok: true, detail: "Auth verified — Copilot responded." };
  }
  return { ok: false, detail: (res.stderr || res.stdout || `${copilotBin} exited ${res.code}`).trim() };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd ~/Sites/copilot-review-claude-plugin && node --test test/copilot.test.mjs`
Expected: PASS — 7 tests total.

- [ ] **Step 7: Commit**

```bash
cd ~/Sites/copilot-review-claude-plugin
git add test/fixtures/bin/copilot scripts/lib/copilot.mjs test/copilot.test.mjs
git commit -m "feat: add runReview + probeAuth with a test stub copilot binary"
```

---

## Task 7: `copilot-companion.mjs` entry + integration tests (TDD)

**Files:**
- Create: `scripts/copilot-companion.mjs`
- Test: `test/companion.test.mjs`

- [ ] **Step 1: Write the failing integration tests**

Create `test/companion.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { run } from "../scripts/lib/process.mjs";
import { tempRepo, write, git } from "./helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const COMPANION = join(here, "..", "scripts", "copilot-companion.mjs");
const STUB_DIR = join(here, "fixtures", "bin");

// Run the companion with the stub `copilot` on PATH.
function companion(args, cwd, extraEnv = {}) {
  return run("node", [COMPANION, ...args], {
    cwd,
    env: { ...process.env, PATH: `${STUB_DIR}:${process.env.PATH}`, ...extraEnv }
  });
}

test("setup reports copilot detected", () => {
  const dir = tempRepo();
  const r = companion(["setup"], dir, { COPILOT_GITHUB_TOKEN: "" , GH_TOKEN: "", GITHUB_TOKEN: "" });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /copilot detected/i);
});

test("setup detects env credentials", () => {
  const dir = tempRepo();
  const r = companion(["setup"], dir, { COPILOT_GITHUB_TOKEN: "abc" });
  assert.match(r.stdout, /Credentials detected/);
});

test("setup --probe verifies via stub", () => {
  const dir = tempRepo();
  const r = companion(["setup", "--probe"], dir);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Auth verified/);
});

test("review on a change returns stub findings", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  write(dir, "a.txt", "x\ny\n");
  const r = companion(["review"], dir);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /## Summary/);
});

test("review on a clean repo says nothing to review", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  const r = companion(["review"], dir);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /[Nn]othing to review/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Sites/copilot-review-claude-plugin && node --test test/companion.test.mjs`
Expected: FAIL — cannot find module `scripts/copilot-companion.mjs`.

- [ ] **Step 3: Write the companion implementation**

Create `scripts/copilot-companion.mjs`:

```js
#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { binaryAvailable } from "./lib/process.mjs";
import { resolveScope } from "./lib/git.mjs";
import { buildReviewPrompt, getAuthStatus, probeAuth, runReview } from "./lib/copilot.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(here, "..", "prompts", "review.md");

function out(s) {
  process.stdout.write(s.endsWith("\n") ? s : s + "\n");
}

function parseFlags(rest) {
  const tokens = rest.join(" ").trim().split(/\s+/).filter(Boolean);
  const flags = { scope: "working-tree", base: null, model: null, probe: false };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--probe") flags.probe = true;
    else if (t === "--scope") flags.scope = tokens[++i];
    else if (t === "--base") flags.base = tokens[++i];
    else if (t === "--model") flags.model = tokens[++i];
  }
  return flags;
}

function cmdSetup(flags, cwd) {
  const avail = binaryAvailable("copilot", ["--version"], { cwd });
  if (!avail.available) {
    out("GitHub Copilot CLI not found.");
    out("Install it with:  npm install -g @github/copilot");
    out("Requires Node.js >=18 and an active GitHub Copilot subscription.");
    out(`Detail: ${avail.detail}`);
    process.exit(1);
  }
  out(`copilot detected: ${avail.detail}`);

  const auth = getAuthStatus({});
  out(auth.detail);

  if (flags.probe) {
    const p = probeAuth({ cwd });
    out(p.detail);
    process.exit(p.ok ? 0 : 1);
  }

  if (!auth.likelyAuthed) {
    out("");
    out("To authenticate, either:");
    out("  1. Run an interactive login (browser device flow):  copilot login");
    out("     (In Claude Code, run it yourself with:  ! copilot login )");
    out("  2. Or set a fine-grained PAT with the \"Copilot Requests\" permission");
    out("     as COPILOT_GITHUB_TOKEN (or GH_TOKEN / GITHUB_TOKEN) for CI/headless.");
    out("");
    out("This plugin never stores your token. Re-run with --probe to verify.");
  }
  process.exit(0);
}

function cmdReview(flags, cwd) {
  const scope = resolveScope({ scope: flags.scope, base: flags.base, cwd });
  if (scope.isEmpty) {
    out("Nothing to review — no uncommitted changes (or no branch diff) found.");
    process.exit(0);
  }

  const prompt = buildReviewPrompt({ diff: scope.text, scopeLabel: scope.scopeLabel, templatePath: TEMPLATE });
  const result = runReview({ cwd, prompt, model: flags.model });

  if (scope.truncated) {
    out(`> Note: the diff was large and was truncated. Files omitted from this review: ${scope.droppedFiles.join(", ")}`);
    out("");
  }

  if (!result.ok) {
    out(`Copilot review could not complete: ${result.detail}`);
    if (result.output) {
      out("");
      out(result.output);
    }
    process.exit(1);
  }

  out(result.output);
  process.exit(0);
}

const [cmd, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
const cwd = process.cwd();

if (cmd === "setup") cmdSetup(flags, cwd);
else if (cmd === "review") cmdReview(flags, cwd);
else {
  out("Usage: copilot-companion.mjs <setup|review> [flags]");
  process.exit(2);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Sites/copilot-review-claude-plugin && node --test test/companion.test.mjs`
Expected: PASS — 5 tests.

- [ ] **Step 5: Run the full suite**

Run: `cd ~/Sites/copilot-review-claude-plugin && npm test`
Expected: PASS — all tests across the 4 test files (process 4, git 7, copilot 7, companion 5).

- [ ] **Step 6: Commit**

```bash
cd ~/Sites/copilot-review-claude-plugin
git add scripts/copilot-companion.mjs test/companion.test.mjs
git commit -m "feat: add companion entry (setup + review) with integration tests"
```

---

## Task 8: Slash commands

**Files:**
- Create: `commands/setup.md`
- Create: `commands/review.md`

- [ ] **Step 1: Create `commands/setup.md`**

```markdown
---
description: Check the GitHub Copilot CLI is installed and authenticated (no secrets stored)
argument-hint: '[--probe]'
allowed-tools: Bash(node:*), Bash(copilot:*)
---

Run the setup check:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" setup $ARGUMENTS
```

Return the command's output verbatim.

If the output says credentials were not detected, tell the user they can
authenticate by running `! copilot login` themselves (an interactive browser
device flow that Claude cannot complete for them), or by setting a fine-grained
PAT with the "Copilot Requests" permission as `COPILOT_GITHUB_TOKEN`. Do not
attempt to store or write any token.
```

- [ ] **Step 2: Create `commands/review.md`**

```markdown
---
description: Ask GitHub Copilot to review your current git changes
argument-hint: '[--scope working-tree|branch] [--base <ref>] [--model <model>]'
allowed-tools: Bash(node:*), Bash(git:*)
---

This command is **review-only**. Do not fix issues, apply patches, or edit any
files as part of running it. Your only job is to run the review and return
Copilot's output to the user.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" review $ARGUMENTS
```

Return the command's stdout verbatim — do not summarize, re-rank, or act on the
findings. Only address them if the user asks in a later message.
```

- [ ] **Step 3: Verify command frontmatter parses as YAML**

Run: `cd ~/Sites/copilot-review-claude-plugin && for f in commands/*.md; do node -e "const fs=require('fs');const s=fs.readFileSync('$f','utf8');const m=s.match(/^---\n([\s\S]*?)\n---/);if(!m){console.error('no frontmatter in $f');process.exit(1)};console.log('$f frontmatter ok')"; done`
Expected: prints `commands/setup.md frontmatter ok` and `commands/review.md frontmatter ok`.

- [ ] **Step 4: Commit**

```bash
cd ~/Sites/copilot-review-claude-plugin
git add commands/setup.md commands/review.md
git commit -m "feat: add /copilot-review:setup and /copilot-review:review commands"
```

---

## Task 9: README, manual smoke test, release prep

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the full `README.md`**

```markdown
# copilot-review

A Claude Code plugin that uses the **GitHub Copilot CLI as a code reviewer**.
Ask Claude to have Copilot review your current git changes; Copilot returns
severity-grouped findings. Copilot **only reviews — it never edits your code**;
all fixes are made by Claude Code (or you).

## Prerequisites

- An active **GitHub Copilot** subscription.
- The Copilot CLI: `npm install -g @github/copilot` (Node.js >= 18).

## Install

```
/plugin marketplace add thomasguillot/copilot-review-claude-plugin
/plugin install copilot-review
```

## Setup

```
/copilot-review:setup
```

This checks the CLI is installed and whether your credentials resolve. It never
stores a token. To authenticate, either:

- Run `copilot login` (interactive browser device flow), or
- Set a fine-grained PAT with the **Copilot Requests** permission as
  `COPILOT_GITHUB_TOKEN` (or `GH_TOKEN` / `GITHUB_TOKEN`) for CI/headless.

Verify end-to-end with `/copilot-review:setup --probe`.

## Usage

Review your uncommitted changes:

```
/copilot-review:review
```

Review a branch against its base:

```
/copilot-review:review --scope branch --base main
```

Options: `--scope working-tree|branch`, `--base <ref>`, `--model <model>`.

Want a review loop? Just tell Claude: "fix the High findings and run
`/copilot-review:review` again," and repeat until it's clean.

## How it works

A small Node script computes the diff for the chosen scope and passes it to
`copilot -p` with no tool permissions, so Copilot only reasons over the diff.
Its review is returned verbatim.

## Development

```
npm test
```

## License

MIT © Thomas Guillot
```

- [ ] **Step 2: Update `CHANGELOG.md`**

```markdown
# Changelog

## 0.1.0

- Initial release.
- `/copilot-review:setup` — verify Copilot CLI install + auth (never stores secrets).
- `/copilot-review:review` — single-pass Copilot review of working-tree or branch changes.
```

- [ ] **Step 3: Manual smoke test (real Copilot CLI)**

Run these yourself in a repo with uncommitted changes (requires a real Copilot login):
```bash
cd ~/Sites/copilot-review-claude-plugin
node scripts/copilot-companion.mjs setup
node scripts/copilot-companion.mjs setup --probe
# in any repo with a diff:
node /Users/thomasguillot/Sites/copilot-review-claude-plugin/scripts/copilot-companion.mjs review
```
Expected: setup reports detected/authed; review prints a markdown review or "Nothing to review".
(If you have no Copilot subscription, skip — the stub-based test suite already covers the wiring.)

- [ ] **Step 4: Run the full suite one more time**

Run: `cd ~/Sites/copilot-review-claude-plugin && npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/Sites/copilot-review-claude-plugin
git add README.md CHANGELOG.md
git commit -m "docs: full README and 0.1.0 changelog"
```

- [ ] **Step 6: (Optional) publish**

When ready to open-source:
```bash
cd ~/Sites/copilot-review-claude-plugin
gh repo create copilot-review-claude-plugin --public --source=. --remote=origin --push
```
Then anyone can install via the two `/plugin` commands in the README.

---

## Self-Review Notes

- **Spec coverage:** setup (Tasks 7–8), review single-pass (Tasks 4–8), verify-don't-store auth (Tasks 6–8), working-tree + branch scope (Task 4), size cap (Task 4), severity-grouped verbatim output (Task 5 template + Task 7), plugin.json + marketplace.json (Task 2), README/LICENSE/CHANGELOG (Tasks 1, 9), stub-based tests without a subscription (Tasks 6–7). All spec sections map to a task.
- **Local-install testing note:** before `gh repo create`, the plugin can be loaded locally via Claude Code's local marketplace add against the repo path for end-to-end command testing.
```
