import { spawnSync } from "node:child_process";

export function run(cmd, args = [], opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input,
    encoding: "utf8",
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    env: opts.env ?? process.env
  });
  return {
    code: res.status,
    signal: res.signal ?? null,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error ?? null
  };
}

export function binaryAvailable(cmd, args = ["--version"], opts = {}) {
  const res = run(cmd, args, opts);
  if (res.error) {
    return { available: false, detail: `${cmd} not found (${res.error.code ?? res.error.message})` };
  }
  if (res.code !== 0 || res.signal) {
    const how = res.signal ? `terminated by signal ${res.signal}` : `exited ${res.code}`;
    return { available: false, detail: `${cmd} ${how}: ${(res.stderr || res.stdout).trim()}` };
  }
  // Strip CR first so CRLF output doesn't leave a trailing \r on the first line.
  return { available: true, detail: (res.stdout || res.stderr).replace(/\r/g, "").trim().split("\n")[0] };
}
