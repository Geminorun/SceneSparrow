import { app, BrowserWindow, ipcMain, session, dialog, shell } from "electron";
import { intakeSelectedFile } from "./file-intake.js";
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
  async function request(path: string, body?: unknown, method?: string) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
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
  const checkSender = (event: Electron.IpcMainInvokeEvent) => {
    if (event.senderFrame?.url !== entryUrl) throw Error("ORIGIN_DENIED");
  };
  for (const [channel, path] of [
    ["sources:read", "/sources"],
    ["document:action", "/document-jobs"],
    ["document:job", "/document-jobs"],
    ["source:extraction", "/source-extractions"],
    ["intake:cancel", "/intakes"],
  ] as const) {
    ipcMain.handle(channel, (event, value: unknown, offset: unknown) => {
      checkSender(event);
      if (channel === "document:action") return request(path, value);
      if (channel === "sources:read") {
        if (
          value !== undefined &&
          (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value))
        )
          return { ok: false, code: "INVALID_REQUEST" };
        return request(path + (value ? `?after=${value}` : ""));
      }
      if (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value))
        return { ok: false, code: "INVALID_REQUEST" };
      if (
        channel === "source:extraction" &&
        (!Number.isSafeInteger(offset) || Number(offset) < 0)
      )
        return { ok: false, code: "INVALID_REQUEST" };
      return request(
        `${path}/${value}${channel === "source:extraction" ? `?offset=${offset}` : ""}`,
        undefined,
        channel === "intake:cancel" ? "DELETE" : undefined,
      );
    });
  }
  const fileSelections = new Map<
    string,
    { abort: AbortController; sender: number }
  >();
  ipcMain.handle("intake:pick-cancel", (event, id: unknown) => {
    checkSender(event);
    if (typeof id !== "string") return { ok: false, code: "INVALID_REQUEST" };
    const selection = fileSelections.get(id);
    if (selection?.sender === event.sender.id) selection.abort.abort();
    return { ok: true, data: null };
  });
  ipcMain.handle("intake:pick", async (event, id: unknown) => {
    checkSender(event);
    if (!primaryWindow) return { ok: false, code: "SERVICE_UNAVAILABLE" };
    if (
      typeof id !== "string" ||
      !/^[0-9a-f-]{36}$/.test(id) ||
      fileSelections.has(id) ||
      fileSelections.size > 0
    )
      return { ok: false, code: "INVALID_REQUEST" };
    const abort = new AbortController();
    fileSelections.set(id, { abort, sender: event.sender.id });
    try {
      const dialogText = app.getLocale().startsWith("zh") ? zhCN : en;
      const selected = await dialog.showOpenDialog(primaryWindow, {
        properties: ["openFile"],
        filters: [
          {
            name: dialogText.documentFiles,
            extensions: ["txt", "md", "markdown", "docx", "pdf"],
          },
        ],
      });
      if (abort.signal.aborted || selected.canceled || !selected.filePaths[0])
        return { ok: true, data: null };
      const data = await intakeSelectedFile(
        selected.filePaths[0],
        baseUrl,
        token,
        abort.signal,
        (loaded, total) => {
          if (!event.sender.isDestroyed())
            event.sender.send("intake:progress", id, loaded, total);
        },
      );
      return { ok: true, data };
    } catch (error) {
      const code = abort.signal.aborted
        ? "DOCUMENT_JOB_INTERRUPTED"
        : error instanceof Error &&
            [
              "INPUT_TOO_LARGE",
              "INVALID_REQUEST",
              "STORAGE_UNAVAILABLE",
            ].includes(error.message)
          ? error.message
          : "STORAGE_UNAVAILABLE";
      return { ok: false, code };
    } finally {
      fileSelections.delete(id);
    }
  });
  ipcMain.handle("source:open-link", async (event, value: unknown) => {
    checkSender(event);
    try {
      if (
        typeof value !== "string" ||
        value.length > 8192 ||
        /[\u0000-\u001f\u007f]/u.test(value)
      )
        throw Error();
      const url = new URL(value);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw Error();
      await shell.openExternal(url.href);
      return { ok: true, data: null };
    } catch {
      return { ok: false, code: "INVALID_URL" };
    }
  });
  const subscriptions = new Map<string, AbortController>();
  ipcMain.on("project:events-start", (event, nonce: unknown) => {
    if (
      event.senderFrame?.url !== entryUrl ||
      typeof nonce !== "string" ||
      !/^[0-9a-f-]{36}$/.test(nonce) ||
      subscriptions.size >= 8
    )
      return;
    const abort = new AbortController();
    subscriptions.set(nonce, abort);
    let after = 0;
    const send = (kind: string, data: unknown) => {
      if (!event.sender.isDestroyed())
        event.sender.send("project:event", nonce, kind, data);
    };
    void (async () => {
      try {
        while (!abort.signal.aborted) {
          try {
            const response = await fetch(
              `${baseUrl}/project/events?after=${after}`,
              {
                headers: { Authorization: `Bearer ${token}` },
                signal: abort.signal,
              },
            );
            if (!response.ok || !response.body) throw Error();
            const decoder = new TextDecoder();
            let pending = "";
            const reader = response.body.getReader();
            for (;;) {
              const { done, value: chunk } = await reader.read();
              if (done) break;
              pending += decoder
                .decode(chunk, { stream: true })
                .replaceAll("\r\n", "\n");
              if (pending.length > 1024 * 1024) throw Error();
              let at;
              while ((at = pending.indexOf("\n\n")) >= 0) {
                const frame = pending.slice(0, at);
                pending = pending.slice(at + 2);
                const data = frame
                  .split("\n")
                  .filter((l) => l.startsWith("data:"))
                  .map((l) => l.slice(5).trimStart())
                  .join("\n");
                if (frame.includes("event: resync_required")) {
                  after = Number(data) || 0;
                  send("resync", null);
                } else if (data) {
                  const item = JSON.parse(data);
                  if (
                    Number.isSafeInteger(item.sequence) &&
                    item.sequence > after
                  ) {
                    after = item.sequence;
                    send("event", item);
                  }
                }
              }
            }
          } catch {}
          if (!abort.signal.aborted)
            await new Promise<void>((done) => {
              const timer = setTimeout(done, 500);
              abort.signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  done();
                },
                { once: true },
              );
            });
        }
      } finally {
        subscriptions.delete(nonce);
      }
    })();
    const destroyed = () => abort.abort();
    event.sender.once("destroyed", destroyed);
    abort.signal.addEventListener(
      "abort",
      () => event.sender.removeListener("destroyed", destroyed),
      { once: true },
    );
  });
  ipcMain.on("project:events-stop", (event, nonce: unknown) => {
    if (event.senderFrame?.url === entryUrl && typeof nonce === "string") {
      subscriptions.get(nonce)?.abort();
      subscriptions.delete(nonce);
    }
  });
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
