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
