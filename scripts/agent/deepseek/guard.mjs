// Fail closed before ACP starts if the effective native tool registry is not empty.
import { writeFileSync } from "node:fs";
export const name = "writing-profile-guard";
export const inject = [
  "tools",
  "agents",
  "llm",
  "sessionPersistence",
  "sessions",
];
export function apply(ctx) {
  const check = (scope) => {
    if (ctx.tools.definitions(scope).length !== 0)
      throw Error("Writing profile unexpectedly exposes tools");
  };
  check();
  ctx.on("tools/change", () => check());
  ctx.on("agent/created", ({ agent }) => check(agent));
  writeFileSync(process.env.DSH_INVENTORY_FILE, JSON.stringify({ tools: [] }), {
    mode: 0o600,
  });
  ctx.provide("writingProfileGuard", {});
}
