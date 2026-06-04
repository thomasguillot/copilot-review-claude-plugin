// Pure helpers for the review loop: severity ranking, stable finding keys, and
// filtering findings by severity threshold + confidence floor (minus dismissed).

import { createHash } from "node:crypto";

export const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 };

// Canonical identity for a finding. JSON-encoding the tuple removes delimiter
// ambiguity (a plain space join could let distinct field values collide, e.g.
// file "a b" vs file "a" + "b"). Identity is intentionally COARSE — only
// [file, line_start, line_end, title] — so a finding keeps the same id when its
// body/recommendation is reworded across rounds. Two genuinely different
// findings that share all four fields will collide; that is the accepted
// line-sensitivity tradeoff (a fix that shifts lines resets the id), backstopped
// by the max-rounds cap. Do NOT describe this as globally collision-free.
export function findingKey(finding) {
  return JSON.stringify([finding.file, finding.line_start, finding.line_end, finding.title]);
}

// Opaque, shell-safe identifier (hex only — no metacharacters), used to record
// dismissals/attempts and pass them between the command and the companion.
export function findingId(finding) {
  return createHash("sha256").update(findingKey(finding)).digest("hex").slice(0, 12);
}

// Returns { blocking, ignored, clean }. A finding is "blocking" when it is at or
// above the severity threshold, at or above the confidence floor, and not
// dismissed. Everything else is "ignored". clean === (blocking.length === 0).
export function filterFindings(findings, { threshold = "all", minConfidence = 0, dismissedIds = [] } = {}) {
  const floorRank = threshold === "all" ? 1 : (SEVERITY_RANK[threshold] ?? 1);
  const dismissed = new Set(dismissedIds);
  const blocking = [];
  const ignored = [];
  for (const finding of findings || []) {
    // Unknown severities rank as Infinity so malformed input fails loud (always
    // blocks) instead of slipping through as "ignored".
    const rank = SEVERITY_RANK[finding.severity] ?? Infinity;
    const meetsSeverity = rank >= floorRank;
    const meetsConfidence = typeof finding.confidence === "number" ? finding.confidence >= minConfidence : true;
    const id = findingId(finding);
    if (meetsSeverity && meetsConfidence && !dismissed.has(id)) blocking.push({ ...finding, id });
    else ignored.push(finding);
  }
  return { blocking, ignored, clean: blocking.length === 0 };
}

const DEFAULT_CONFIG = {
  threshold: "all",
  minConfidence: 0.7,
  maxRounds: 6,
  scope: "working-tree",
  base: null,
  model: null
};

const VALID_THRESHOLDS = new Set(["all", "low", "medium", "high", "critical"]);

// Merge built-in defaults < .copilot-review.json "loop" block < CLI flags, then
// validate. `fileText` is the raw file contents (or null if absent). `flags` is
// an object with any of: threshold, minConfidence, maxRounds, scope, base, model.
// Returns { config, error }. On any validation/parse error, config is null.
export function resolveLoopConfig({ flags = {}, fileText = null } = {}) {
  let fileConfig = {};
  if (typeof fileText === "string" && fileText.trim() !== "") {
    let parsed;
    try {
      parsed = JSON.parse(fileText);
    } catch (err) {
      return { config: null, error: `Could not parse .copilot-review.json: ${err.message}` };
    }
    fileConfig = (parsed && typeof parsed === "object" && parsed.loop && typeof parsed.loop === "object") ? parsed.loop : {};
  }

  const pick = (key) => (flags[key] !== undefined && flags[key] !== null) ? flags[key]
    : (fileConfig[key] !== undefined && fileConfig[key] !== null) ? fileConfig[key]
    : DEFAULT_CONFIG[key];

  const config = {
    threshold: pick("threshold"),
    minConfidence: pick("minConfidence"),
    maxRounds: pick("maxRounds"),
    scope: pick("scope"),
    base: pick("base"),
    model: pick("model")
  };

  if (!VALID_THRESHOLDS.has(config.threshold)) {
    return { config: null, error: `Invalid threshold '${config.threshold}'. Use one of: ${[...VALID_THRESHOLDS].join(", ")}.` };
  }
  if (typeof config.minConfidence !== "number" || Number.isNaN(config.minConfidence) || config.minConfidence < 0 || config.minConfidence > 1) {
    return { config: null, error: `Invalid min-confidence '${config.minConfidence}'. Use a number between 0 and 1.` };
  }
  if (!Number.isInteger(config.maxRounds) || config.maxRounds < 1) {
    return { config: null, error: `Invalid max-rounds '${config.maxRounds}'. Use a positive integer.` };
  }
  if (config.scope !== "working-tree" && config.scope !== "branch") {
    return { config: null, error: `Invalid scope '${config.scope}'. Use working-tree or branch.` };
  }
  // base is optional (null) but, when set, must be a string that cannot be
  // misread by git as an option (see resolveScope's option-injection guard).
  if (config.base !== null && (typeof config.base !== "string" || config.base.startsWith("-"))) {
    return { config: null, error: `Invalid base '${config.base}'. Use a branch name or ref that does not start with '-'.` };
  }
  return { config, error: null };
}
