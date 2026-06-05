# Changelog

## 1.3.0

- Optional stop-time review gate (off by default): `/copilot-review:setup --enable-review-gate` makes Copilot review your changes before a session ends and blocks the stop until they're clean, handing off to `/copilot-review:loop`. Per-repo and machine-local; disable with `--disable-review-gate`. The gate never edits code.

## 1.2.0

- `/copilot-review:loop`: a fix-and-re-review loop — Copilot reviews, Claude fixes, repeating until clean or a round cap (default 6). Findings are filtered by a severity `--threshold` (default `all`) and a `--min-confidence` floor (default `0.7`) so low-confidence noise doesn't stall the loop; risky or oscillating findings pause for input, and findings can be dismissed. Configure defaults in `.copilot-review.json` (a `loop` block); flags override. Unlike `review`, this command edits code.
- Hardening: a `base` ref starting with `-` is rejected before reaching git (avoids option injection such as `git diff --output=…`), and an unreadable `.copilot-review.json` now yields a controlled error instead of a stack trace.

## 1.1.0

- `/copilot-review:review --format json` (alias `--json`): validated structured review output matching a shared finding contract (`schemas/review-output.schema.json`); markdown remains the default. Invalid or contradictory output is retried once, then fails rather than emitting a bogus result.

## 1.0.1

- Docs: simplified agent guidance (dropped `AGENTS.md`) and trimmed the README.
- Docs: linked the changelog from the README.

## 1.0.0

- Initial release.
- `/copilot-review:setup` — verify Copilot CLI install + auth (never stores secrets).
- `/copilot-review:review` — single-pass Copilot review of working-tree or branch changes.
