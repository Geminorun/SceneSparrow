import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createDiagnostics, collectChild } from "./diagnostics.mjs";
import { pathToFileURL } from "node:url";
import { createGateway, readOperator, validateOrigin } from "./gateway.mjs";

// Injectable process/socket locations let lifecycle tests exercise real child processes.
export async function startRuntime({
  origin,
  operator,
  binary = "/app/bin/scenesparrow-service",
  args = [],
  staticRoot = "/app/apps/web/dist",
  corePort = 4318,
  gatewayPort = 8080,
  projectDir = "/data/project",
  appDataDir = "/data/app",
  signals = process,
  onExit = (code) => {
    process.exitCode = code;
  },
  shutdownMs = 40_000,
  quiesceMs = 30_000,
  startupMs = 30_000,
  version = "unknown",
  buildSha = "unknown",
}) {
  validateOrigin(origin);
  const token = randomBytes(32).toString("hex");
  const native = randomBytes(32).toString("hex");
  // Use an explicit environment so operator configuration cannot reach the core or workers.
  const env = {
    PATH: process.env.PATH,
    HOME: "/home/node",
    SCENESPARROW_SESSION_TOKEN: token,
    SCENESPARROW_NATIVE_TOKEN: native,
    SCENESPARROW_CORE_PORT: String(corePort),
    SCENESPARROW_WEB_ORIGIN: origin,
    SCENESPARROW_PROJECT_DIR: projectDir,
    SCENESPARROW_APP_DATA_DIR: appDataDir,
  };
  let ready = false;
  const diagnostics = createDiagnostics({
    directory: join(appDataDir, "diagnostics"),
    version,
    buildSha,
    coreAvailable: () => ready,
  });
  diagnostics.emit({
    schemaVersion: 1,
    component: "supervisor",
    level: "info",
    eventCode: "CORE_START",
    stage: "startup",
  });
  const child = spawn(binary, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stopping = false;
  collectChild(child.stdout, diagnostics);
  collectChild(child.stderr, diagnostics);
  let gateway;
  let stopPromise;
  const exited = new Promise((done) => {
    child.once("exit", done);
    child.once("error", done);
  });
  const killGroup = (signal) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* The process group may already have exited. */
    }
  };
  const stop = (failed = false) => {
    if (stopPromise) return stopPromise;
    stopping = true;
    ready = false;
    stopPromise = (async () => {
      const deadline = setTimeout(() => killGroup("SIGKILL"), shutdownMs);
      try {
        await gateway?.close();
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          try {
            const result = await fetch(
              `http://127.0.0.1:${corePort}/v1/project/quiesce`,
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${token}`,
                  "x-scenesparrow-native": native,
                },
                signal: AbortSignal.timeout(quiesceMs),
              },
            );
            if (!result.ok) failed = true;
          } catch {
            failed = true;
          }
          child.kill("SIGINT");
          await exited;
        }
      } finally {
        clearTimeout(deadline);
        killGroup("SIGKILL");
        signals.removeListener("SIGTERM", terminate);
        signals.removeListener("SIGINT", terminate);
        diagnostics.emit({
          schemaVersion: 1,
          component: "supervisor",
          level: failed ? "error" : "info",
          eventCode: failed ? "CORE_FAILED" : "CORE_STOP",
          stage: "shutdown",
        });
        await diagnostics.close(250);
        onExit(failed ? 1 : 0);
      }
    })();
    return stopPromise;
  };
  const terminate = () => {
    void stop();
  };
  signals.once("SIGTERM", terminate);
  signals.once("SIGINT", terminate);
  child.once("error", () => {
    void stop(true);
  });
  child.once("exit", () => {
    if (!stopping) void stop(true);
  });
  try {
    const until = Date.now() + startupMs;
    while (!stopping && Date.now() < until) {
      try {
        const result = await fetch(`http://127.0.0.1:${corePort}/v1/health`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(1000),
        });
        if (result.ok) {
          ready = true;
          diagnostics.emit({
            schemaVersion: 1,
            component: "supervisor",
            level: "info",
            eventCode: "CORE_READY",
            stage: "startup",
          });
          break;
        }
      } catch {
        /* Wait for the core socket and migration completion. */
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    if (!ready || stopping) throw Error("Core startup failed");
    gateway = await createGateway({
      origin,
      operator,
      staticRoot,
      corePort,
      token,
      ready: () => ready,
      diagnostics,
    });
    if (stopping) {
      await gateway.close();
      throw Error("Startup interrupted");
    }
    await new Promise((done, reject) => {
      gateway.server.once("error", reject);
      gateway.server.listen(gatewayPort, "0.0.0.0", done);
    });
    if (stopping) {
      await gateway.close();
      throw Error("Startup interrupted");
    }
    gateway.server.on("error", () => {
      void stop(true);
    });
    return { child, gateway, stop };
  } catch (error) {
    await stop(true);
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  (async () => {
    const origin = process.env.PUBLIC_ORIGIN;
    validateOrigin(origin);
    const operator = await readOperator(
      process.env.OPERATOR_AUTH_FILE ?? "/run/secrets/operator_auth",
    );
    const { version } = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    );
    await startRuntime({
      origin,
      operator,
      version,
      buildSha: process.env.SCENESPARROW_BUILD_SHA ?? "unknown",
    });
  })().catch(() => {
    console.error("SceneSparrow startup failed");
    process.exitCode = 1;
  });
}
