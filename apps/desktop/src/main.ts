import { registerProjectPackageIpc } from "./project-package-ipc.js";
import { registerProjectTransferIpc } from "./project-transfer-ipc.js";
import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  dialog,
  shell,
  clipboard,
} from "electron";
import { registerAiIpc } from "./ai-ipc.js";
import { registerExternalWorkIpc } from "./external-work-ipc.js";
import { registerExportIpc } from "./export-ipc.js";
import { suggestedExportName } from "./export-files.js";
import type { ProjectResponse } from "@scenesparrow/contracts";
import { intakeSelectedFile } from "./file-intake.js";
import {
  ReferenceDirectoryRegistry,
  directoryIntakePort,
} from "./reference-directory.js";
import { registerReferenceDirectoryIpc } from "./reference-directory-ipc.js";
import {
  ProjectRegistry,
  type ProjectOpenMode,
  inspectRememberedProject,
  prepareInitialProject,
} from "./project-registry.js";
import { activateProject } from "./project-activation.js";
import { coreIsRunning, stopCoreProcess } from "./core-process.js";
import { CloseHandshake } from "./close-handshake.js";
import en from "../../../packages/editor-ui/src/locales/en.json" with { type: "json" };
import zhCN from "../../../packages/editor-ui/src/locales/zh-CN.json" with { type: "json" };
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let core: ChildProcess | undefined;
let primaryWindow: BrowserWindow | undefined;
let allowClose = false;
let switching = false;

const directory = dirname(fileURLToPath(import.meta.url));
const entry = resolve(directory, "../../web/dist/index.html");
const entryUrl = pathToFileURL(entry).href;

async function main() {
  const binary = process.env.SCENESPARROW_CORE_BIN;
  if (!binary)
    throw new Error("Start desktop development with pnpm dev:desktop");
  let token = randomBytes(32).toString("hex");
  const corePort = process.env.SCENESPARROW_CORE_PORT ?? "4318";
  const baseUrl = `http://127.0.0.1:${corePort}/v1`;
  let closingCore = false;
  let startingCore = true;
  let nativeToken = randomBytes(32).toString("hex");
  const registry = new ProjectRegistry(
    join(app.getPath("userData"), "project-registry.json"),
  );
  await registry.load();
  const referenceRegistry = new ReferenceDirectoryRegistry(
    join(app.getPath("userData"), "reference-directories.json"),
  );
  await referenceRegistry.load();
  const defaultDirectory = join(app.getPath("userData"), "projects", "default");
  let projectDirectory = "";
  let registryWarningShown = false;
  let registryRefresh: Promise<void> = Promise.resolve();
  function recordCurrentProject() {
    const update = registryRefresh.then(async () => {
      const owner = core,
        directory = projectDirectory;
      try {
        const result = await request("/project");
        if (!result.ok || owner !== core || directory !== projectDirectory)
          return;
        await registry.record(
          directory,
          (result.data as unknown as ProjectResponse).project,
        );
        registryWarningShown = false;
      } catch {
        if (registryWarningShown) return;
        registryWarningShown = true;
        const t = app.getLocale().startsWith("zh") ? zhCN : en;
        await dialog
          .showMessageBox({
            type: "warning",
            title: t.appName,
            message: t.projectRegistryWarning,
          })
          .catch(() => {});
      }
    });
    registryRefresh = update.catch(() => {});
    return registryRefresh;
  }
  function spawnCore(mode: ProjectOpenMode) {
    token = randomBytes(32).toString("hex");
    nativeToken = randomBytes(32).toString("hex");
    core = spawn(binary!, [], {
      stdio: "inherit",
      env: {
        ...process.env,
        SCENESPARROW_SESSION_TOKEN: token,
        SCENESPARROW_NATIVE_TOKEN: nativeToken,
        SCENESPARROW_APP_DATA_DIR:
          process.env.SCENESPARROW_APP_DATA_DIR ?? app.getPath("userData"),
        SCENESPARROW_PROJECT_DIR: projectDirectory,
        SCENESPARROW_PROJECT_OPEN_MODE: mode,
      },
    });
    core.on("error", (error) => {
      console.error(error.message);
      if (!switching && !startingCore) app.quit();
    });
    core.on("exit", () => {
      if (!switching && !startingCore) app.quit();
    });
  }
  async function request(path: string, body?: unknown, method?: string) {
    const owningCore = core;
    const response = await fetch(`${baseUrl}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${token}`,
        "x-scenesparrow-native": nativeToken,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(
        path === "/health"
          ? 1000
          : path.includes("quiesce")
            ? 70000
            : path.includes("connection-tests")
              ? 35_000
              : path.includes("models/discover")
                ? 20_000
                : 10_000,
      ),
    });
    if (core !== owningCore)
      return { ok: false as const, code: "CAPABILITY_EXPIRED" };
    const data = (await response.json()) as {
      code?: string;
      details?: unknown;
    };
    if (!response.ok)
      return {
        ok: false as const,
        code: data.code ?? "SERVICE_UNAVAILABLE",
        ...(data.details ? { details: data.details } : {}),
      };
    return { ok: true as const, data };
  }
  async function stopCore() {
    await stopCoreProcess(core);
  }
  async function waitCoreReady() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (!coreIsRunning(core)) return false;
      try {
        if ((await request("/health")).ok) return true;
      } catch {}
      await new Promise((done) => setTimeout(done, 100));
    }
    return false;
  }
  const runProjectTool = (args: string[]) =>
    new Promise<void>((resolveTool, reject) => {
      const child = spawn(binary!, args, {
        stdio: "ignore",
        env: {
          ...process.env,
          SCENESPARROW_APP_DATA_DIR:
            process.env.SCENESPARROW_APP_DATA_DIR ?? app.getPath("userData"),
        },
      });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolveTool() : reject(Error("PROJECT_INTEGRITY_FAILED")),
      );
    });
  const inspectProject = (path: string) =>
    runProjectTool(["--inspect-project", path]);
  async function startInitial(
    directory: string,
    create = false,
    mode: ProjectOpenMode = "existing",
  ) {
    if (create) {
      await mkdir(dirname(directory), { recursive: true });
      // Exclusive creation refuses a directory that appeared since preflight.
      await mkdir(directory);
    }
    await inspectProject(directory);
    projectDirectory = directory;
    spawnCore(mode);
    if (!(await waitCoreReady())) {
      await stopCore();
      throw Error("PROJECT_INTEGRITY_FAILED");
    }
  }
  let ready = false;
  try {
    const initial = await prepareInitialProject(
      registry,
      defaultDirectory,
      process.env.SCENESPARROW_PROJECT_DIR,
      inspectProject,
    );
    await startInitial(initial.directory, initial.create, initial.mode);
    ready = true;
  } catch {
    /* A failed locator never initializes replacement data. */
  }
  while (!ready) {
    const t = app.getLocale().startsWith("zh") ? zhCN : en;
    const choice = await dialog.showMessageBox({
      type: "error",
      title: t.appName,
      message: t.projectOpenFailed,
      buttons: [t.openProject, t.recoverProject, t.useDefaultProject, t.cancel],
      defaultId: 0,
      cancelId: 3,
    });
    if (choice.response === 3) {
      app.quit();
      return;
    }
    try {
      if (choice.response === 2) {
        // Explicit default choice still refuses a disappeared remembered default.
        const initial = await prepareInitialProject(
          registry,
          defaultDirectory,
          defaultDirectory,
          inspectProject,
        );
        await startInitial(initial.directory, initial.create, initial.mode);
      } else {
        const selected = await dialog.showOpenDialog({
          title: choice.response === 1 ? t.recoverProject : t.openProject,
          properties: ["openDirectory"],
        });
        if (selected.canceled || !selected.filePaths[0]) continue;
        let path = selected.filePaths[0];
        if (choice.response === 1) {
          const target = join(
            dirname(path),
            `recovered-${randomBytes(16).toString("hex")}`,
          );
          await runProjectTool(["--recover-project", path, target]);
          path = target;
        }
        await inspectRememberedProject(path, inspectProject);
        await startInitial(path);
      }
      ready = true;
    } catch {
      /* Keep the original selection and offer another explicit choice. */
    }
  }
  await recordCurrentProject();
  startingCore = false;
  for (const [channel, path] of [
    ["project:health", "/health"],
    ["project:read", "/project"],
    ["project:create", "/project"],
    ["project:ensure", "/project/ensure"],
    ["project:rename", "/project/rename"],
    ["manuscript:history", "/history"],
    ["project:format", "/project/format"],
    ["manuscript:source-read", "/manuscript/source"],
    ["manuscript:source-evidence", "/manuscript/source/recoveries"],
    ["manuscript:source-evidence-version", "/manuscript/source/recoveries"],
    ["manuscript:source-status", "/manuscript/source/status"],
    ["manuscript:source-rescan", "/manuscript/source/rescan"],
    ["manuscript:source-candidate", "/manuscript/source/candidates"],
    ["manuscript:source-resolve", "/manuscript/source/resolve"],
    ["manuscript:source-recover", "/manuscript/source/recover"],
    ["manuscript:source-save", "/manuscript/source"],
    ["manuscript:identity", "/manuscript/identity"],
    ["manuscript:read", "/manuscript"],
    ["manuscript:command", "/manuscript/commands"],
    ["manuscript:receipt", "/commands"],
  ] as const) {
    ipcMain.handle(channel, async (event, command: unknown) => {
      checkSender(event);
      if (channel === "manuscript:source-evidence") {
        if (typeof command !== "string" || !/^[0-9a-f]{64}$/.test(command))
          return { ok: false, code: "INVALID_REQUEST" };
        return request(`${path}/${command}/evidence`);
      }
      if (channel === "manuscript:source-evidence-version") {
        if (
          !command ||
          typeof command !== "object" ||
          Object.keys(command).sort().join(",") !== "intentHash,sourceHash"
        )
          return { ok: false, code: "INVALID_REQUEST" };
        const { intentHash, sourceHash } = command as {
          intentHash: unknown;
          sourceHash: unknown;
        };
        if (
          typeof intentHash !== "string" ||
          typeof sourceHash !== "string" ||
          !/^[0-9a-f]{64}$/.test(intentHash) ||
          !/^[0-9a-f]{64}$/.test(sourceHash)
        )
          return { ok: false, code: "INVALID_REQUEST" };
        return request(`${path}/${intentHash}/evidence/${sourceHash}`);
      }
      if (channel === "manuscript:source-rescan") return request(path, {});
      if (
        channel === "manuscript:receipt" ||
        channel === "manuscript:source-candidate"
      ) {
        if (typeof command !== "string" || !/^[0-9a-f-]{36}$/.test(command))
          return { ok: false, code: "INVALID_REQUEST" };
        return request(`${path}/${encodeURIComponent(command)}`);
      }
      const result = await request(
        path,
        channel === "project:create" ||
          channel === "project:ensure" ||
          channel === "project:rename" ||
          channel === "manuscript:command" ||
          channel === "manuscript:source-save" ||
          channel === "manuscript:source-resolve" ||
          channel === "manuscript:source-recover"
          ? command
          : undefined,
      );
      if (
        result.ok &&
        channel.startsWith("project:") &&
        channel !== "project:health"
      )
        await recordCurrentProject();
      return result;
    });
  }
  const checkSender = (
    event: Electron.IpcMainInvokeEvent,
    existing = false,
  ) => {
    if (
      !primaryWindow ||
      event.sender !== primaryWindow.webContents ||
      event.senderFrame !== primaryWindow.webContents.mainFrame ||
      event.senderFrame.url !== entryUrl
    )
      throw Error("ORIGIN_DENIED");
    if (closingCore && !existing) throw Error("PROJECT_CLOSING");
  };
  registerProjectTransferIpc(ipcMain, { checkSender, request });
  registerProjectPackageIpc(ipcMain, {
    checkSender,
    request,
    uploadChunk: async (metadata, bytes) => {
      const owningCore = core;
      const response = await fetch(
        `${baseUrl}/project/package-intakes/${metadata.intakeId}/chunks`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "x-scenesparrow-native": nativeToken,
            "content-type": "application/octet-stream",
            "x-scenesparrow-owner-project-id": metadata.ownerProjectId,
            "x-scenesparrow-chunk-offset": String(metadata.offset),
            "x-scenesparrow-chunk-length": String(metadata.length),
            "x-scenesparrow-chunk-sha256": metadata.hash,
          },
          body: bytes as BodyInit,
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (core !== owningCore) return { ok: false, code: "CAPABILITY_EXPIRED" };
      const data = (await response.json()) as {
        code?: string;
        details?: unknown;
      };
      return response.ok
        ? { ok: true, data }
        : {
            ok: false,
            code: data.code ?? "SERVICE_UNAVAILABLE",
            details: data.details,
          };
    },
  });

  const externalWork = registerExternalWorkIpc(ipcMain, {
    checkSender,
    session: () => ({ core, baseUrl, token }),
    request,
    reveal: async (path) => {
      const error = await shell.openPath(path);
      if (error) throw Error("DOWNLOAD_UNAVAILABLE");
    },
    chooseFile: async () => {
      const result = await dialog.showSaveDialog({
        defaultPath: "creative-member.bin",
      });
      return result.canceled ? null : (result.filePath ?? null);
    },
    fetch,
  });
  const exports = registerExportIpc(ipcMain, {
    checkSender,
    request,
    session: () => ({ core, baseUrl, token }),
    fetch,
    chooseFile: async (job) => {
      const selected = await dialog.showSaveDialog(primaryWindow!, {
        defaultPath: suggestedExportName(
          job.filename.slice(0, -(job.format.length + 1)),
          job.format,
        ),
        filters: [{ name: job.format.toUpperCase(), extensions: [job.format] }],
      });
      return selected.canceled ? null : (selected.filePath ?? null);
    },
    writeClipboard: (text) => clipboard.writeText(text),
  });
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
  ipcMain.handle("reviews:candidate", (event, id: unknown, offset: unknown) => {
    checkSender(event);
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id))
      return { ok: false, code: "INVALID_REQUEST" };
    if (
      offset !== undefined &&
      (!Number.isSafeInteger(offset) || Number(offset) < 0)
    )
      return { ok: false, code: "INVALID_REQUEST" };
    return request(
      `/reviews/candidates/${id}${offset ? `?offset=${offset}` : ""}`,
    );
  });
  ipcMain.handle("reviews:comparison", (event, id: unknown) => {
    checkSender(event);
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id))
      return { ok: false, code: "INVALID_REQUEST" };
    return request(`/reviews/comparisons/${id}`);
  });
  ipcMain.handle("reviews:messages", (event, id: unknown, before: unknown) => {
    checkSender(event);
    if (
      typeof id !== "string" ||
      !/^[0-9a-f-]{36}$/.test(id) ||
      (before !== undefined &&
        (!Number.isSafeInteger(before) || Number(before) < 1))
    )
      return { ok: false, code: "INVALID_REQUEST" };
    return request(
      `/reviews/${id}/messages${before ? `?before=${before}` : ""}`,
    );
  });
  for (const [channel, path, method] of [
    ["manuscript:finalization", "/manuscript/finalization", "GET"],
    ["reviews:read", "/reviews", "GET"],
    ["planning:read", "/planning", "GET"],
    ["planning:prepare", "/planning/preparations", "POST"],
    ["planning:task", "/planning/tasks", "GET"],
    ["planning:visual-prepare", "/planning/visuals", "POST"],
    ["planning:visual", "/planning/visuals", "GET"],
    ["planning:visual-cancel", "/planning/visuals", "DELETE"],
  ] as const) {
    ipcMain.handle(channel, (event, value: unknown) => {
      checkSender(event);
      if (
        ["planning:task", "planning:visual", "planning:visual-cancel"].includes(
          channel,
        )
      ) {
        if (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value))
          return { ok: false, code: "INVALID_REQUEST" };
        return request(`${path}/${value}`, undefined, method);
      }
      if (channel === "reviews:read") {
        if (
          value !== undefined &&
          (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value))
        )
          return { ok: false, code: "INVALID_REQUEST" };
        return request(
          value ? `${path}?after=${encodeURIComponent(value as string)}` : path,
          undefined,
          method,
        );
      }
      return request(path, method === "POST" ? value : undefined, method);
    });
  }
  registerAiIpc(ipcMain, {
    checkSender,
    request,
    session: () => ({ baseUrl, token }),
    fetch,
  });
  const fileSelections = new Map<
    string,
    { abort: AbortController; sender: number }
  >();
  const referenceDirectories = registerReferenceDirectoryIpc(ipcMain, {
    checkSender,
    registry: referenceRegistry,
    projectId: async () => {
      const response = await request("/project");
      if (!response.ok) throw Error(response.code);
      const project = (response.data as unknown as ProjectResponse).project;
      if (!project) throw Error("PROJECT_NOT_FOUND");
      return project.id;
    },
    chooseDirectory: async () => {
      if (!primaryWindow) throw Error("SERVICE_UNAVAILABLE");
      const selected = await dialog.showOpenDialog(primaryWindow, {
        properties: ["openDirectory"],
      });
      return selected.canceled ? null : (selected.filePaths[0] ?? null);
    },
    intakePort: () => directoryIntakePort(baseUrl, token),
  });
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
      return { ok: true as const, data };
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
      event.sender !== primaryWindow?.webContents ||
      event.senderFrame !== primaryWindow?.webContents.mainFrame ||
      event.senderFrame?.url !== entryUrl ||
      typeof nonce !== "string" ||
      !/^[0-9a-f-]{36}$/.test(nonce) ||
      closingCore ||
      subscriptions.size >= 8 ||
      subscriptions.has(nonce)
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
            try {
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
            } finally {
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          } catch {}
          if (!abort.signal.aborted)
            await new Promise<void>((done) => {
              const finish = () => {
                clearTimeout(timer);
                abort.signal.removeEventListener("abort", finish);
                done();
              };
              const timer = setTimeout(finish, 500);
              abort.signal.addEventListener("abort", finish, { once: true });
              if (abort.signal.aborted) finish();
            });
        }
      } finally {
        if (subscriptions.get(nonce) === abort) subscriptions.delete(nonce);
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
    if (
      event.sender === primaryWindow?.webContents &&
      event.senderFrame === primaryWindow?.webContents.mainFrame &&
      event.senderFrame?.url === entryUrl &&
      typeof nonce === "string"
    ) {
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
  let nextProject: string | null = null;
  const close = new CloseHandshake(
    () => {
      if (closingCore) return;
      closingCore = true;
      void (async () => {
        try {
          for (const selection of fileSelections.values())
            selection.abort.abort();
          await referenceDirectories.abortAndSettle();
          externalWork.cancel();
          await exports.settled();
          if (coreIsRunning(core)) {
            const result = await request("/project/quiesce", {});
            if (!result.ok) throw Error("SHUTDOWN_FAILED");
          }
          if (nextProject) {
            switching = true;
            for (const abort of subscriptions.values()) abort.abort();
            subscriptions.clear();
            for (const selection of fileSelections.values())
              selection.abort.abort();
            const previous = projectDirectory,
              candidate = nextProject;
            nextProject = null;
            exports.clear();
            try {
              const result = await activateProject(previous, candidate, {
                stop: stopCore,
                start: async (directory) => {
                  await inspectRememberedProject(directory, inspectProject);
                  projectDirectory = directory;
                  spawnCore("existing");
                  if (!(await waitCoreReady()))
                    throw Error("PROJECT_INTEGRITY_FAILED");
                },
              });
              projectDirectory = result.directory;
              if (result.changed) await recordCurrentProject();
              switching = false;
              closingCore = false;
              window.reload();
              if (!result.changed) {
                const t = app.getLocale().startsWith("zh") ? zhCN : en;
                await dialog.showMessageBox(window, {
                  type: "error",
                  title: t.appName,
                  message: t.projectOpenFailed,
                });
              }
            } catch {
              projectDirectory = previous;
              switching = false;
              throw Error("PROJECT_REOPEN_FAILED");
            }
          } else {
            allowClose = true;
            window.close();
          }
        } catch {
          nextProject = null;
          switching = false;
          closingCore = false;
          await request("/project/resume", {}).catch(() => {});
          window.webContents.send("manuscript:close-aborted");
        }
      })();
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
    15000,
    () => {
      nextProject = null;
    },
  );
  let pickingProject = false;
  async function chooseProject(
    select: () => Promise<string | null>,
    recover = false,
  ) {
    if (pickingProject || closingCore || close.isPending)
      return { ok: false, code: "PROJECT_CLOSING" };
    pickingProject = true;
    try {
      let path = await select();
      if (!path || (!recover && resolve(path) === resolve(projectDirectory)))
        return { ok: true, data: null };
      if (recover) {
        const destination = join(
          dirname(path),
          `recovered-${randomBytes(16).toString("hex")}`,
        );
        await runProjectTool(["--recover-project", path, destination]);
        path = destination;
      }
      await inspectRememberedProject(path, inspectProject);
      if (closingCore || close.isPending)
        return { ok: false, code: "PROJECT_CLOSING" };
      nextProject = path;
      close.request(randomBytes(16).toString("hex"), (nonce) =>
        window.webContents.send("manuscript:close-request", nonce),
      );
      return { ok: true, data: null };
    } catch {
      return { ok: false, code: "PROJECT_INTEGRITY_FAILED" };
    } finally {
      pickingProject = false;
    }
  }
  ipcMain.handle("project:pick", async (event, recover: unknown) => {
    checkSender(event);
    if (recover !== undefined && typeof recover !== "boolean")
      return { ok: false, code: "INVALID_REQUEST" };
    return chooseProject(async () => {
      const selected = await dialog.showOpenDialog(window, {
        properties: ["openDirectory"],
      });
      return selected.canceled ? null : (selected.filePaths[0] ?? null);
    }, recover === true);
  });
  ipcMain.handle("project:recents", (event) => {
    checkSender(event);
    return { ok: true, data: registry.recentProjects() };
  });
  ipcMain.handle("project:open-recent", (event, id: unknown) => {
    checkSender(event);
    let path: string;
    try {
      path = registry.resolveRecent(id);
    } catch (error) {
      return { ok: false, code: (error as Error).message };
    }
    return chooseProject(async () => path);
  });
  ipcMain.handle("project:backup", async (event) => {
    checkSender(event);
    return request("/project/backup", {});
  });
  window.on("closed", () => close.dispose());
  window.on("close", (event) => {
    if (allowClose) return;
    event.preventDefault();
    if (closingCore) return;
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
