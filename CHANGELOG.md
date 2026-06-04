# Changelog

## 1.1.0

- `/copilot-review:review --format json` (alias `--json`): validated structured review output matching a shared finding contract (`schemas/review-output.schema.json`); markdown remains the default. Invalid or contradictory output is retried once, then fails rather than emitting a bogus result.

## 1.0.1

- Docs: simplified agent guidance (dropped `AGENTS.md`) and trimmed the README.
- Docs: linked the changelog from the README.

## 1.0.0

- Initial release.
- `/copilot-review:setup` — verify Copilot CLI install + auth (never stores secrets).
- `/copilot-review:review` — single-pass Copilot review of working-tree or branch changes.
