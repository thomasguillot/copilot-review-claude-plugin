import { readFileSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { run } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 64 * 1024;

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
    return { path: rel, text: `### New file: ${rel}\n\`\`\`\n${body}\n\`\`\`\n` };
  });
}

function assembleSegments(segments, maxBytes) {
  let text = "";
  const droppedFiles = [];
  let truncated = false;
  for (const seg of segments) {
    if (truncated) {
      droppedFiles.push(seg.path);
    } else if (text.length + seg.text.length <= maxBytes) {
      text += seg.text + "\n";
    } else if (text.length === 0) {
      // First segment alone exceeds the cap: include a truncated slice so the
      // review is never silently skipped.
      text += seg.text.slice(0, maxBytes) + "\n[... diff truncated ...]\n";
      truncated = true;
      droppedFiles.push(seg.path);
    } else {
      truncated = true;
      droppedFiles.push(seg.path);
    }
  }
  return { text: text.trim(), truncated, droppedFiles };
}

export function resolveScope({ scope = "working-tree", base = null, cwd = process.cwd(), maxBytes = 200000 } = {}) {
  let segments = [];
  let scopeLabel;

  if (scope === "branch") {
    const ref = base || detectBase(cwd);
    const baseNote = !base && ref === "HEAD" ? " — no base branch detected" : "";
    scopeLabel = `branch diff (${ref}...HEAD)${baseNote}`;
    const d = run("git", ["diff", "--no-ext-diff", "--no-textconv", `${ref}...HEAD`], { cwd });
    if (d.code !== 0) {
      return {
        text: "",
        fileCount: 0,
        truncated: false,
        droppedFiles: [],
        isEmpty: true,
        scopeLabel,
        error: `Could not diff against base '${ref}': ${(d.stderr || "").trim() || "git diff failed"}`
      };
    }
    segments = splitDiffSegments(d.stdout);
  } else {
    scopeLabel = "working tree (uncommitted changes)";
    const trackedRes = hasHead(cwd)
      ? run("git", ["diff", "--no-ext-diff", "--no-textconv", "HEAD"], { cwd })
      : run("git", ["diff", "--no-ext-diff", "--no-textconv", "--cached"], { cwd });
    if (trackedRes.code !== 0) {
      return {
        text: "",
        fileCount: 0,
        truncated: false,
        droppedFiles: [],
        isEmpty: true,
        scopeLabel,
        error: `git diff failed: ${(trackedRes.stderr || "").trim() || "not a git repository?"}`
      };
    }
    const lsRes = run("git", ["ls-files", "--others", "--exclude-standard"], { cwd });
    if (lsRes.code !== 0) {
      return {
        text: "",
        fileCount: 0,
        truncated: false,
        droppedFiles: [],
        isEmpty: true,
        scopeLabel,
        error: `git ls-files failed: ${(lsRes.stderr || "").trim() || "not a git repository?"}`
      };
    }
    const untracked = lsRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
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
