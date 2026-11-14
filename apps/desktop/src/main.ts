import { app, BrowserWindow, ipcMain, session } from "electron";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let core: ChildProcess | undefined;
const directory = dirname(fileURLToPath(import.meta.url));
const entry = resolve(directory, "../../web/dist/index.html");
const entryUrl = pathToFileURL(entry).href;

async function main() {
  const binary = process.env.SCENESPARROW_CORE_BIN;
  if (!binary)
    throw new Error("Start desktop development with pnpm dev:desktop");
  const token = randomBytes(32).toString("hex");
  const corePort = process.env.SCENESPARROW_CORE_PORT ?? "4318";
  const baseUrl = `http://127.0.0.1:${corePort}/v1`;
  core = spawn(binary, [], {
    stdio: "inherit",
    env: {
      ...process.env,
      SCENESPARROW_SESSION_TOKEN: token,
      SCENESPARROW_PROJECT_DIR:
        process.env.SCENESPARROW_PROJECT_DIR ??
        join(app.getPath("userData"), "projects", "default"),
    },
  });
  core.on("error", (error) => {
    console.error(error.message);
    app.quit();
  });
  core.on("exit", () => app.quit());
  async function request(path: string, body?: unknown) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await response.json()) as { code?: string };
    if (!response.ok) throw new Error(data.code ?? "SERVICE_UNAVAILABLE");
    return data;
  }
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (core.exitCode !== null) throw new Error("Core exited during startup");
    try {
      await request("/health");
      ready = true;
      break;
    } catch {
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  if (!ready) throw new Error("Core readiness timed out");
  for (const [channel, path] of [
    ["project:health", "/health"],
    ["project:read", "/project"],
    ["project:create", "/project"],
  ] as const) {
    ipcMain.handle(channel, (event, command: unknown) => {
      if (event.senderFrame?.url !== entryUrl) throw new Error("ORIGIN_DENIED");
      return request(path, channel === "project:create" ? command : undefined);
    });
  }
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  const window = new BrowserWindow({
    title: "SceneSparrow",
    width: 1200,
    height: 820,
    webPreferences: {
      preload: join(directory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  await window.loadFile(entry);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("before-quit", () => {
    core?.kill();
  });
  app.on("window-all-closed", () => app.quit());
  app
    .whenReady()
    .then(main)
    .catch((error: unknown) => {
      console.error(error);
      app.quit();
    });
}
