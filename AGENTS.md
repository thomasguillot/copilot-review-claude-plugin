# copilot-review — agent guide

`copilot-review` is a Claude Code plugin that uses the **GitHub Copilot CLI as a
read-only code reviewer**. Copilot reviews the current git changes and returns
severity-grouped findings. **It never edits code** — review-only is enforced by
running `copilot` with `--deny-tool write --deny-tool shell`. All fixes are made
by the calling agent (or the user).

## Commands

- `/copilot-review:setup [--probe]` — check the Copilot CLI is installed and
  whether credentials resolve. Never stores a token. `--probe` does a live
  request to confirm auth end-to-end.
- `/copilot-review:review [--scope working-tree|branch] [--base <ref>] [--model <m>]`
  — compute the diff for the chosen scope and have Copilot review it. Default
  scope is `working-tree` (uncommitted changes). Output is returned verbatim.

## Prerequisites

- An active **GitHub Copilot** subscription.
- The Copilot CLI: `npm install -g @github/copilot` (Node.js >= 18).
- Authentication (any one):
  - a stored `copilot login` (interactive browser device flow), or
  - a fine-grained PAT with the **Copilot Requests** permission exported as
    `COPILOT_GITHUB_TOKEN` (or `GH_TOKEN` / `GITHUB_TOKEN`).

## Install — interactive (inside Claude Code)

```
/plugin marketplace add thomasguillot/copilot-review-claude-plugin
/plugin install copilot-review
```

## Install — non-interactive (edit settings.json)

Merge the following into `~/.claude/settings.json` (user scope) or
`.claude/settings.json` (project scope), then restart/reload Claude Code:

```json
{
  "extraKnownMarketplaces": {
    "copilot-review": {
      "source": { "source": "github", "repo": "thomasguillot/copilot-review-claude-plugin" }
    }
  },
  "enabledPlugins": {
    "copilot-review@copilot-review": true
  }
}
```

Notes:
- `enabledPlugins` keys are `<plugin-name>@<marketplace-name>`. Here both the
  plugin and the marketplace are named `copilot-review`, hence
  `copilot-review@copilot-review`.
- Merge these keys into any existing `extraKnownMarketplaces` / `enabledPlugins`
  objects — do not overwrite the whole file.

## Verify

```
/copilot-review:setup --probe
```

## Use

```
/copilot-review:review                          # review uncommitted changes
/copilot-review:review --scope branch --base main
```

To run a review loop, fix the reported findings and run the command again until
it reports no issues.

## Develop

```
npm test    # 36 tests, Node's built-in node:test runner, no external deps
```

Tests use a stub `copilot` binary, so they run without a Copilot subscription.
