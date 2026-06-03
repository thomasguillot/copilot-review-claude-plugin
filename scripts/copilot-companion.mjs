#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { binaryAvailable } from "./lib/process.mjs";
import { resolveScope } from "./lib/git.mjs";
import { buildReviewPrompt, getAuthStatus, probeAuth, runReview } from "./lib/copilot.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(here, "..", "prompts", "review.md");

function out(s) {
  process.stdout.write(s.endsWith("\n") ? s : s + "\n");
}

function parseFlags(rest) {
  const tokens = rest.join(" ").trim().split(/\s+/).filter(Boolean);
  const flags = { scope: "working-tree", base: null, model: null, probe: false, error: null };
  for (let i = 0; i < tokens.length; i++) {
    let name = tokens[i];
    if (name === "--probe") {
      flags.probe = true;
      continue;
    }
    let value = null;
    const eq = name.indexOf("=");
    if (eq !== -1) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (name === "--scope" || name === "--base" || name === "--model") {
      if (value === null) value = tokens[++i];
      if (!value) {
        flags.error = `${name} requires a value`;
        continue;
      }
      if (name === "--scope") flags.scope = value;
      else if (name === "--base") flags.base = value;
      else if (name === "--model") flags.model = value;
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
  const scope = resolveScope({ scope: flags.scope, base: flags.base, cwd });
  if (scope.isEmpty) {
    out("Nothing to review — no uncommitted changes (or no branch diff) found.");
    return;
  }

  const prompt = buildReviewPrompt({ diff: scope.text, scopeLabel: scope.scopeLabel, templatePath: TEMPLATE });
  const result = runReview({ cwd, prompt, model: flags.model });

  if (scope.truncated) {
    out(`> Note: the diff was large and was truncated. Files omitted from this review: ${scope.droppedFiles.join(", ")}`);
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
  out(`Error: ${flags.error}`);
  out("Usage: copilot-companion.mjs <setup|review> [--scope working-tree|branch] [--base <ref>] [--model <m>] [--probe]");
  process.exitCode = 2;
} else if (cmd === "setup") {
  cmdSetup(flags, cwd);
} else if (cmd === "review") {
  cmdReview(flags, cwd);
} else {
  out("Usage: copilot-companion.mjs <setup|review> [flags]");
  process.exitCode = 2;
}
