import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { readFile } from "node:fs/promises";
import { CloseHandshake } from "../../apps/desktop/src/close-handshake.ts";
import {
  createDesktopClient,
  ApiError,
} from "../../packages/platform-client/src/index.ts";
test("desktop close rejects stale replies, cancels safely, and offers an unresponsive decision", async () => {
  let accepted = 0;
  let prompts = 0;
  const sent = [];
  const close = new CloseHandshake(
    () => accepted++,
    async () => {
      prompts++;
      return false;
    },
    10,
  );
  close.request("a", (v) => sent.push(v));
  close.request("b", (v) => sent.push(v));
  assert.deepEqual(sent, ["a"]);
  close.reply("wrong", true);
  assert.equal(accepted, 0);
  close.reply("a", false);
  close.request("b", (v) => sent.push(v));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(prompts, 1);
  assert.equal(accepted, 0);
  close.request("c", (v) => sent.push(v));
  close.reply("b", true);
  assert.equal(accepted, 0);
  close.reply("c", true);
  assert.equal(accepted, 1);
  close.dispose();
});
test("desktop errors keep stable API classification and bridge exposes scoped methods", async () => {
  const client = createDesktopClient({
    executeManuscript: async () => ({ ok: false, code: "REVISION_CONFLICT" }),
  });
  await assert.rejects(
    client.executeManuscript({}),
    (e) => e instanceof ApiError && e.code === "REVISION_CONFLICT",
  );
  const main = await readFile(
    new URL("../../apps/desktop/src/main.ts", import.meta.url),
    "utf8",
  );
  const preload = await readFile(
    new URL("../../apps/desktop/src/preload.cts", import.meta.url),
    "utf8",
  );
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /event\.senderFrame\?\.url !== entryUrl/);
  for (const unsafe of ["readFile:", "fetch:", "request:", "ipcRenderer:"])
    assert.ok(!preload.includes(unsafe));
  assert.match(preload, /let closeHandler/);
  assert.match(preload, /remove|closeHandler\s*===\s*handler/);
});

test("preload close registration has a safe default, scoped IPC and cleanup without an Electron host", async () => {
  const source = await readFile(
    new URL("../../apps/desktop/src/preload.cts", import.meta.url),
    "utf8",
  );
  const listeners = new Map();
  const calls = [];
  let exposed;
  const ipc = {
    on: (name, callback) => listeners.set(name, callback),
    send: (...args) => calls.push(args),
    invoke: async (...args) => {
      calls.push(args);
      return { ok: true, data: {} };
    },
  };
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  runInNewContext(javascript, {
    exports: {},
    require: (name) => {
      assert.equal(name, "electron");
      return {
        contextBridge: {
          exposeInMainWorld: (_name, value) => {
            exposed = value;
          },
        },
        ipcRenderer: ipc,
      };
    },
  });
  assert.deepEqual(
    Object.keys(exposed).sort(),
    [
      "readAiSettings",
      "updateAiSettings",
      "updateAiCredential",
      "deleteAiCredential",
      "resolveAiConfiguration",
      "discoverAiModels",
      "prepareAiTest",
      "testAiConnection",
      "readAiRun",
      "readAiResult",
      "cancelAiRun",
      "readSources",
      "readPlanning",
      "preparePlanning",
      "planningTask",
      "preparePlanningVisual",
      "planningVisual",
      "cancelPlanningVisual",
      "pickFileIntake",
      "cancelFileSelection",
      "onFileIntakeProgress",
      "cancelIntake",
      "documentAction",
      "documentJob",
      "extractionPage",
      "openExternalLink",
      "subscribeEvents",
      "commandReceipt",
      "createProject",
      "executeManuscript",
      "health",
      "onCloseRequested",
      "readHistory",
      "readManuscript",
      "readProject",
    ].sort(),
  );
  await exposed.prepareAiTest({
    providerId: "fixture",
    modelId: "manual",
    tokenField: "max_tokens",
  });
  assert.deepEqual(calls.pop(), [
    "ai:test-prepare",
    { providerId: "fixture", modelId: "manual", tokenField: "max_tokens" },
  ]);
  await exposed.preparePlanning({ operation: "generate_outline" });
  assert.deepEqual(calls.pop(), [
    "planning:prepare",
    { operation: "generate_outline" },
  ]);
  await exposed.planningTask("task-id");
  assert.deepEqual(calls.pop(), ["planning:task", "task-id"]);
  await exposed.readAiSettings();
  assert.deepEqual(calls.pop(), ["ai:settings-read"]);
  await exposed.readHistory();
  assert.deepEqual(calls.pop(), ["manuscript:history"]);
  await exposed.commandReceipt("request-id");
  assert.deepEqual(calls.pop(), ["manuscript:receipt", "request-id"]);
  await listeners.get("manuscript:close-request")({}, "initial");
  assert.deepEqual(calls.pop(), ["manuscript:close-result", "initial", true]);
  const cleanupOld = exposed.onCloseRequested(async () => true);
  const cleanupCurrent = exposed.onCloseRequested(async () => false);
  cleanupOld();
  await listeners.get("manuscript:close-request")({}, "cancel");
  assert.deepEqual(calls.pop(), ["manuscript:close-result", "cancel", false]);
  cleanupCurrent();
  await listeners.get("manuscript:close-request")({}, "after-cleanup");
  assert.deepEqual(calls.pop(), [
    "manuscript:close-result",
    "after-cleanup",
    true,
  ]);
});
