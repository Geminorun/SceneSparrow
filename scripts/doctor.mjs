import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

let failed = false;
for (const [name, command, args] of [
  ["Node.js", process.execPath, ["--version"]],
  ["Rust", "rustc", ["--version"]],
  ["Cargo", "cargo", ["--version"]],
  ["FFmpeg", "ffmpeg", ["-version"]],
]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(`${name}: unavailable`);
    failed = true;
  } else console.log(`${name}: ${result.stdout.split("\n")[0]}`);
}
const require = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
try {
  require("electron");
  console.log(
    `Electron: ${JSON.parse(readFileSync(require.resolve("electron/package.json"), "utf8")).version} (binary installed)`,
  );
} catch {
  console.error(
    "Electron: run node apps/desktop/node_modules/electron/install.js",
  );
  failed = true;
}
process.exitCode = failed ? 1 : 0;
