---
description: Ask GitHub Copilot to review your current git changes
argument-hint: '[--scope working-tree|branch] [--base <ref>] [--model <model>] [--format markdown|json]'
allowed-tools: Bash(node:*)
---

This command is **review-only**. Do not fix issues, apply patches, or edit any
files as part of running it. Your only job is to run the review and return
Copilot's output to the user.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" review "$ARGUMENTS"
```

Return the command's stdout verbatim — do not summarize, re-rank, or act on the
findings. Only address them if the user asks in a later message. If the command
exits non-zero (for example, a JSON-mode review that fails on a truncated diff
or a git scope error writes its message to stderr with empty stdout), surface
that stderr message to the user instead of returning an empty response.

Pass `--format json` (or `--json`) to get a validated structured review matching the shared finding contract (`schemas/review-output.schema.json`) instead of markdown. Return the command's stdout verbatim as usual.
