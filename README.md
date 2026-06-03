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
`copilot -p` with the **write and shell tools denied** (`--deny-tool`), so
Copilot cannot modify files or run commands while it reviews. It reasons over
the assembled diff and its findings are returned verbatim.

## For AI agents

Agent-oriented install and usage instructions live in [`AGENTS.md`](AGENTS.md),
including a non-interactive `settings.json` install path. `CLAUDE.md` imports it
(`@AGENTS.md`) so Claude Code picks it up automatically.

## Development

```
npm test
```

## License

MIT © Thomas Guillot
