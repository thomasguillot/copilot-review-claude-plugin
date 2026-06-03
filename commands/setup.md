---
description: Check the GitHub Copilot CLI is installed and authenticated (no secrets stored)
argument-hint: '[--probe]'
allowed-tools: Bash(node:*), Bash(copilot:*)
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
