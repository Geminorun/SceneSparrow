import { spawn, spawnSync } from "node:child_process";

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited with ${result.status}`);
}

export function pnpmCommand(args) {
  if (!process.env.npm_execpath)
    throw new Error("Run this command through pnpm");
  return [process.execPath, [process.env.npm_execpath, ...args]];
}

export async function waitFor(url, headers = {}, child, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null)
      throw new Error("Service exited before becoming ready");
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return response;
    } catch {
      /* A newly launched process may not have bound its socket yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Service readiness timed out: ${url}`);
}

export function start(command, args, options = {}) {
  return spawn(command, args, { stdio: "inherit", ...options });
}
