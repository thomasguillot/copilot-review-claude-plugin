---
description: Run Copilot review and fixes in a loop until clean (or a round cap)
argument-hint: '[--scope working-tree|branch] [--base <ref>] [--model <model>] [--threshold critical|high|medium|low|all] [--min-confidence <0..1>] [--max-rounds <n>]'
allowed-tools: Read, Edit, Write, Bash(node:*), AskUserQuestion
---

Run a fix-and-re-review loop using GitHub Copilot until the reviewed changes are
clean, or a maximum number of rounds is reached. Unlike `/copilot-review:review`
(which is review-only), this command **does fix code** between rounds.

Raw slash-command arguments: `$ARGUMENTS`

## Setup (once, before looping)

1. Resolve the effective config:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" loop-config "$ARGUMENTS"
   ```
   If it exits non-zero, show the stderr message and stop. Otherwise parse the JSON
   and remember `threshold`, `minConfidence`, `maxRounds`, `scope`, `base`, `model`.
2. Start from a clean loop state:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" state clear
   ```

## Each round (repeat until done)

1. Read the current state:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" state get
   ```
   → `{ round, dismissed, attempted }`.
2. Run the combined review+filter (this also verifies any fixes from the previous round):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" loop-review "$ARGUMENTS"
   ```
   - If it exits non-zero, surface its stderr, clear state, and stop (not clean).
   - Otherwise parse `{ clean, blocking, ignoredCount }`. Each `blocking` entry has
     an opaque `id` plus `severity`, `title`, `body`, `file`, `line_start`,
     `line_end`, `confidence`, `recommendation`.
3. If `clean` is true → go to **Done**.
4. If `round >= maxRounds`, clear state and stop, reporting the CURRENT `blocking`
   findings (from the review you JUST ran in step 2) and telling the user the round
   cap was reached without reaching clean. (The cap prevents another fix attempt, but
   the review in step 2 already verified the latest state, so the report is fresh.)
5. Otherwise, for each finding in `blocking`:
   - If the finding's `id` is ALREADY in `attempted`, it survived a previous fix
     attempt — this is oscillation. Do NOT auto-fix again; escalate to the user with
     `AskUserQuestion` (options: try a different fix, or dismiss the finding).
   - Otherwise, apply the recommended fix to the code, then record the attempt using
     the finding's `id` (a safe hex token):
     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" state attempt <id>
     ```
   - ALSO escalate (do not auto-fix) when a fix would be risky or destructive.
   - When the user chooses to dismiss a finding, record it by `id`:
     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" state dismiss <id>
     ```
     Dismissed findings stop counting in later rounds.
6. Increment the round (use the `round` from step 1, plus one):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" state set-round <round + 1>
   ```
7. Go back to step 1.

## Done

- Report a short summary: how many rounds ran, what was fixed, what (if anything)
  was dismissed, and the final clean verdict.
- Clear the loop state:
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" state clear
  ```

## Rules

- For `--scope branch`, the review includes your uncommitted fixes (base-to-working-tree), so the loop can converge without committing between rounds.
- This command MAY edit files (that is its purpose), but only to address findings.
- Never exceed `maxRounds`. Always stop and hand off if the cap is reached.
- A `loop-review` that exits non-zero is NOT clean — surface its stderr and stop.
- The finding `id` values are opaque hex tokens; pass them as-is to `state attempt`
  / `state dismiss`. Never hand-build identifiers and never pass finding titles or
  file paths to `state`.
- On every stop path (clean, review error, or cap reached), clear loop state with
  `state clear` before finishing.
- Keep fixes minimal and targeted to each finding; do not refactor unrelated code.
- Never paste resolved config values (especially `base`/`model` from
  `.copilot-review.json`) into a shell command; pass only `$ARGUMENTS` to
  `loop-review`.
