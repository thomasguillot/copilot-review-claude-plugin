import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { run } from "./process.mjs";
import { validate } from "./schema.mjs";

// The review-output contract is loaded lazily and cached on first use, so a
// missing/corrupt schema only affects the JSON review path (with a controlled
// error) — it never crashes the module at import time or the markdown path.
let schemaCache;
let schemaLoaded = false;
function getSchema() {
  if (!schemaLoaded) {
    schemaLoaded = true;
    try {
      schemaCache = JSON.parse(
        readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas", "review-output.schema.json"), "utf8")
      );
    } catch {
      schemaCache = null;
    }
  }
  return schemaCache;
}

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

// Return the substring from `start` to its matching closing brace, accounting
// for braces that appear inside JSON string literals. Returns null if the
// object never closes (unbalanced).
function balancedObject(text, start) {
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Cross-field checks the JSON Schema cannot express. Returns an error string
// if the review object is internally contradictory, else null.
function reviewConsistencyError(data) {
  const count = Array.isArray(data.findings) ? data.findings.length : 0;
  if (data.verdict === "approve" && count > 0) {
    return `Inconsistent review: verdict "approve" with ${count} finding(s).`;
  }
  if (data.verdict === "needs-attention" && count === 0) {
    return `Inconsistent review: verdict "needs-attention" with no findings.`;
  }
  for (const f of data.findings || []) {
    if (typeof f.line_start === "number" && typeof f.line_end === "number" && f.line_end < f.line_start) {
      return `Invalid finding range in "${f.title}": line_end (${f.line_end}) < line_start (${f.line_start}).`;
    }
  }
  return null;
}

// Extract a JSON review object from a model response that may include stray
// prose or ```code fences```, then validate it against the shared contract and
// internal-consistency rules. Requires EXACTLY ONE valid review object: zero
// means fail (retry/fail loud); more than one is ambiguous and also fails, so a
// stray/echoed object can never be silently accepted in place of the real one.
export function parseStructuredReview(stdout) {
  const schema = getSchema();
  if (!schema) {
    return { ok: false, data: null, error: "Review schema unavailable (could not load review-output.schema.json)." };
  }
  const text = String(stdout ?? "");
  const valid = [];
  let lastError = null;
  let i = text.indexOf("{");
  while (i !== -1) {
    const slice = balancedObject(text, i);
    if (!slice) {
      i = text.indexOf("{", i + 1);
      continue;
    }
    let data;
    try {
      data = JSON.parse(slice);
    } catch (err) {
      lastError = `Could not parse JSON: ${err.message}`;
      i = text.indexOf("{", i + slice.length);
      continue;
    }
    const result = validate(data, schema);
    if (result.ok) {
      const consErr = reviewConsistencyError(data);
      if (consErr) {
        lastError = consErr;
      } else {
        valid.push(data);
      }
      // Skip past this whole object; do not descend into its inner braces.
      i = text.indexOf("{", i + slice.length);
    } else {
      lastError = `JSON did not match contract: ${result.errors.join("; ")}`;
      i = text.indexOf("{", i + slice.length);
    }
  }
  if (valid.length === 1) return { ok: true, data: valid[0], error: null };
  if (valid.length > 1) {
    return { ok: false, data: null, error: `Ambiguous output: ${valid.length} structured review objects found.` };
  }
  return { ok: false, data: null, error: lastError || "No JSON object found in Copilot response." };
}
