import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { run, start, pnpmCommand, waitFor } from "./processes.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const release = process.env.SCENESPARROW_CORE_PROFILE === "release";
if (!process.env.SCENESPARROW_CORE_BIN)
  run("cargo", [
    "build",
    ...(release ? ["--release"] : []),
    "--locked",
    "-p",
    "scenesparrow-service",
  ]);
const coreBinary =
  process.env.SCENESPARROW_CORE_BIN ??
  fileURLToPath(
    new URL(
      `../target/${release ? "release" : "debug"}/scenesparrow-service${process.platform === "win32" ? ".exe" : ""}`,
      import.meta.url,
    ),
  );
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
function supervise(child) {
  children.push(child);
  child.once("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.once("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
  return child;
}

try {
  if (process.argv.includes("--desktop")) {
    run(...pnpmCommand(["--filter", "@scenesparrow/web", "build"]));
    run(...pnpmCommand(["--filter", "@scenesparrow/desktop", "build"]));
    const require = createRequire(
      new URL("../apps/desktop/package.json", import.meta.url),
    );
    const electron = require("electron");
    supervise(
      start(electron, ["apps/desktop"], {
        env: { ...process.env, SCENESPARROW_CORE_BIN: coreBinary },
      }),
    );
  } else {
    const token = randomBytes(32).toString("hex");
    const corePort = process.env.SCENESPARROW_CORE_PORT ?? "4318";
    const webPort = process.env.SCENESPARROW_WEB_PORT ?? "5173";
    const env = {
      ...process.env,
      SCENESPARROW_SESSION_TOKEN: token,
      SCENESPARROW_WEB_ORIGIN: `http://127.0.0.1:${webPort}`,
    };
    const core = supervise(start(coreBinary, [], { env }));
    await waitFor(
      `http://127.0.0.1:${corePort}/v1/health`,
      { Authorization: `Bearer ${token}` },
      core,
    );
    const require = createRequire(
      new URL("../apps/web/package.json", import.meta.url),
    );
    const vite = fileURLToPath(
      new URL(
        "bin/vite.js",
        pathToFileURL(require.resolve("vite/package.json")),
      ),
    );
    if (process.env.SCENESPARROW_PRODUCTION_UI === "1")
      run(...pnpmCommand(["--filter", "@scenesparrow/web", "build"]));
    const web = supervise(
      start(
        process.execPath,
        [
          vite,
          ...(process.env.SCENESPARROW_PRODUCTION_UI === "1"
            ? ["preview", "--host", "127.0.0.1", "--port", webPort]
            : []),
        ],
        {
          env,
          cwd: fileURLToPath(new URL("../apps/web/", import.meta.url)),
        },
      ),
    );
    if (process.env.SCENESPARROW_PERF_PID_FILE)
      writeFileSync(
        process.env.SCENESPARROW_PERF_PID_FILE,
        JSON.stringify({
          core: core.pid,
          web: web.pid,
          coordinator: process.pid,
        }),
      );
  }
} catch (error) {
  console.error(error.message);
  stop(1);
}
