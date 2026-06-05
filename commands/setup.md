---
description: Check the GitHub Copilot CLI is installed and authenticated (no secrets stored)
argument-hint: '[--probe] [--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*)
---

Run the setup check:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" setup "$ARGUMENTS"
```

Return the command's output verbatim.

If the output says credentials were not detected, tell the user they can
authenticate by running `! copilot login` themselves (an interactive browser
device flow that Claude cannot complete for them), or by setting a fine-grained
PAT with the "Copilot Requests" permission as `COPILOT_GITHUB_TOKEN`. Do not
attempt to store or write any token.

## Optional stop-time review gate

Passing `--enable-review-gate` turns on a `Stop` hook for this repo: before a
session can end, Copilot reviews your working-tree changes and, if anything is
still flagged, blocks the stop and hands off to `/copilot-review:loop`. It is
**off by default** and is a machine-local, per-repo setting (never committed).
Turn it off with `--disable-review-gate`. Every `setup` run reports the current
gate status. The gate never edits code — it only blocks and points you at the
loop. Automated orchestrators (e.g. `the-reviewer`) should disable it while they
drive their own review loop. The gate runs as a `Stop` hook and therefore requires
Node.js to be available in the environment where Claude Code executes hooks.
