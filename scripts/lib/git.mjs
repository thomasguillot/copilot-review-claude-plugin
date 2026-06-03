import { readFileSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { run } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 64 * 1024;

function longestBacktickRun(s) {
  const runs = String(s).match(/`+/g);
  return runs ? Math.max(...runs.map((r) => r.length)) : 0;
}

function hasHead(cwd) {
  return run("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd }).code === 0;
}

function detectBase(cwd) {
  const head = run("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd }).stdout.trim();
  for (const ref of ["main", "master", "origin/main", "origin/master", "origin/HEAD"]) {
    const r = run("git", ["rev-parse", "--verify", "--quiet", ref], { cwd });
    // Skip a candidate that points at the same commit as HEAD (e.g. running
    // --scope branch while checked out on main itself) — it would yield an
    // empty, falsely-clean diff.
    if (r.code === 0 && r.stdout.trim() !== head) {
      return ref;
    }
  }
  return "HEAD";
}

function splitDiffSegments(diffText) {
  if (!diffText || !diffText.trim()) return [];
  const parts = diffText.split(/(?=^diff --git )/m).filter((s) => s.trim());
  return parts.map((text) => {
    const plus = text.match(/^\+\+\+ b\/(.+)$/m);
    const head = text.match(/^diff --git a\/.+ b\/(.+)$/m);
    const path = plus ? plus[1] : head ? head[1] : "unknown";
    return { path, text };
  });
}

function untrackedSegments(cwd, files) {
  return files.map((rel) => {
    const abs = join(cwd, rel);
    let body;
    try {
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        body = `Symlink → ${readlinkSync(abs)}`;
      } else if (st.isFile()) {
        if (st.size > MAX_UNTRACKED_BYTES) {
          body = `<untracked file too large to inline: ${st.size} bytes>`;
        } else {
          const buf = readFileSync(abs);
          body = buf.includes(0) ? "<binary file omitted>" : buf.toString("utf8");
        }
      } else {
        body = "<non-regular file>";
      }
    } catch {
      body = "<unreadable>";
    }
    // Use a fence longer than any backtick run in the body so file content
    // containing ``` cannot prematurely terminate the code fence.
    const fence = "`".repeat(Math.max(3, longestBacktickRun(body) + 1));
    // Render the path via JSON.stringify in the heading so newlines/control
    // characters in a crafted filename can't break the markdown or shape the
    // prompt; the raw `rel` is still used for file I/O above.
    return { path: rel, text: `### New file: ${JSON.stringify(rel)}\n${fence}\n${body}\n${fence}\n` };
  });
}

const TRUNCATION_MARKER = "\n[... diff truncated ...]\n";

function sliceBytes(s, maxBytes) {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let end = Math.max(0, maxBytes);
  // Back off so we never cut in the middle of a UTF-8 multibyte sequence.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.toString("utf8", 0, end);
}

function assembleSegments(segments, maxBytes) {
  let text = "";
  let bytes = 0;
  const droppedFiles = [];
  let truncated = false;
  for (const seg of segments) {
    const segBytes = Buffer.byteLength(seg.text, "utf8");
    if (truncated) {
      droppedFiles.push(seg.path);
    } else if (bytes + segBytes + 1 <= maxBytes) {
      // +1 accounts for the newline appended after each segment, so the
      // assembled output never exceeds maxBytes.
      text += seg.text + "\n";
      bytes += segBytes + 1;
    } else if (bytes === 0) {
      // First segment alone exceeds the cap: include a truncated slice, leaving
      // room for the marker, so the review is never silently skipped and the
      // output still stays within maxBytes.
      const room = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATION_MARKER, "utf8"));
      text += sliceBytes(seg.text, room) + TRUNCATION_MARKER;
      truncated = true;
      droppedFiles.push(seg.path);
    } else {
      truncated = true;
      droppedFiles.push(seg.path);
    }
  }
  return { text: text.trim(), truncated, droppedFiles };
}

function gitFailDetail(res, label, fallback) {
  if (res.error) {
    // Spawn failure (e.g. git not installed / not on PATH) — surface the real cause.
    return `${label}: could not run git (${res.error.code ?? res.error.message})`;
  }
  return `${label}: ${(res.stderr || "").trim() || fallback}`;
}

export function resolveScope({ scope = "working-tree", base = null, cwd = process.cwd(), maxBytes = 200000 } = {}) {
  let segments = [];
  let scopeLabel;

  // Fail clearly if git itself can't be run, before interpreting any exit codes.
  const gitCheck = run("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  if (gitCheck.error) {
    return {
      text: "",
      fileCount: 0,
      truncated: false,
      droppedFiles: [],
      isEmpty: true,
      scopeLabel: scope === "branch" ? "branch diff" : "working tree (uncommitted changes)",
      error: `Could not run git (${gitCheck.error.code ?? gitCheck.error.message}). Is git installed and on your PATH?`
    };
  }

  if (scope === "branch") {
    if (!hasHead(cwd)) {
      return {
        text: "",
        fileCount: 0,
        truncated: false,
        droppedFiles: [],
        isEmpty: true,
        scopeLabel: "branch diff",
        error: "No commits yet (unborn HEAD); use --scope working-tree until the first commit exists."
      };
    }
    const ref = base || detectBase(cwd);
    const baseNote = !base && ref === "HEAD" ? " — no base branch detected" : "";
    scopeLabel = `branch diff (${ref}...HEAD)${baseNote}`;
    const d = run("git", ["diff", "--no-ext-diff", "--no-textconv", `${ref}...HEAD`], { cwd });
    if (d.code !== 0 || d.error) {
      return {
        text: "",
        fileCount: 0,
        truncated: false,
        droppedFiles: [],
        isEmpty: true,
        scopeLabel,
        error: gitFailDetail(d, `Could not diff against base '${ref}'`, "git diff failed")
      };
    }
    segments = splitDiffSegments(d.stdout);
  } else {
    scopeLabel = "working tree (uncommitted changes)";
    let trackedRes;
    if (hasHead(cwd)) {
      trackedRes = run("git", ["diff", "--no-ext-diff", "--no-textconv", "HEAD"], { cwd });
    } else {
      // No commits yet: diff the working tree against the empty tree so BOTH
      // staged and later-unstaged edits to tracked files are captured
      // (`--cached` alone would miss unstaged changes to already-staged files).
      // The empty-tree hash is computed from empty stdin (portable, no special
      // filesystem path) — this also adapts to the repo's hash algorithm.
      const emptyTree = run("git", ["hash-object", "-t", "tree", "--stdin"], { cwd, input: "" }).stdout.trim();
      trackedRes = run("git", ["diff", "--no-ext-diff", "--no-textconv", emptyTree], { cwd });
    }
    if (trackedRes.code !== 0 || trackedRes.error) {
      return {
        text: "",
        fileCount: 0,
        truncated: false,
        droppedFiles: [],
        isEmpty: true,
        scopeLabel,
        error: gitFailDetail(trackedRes, "git diff failed", "not a git repository?")
      };
    }
    const lsRes = run("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd });
    if (lsRes.code !== 0 || lsRes.error) {
      return {
        text: "",
        fileCount: 0,
        truncated: false,
        droppedFiles: [],
        isEmpty: true,
        scopeLabel,
        error: gitFailDetail(lsRes, "git ls-files failed", "not a git repository?")
      };
    }
    // NUL-delimited (-z) and no trimming, so pathnames containing newlines or
    // leading/trailing spaces are preserved exactly.
    const untracked = lsRes.stdout.split("\0").filter(Boolean);
    segments = [...splitDiffSegments(trackedRes.stdout), ...untrackedSegments(cwd, untracked)];
  }

  const { text, truncated, droppedFiles } = assembleSegments(segments, maxBytes);
  return {
    text,
    fileCount: segments.length,
    truncated,
    droppedFiles,
    isEmpty: text.trim().length === 0,
    scopeLabel,
    error: null
  };
}
