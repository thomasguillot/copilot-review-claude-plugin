#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { binaryAvailable } from "./lib/process.mjs";
import { resolveScope } from "./lib/git.mjs";
import { buildReviewPrompt, getAuthStatus, parseStructuredReview, probeAuth, runReview } from "./lib/copilot.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(here, "..", "prompts", "review.md");
const JSON_TEMPLATE = join(here, "..", "prompts", "review-json.md");

function out(s) {
  process.stdout.write(s.endsWith("\n") ? s : s + "\n");
}

function parseFlags(rest) {
  const tokens = rest.join(" ").trim().split(/\s+/).filter(Boolean);
  const flags = { scope: "working-tree", base: null, model: null, probe: false, format: "markdown", error: null };
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
    if (name === "--scope" || name === "--base" || name === "--model" || name === "--format") {
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
      if (name === "--scope") flags.scope = value;
      else if (name === "--base") flags.base = value;
      else if (name === "--model") flags.model = value;
      else if (name === "--format") flags.format = value;
    } else {
      // Anything else (e.g. a typo'd flag like --scpoe) is rejected rather than
      // silently ignored, so misconfigured reviews fail loudly.
      flags.error = `Unknown option '${tokens[i]}'.`;
    }
  }
  return flags;
}

function cmdSetup(flags, cwd) {
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
    const attempt = (p) => {
      const res = runReview({ cwd, prompt: p, model: flags.model });
      if (!res.ok) return { failDetail: res.detail, parsed: null };
      return { failDetail: null, parsed: parseStructuredReview(res.output) };
    };

    let { failDetail, parsed } = attempt(prompt);
    if (!failDetail && (!parsed || !parsed.ok)) {
      const stricter = prompt + "\n\nIMPORTANT: Return ONLY the JSON object. No prose, no code fences.";
      ({ failDetail, parsed } = attempt(stricter));
    }

    // On failure, keep stdout empty and report on stderr, so consumers can
    // safely JSON.parse stdout only when the exit code is 0.
    if (failDetail) {
      process.stderr.write(`Copilot review could not complete: ${failDetail}\n`);
      process.exitCode = 1;
      return;
    }
    if (!parsed || !parsed.ok) {
      process.stderr.write(`Copilot did not return a valid structured review: ${parsed ? parsed.error : "unknown error"}\n`);
      process.exitCode = 1;
      return;
    }
    out(JSON.stringify(parsed.data, null, 2));
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

const [cmd, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
const cwd = process.cwd();

if (flags.error) {
  process.stderr.write(`Error: ${flags.error}\n`);
  process.stderr.write("Usage: copilot-companion.mjs <setup|review> [--scope working-tree|branch] [--base <ref>] [--model <m>] [--probe] [--format markdown|json]\n");
  process.exitCode = 2;
} else if (cmd === "setup") {
  cmdSetup(flags, cwd);
} else if (cmd === "review") {
  cmdReview(flags, cwd);
} else {
  process.stderr.write("Usage: copilot-companion.mjs <setup|review> [flags]\n");
  process.exitCode = 2;
}
