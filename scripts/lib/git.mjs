import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./process.mjs";

function hasHead(cwd) {
  return run("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd }).code === 0;
}

function detectBase(cwd) {
  for (const ref of ["main", "master", "origin/HEAD"]) {
    if (run("git", ["rev-parse", "--verify", "--quiet", ref], { cwd }).code === 0) {
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

function untrackedSegments(cwd) {
  const res = run("git", ["ls-files", "--others", "--exclude-standard"], { cwd });
  const files = res.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  return files.map((rel) => {
    let content;
    try {
      content = readFileSync(join(cwd, rel), "utf8");
    } catch {
      content = "<unreadable>";
    }
    return { path: rel, text: `### New file: ${rel}\n\`\`\`\n${content}\n\`\`\`\n` };
  });
}

function assembleSegments(segments, maxBytes) {
  let text = "";
  const droppedFiles = [];
  let truncated = false;
  for (const seg of segments) {
    if (!truncated && text.length + seg.text.length <= maxBytes) {
      text += seg.text + "\n";
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
    const d = run("git", ["diff", `${ref}...HEAD`], { cwd });
    segments = splitDiffSegments(d.stdout);
  } else {
    scopeLabel = "working tree (uncommitted changes)";
    const trackedDiff = hasHead(cwd)
      ? run("git", ["diff", "HEAD"], { cwd }).stdout
      : run("git", ["diff", "--cached"], { cwd }).stdout;
    segments = [...splitDiffSegments(trackedDiff), ...untrackedSegments(cwd)];
  }

  const { text, truncated, droppedFiles } = assembleSegments(segments, maxBytes);
  return {
    text,
    fileCount: segments.length,
    truncated,
    droppedFiles,
    isEmpty: text.trim().length === 0,
    scopeLabel
  };
}
