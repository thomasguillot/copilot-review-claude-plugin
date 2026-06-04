#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { binaryAvailable } from "./lib/process.mjs";
import { resolveScope } from "./lib/git.mjs";
import { buildReviewPrompt, getAuthStatus, parseStructuredReview, probeAuth, runReview } from "./lib/copilot.mjs";
import { resolveLoopConfig, filterFindings, findingKey, findingId } from "./lib/loop.mjs";
import { readState, setRound, addDismissed, addAttempted, clearState } from "./lib/loop-state.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(here, "..", "prompts", "review.md");
const JSON_TEMPLATE = join(here, "..", "prompts", "review-json.md");

function out(s) {
  process.stdout.write(s.endsWith("\n") ? s : s + "\n");
}

function parseFlags(rest) {
  const tokens = rest.join(" ").trim().split(/\s+/).filter(Boolean);
  const flags = { scope: "working-tree", base: null, model: null, probe: false, format: "markdown", error: null, maxRounds: undefined, threshold: undefined, minConfidence: undefined, scopeProvided: false };
  for (let i = 0; i < tokens.length; i++) {
    let name = tokens[i];
    if (name === "--probe") {
      flags.probe = true;
      continue;
    }
    if (name === "--json") {
      flags.format = "json";
      continue;
    }
    let value = null;
    const eq = name.indexOf("=");
    if (eq !== -1) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (name === "--scope" || name === "--base" || name === "--model" || name === "--format" || name === "--max-rounds" || name === "--threshold" || name === "--min-confidence") {
      if (value === null) value = tokens[++i];
      if (!value) {
        flags.error = `${name} requires a value`;
        continue;
      }
      // Strip a single layer of surrounding quotes (e.g. --base "main"), since
      // $ARGUMENTS arrives as one already-quoted string and is split on spaces.
      if (
        value.length >= 2 &&
        ((value[0] === '"' && value[value.length - 1] === '"') ||
          (value[0] === "'" && value[value.length - 1] === "'"))
      ) {
        value = value.slice(1, -1);
      }
      if (name === "--scope") { flags.scope = value; flags.scopeProvided = true; }
      else if (name === "--base") flags.base = value;
      else if (name === "--model") flags.model = value;
      else if (name === "--format") flags.format = value;
      else if (name === "--max-rounds") flags.maxRounds = Number(value);
      else if (name === "--threshold") flags.threshold = value;
      else if (name === "--min-confidence") flags.minConfidence = Number(value);
    } else {
      // Anything else (e.g. a typo'd flag like --scpoe) is rejected rather than
      // silently ignored, so misconfigured reviews fail loudly.
      flags.error = `Unknown option '${tokens[i]}'.`;
    }
  }
  return flags;
}

function rejectLoopFlags(flags, command) {
  const offenders = [];
  if (flags.threshold !== undefined) offenders.push("--threshold");
  if (flags.minConfidence !== undefined) offenders.push("--min-confidence");
  if (flags.maxRounds !== undefined) offenders.push("--max-rounds");
  if (offenders.length) {
    process.stderr.write(`${command}: ${offenders.join(", ")} ${offenders.length > 1 ? "are" : "is"} only valid for the loop commands (loop-config/loop-review/loop).\n`);
    process.exitCode = 2;
    return true;
  }
  return false;
}

function cmdSetup(flags, cwd) {
  if (rejectLoopFlags(flags, "setup")) return;
  const avail = binaryAvailable("copilot", ["--version"], { cwd });
  if (!avail.available) {
    out("GitHub Copilot CLI not found.");
    out("Install it with:  npm install -g @github/copilot");
    out("Requires Node.js >=18 and an active GitHub Copilot subscription.");
    out(`Detail: ${avail.detail}`);
    process.exitCode = 1;
    return;
  }
  out(`copilot detected: ${avail.detail}`);

  const auth = getAuthStatus({});
  out(auth.detail);

  if (flags.probe) {
    const p = probeAuth({ cwd });
    out(p.detail);
    process.exitCode = p.ok ? 0 : 1;
    return;
  }

  if (!auth.likelyAuthed) {
    out("");
    out("To authenticate, either:");
    out("  1. Run an interactive login (browser device flow):  copilot login");
    out("     (In Claude Code, run it yourself with:  ! copilot login )");
    out("  2. Or set a fine-grained PAT with the \"Copilot Requests\" permission");
    out("     as COPILOT_GITHUB_TOKEN (or GH_TOKEN / GITHUB_TOKEN) for CI/headless.");
    out("");
    out("This plugin never stores your token. Re-run with --probe to verify.");
  }
}

function cmdReview(flags, cwd) {
  if (rejectLoopFlags(flags, "review")) return;
  // Usage/validation errors (exit 2) go to stderr by CLI convention, leaving
  // stdout empty so machine consumers never parse a usage message as output.
  if (flags.scope !== "working-tree" && flags.scope !== "branch") {
    process.stderr.write(`Invalid --scope '${flags.scope}'. Use working-tree or branch.\n`);
    process.exitCode = 2;
    return;
  }
  if (flags.format !== "markdown" && flags.format !== "json") {
    process.stderr.write(`Invalid --format '${flags.format}'. Use markdown or json.\n`);
    process.exitCode = 2;
    return;
  }
  const scope = resolveScope({ scope: flags.scope, base: flags.base, cwd });
  if (scope.error) {
    if (flags.format === "json") {
      process.stderr.write(`Cannot review: ${scope.error}\n`);
    } else {
      out(`Cannot review: ${scope.error}`);
    }
    process.exitCode = 1;
    return;
  }
  if (scope.isEmpty) {
    const noBase = scope.noBaseDetected === true;
    if (flags.format === "json") {
      if (noBase) {
        process.stderr.write("Could not detect a base branch (looked for main/master/origin). Pass --base <ref> to specify one.\n");
        process.exitCode = 1;
      } else {
        out(JSON.stringify({ verdict: "approve", summary: "No changes to review.", findings: [], next_steps: [] }, null, 2));
      }
      return;
    }
    if (noBase) {
      out("Could not detect a base branch (looked for main/master/origin). Pass --base <ref> to specify one.");
    } else {
      out("Nothing to review — no uncommitted changes (or no branch diff) found.");
    }
    return;
  }

  const templatePath = flags.format === "json" ? JSON_TEMPLATE : TEMPLATE;
  let prompt;
  try {
    prompt = buildReviewPrompt({ diff: scope.text, scopeLabel: scope.scopeLabel, templatePath });
  } catch (err) {
    const msg = `Cannot review: failed to load the review prompt template (${err.message}).`;
    if (flags.format === "json") process.stderr.write(msg + "\n");
    else out(msg);
    process.exitCode = 1;
    return;
  }

  if (flags.format === "json") {
    if (scope.truncated) {
      const omitted = scope.droppedFiles.length;
      process.stderr.write(
        `Cannot produce a complete structured review: the diff was truncated (${omitted} file(s) omitted). ` +
        `Narrow the scope (e.g. review fewer files) and retry.\n`
      );
      process.exitCode = 1;
      return;
    }
    const r = reviewToContract({ cwd, prompt, model: flags.model });
    if (!r.ok) {
      process.stderr.write(r.error + "\n");
      process.exitCode = 1;
      return;
    }
    out(JSON.stringify(r.data, null, 2));
    return;
  }

  const result = runReview({ cwd, prompt, model: flags.model });

  if (scope.truncated) {
    const MAX_LISTED = 10;
    const shown = scope.droppedFiles.slice(0, MAX_LISTED);
    const extra = scope.droppedFiles.length - shown.length;
    const list = shown.join(", ") + (extra > 0 ? `, and ${extra} more` : "");
    out(`> Note: the diff was large and was truncated. Files omitted or only partially included: ${list}`);
    out("");
  }

  if (!result.ok) {
    out(`Copilot review could not complete: ${result.detail}`);
    if (result.output) {
      out("");
      out(result.output);
    }
    process.exitCode = 1;
    return;
  }

  out(result.output || "Copilot returned an empty response.");
}

// Run the structured review with one stricter retry on parse failure.
// Returns { ok, data, error }.
function reviewToContract({ cwd, prompt, model }) {
  const attempt = (p) => {
    const res = runReview({ cwd, prompt: p, model });
    if (!res.ok) return { failDetail: res.detail, parsed: null };
    return { failDetail: null, parsed: parseStructuredReview(res.output) };
  };
  let { failDetail, parsed } = attempt(prompt);
  if (!failDetail && (!parsed || !parsed.ok)) {
    const stricter = prompt + "\n\nIMPORTANT: Return ONLY the JSON object. No prose, no code fences.";
    ({ failDetail, parsed } = attempt(stricter));
  }
  if (failDetail) return { ok: false, data: null, error: `Copilot review could not complete: ${failDetail}` };
  if (!parsed || !parsed.ok) return { ok: false, data: null, error: `Copilot did not return a valid structured review: ${parsed ? parsed.error : "unknown error"}` };
  return { ok: true, data: parsed.data, error: null };
}

// Find the nearest .copilot-review.json at or above cwd, WITHOUT escaping the
// git/project root — so a stray config outside the repo can't be applied.
function findConfigText(cwd) {
  let dir = cwd;
  while (true) {
    const candidate = join(dir, ".copilot-review.json");
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
    // Reached the repo root with no config — do not read configs from outside it.
    if (existsSync(join(dir, ".git"))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root (not in a git repo)
    dir = parent;
  }
}

function loadLoopConfig(flags, cwd) {
  let fileText;
  try {
    fileText = findConfigText(cwd);
  } catch (err) {
    // e.g. unreadable .copilot-review.json, a permission error, or a directory
    // by that name (EISDIR). Surface a controlled error instead of crashing.
    return { config: null, error: `Could not read .copilot-review.json: ${err.message}` };
  }
  return resolveLoopConfig({
    flags: {
      threshold: flags.threshold,
      minConfidence: flags.minConfidence,
      maxRounds: flags.maxRounds,
      // Only override scope when the user explicitly passed --scope, so a scope
      // set in .copilot-review.json is not shadowed by the working-tree default.
      scope: flags.scopeProvided ? flags.scope : undefined,
      base: flags.base,
      model: flags.model
    },
    fileText
  });
}

function cmdLoopConfig(flags, cwd) {
  const { config, error } = loadLoopConfig(flags, cwd);
  if (error) {
    process.stderr.write(error + "\n");
    process.exitCode = 2;
    return;
  }
  out(JSON.stringify(config, null, 2));
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Standalone composable filter: reads a review JSON on stdin and applies the
// same threshold/confidence/dismissed logic as loop-review. Not used by /loop;
// kept as a reusable seam (e.g. for the `the-reviewer` orchestrator) and tested.
function cmdFilter(flags, cwd) {
  const { config, error } = loadLoopConfig(flags, cwd);
  if (error) {
    process.stderr.write(error + "\n");
    process.exitCode = 2;
    return;
  }
  let review;
  try {
    review = JSON.parse(readStdin());
  } catch (err) {
    process.stderr.write(`filter: could not parse review JSON from stdin: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    process.stderr.write("filter: expected a review JSON object on stdin.\n");
    process.exitCode = 1;
    return;
  }
  if (!Array.isArray(review.findings)) {
    process.stderr.write("filter: review JSON is missing a 'findings' array.\n");
    process.exitCode = 1;
    return;
  }
  const { blocking, ignored, clean } = filterFindings(review.findings || [], {
    threshold: config.threshold,
    minConfidence: config.minConfidence,
    dismissedIds: readState(cwd).dismissed
  });
  out(JSON.stringify({
    clean,
    blocking,
    ignoredCount: ignored.length
  }, null, 2));
}

function cmdState(rest, cwd) {
  const [action, value] = rest;
  switch (action) {
    case "get":
      out(JSON.stringify(readState(cwd), null, 2));
      return;
    case "set-round": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        process.stderr.write(`state set-round: expected a non-negative integer, got ${value === undefined ? "no value" : `'${value}'`}.\n`);
        process.exitCode = 2;
        return;
      }
      setRound(cwd, n);
      out(JSON.stringify(readState(cwd), null, 2));
      return;
    }
    case "dismiss":
      if (!value) {
        process.stderr.write("state dismiss: expected a finding id.\n");
        process.exitCode = 2;
        return;
      }
      addDismissed(cwd, value);
      out(JSON.stringify(readState(cwd), null, 2));
      return;
    case "attempt":
      if (!value) {
        process.stderr.write("state attempt: expected a finding id.\n");
        process.exitCode = 2;
        return;
      }
      addAttempted(cwd, value);
      out(JSON.stringify(readState(cwd), null, 2));
      return;
    case "clear":
      clearState(cwd);
      out(JSON.stringify(readState(cwd), null, 2));
      return;
    default:
      process.stderr.write("Usage: state <get|set-round <n>|dismiss <id>|attempt <id>|clear>\n");
      process.exitCode = 2;
  }
}

function cmdLoopReview(flags, cwd) {
  const { config, error } = loadLoopConfig(flags, cwd);
  if (error) {
    process.stderr.write(error + "\n");
    process.exitCode = 2;
    return;
  }
  const scope = resolveScope({ scope: config.scope, base: config.base, cwd, includeWorktree: true });
  if (scope.error) {
    process.stderr.write(`Cannot review: ${scope.error}\n`);
    process.exitCode = 1;
    return;
  }
  if (scope.noBaseDetected) {
    process.stderr.write("Could not detect a base branch (looked for main/master/origin). Pass --base <ref> to specify one.\n");
    process.exitCode = 1;
    return;
  }
  if (scope.isEmpty) {
    out(JSON.stringify({ clean: true, blocking: [], ignoredCount: 0 }, null, 2));
    return;
  }
  if (scope.truncated) {
    process.stderr.write(`Cannot produce a complete structured review: the diff was truncated (${scope.droppedFiles.length} file(s) omitted). Narrow the scope and retry.\n`);
    process.exitCode = 1;
    return;
  }
  let prompt;
  try {
    prompt = buildReviewPrompt({ diff: scope.text, scopeLabel: scope.scopeLabel, templatePath: JSON_TEMPLATE });
  } catch (err) {
    process.stderr.write(`Cannot review: failed to load the review prompt template (${err.message}).\n`);
    process.exitCode = 1;
    return;
  }
  const r = reviewToContract({ cwd, prompt, model: config.model });
  if (!r.ok) {
    process.stderr.write(r.error + "\n");
    process.exitCode = 1;
    return;
  }
  const { blocking, ignored, clean } = filterFindings(r.data.findings || [], {
    threshold: config.threshold,
    minConfidence: config.minConfidence,
    dismissedIds: readState(cwd).dismissed
  });
  out(JSON.stringify({ clean, blocking, ignoredCount: ignored.length }, null, 2));
}

const [cmd, ...rest] = process.argv.slice(2);
const cwd = process.cwd();

if (cmd === "state") {
  cmdState(rest, cwd);
} else {
  const flags = parseFlags(rest);
  if (flags.error) {
    process.stderr.write(`Error: ${flags.error}\n`);
    process.stderr.write("Usage: copilot-companion.mjs <setup|review|loop-config|filter|loop-review|state> [--scope working-tree|branch] [--base <ref>] [--model <m>] [--probe] [--format markdown|json] [--threshold <t>] [--min-confidence <0..1>] [--max-rounds <n>]\n");
    process.exitCode = 2;
  } else if (cmd === "setup") {
    cmdSetup(flags, cwd);
  } else if (cmd === "review") {
    cmdReview(flags, cwd);
  } else if (cmd === "loop-config") {
    cmdLoopConfig(flags, cwd);
  } else if (cmd === "filter") {
    cmdFilter(flags, cwd);
  } else if (cmd === "loop-review") {
    cmdLoopReview(flags, cwd);
  } else {
    process.stderr.write("Usage: copilot-companion.mjs <setup|review|loop-config|filter|loop-review|state> [flags]\n");
    process.exitCode = 2;
  }
}
