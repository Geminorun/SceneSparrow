import { app, BrowserWindow, ipcMain, session, dialog } from "electron";
import { CloseHandshake } from "./close-handshake.js";
import en from "../../../packages/editor-ui/src/locales/en.json" with { type: "json" };
import zhCN from "../../../packages/editor-ui/src/locales/zh-CN.json" with { type: "json" };
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let core: ChildProcess | undefined;
let primaryWindow: BrowserWindow | undefined;
let allowClose = false;

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
    const data = (await response.json()) as {
      code?: string;
      details?: unknown;
    };
    if (!response.ok)
      return {
        ok: false,
        code: data.code ?? "SERVICE_UNAVAILABLE",
        ...(data.details ? { details: data.details } : {}),
      };
    return { ok: true, data };
  }
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (core.exitCode !== null) throw new Error("Core exited during startup");
    try {
      const health = await request("/health");
      if (!health.ok) throw new Error("Core unavailable");
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
    ["manuscript:history", "/history"],
    ["manuscript:read", "/manuscript"],
    ["manuscript:command", "/manuscript/commands"],
    ["manuscript:receipt", "/commands"],
  ] as const) {
    ipcMain.handle(channel, (event, command: unknown) => {
      if (event.senderFrame?.url !== entryUrl) throw new Error("ORIGIN_DENIED");
      if (channel === "manuscript:receipt") {
        if (typeof command !== "string" || !/^[0-9a-f-]{36}$/.test(command))
          return { ok: false, code: "INVALID_REQUEST" };
        return request(`${path}/${encodeURIComponent(command)}`);
      }
      return request(
        path,
        channel === "project:create" || channel === "manuscript:command"
          ? command
          : undefined,
      );
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
  primaryWindow = window;
  const close = new CloseHandshake(
    () => {
      allowClose = true;
      window.close();
    },
    async () => {
      const t = app.getLocale().startsWith("zh") ? zhCN : en;
      const result = await dialog.showMessageBox(window, {
        type: "warning",
        title: t.appName,
        message: t.unresponsiveClose,
        buttons: [t.keepEditing, t.closeUnsaved],
        defaultId: 0,
        cancelId: 0,
      });
      return result.response === 1;
    },
  );
  window.on("closed", () => close.dispose());
  window.on("close", (event) => {
    if (allowClose) return;
    event.preventDefault();
    close.request(randomBytes(16).toString("hex"), (nonce) =>
      window.webContents.send("manuscript:close-request", nonce),
    );
  });
  ipcMain.on("manuscript:close-progress", (event, nonce: unknown) => {
    if (
      event.senderFrame?.url === entryUrl &&
      event.sender === window.webContents
    )
      close.responsive(nonce);
  });
  window.webContents.on("render-process-gone", () => close.rendererLost());
  window.on("unresponsive", () => close.rendererLost());
  ipcMain.on(
    "manuscript:close-result",
    (event, nonce: unknown, allowed: unknown) => {
      if (
        event.senderFrame?.url !== entryUrl ||
        event.sender !== window.webContents
      )
        return;
      close.reply(nonce, allowed);
    },
  );
  window.webContents.on("will-prevent-unload", (event) => {
    if (allowClose) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  await window.loadFile(entry);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("before-quit", (event) => {
    if (primaryWindow && !primaryWindow.isDestroyed() && !allowClose) {
      event.preventDefault();
      primaryWindow.close();
      return;
    }
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
