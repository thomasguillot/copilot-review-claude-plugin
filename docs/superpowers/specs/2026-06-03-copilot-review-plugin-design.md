# Design: `copilot-review` — a Claude Code plugin for GitHub Copilot code review

**Date:** 2026-06-03
**Status:** Approved (pending spec review)
**Author:** Thomas Guillot

## Goal

Give Claude Code a "second reviewer" by delegating code review to the GitHub
Copilot CLI, mirroring the role the `codex` plugin's `/codex:review` plays for
Codex. Claude Code asks Copilot to review the current git changes; Copilot
returns findings; Claude (or the user) decides what to fix.

Open-sourced under **MIT** so anyone can install it from a public GitHub repo.

## Non-goals (v1)

- **No review loop.** A single review pass only. The user can ask Claude to fix
  findings and re-run `/copilot-review:review` as many times as they want. No
  built-in convergence orchestration.
- **No task delegation / "rescue".** Copilot is a *reviewer only*. It is never
  given write or shell tools and never edits the codebase. All fixes are made by
  Claude Code in the main thread.
- **No background jobs, status, or cancel commands.** The codex plugin needs
  those because it speaks a long-running JSON-RPC `app-server` protocol. Copilot
  CLI is a simple headless one-shot (`copilot -p …`), so none of that machinery
  is required.
- **No stored secrets.** Setup verifies and guides auth; it never writes a token.

## Background: why this is far simpler than the codex plugin

The codex plugin carries a Node "companion" broker, an app-server JSON-RPC
client, thread/turn streaming, and background job control (~1000 lines in
`lib/codex.mjs` alone) **because Codex exposes a stateful `app-server`
protocol**. The GitHub Copilot CLI has no equivalent. Its programmatic surface
is a single headless invocation:

```
copilot -p "<prompt>" [--model <m>] [--no-color] [--allow-tool …]
```

It runs the prompt, prints to stdout, and exits. So this plugin is mostly
**prompt files + a thin shell shim**.

### Copilot CLI facts the design relies on

- Package: `@github/copilot` (bin: `copilot`), installed via `npm i -g @github/copilot`.
- Headless: `-p` / `--prompt` runs one task and exits.
- Tool permissions: `--allow-all-tools`, `--allow-tool`, `--deny-tool`
  (deny wins). For review we pass **none** — Copilot reasons over the diff we
  embed in the prompt and needs no tools.
- Model: `--model <name>` (optional passthrough; default = user's Copilot model).
- Auth precedence: `COPILOT_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN` →
  stored device-flow token (`copilot login` / `/login`) → `gh` CLI auth. Token
  must be a fine-grained PAT with the **"Copilot Requests"** permission, and an
  active Copilot subscription is required.

## Architecture

Two layers with a clean split of responsibility:

1. **Node companion** (`scripts/copilot-companion.mjs`) — the *deterministic*
   layer. Subcommands `setup` and `review`. It computes the git diff for the
   chosen scope, builds the reviewer prompt, shells out to `copilot`, cleans and
   returns the output. Single-purpose, unit-testable, no network state.
2. **Slash-command prompts** (`commands/*.md`) — the *thin orchestration* layer.
   They invoke the companion and return its output verbatim. Review is review-only;
   the commands explicitly must not fix anything.

Because there is no loop in v1, no intelligence is needed beyond invoking the
companion and relaying its output.

## File layout

```
copilot-review-claude-plugin/        ← public repo; also a one-plugin marketplace
├── .claude-plugin/
│   ├── plugin.json                  ← { "name": "copilot-review", … }
│   └── marketplace.json             ← lets users `/plugin marketplace add <gh>/<repo>`
├── commands/
│   ├── setup.md                     ← /copilot-review:setup
│   └── review.md                    ← /copilot-review:review
├── scripts/
│   ├── copilot-companion.mjs        ← entry; dispatches `setup` | `review`
│   └── lib/
│       ├── copilot.mjs              ← build prompt, invoke copilot, clean output
│       ├── git.mjs                  ← scope/diff computation
│       └── process.mjs              ← binaryAvailable() + spawn helpers
├── prompts/
│   └── review.md                    ← reviewer instruction template
├── test/                            ← node:test unit tests + a stub `copilot` bin
├── README.md
├── LICENSE                          ← MIT
└── CHANGELOG.md
```

## Component specs

### `.claude-plugin/plugin.json`
```json
{
  "name": "copilot-review",
  "version": "0.1.0",
  "description": "Use GitHub Copilot from Claude Code to review your code changes.",
  "author": { "name": "Thomas Guillot" }
}
```

### `.claude-plugin/marketplace.json`
A minimal marketplace manifest pointing at this same repo as a single plugin, so
the install flow is:
```
/plugin marketplace add <your-gh>/copilot-review-claude-plugin
/plugin install copilot-review
```

### `scripts/lib/process.mjs`
- `binaryAvailable(cmd, args, opts)` → `{ available, detail }` by spawning
  `cmd args` (e.g. `copilot --version`) and inspecting exit/stderr.
- `run(cmd, args, opts)` → `{ code, stdout, stderr }` thin `spawnSync` wrapper
  (utf-8, captured), with an optional `input` for stdin.

### `scripts/lib/git.mjs`
- `resolveScope({ scope, base, cwd })`:
  - `working-tree` (default): `git diff HEAD` (covers staged + unstaged tracked
    changes) **plus** untracked files from
    `git ls-files --others --exclude-standard` (their contents appended as
    synthetic diffs). Empty diff **and** no untracked files → "nothing to review".
  - `branch`: `git diff <base>...HEAD`. `base` defaults to `main`, else `master`,
    else `origin/HEAD`.
- Handles a repo with no commits yet (no `HEAD`) gracefully (treat all tracked +
  untracked as new).
- **Size guard:** if the assembled diff exceeds a cap (e.g. ~200 KB), truncate
  and append an explicit note listing what was dropped. **Never truncate
  silently.**
- Returns `{ text, fileCount, truncated, droppedFiles }`.

### `scripts/lib/copilot.mjs`
- `buildReviewPrompt({ diff, scopeLabel, templatePath })` — loads
  `prompts/review.md` and substitutes the diff + scope description.
- `runReview({ cwd, prompt, model })` — invokes
  `copilot -p <prompt> --no-color [--model <model>]` with **no tool-allow
  flags**. Captures stdout; strips CLI banner/noise lines.
- `getAuthStatus()` — non-destructive auth detection:
  - env vars `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` present?
  - `gh auth status` hint if `gh` is installed.
  - Returns `{ likelyAuthed: bool, sources: [...], detail }`. (We can't read the
    CLI's stored device-flow token reliably across platforms, so absence of a
    detected source is reported as "unknown — try `--probe`", not "unauthed".)
- `probeAuth({ cwd })` — optional live check: `copilot -p "Reply with exactly:
  READY"` and confirm the reply, distinguishing an auth error from success.

### `scripts/copilot-companion.mjs`
Dispatch on `argv[2]`:
- **`setup [--probe]`**
  1. `binaryAvailable("copilot", ["--version"])`. If missing → print install
     guidance (`npm install -g @github/copilot`, requires a Copilot subscription)
     and exit non-zero.
  2. `getAuthStatus()`; print what was detected.
  3. If not clearly authed → print guidance: run `copilot login` (browser device
     flow) **or** set a fine-grained PAT with the "Copilot Requests" permission
     as `COPILOT_GITHUB_TOKEN`. Emphasize the plugin never stores the token.
  4. If `--probe`, run `probeAuth` and report the end-to-end result.
- **`review [--base <ref>] [--scope working-tree|branch] [--model <m>]`**
  1. `resolveScope(...)`. If nothing to review → say so and exit 0.
  2. `buildReviewPrompt(...)` → `runReview(...)`.
  3. Print Copilot's review verbatim (cleaned). If the size guard truncated the
     diff, prepend the truncation note.

### `prompts/review.md`
Instructs Copilot to act as a senior reviewer over the **provided diff only**
(do not run commands, do not assume access to the rest of the repo beyond the
diff), and to respond as severity-grouped markdown:

```
## Summary
<one or two sentences>

## High
- `path:line` — <issue and why it matters>

## Medium
- …

## Low
- …
```

If there are no issues in a tier, omit that tier. If nothing at all, respond
exactly `No issues found.` Verbatim markdown keeps it readable for the user and
parseable enough that "fix the High findings" works for Claude.

### `commands/setup.md`
Frontmatter: `description`, `argument-hint: '[--probe]'`,
`allowed-tools: Bash(node:*), Bash(copilot:*)`.
Body: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" setup
"$ARGUMENTS"`, return output verbatim. If output indicates not-authed, surface
the suggestion to run `! copilot login` (the user runs the browser device flow
themselves; Claude can't complete it).

### `commands/review.md`
Frontmatter: `description`, `argument-hint: '[--base <ref>] [--scope
working-tree|branch] [--model <m>]'`,
`allowed-tools: Bash(node:*), Bash(git:*)`.
Body (mirrors `/codex:review`'s review-only discipline):
- This command is **review-only**. Do not fix issues or apply patches.
- Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" review
  "$ARGUMENTS"`.
- Return stdout verbatim. Do not summarize or act on the findings unless the user
  asks in a later message.

## Auth / setup flow (the "enter their creds" requirement)

Setup **verifies and guides; it never stores a secret.** Two supported paths,
both owned by the Copilot CLI itself:

1. **Interactive (recommended for humans):** `copilot login` → browser device
   flow → the CLI stores its own token. Claude can't drive the browser, so setup
   tells the user to run `! copilot login`.
2. **Env var (recommended for CI / headless):** set a fine-grained PAT with the
   "Copilot Requests" permission as `COPILOT_GITHUB_TOKEN` (or `GH_TOKEN` /
   `GITHUB_TOKEN`). Setup detects its presence but never writes it.

`--probe` runs one tiny live request to confirm auth works end-to-end.

## Error handling

- `copilot` not installed → actionable install message, non-zero exit.
- Not authenticated (detected, or probe fails) → guidance for both auth paths.
- Empty scope → "nothing to review", exit 0.
- Copilot returns an auth/error string instead of a review → surface it plainly
  rather than presenting it as findings.
- Oversized diff → truncate + explicit dropped-files note.

## Testing

- **Unit (node:test):** `git.mjs` scope/diff against a temp repo (staged,
  unstaged, untracked, branch, no-HEAD); prompt building; output cleaning;
  `getAuthStatus` env detection.
- **Integration with a stub:** a fake `copilot` executable on `PATH` that echoes
  canned review/probe output, so `review` and `setup --probe` are testable
  without a real subscription.
- **Manual smoke:** install the plugin locally, run `/copilot-review:setup` and
  `/copilot-review:review` against a real working-tree diff.

## Open-source packaging

- **README.md:** what it is (Copilot as a Claude Code reviewer), prerequisites
  (Copilot subscription + `@github/copilot`), install via marketplace, the two
  commands, a clear note that **Copilot only reviews, never edits**, and the auth
  guidance.
- **LICENSE:** MIT, © Thomas Guillot.
- **CHANGELOG.md:** `0.1.0 — initial release`.
- Repo doubles as its own marketplace so install is two commands.

## Decisions log

| Decision | Choice | Rationale |
|---|---|---|
| Scope | setup + review only | User wants a single review pass; loop is manual |
| Copilot edits code? | Never | Reviewer-only is safe and predictable |
| Architecture | Thin Node shim + prompt files | Copilot CLI is one-shot; no broker needed |
| Output format | Severity-grouped markdown, verbatim | Readable + parseable; no rigid JSON |
| Credentials | Verify + guide, never store | Avoids plaintext-secret footgun |
| License | MIT | Maximize adoption; ecosystem norm |
| Name | `copilot-review` | Avoids clash with a possible future official plugin |
| Repo | `~/Sites/copilot-review-claude-plugin` | Standalone, unrelated to other repos |
```
