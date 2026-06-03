# copilot-review — contributor guide

`copilot-review` is a Claude Code plugin that drives the GitHub Copilot CLI as a
**review-only** code reviewer: it builds a diff for the chosen scope and hands it
to `copilot -p` with `--deny-tool write --deny-tool shell`, so Copilot reasons
over the diff and **never edits code or runs commands** — all fixes are made by
Claude Code (or the user). End-user install, auth, and usage details live in
[README.md](README.md); this file is context for working on the plugin itself.

## Commands

- `/copilot-review:setup [--probe]` — verify the Copilot CLI is installed and that
  auth resolves (env vars / stored `copilot login` / `gh`). Never stores a token;
  `--probe` does a live request to confirm end-to-end.
- `/copilot-review:review [--scope working-tree|branch] [--base <ref>] [--model <m>]`
  — review the current git changes; Copilot's findings are returned verbatim.
  Default scope is the working tree (uncommitted changes).

## Architecture

A thin Node companion does the deterministic work; the slash commands just invoke
it and relay its output. There is no long-running process — the Copilot CLI is a
one-shot per review.

- `scripts/copilot-companion.mjs` — CLI entry (`setup` / `review`): flag parsing, dispatch, output.
- `scripts/lib/process.mjs` — `run()` / `binaryAvailable()` process helpers (capture stdout/stderr/exit/signal).
- `scripts/lib/git.mjs` — `resolveScope()`: builds the diff for working-tree or branch scope, with a byte cap, untracked-file handling (binary/symlink/odd names), and clear git-failure reporting.
- `scripts/lib/copilot.mjs` — prompt building, auth status/probe, and `runReview()` (the review-only `copilot` invocation).
- `prompts/review.md` — the reviewer prompt template (`{{SCOPE}}` / `{{DIFF}}`).
- `commands/` — the two slash-command definitions.
- `test/` — `node:test` suite plus a stub `copilot` binary, so it runs without a Copilot subscription.

## Develop

```
npm test
```

## Conventions

- Conventional-commit messages and PR titles (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
- No `Co-Authored-By` trailers.
- Keep Copilot review-only — never grant it write/shell tools, and never let it modify the working tree.
- Cross-platform: avoid POSIX-only assumptions (paths, separators, `/dev/null`); the suite skips genuinely-unportable cases on Windows.
