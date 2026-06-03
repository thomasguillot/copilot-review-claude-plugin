import { readFileSync } from "node:fs";
import { run } from "./process.mjs";

const AUTH_ENV_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];

export function buildReviewPrompt({ diff, scopeLabel, templatePath }) {
  const tmpl = readFileSync(templatePath, "utf8");
  return tmpl.replaceAll("{{SCOPE}}", scopeLabel).replaceAll("{{DIFF}}", diff);
}

export function getAuthStatus({ env = process.env, skipGh = false } = {}) {
  const sources = AUTH_ENV_VARS.filter((v) => env[v] && String(env[v]).trim());
  let ghHint = null;
  if (!skipGh) {
    const gh = run("gh", ["auth", "status"], { env });
    if (!gh.error && gh.code === 0) ghHint = "gh CLI is authenticated";
  }
  const likelyAuthed = sources.length > 0 || ghHint !== null;
  return {
    likelyAuthed,
    sources,
    ghHint,
    detail: likelyAuthed
      ? `Credentials detected: ${[...sources, ghHint].filter(Boolean).join(", ")}`
      : "No credentials detected from env vars or gh. The Copilot CLI may still have a stored login — run setup with --probe to confirm."
  };
}

export function cleanCopilotOutput(stdout) {
  return String(stdout ?? "").replace(/\r\n/g, "\n").trim();
}
