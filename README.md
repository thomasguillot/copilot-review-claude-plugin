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

Or install non-interactively by merging this into `~/.claude/settings.json` (or a
project's `.claude/settings.json`) and restarting Claude Code:

```json
{
  "extraKnownMarketplaces": {
    "copilot-review": {
      "source": { "source": "github", "repo": "thomasguillot/copilot-review-claude-plugin" }
    }
  },
  "enabledPlugins": { "copilot-review@copilot-review": true }
}
```

Merge these keys into any existing `extraKnownMarketplaces` / `enabledPlugins`
objects — don't replace the whole settings file. The `enabledPlugins` key is
`<plugin>@<marketplace>`; here the plugin and the marketplace are both named
`copilot-review`, hence `copilot-review@copilot-review`.

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

### Structured (JSON) output

`/copilot-review:review --format json` (or `--json`) returns a validated JSON object — `verdict`, `summary`, `findings[]` (each with `severity`, `title`, `body`, `file`, `line_start`/`line_end`, `confidence`, `recommendation`), and `next_steps` — instead of markdown. If Copilot returns output that doesn't match the contract, the command retries once and then fails rather than emitting an invalid result.

Want a review loop? Just tell Claude: "fix the High findings and run
`/copilot-review:review` again," and repeat until it's clean.

## How it works

A small Node script computes the diff for the chosen scope and passes it to
`copilot -p` with the **write and shell tools denied** (`--deny-tool`), so
Copilot cannot modify files or run commands while it reviews. It reasons over
the assembled diff and its findings are returned verbatim.

## Development

```
npm test
```

## Contributing

Plugin updates reach installed users based on the `version` in
`.claude-plugin/plugin.json` (not the GitHub release/tag), so **every PR into
`main` must bump that version** — a CI check enforces it. Bump the appropriate
digit (`MAJOR.MINOR.PATCH`) and add a matching entry to
[CHANGELOG.md](CHANGELOG.md).

For changes not worth a release (typos, internal tweaks), add the **`no-release`**
label to the PR to skip the version-bump check.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes.
