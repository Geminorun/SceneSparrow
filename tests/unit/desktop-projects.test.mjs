import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import * as registryModule from "../../apps/desktop/src/project-registry.ts";
import * as activationModule from "../../apps/desktop/src/project-activation.ts";
import * as closeModule from "../../apps/desktop/src/close-handshake.ts";
import * as projectTransferIpcModule from "../../apps/desktop/src/project-transfer-ipc.ts";
import * as externalWorkIpcModule from "../../apps/desktop/src/external-work-ipc.ts";
import * as exportIpcModule from "../../apps/desktop/src/export-ipc.ts";
import * as aiIpcModule from "../../apps/desktop/src/ai-ipc.ts";
import * as exportModule from "../../apps/desktop/src/export-files.ts";
import * as intakeModule from "../../apps/desktop/src/file-intake.ts";
import * as referenceModule from "../../apps/desktop/src/reference-directory.ts";
import * as referenceIpcModule from "../../apps/desktop/src/reference-directory-ipc.ts";

const require = createRequire(import.meta.url);
const source = await readFile(
  new URL("../../apps/desktop/src/main.ts", import.meta.url),
  "utf8",
);
const entryUrl = new URL("../../apps/web/dist/index.html", import.meta.url)
  .href;
const javascript = ts.transpileModule(
  source.replaceAll(
    "import.meta.url",
    JSON.stringify(
      new URL("../../apps/desktop/dist/main.js", import.meta.url).href,
    ),
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  },
).outputText;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "scenesparrow-desktop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const defaultDirectory = join(root, "projects", "default");
  async function project(path) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "project.sqlite"), "healthy fixture");
    return path;
  }
  return { root, defaultDirectory, project };
}

async function desktop(t, fixture, options = {}) {
  const handlers = new Map(),
    sent = [],
    spawns = [],
    modes = [],
    inspections = [],
    prompts = [];
  const metadata = options.metadata ?? new Map();
  const failures = new Set();
  const refused = new Set(options.refused ?? []);
  let active, window, completed;
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: entryUrl },
      send: (...args) => sent.push(args),
      setWindowOpenHandler() {},
    });
    constructor() {
      super();
      window = this;
    }
    async loadFile() {}
    reload() {
      this.reloads = (this.reloads ?? 0) + 1;
    }
    isDestroyed() {
      return false;
    }
    close() {}
  }
  const ipc = Object.assign(new EventEmitter(), {
    handle: (name, handler) => handlers.set(name, handler),
  });
  const app = Object.assign(new EventEmitter(), {
    getPath: () => fixture.root,
    getLocale: () => "en-US",
    requestSingleInstanceLock: () => true,
    quit() {
      this.quits = (this.quits ?? 0) + 1;
    },
    whenReady: () => ({
      then: (callback) => {
        completed = Promise.resolve().then(callback);
        return completed;
      },
    }),
  });
  const electron = {
    app,
    BrowserWindow: Window,
    ipcMain: ipc,
    session: { defaultSession: { setPermissionRequestHandler() {} } },
    dialog: {
      async showMessageBox(...args) {
        prompts.push(args.at(-1));
        return { response: options.choices?.shift() ?? 3 };
      },
      async showOpenDialog() {
        return options.picks?.shift() ?? { canceled: true, filePaths: [] };
      },
    },
    shell: {},
    clipboard: {},
  };
  let registryWrites = 0;
  class Registry extends registryModule.ProjectRegistry {
    constructor(path) {
      super(path, async (...args) => {
        registryWrites++;
        if (options.failRegistry?.()) throw Error("EPERM");
        await registryModule.writeRegistryAtomically(...args);
      });
    }
  }
  const modules = {
    "./reference-directory.js": referenceModule,
    "./reference-directory-ipc.js": referenceIpcModule,
    electron,
    "../../../packages/editor-ui/src/locales/en.json": require("../../packages/editor-ui/src/locales/en.json"),
    "../../../packages/editor-ui/src/locales/zh-CN.json": require("../../packages/editor-ui/src/locales/zh-CN.json"),
    "./project-registry.js": { ...registryModule, ProjectRegistry: Registry },
    "./project-activation.js": activationModule,
    "./close-handshake.js": closeModule,
    "./export-ipc.js": exportIpcModule,
    "./external-work-ipc.js": externalWorkIpcModule,
    "./project-transfer-ipc.js": projectTransferIpcModule,
    "./ai-ipc.js": aiIpcModule,
    "./export-files.js": exportModule,
    "./file-intake.js": intakeModule,
    "./core-process.js": {
      coreIsRunning: (child) => child?.running === true,
      stopCoreProcess: async (child) => {
        if (child) child.running = false;
      },
    },
    "node:child_process": {
      spawn(_binary, args, config) {
        const child = new EventEmitter();
        if (args.length) {
          inspections.push(args);
          queueMicrotask(() => {
            const path = args[1];
            if (args[0] === "--recover-project") {
              cpSync(path, args[2], {
                recursive: true,
                errorOnExist: true,
                force: false,
              });
              metadata.set(args[2], metadata.get(path) ?? null);
              child.emit("exit", 0);
              return;
            }
            const valid =
              !refused.has(path) &&
              existsSync(path) &&
              (existsSync(join(path, "project.sqlite"))
                ? readFileSync(join(path, "project.sqlite"), "utf8") !==
                  "corrupt"
                : readdirSync(path).length === 0);
            child.emit("exit", valid ? 0 : 1);
          });
        } else {
          active = child;
          child.directory = config.env.SCENESPARROW_PROJECT_DIR;
          child.running = !failures.has(child.directory);
          modes.push(config.env.SCENESPARROW_PROJECT_OPEN_MODE);
          if (
            child.running &&
            !existsSync(join(child.directory, "project.sqlite"))
          )
            writeFileSync(
              join(child.directory, "project.sqlite"),
              "healthy fixture",
            );
          spawns.push(child.directory);
        }
        return child;
      },
    },
  };
  runInNewContext(javascript, {
    exports: {},
    require: (name) => modules[name] ?? require(name),
    process: { env: { SCENESPARROW_CORE_BIN: "fixture-core", ...options.env } },
    console,
    setTimeout,
    clearTimeout,
    AbortSignal,
    fetch: async (url, config) => {
      const path = new URL(url).pathname.slice(3);
      let data = {};
      if (path === "/project/ensure" || path === "/project/rename") {
        const command = JSON.parse(config.body);
        data = { project: { id: "core-project", title: command.title } };
        metadata.set(active.directory, data.project);
      } else if (path === "/project")
        data = { project: metadata.get(active.directory) ?? null };
      return { ok: true, json: async () => data };
    },
  });
  await completed;
  t.after(() => {
    window?.emit("closed");
  });
  const event = () => ({
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  });
  const call = (name, ...args) => handlers.get(name)(event(), ...args);
  const saved = async () =>
    JSON.parse(
      await readFile(join(fixture.root, "project-registry.json"), "utf8"),
    );
  return {
    call,
    event,
    handlers,
    sent,
    spawns,
    modes,
    inspections,
    failures,
    refused,
    prompts,
    window,
    app,
    metadata,
    saved,
    get registryWrites() {
      return registryWrites;
    },
    reply: () => {
      const request = sent.findLast(
        (args) => args[0] === "manuscript:close-request",
      );
      ipc.emit("manuscript:close-result", event(), request[1], true);
    },
  };
}
async function settled(predicate) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("desktop operation did not settle");
}

test("desktop first run opens default and ensure/rename update persisted identity without exposing locators", async (t) => {
  const fixtureData = await fixture(t);
  const host = await desktop(t, fixtureData);
  assert.deepEqual(host.spawns, [fixtureData.defaultDirectory]);
  assert.deepEqual(host.modes, ["create"]);
  assert.equal((await host.saved()).entries[0].title, null);
  await host.call("project:ensure", { title: "Untitled" });
  const first = await host.call("project:recents");
  assert.deepEqual(Object.keys(first.data[0]), ["id", "title"]);
  await host.call("project:rename", { title: "幕雀 🌱" });
  const next = await host.call("project:recents");
  assert.equal(next.data[0].id, first.data[0].id);
  assert.equal(next.data[0].title, "幕雀 🌱");
  const saved = await host.saved();
  assert.equal(saved.entries[0].projectId, "core-project");
  assert.equal(saved.entries[0].title, "幕雀 🌱");
  assert.equal(host.prompts.length, 0);
  assert.throws(
    () =>
      host.handlers.get("project:recents")({
        sender: {},
        senderFrame: host.event().senderFrame,
      }),
    /ORIGIN_DENIED/,
  );
  assert.throws(
    () =>
      host.handlers.get("project:open-recent")(
        { sender: host.event().sender, senderFrame: { url: entryUrl } },
        next.data[0].id,
      ),
    /ORIGIN_DENIED/,
  );
  assert.equal(
    (await host.call("project:open-recent", fixtureData.defaultDirectory)).code,
    "INVALID_REQUEST",
  );
});

test("desktop restores last selection, gates recent switches on close, and records only successful candidate activation", async (t) => {
  const fixtureData = await fixture(t);
  const old = await fixtureData.project(join(fixtureData.root, "old"));
  const candidate = await fixtureData.project(
    join(fixtureData.root, "candidate"),
  );
  const registry = new registryModule.ProjectRegistry(
    join(fixtureData.root, "project-registry.json"),
  );
  await registry.record(candidate, { id: "same-core-id", title: "Candidate" });
  await registry.record(old, { id: "same-core-id", title: "Old" });
  const metadata = new Map([
    [old, { id: "same-core-id", title: "Old" }],
    [candidate, { id: "same-core-id", title: "Candidate" }],
  ]);
  const host = await desktop(t, fixtureData, { metadata });
  assert.deepEqual(host.spawns, [old]);
  const recent = (await host.call("project:recents")).data.find(
    (entry) => entry.title === "Candidate",
  );
  const before = await readFile(registry.path, "utf8");
  assert.equal((await host.call("project:open-recent", recent.id)).ok, true);
  assert.equal((await host.call("project:pick")).code, "PROJECT_CLOSING");
  assert.equal(
    (await host.call("project:open-recent", recent.id)).code,
    "PROJECT_CLOSING",
  );
  assert.equal(await readFile(registry.path, "utf8"), before);
  host.failures.add(candidate);
  host.reply();
  await settled(() => host.window.reloads === 1);
  assert.deepEqual(host.spawns, [old, candidate, old]);
  assert.deepEqual(host.modes, ["existing", "existing", "existing"]);
  assert.equal(await readFile(registry.path, "utf8"), before);
  host.failures.clear();
  await host.call("project:open-recent", recent.id);
  host.reply();
  await settled(() => host.window.reloads === 2);
  assert.equal((await host.saved()).entries[0].directory, candidate);
  assert.equal((await host.saved()).lastId, recent.id);
});

test("missing remembered directory and corrupt registry prompt before spawn and cancel preserves originals", async (t) => {
  for (const mode of ["missing", "corrupt"]) {
    const fixtureData = await fixture(t);
    const path = join(fixtureData.root, "project-registry.json");
    if (mode === "missing") {
      const registry = new registryModule.ProjectRegistry(path);
      await registry.record(join(fixtureData.root, "gone"), {
        id: "missing",
        title: "Missing",
      });
    } else await writeFile(path, "{invalid");
    const before = await readFile(path, "utf8");
    const host = await desktop(t, fixtureData, { choices: [3] });
    assert.deepEqual(host.spawns, []);
    assert.equal(host.prompts.length, 1);
    assert.equal(host.prompts[0].buttons.length, 4);
    assert.equal(host.app.quits, 1);
    assert.equal(await readFile(path, "utf8"), before);
    assert.equal(existsSync(fixtureData.defaultDirectory), false);
  }
});

test("explicit default choice and env override activate only their selected directory", async (t) => {
  const fixtureData = await fixture(t);
  await writeFile(join(fixtureData.root, "project-registry.json"), "{invalid");
  const host = await desktop(t, fixtureData, { choices: [2] });
  assert.deepEqual(host.spawns, [fixtureData.defaultDirectory]);
  assert.equal(
    (await host.saved()).entries[0].directory,
    fixtureData.defaultDirectory,
  );
  assert.equal(
    (await readdir(fixtureData.root)).filter((name) =>
      name.includes(".corrupt-"),
    ).length,
    1,
  );
  const override = await fixtureData.project(
    join(fixtureData.root, "override"),
  );
  const second = await desktop(t, fixtureData, {
    env: { SCENESPARROW_PROJECT_DIR: override },
  });
  assert.deepEqual(second.spawns, [override]);
  assert.deepEqual(second.modes, ["existing"]);
  assert.equal(second.prompts.length, 0);
});

test("registry write failure cannot falsify acknowledged mutation and warning is deduped until recovery", async (t) => {
  const fixtureData = await fixture(t);
  let fail = true;
  const host = await desktop(t, fixtureData, { failRegistry: () => fail });
  assert.equal(host.prompts.length, 1);
  assert.equal(
    (await host.call("project:ensure", { title: "Durable" })).ok,
    true,
  );
  assert.equal(
    (await host.call("project:rename", { title: "Renamed" })).ok,
    true,
  );
  await host.call("project:read");
  assert.equal(host.prompts.length, 1);
  fail = false;
  await host.call("project:read");
  assert.equal((await host.saved()).entries[0].title, "Renamed");
  fail = true;
  assert.equal(
    (await host.call("project:rename", { title: "Still durable" })).ok,
    true,
  );
  assert.equal(host.prompts.length, 2);
  assert.equal(
    host.metadata.get(fixtureData.defaultDirectory).title,
    "Still durable",
  );
  assert.equal((await host.saved()).entries[0].title, "Renamed");
});

test("startup inspection refusal preserves the corrupt/owned original and explicit recovery opens a separate copy", async (t) => {
  const fixtureData = await fixture(t);
  const old = await fixtureData.project(join(fixtureData.root, "old"));
  const backup = await fixtureData.project(
    join(fixtureData.root, "verified-backup"),
  );
  await writeFile(join(old, "project.sqlite"), "corrupt");
  const registry = new registryModule.ProjectRegistry(
    join(fixtureData.root, "project-registry.json"),
  );
  await registry.record(old, { id: "core-project", title: "Original" });
  const host = await desktop(t, fixtureData, {
    choices: [1],
    picks: [{ canceled: false, filePaths: [backup] }],
    metadata: new Map([[backup, { id: "core-project", title: "Recovered" }]]),
  });
  assert.equal(host.prompts.length, 1);
  assert.equal(host.spawns.length, 1);
  assert.deepEqual(host.modes, ["existing"]);
  assert.match(host.spawns[0], /recovered-[0-9a-f]{32}$/);
  assert.notEqual(host.spawns[0], old);
  assert.equal(await readFile(join(old, "project.sqlite"), "utf8"), "corrupt");
  const data = await host.saved();
  assert.equal(data.entries[0].title, "Recovered");
  assert.equal(data.entries[1].directory, old);
  assert.notEqual(data.entries[0].id, data.entries[1].id);
});

test("a pending native picker excludes recent switches and cancellation preserves registry", async (t) => {
  const fixtureData = await fixture(t);
  let finish;
  const selected = new Promise((resolve) => {
    finish = resolve;
  });
  const host = await desktop(t, fixtureData, { picks: [selected] });
  await host.call("project:ensure", { title: "Active" });
  const id = (await host.call("project:recents")).data[0].id;
  const before = await host.saved();
  const picking = host.call("project:pick");
  assert.equal(
    (await host.call("project:open-recent", id)).code,
    "PROJECT_CLOSING",
  );
  assert.equal((await host.call("project:pick")).code, "PROJECT_CLOSING");
  finish({ canceled: true, filePaths: [] });
  assert.equal((await picking).ok, true);
  assert.deepEqual(await host.saved(), before);
  assert.equal(host.sent.length, 0);
  assert.equal(
    (await host.call("project:pick", "arbitrary")).code,
    "INVALID_REQUEST",
  );
});

test("recent missing/corrupt/owned preflight fails before close and preserves acknowledged current selection", async (t) => {
  const fixtureData = await fixture(t);
  const old = await fixtureData.project(join(fixtureData.root, "old"));
  const candidate = await fixtureData.project(
    join(fixtureData.root, "candidate"),
  );
  const registry = new registryModule.ProjectRegistry(
    join(fixtureData.root, "project-registry.json"),
  );
  await registry.record(candidate, { id: "candidate", title: "Candidate" });
  await registry.record(old, { id: "old", title: "Old" });
  const host = await desktop(t, fixtureData, {
    metadata: new Map([[old, { id: "old", title: "Old" }]]),
  });
  const id = (await host.call("project:recents")).data.find(
    (entry) => entry.title === "Candidate",
  ).id;
  const before = await readFile(registry.path, "utf8");
  host.refused.add(candidate);
  assert.equal(
    (await host.call("project:open-recent", id)).code,
    "PROJECT_INTEGRITY_FAILED",
  );
  host.refused.clear();
  await writeFile(join(candidate, "project.sqlite"), "corrupt");
  assert.equal(
    (await host.call("project:open-recent", id)).code,
    "PROJECT_INTEGRITY_FAILED",
  );
  await rm(candidate, { recursive: true });
  assert.equal(
    (await host.call("project:open-recent", id)).code,
    "PROJECT_INTEGRITY_FAILED",
  );
  assert.equal(await readFile(registry.path, "utf8"), before);
  assert.deepEqual(host.spawns, [old]);
  assert.deepEqual(host.sent, []);
  assert.equal(existsSync(candidate), false);
});

test("an owned remembered project is never spawned, and cancelled native selection preserves it", async (t) => {
  const fixtureData = await fixture(t);
  const old = await fixtureData.project(join(fixtureData.root, "owned"));
  const registry = new registryModule.ProjectRegistry(
    join(fixtureData.root, "project-registry.json"),
  );
  await registry.record(old, { id: "old", title: "Owned" });
  const before = await readFile(registry.path, "utf8");
  const host = await desktop(t, fixtureData, {
    refused: [old],
    choices: [0, 3],
    picks: [{ canceled: true, filePaths: [] }],
  });
  assert.deepEqual(host.spawns, []);
  assert.equal(host.prompts.length, 2);
  assert.equal(await readFile(registry.path, "utf8"), before);
  assert.equal(
    await readFile(join(old, "project.sqlite"), "utf8"),
    "healthy fixture",
  );
});

test("empty first-run default/override folders initialize once then reopen with existing mode", async (t) => {
  for (const override of [false, true]) {
    const fixtureData = await fixture(t);
    const directory = override
      ? join(fixtureData.root, "empty-override")
      : fixtureData.defaultDirectory;
    await mkdir(directory, { recursive: true });
    const env = override ? { SCENESPARROW_PROJECT_DIR: directory } : {};
    const first = await desktop(t, fixtureData, { env });
    assert.deepEqual(first.spawns, [directory]);
    assert.deepEqual(first.modes, ["create"]);
    assert.equal(first.prompts.length, 0);
    const second = await desktop(t, fixtureData, { env });
    assert.deepEqual(second.spawns, [directory]);
    assert.deepEqual(second.modes, ["existing"]);
    assert.equal(second.prompts.length, 0);
  }
});
