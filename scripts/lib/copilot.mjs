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

export function buildReviewArgs({ prompt, model = null }) {
  // Review-only: deny write/shell so Copilot cannot edit files or run commands,
  // regardless of the folder's trust settings. It only reasons over the diff.
  const args = ["-p", prompt, "--no-color", "--deny-tool", "write", "--deny-tool", "shell"];
  if (model) args.push("--model", model);
  return args;
}

// Conservative single-argument size limits: Windows command lines cap near
// 32 KB; POSIX ARG_MAX is far larger but shared with the environment.
const MAX_PROMPT_BYTES = process.platform === "win32" ? 30000 : 1000000;

export function runReview({ cwd, prompt, model = null, copilotBin = "copilot" }) {
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (promptBytes > MAX_PROMPT_BYTES) {
    return {
      ok: false,
      detail: `Review prompt is too large (${promptBytes} bytes) to pass to ${copilotBin} as a command-line argument on this platform (limit ~${MAX_PROMPT_BYTES}). Review fewer files or use a narrower --scope.`,
      output: ""
    };
  }
  const args = buildReviewArgs({ prompt, model });
  const res = run(copilotBin, args, { cwd });
  if (res.error) {
    return { ok: false, detail: `Could not run ${copilotBin}: ${res.error.code ?? res.error.message}`, output: "" };
  }
  if (res.code !== 0 || res.signal) {
    const how = res.signal ? `terminated by signal ${res.signal}` : `exited ${res.code}`;
    return {
      ok: false,
      detail: (res.stderr || "").trim() || `${copilotBin} ${how}`,
      output: cleanCopilotOutput(res.stdout)
    };
  }
  return { ok: true, detail: null, output: cleanCopilotOutput(res.stdout) };
}

export function probeSaysReady(stdout) {
  // Require READY as a standalone token on its own line, so "NOT READY" or a
  // sentence merely containing the word does not count as success.
  return /(^|\n)\s*READY\s*(\n|$)/i.test(String(stdout ?? ""));
}

export function probeAuth({ cwd, copilotBin = "copilot" }) {
  const res = run(copilotBin, ["-p", "Reply with exactly: READY", "--no-color", "--deny-tool", "write", "--deny-tool", "shell"], { cwd });
  if (res.error) {
    return { ok: false, detail: `Could not run ${copilotBin}: ${res.error.code ?? res.error.message}` };
  }
  if (res.code === 0 && probeSaysReady(res.stdout)) {
    return { ok: true, detail: "Auth verified — Copilot responded." };
  }
  const how = res.signal ? `terminated by signal ${res.signal}` : `exited ${res.code}`;
  return { ok: false, detail: (res.stderr || res.stdout || `${copilotBin} ${how}`).trim() };
}
