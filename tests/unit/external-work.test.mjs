import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectSession } from "../../packages/editor-ui/src/project-session/project-session.ts";
import { ApplicationPreferencesStore } from "../../packages/editor-ui/src/app-preferences.ts";
import {
  ApiError,
  createHttpClient,
  createDesktopClient,
} from "../../packages/platform-client/src/index.ts";
import { registerExternalWorkIpc } from "../../apps/desktop/src/external-work-ipc.ts";
const gate = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
const turn = () => new Promise((done) => setTimeout(done, 0));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function sessionFixture() {
  let state = {
    manuscriptId: randomUUID(),
    schemaVersion: 1,
    workspaceStage: "draft",
    blocks: [],
    workingRevision: 1,
  };
  let snapshot = {
    projectId: randomUUID(),
    workingRevision: 1,
    generation: 1,
    acceptedHash: "a".repeat(64),
    source: "Accepted\r\n",
    bindings: [],
    semanticBlockIds: [],
    externalStatus: "unchanged",
    externalHash: null,
  };
  let history = {
    workingRevision: 1,
    historyRevision: 0,
    cursor: 0,
    undoCount: 0,
    redoCount: 0,
    undoLabel: null,
    redoLabel: null,
  };
  const prefs = new ApplicationPreferencesStore(null);
  prefs.update({ saveMode: "off" });
  const calls = [];
  const receipts = new Map();
  let heldRead = null;
  const client = {
    readAuthoredSource: async () => {
      await heldRead?.promise;
      return structuredClone(snapshot);
    },
    readManuscript: async () => structuredClone(state),
    readHistory: async () => structuredClone(history),
    commandReceipt: async (id) => {
      if (!receipts.has(id)) throw new ApiError("COMMAND_NOT_FOUND");
      return receipts.get(id);
    },
    readManuscriptIdentity: async () => ({
      bodyHash: "body",
      workingRevision: state.workingRevision,
    }),
    saveAuthoredSource: async (body) => {
      calls.push(body);
      snapshot = {
        ...snapshot,
        source: body.source,
        generation: snapshot.generation + 1,
        workingRevision: state.workingRevision + 1,
      };
      state = { ...state, workingRevision: snapshot.workingRevision };
      history = {
        ...history,
        workingRevision: state.workingRevision,
        historyRevision: history.historyRevision + 1,
      };
      const receipt = {
        requestId: body.requestId,
        ...history,
        blockRevisions: [],
        eventSequence: 1,
        normalized: false,
      };
      receipts.set(body.requestId, receipt);
      return { receipt, snapshot };
    },
    executeManuscript: async (body) => ({
      requestId: body.requestId,
      ...history,
      blockRevisions: [],
      eventSequence: 1,
      normalized: false,
    }),
  };
  const save = new ProjectSession(
    state,
    snapshot.projectId,
    client,
    () => {},
    history,
    prefs,
  );
  save.initializeSource(snapshot);
  return {
    save,
    client,
    calls,
    prefs,
    holdRead() {
      heldRead = gate();
      return heldRead;
    },
    commit(request, acceptedSource) {
      state = { ...state, workingRevision: state.workingRevision + 1 };
      snapshot = {
        ...snapshot,
        workingRevision: state.workingRevision,
        generation: snapshot.generation + 1,
        ...(acceptedSource === undefined
          ? {}
          : { source: acceptedSource, acceptedHash: hash(acceptedSource) }),
      };
      history = {
        ...history,
        workingRevision: state.workingRevision,
        historyRevision: history.historyRevision + 1,
        cursor: history.cursor + 1,
        undoCount: history.undoCount + 1,
      };
      const receipt = {
        requestId: request.requestId,
        ...history,
        blockRevisions: [],
        eventSequence: 2,
        normalized: false,
      };
      receipts.set(request.requestId, receipt);
      return receipt;
    },
  };
}
test("registered rename settles captured source then held readback preserves newer IME input and original receipt", async () => {
  const f = sessionFixture();
  const { save } = f;
  let sends = 0;
  const dto = { requestId: randomUUID(), title: "New name" };
  try {
    save.updateSource([{ from: 0, to: 8, insert: "Captured" }]);
    const held = f.holdRead();
    // Source save returns its own snapshot; only registered rename's readback waits.
    const action = save.projectAction(
      "rename",
      async (revision) => ({
        requestId: dto.requestId,
        send: async () => {
          sends++;
          const receipt = f.commit(dto);
          return {
            receipt,
            project: {
              title: dto.title,
              workingRevision: receipt.workingRevision,
            },
          };
        },
      }),
      true,
    );
    await turn();
    assert.equal(sends, 1);
    assert.equal(f.calls.length, 1);
    save.composition(true);
    save.updateSource([{ from: 8, to: 8, insert: " 中文" }]);
    const identity = save.visibleInputIdentity;
    held.resolve();
    await action;
    assert.equal(save.sourceLocal, "Captured 中文\r\n");
    assert.equal(save.visibleInputIdentity, identity);
    assert.equal(save.hasExternalRecovery, false);
    assert.equal(save.businessReceipt.requestId, dto.requestId);
    assert.equal(save.history.undoCount, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(sends, 1);
    assert.equal(save.status, "pending");
    save.composition(false);
  } finally {
    save.dispose();
  }
});
test("lost registered rename readback keeps exact original action and retries receipt without replacing newer input", async () => {
  const f = sessionFixture();
  const { save } = f;
  let sends = 0,
    fail = true;
  const original = f.client.readAuthoredSource;
  f.client.readAuthoredSource = async () => {
    if (fail) throw Error("readback lost");
    return original();
  };
  const request = { requestId: randomUUID(), title: "Name" };
  try {
    const execute = () =>
      save.projectAction(
        "rename",
        async () => ({
          requestId: request.requestId,
          send: async () => {
            sends++;
            const receipt = f.commit(request);
            return { receipt };
          },
        }),
        true,
      );
    await assert.rejects(execute(), /readback lost/);
    assert.equal(save.hasExternalRecovery, true);
    save.updateSource([{ from: 8, to: 8, insert: " later" }]);
    fail = false;
    await save.retryProjectAction();
    assert.equal(sends, 1);
    assert.equal(save.sourceLocal, "Accepted later\r\n");
    assert.equal(save.hasExternalRecovery, false);
    assert.equal(save.businessReceipt.requestId, request.requestId);
    assert.equal(f.calls.length, 0);
  } finally {
    save.dispose();
  }
});
test("project action held prerequisite never dispatches a newer source buffer or retargets its intent", async () => {
  const f = sessionFixture();
  const { save } = f;
  const held = gate();
  let sends = 0;
  try {
    const task = save.projectAction("create", async () => {
      await held.promise;
      return {
        requestId: randomUUID(),
        send: async () => {
          sends++;
          return {};
        },
      };
    });
    await turn();
    save.updateSource([{ from: 8, to: 8, insert: " later" }]);
    held.resolve();
    assert.equal(await task, null);
    assert.equal(sends, 0);
    assert.equal(f.calls.length, 0);
    assert.equal(save.sourceLocal, "Accepted later\r\n");
  } finally {
    save.dispose();
  }
});
test("named external work adapters preserve full action and bounded page cursors", async () => {
  const old = globalThis.fetch,
    calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([url, init]);
    return Response.json({ records: [], continuation: null });
  };
  const body = {
    requestId: randomUUID(),
    workItemId: randomUUID(),
    candidateId: randomUUID(),
    candidateDigest: "a".repeat(64),
    expectedItemRevision: 2,
    expectedGraphHash: "b".repeat(64),
  };
  try {
    const http = createHttpClient("/api");
    await http.acceptWorkCandidate(body);
    assert.deepEqual(JSON.parse(calls[0][1].body), body);
    await http.readWorkChanges(body.workItemId, body.candidateId, "opaque:100");
    assert.match(calls[1][0], /cursor=opaque%3A100/);
  } finally {
    globalThis.fetch = old;
  }
  const desktop = createDesktopClient({
    acceptWorkCandidate: async (sent) => ({ ok: true, data: sent }),
  });
  assert.equal(await desktop.acceptWorkCandidate(body), body);
  assert.equal(createDesktopClient({}).revealWorkItem, undefined);
});
function ipcFixture(overrides = {}) {
  const handlers = new Map();
  let session = { core: {}, baseUrl: "http://127.0.0.1/v1", token: "token" };
  const event = {};
  const calls = [];
  const lifecycle = registerExternalWorkIpc(
    { handle: (name, handler) => handlers.set(name, handler) },
    {
      checkSender: (actual) => {
        if (actual !== event) throw Error("ORIGIN_DENIED");
      },
      session: () => session,
      request: async (...args) => {
        calls.push(args);
        return { ok: true, data: "/private/registered/copy" };
      },
      fetch: async () =>
        new Response(new Uint8Array([1]), {
          headers: {
            "x-scenesparrow-content-sha256": hash(new Uint8Array([1])),
          },
        }),
      chooseFile: async () => null,
      reveal: async (path) => calls.push(path),
      ...overrides,
    },
  );
  return {
    handlers,
    calls,
    lifecycle,
    call: (name, ...args) =>
      handlers.get("external-work:" + name)(event, ...args),
    switch() {
      session = { ...session, core: {} };
    },
  };
}
test("native reveal validates item IDs and sender/session before and after await without returning paths", async () => {
  const held = gate();
  const f = ipcFixture({
    request: async () => {
      await held.promise;
      return { ok: true, data: "/private/copy" };
    },
  });
  const task = f.call("revealWorkItem", randomUUID());
  f.switch();
  held.resolve();
  assert.equal((await task).code, "CAPABILITY_EXPIRED");
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await f.call("revealWorkItem", "../../escape")).code,
    "INVALID_REQUEST",
  );
  const normal = ipcFixture();
  assert.deepEqual(await normal.call("revealWorkItem", randomUUID()), {
    ok: true,
    data: true,
  });
  assert(
    !JSON.stringify(await normal.call("revealWorkItem", randomUUID())).includes(
      "private",
    ),
  );
});
test("native member dialog cancellation/session expiry aborts authenticated stream; accepted bytes stream to fresh destination", async () => {
  const bytes = new Uint8Array(2 * 1024 * 1024 + 7).fill(137),
    directory = await mkdtemp(join(tmpdir(), "scenesparrow-member-"));
  let cancelled = 0;
  try {
    const f = ipcFixture({
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }),
          { headers: { "x-scenesparrow-content-sha256": hash(bytes) } },
        ),
    });
    assert.deepEqual(
      await f.call(
        "downloadGraphRecoveryMember",
        "a".repeat(64),
        "b".repeat(64),
      ),
      { ok: true, data: false },
    );
    assert.equal(cancelled, 1);
    const held = gate();
    const expired = ipcFixture({
      chooseFile: async () => {
        await held.promise;
        return join(directory, "expired.bin");
      },
    });
    const task = expired.call(
      "downloadGraphRecoveryMember",
      "a".repeat(64),
      "b".repeat(64),
    );
    await turn();
    expired.switch();
    held.resolve();
    assert.equal((await task).code, "CAPABILITY_EXPIRED");
    const native = ipcFixture({
      fetch: async () =>
        new Response(bytes, {
          headers: { "x-scenesparrow-content-sha256": hash(bytes) },
        }),
      chooseFile: async () => join(directory, "member.bin"),
    });
    assert.deepEqual(
      await native.call(
        "downloadGraphRecoveryMember",
        "a".repeat(64),
        "b".repeat(64),
      ),
      { ok: true, data: true },
    );
    assert.deepEqual(
      new Uint8Array(await readFile(join(directory, "member.bin"))),
      bytes,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("actual preload exposes only named external-work channels and forwards the original DTO", async () => {
  const vm = await import("node:vm");
  const { default: ts } = await import("typescript");
  const source = await readFile(
      new URL("../../apps/desktop/src/preload.cts", import.meta.url),
      "utf8",
    ),
    calls = [];
  let exposed;
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(code, {
    exports: {},
    require: (name) => {
      assert.equal(name, "electron");
      return {
        contextBridge: {
          exposeInMainWorld: (name, bridge) => {
            assert.equal(name, "sceneSparrow");
            exposed = bridge;
          },
        },
        ipcRenderer: {
          on() {},
          send() {},
          invoke: async (...args) => {
            calls.push(args);
            return { ok: true, data: {} };
          },
        },
      };
    },
  });
  const body = {
    requestId: randomUUID(),
    workItemId: randomUUID(),
    candidateDigest: "a".repeat(64),
  };
  await exposed.acceptWorkCandidate(body);
  assert.equal(calls[0][0], "external-work:acceptWorkCandidate");
  assert.equal(calls[0][1], body);
  assert.equal(exposed.invoke, undefined);
  assert.equal(exposed.request, undefined);
  assert.equal(exposed.readFile, undefined);
  assert.equal(exposed.execute, undefined);
  await exposed.revealWorkItem(body.workItemId);
  assert.deepEqual(calls[1], ["external-work:revealWorkItem", body.workItemId]);
});

test("a proven lost mutation response retries only readback with the original receipt", async () => {
  const f = sessionFixture(),
    request = { requestId: randomUUID() };
  let sends = 0,
    reads = 0;
  try {
    await assert.rejects(
      f.save.projectAction(
        "accept",
        async () => ({
          requestId: request.requestId,
          send: async () => {
            sends++;
            f.commit(request);
            throw Error("lost mutation response");
          },
          readback: async (receipt) => {
            reads++;
            return { receipt };
          },
        }),
        true,
      ),
      /lost mutation response/,
    );
    f.save.updateSource([{ from: 8, to: 8, insert: " newer" }]);
    await f.save.retryProjectAction();
    assert.equal(sends, 1);
    assert.equal(reads, 1);
    assert.equal(f.save.sourceLocal, "Accepted newer\r\n");
    assert.equal(f.save.businessReceipt.requestId, request.requestId);
    assert.equal(f.calls.length, 0);
  } finally {
    f.save.dispose();
  }
});
test("operational cancellation remains available during IME without settling manuscript input", async () => {
  const f = sessionFixture();
  let sends = 0;
  try {
    f.save.composition(true);
    f.save.updateSource([{ from: 8, to: 8, insert: " composing" }]);
    const result = await f.save.projectAction(
      "cancel",
      async () => ({
        requestId: randomUUID(),
        send: async () => {
          sends++;
          return { cancelled: true };
        },
      }),
      false,
      false,
    );
    assert.deepEqual(result, { cancelled: true });
    assert.equal(sends, 1);
    assert.equal(f.calls.length, 0);
    assert.equal(f.save.composing, true);
    assert.equal(f.save.sourceLocal, "Accepted composing\r\n");
  } finally {
    f.save.dispose();
  }
});

test("verified pre-registration metadata readback updates display without an ordinary graph receipt", async () => {
  const f = sessionFixture();
  let displayed = null,
    lookups = 0;
  f.client.commandReceipt = async () => {
    lookups++;
    throw new ApiError("COMMAND_NOT_FOUND");
  };
  f.save.onProjectMetadata = (project) => (displayed = project);
  try {
    const project = {
      id: f.save.source.projectId,
      title: "Untitled project",
      workingRevision: 1,
      approvedBaseline: null,
    };
    f.client.readProject = async () => ({ project });
    const result = await f.save.projectAction("graph-name", async () => ({
      requestId: randomUUID(),
      send: async () => ({ project }),
    }));
    assert.equal(result.project, project);
    assert.equal(displayed, project);
    assert.equal(lookups, 0);
    assert.equal(f.save.state.workingRevision, 1);
  } finally {
    f.save.dispose();
  }
});

test("lost v3 preserve acknowledgement keeps its original captured graph fingerprint and decision DTO", async () => {
  const f = sessionFixture(),
    calls = [];
  let lost = true;
  const status = {
    projectId: f.save.source.projectId,
    generation: 1,
    acceptedHash: "a".repeat(64),
    externalStatus: "unchanged",
    externalHash: null,
    candidateId: null,
    pendingIntent: {
      intentHash: "b".repeat(64),
      requestId: randomUUID(),
      version: 3,
    },
    observationFingerprint: "c".repeat(64),
    watchMode: "polling",
  };
  f.save.sourceStatus = status;
  f.client.recoverAuthoredSource = async (body) => {
    calls.push(structuredClone(body));
    if (lost) throw Error("lost recovery acknowledgement");
    return { ...status, pendingIntent: null };
  };
  try {
    assert.equal(await f.save.recoverSource(status, true), false);
    assert.equal(f.save.hasPendingSourceRecovery, true);
    assert.equal(await f.save.controlledClose(), false);
    lost = false;
    assert.equal(
      await f.save.recoverSource(
        { ...status, observationFingerprint: "d".repeat(64) },
        true,
      ),
      true,
    );
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(calls[1].observationFingerprint, "c".repeat(64));
    assert.equal(f.save.hasPendingSourceRecovery, false);
  } finally {
    f.save.dispose();
  }
});

test("a definite known-recovery refusal permits a new explicit preserve decision", async () => {
  const f = sessionFixture(),
    calls = [];
  const status = {
    projectId: f.save.source.projectId,
    generation: 1,
    acceptedHash: "a".repeat(64),
    externalStatus: "changed",
    externalHash: "d".repeat(64),
    candidateId: null,
    pendingIntent: {
      intentHash: "b".repeat(64),
      requestId: randomUUID(),
      version: 2,
    },
    observationFingerprint: "c".repeat(64),
    watchMode: "polling",
  };
  f.save.sourceStatus = status;
  f.client.recoverAuthoredSource = async (body) => {
    calls.push(structuredClone(body));
    if (body.disposition === "known")
      throw new ApiError("SOURCE_RECOVERY_REQUIRED");
    return { ...status, pendingIntent: null };
  };
  try {
    assert.equal(await f.save.recoverSource(status), false);
    assert.equal(f.save.hasPendingSourceRecovery, false);
    assert.equal(await f.save.recoverSource(status, true), true);
    assert.equal(calls[0].disposition, "known");
    assert.equal(calls[1].disposition, "preserveExternal");
    assert.equal(
      calls[1].observationFingerprint,
      status.observationFingerprint,
    );
  } finally {
    f.save.dispose();
  }
});

for (const failure of ["unknown-submit", "lost-readback"])
  test(`unresolved ${failure} fences timer/window/manual/planning writes and retains original ID`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
    const f = sessionFixture(),
      request = { requestId: randomUUID() };
    let sends = 0,
      planningWrites = 0,
      fail = true;
    const originalRead = f.client.readAuthoredSource;
    if (failure === "lost-readback")
      f.client.readAuthoredSource = async () => {
        if (fail) throw Error("readback lost");
        return originalRead();
      };
    const ids = [];
    try {
      await assert.rejects(
        f.save.projectAction(
          "accept",
          async () => ({
            requestId: request.requestId,
            send: async () => {
              sends++;
              ids.push(request.requestId);
              if (failure === "unknown-submit" && fail)
                throw Error("unknown response");
              return { receipt: f.commit(request) };
            },
          }),
          true,
        ),
      );
      f.save.planningAdapter = {
        identity: () => "planning",
        dirty: () => true,
        canAutosave: () => true,
        busy: () => false,
        flush: async () => {
          planningWrites++;
          return true;
        },
        autosave: async () => {
          planningWrites++;
          return true;
        },
      };
      f.save.updateSource([{ from: 8, to: 8, insert: " later" }]);
      f.prefs.update({ saveMode: "after_delay", saveDelaySeconds: 5 });
      context.mock.timers.tick(60000);
      for (let n = 0; n < 100; n++) await Promise.resolve();
      assert.equal(f.calls.length, 0);
      assert.equal(await f.save.start(), false);
      assert.equal(f.save.unresolved, null);
      assert.equal(
        await f.save.saveSourceProposal("must remain unsent"),
        false,
      );
      assert.equal(f.save.sourceLocal, "Accepted later\r\n");
      assert.equal(await f.save.flush(true), false);
      assert.equal(await f.save.manualSave(), false);
      f.prefs.update({ saveMode: "on_window_change" });
      assert.equal(await f.save.windowChanged(), false);
      assert.equal(planningWrites, 0);
      assert.equal(f.save.hasExternalRecovery, true);
      f.save.planningAdapter = undefined;
      fail = false;
      await f.save.retryProjectAction();
      assert.equal(f.save.hasExternalRecovery, false);
      assert.deepEqual(ids, Array(sends).fill(request.requestId));
      assert.equal(sends, failure === "unknown-submit" ? 2 : 1);
      assert.equal(f.calls.length, 0);
      assert.equal(await f.save.manualSave(), true);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].source, "Accepted later\r\n");
    } finally {
      f.save.dispose();
      context.mock.timers.reset();
    }
  });

test("definite original legacy metadata rejection retires that owner; lost readback retains it", async () => {
  const f = sessionFixture();
  let sends = 0,
    failRead = true;
  try {
    const requestId = randomUUID();
    await assert.rejects(
      f.save.projectAction("rename", async () => ({
        requestId,
        legacyMetadata: true,
        send: async () => {
          sends++;
          throw new ApiError("PROJECT_CONFLICT");
        },
      })),
      /PROJECT_CONFLICT/,
    );
    assert.equal(f.save.hasExternalRecovery, false);
    f.client.readProject = async () => {
      if (failRead) throw new ApiError("PROJECT_CONFLICT");
      return {
        project: {
          id: f.save.projectId,
          title: "Current",
          workingRevision: 1,
          approvedBaseline: null,
        },
      };
    };
    const nextId = randomUUID();
    await assert.rejects(
      f.save.projectAction("graph-name", async () => ({
        requestId: nextId,
        legacyMetadata: true,
        send: async () => {
          sends++;
          return {
            project: {
              id: f.save.projectId,
              title: "Original",
              workingRevision: 1,
            },
          };
        },
      })),
      /PROJECT_CONFLICT/,
    );
    assert.equal(f.save.hasExternalRecovery, true);
    failRead = false;
    await f.save.retryProjectAction();
    assert.equal(f.save.hasExternalRecovery, false);
    assert.equal(sends, 2);
  } finally {
    f.save.dispose();
  }
});

test("original registered rename outcome remains separate from newer verified project metadata", async () => {
  const f = sessionFixture(),
    request = { requestId: randomUUID() };
  let projected;
  f.save.onProjectMetadata = (next) => (projected = next);
  f.client.readProject = async () => ({
    project: {
      id: f.save.projectId,
      title: "Later",
      workingRevision: 3,
      approvedBaseline: "later-baseline",
    },
  });
  try {
    const result = await f.save.projectAction(
      "rename",
      async () => ({
        requestId: request.requestId,
        send: async () => {
          const receipt = f.commit(request);
          f.commit({ requestId: randomUUID() });
          return {
            receipt,
            project: {
              id: f.save.projectId,
              title: "Earlier",
              workingRevision: 2,
              approvedBaseline: null,
            },
          };
        },
      }),
      true,
    );
    assert.equal(result.project.title, "Earlier");
    assert.equal(f.save.state.workingRevision, 3);
    assert.equal(projected.title, "Later");
    assert.equal(projected.workingRevision, 3);
    assert.equal(projected.approvedBaseline, "later-baseline");
  } finally {
    f.save.dispose();
  }
});

test("settling an external action resumes the owning input delay without early submission", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
  const f = sessionFixture(),
    request = { requestId: randomUUID() };
  let fail = true;
  try {
    await assert.rejects(
      f.save.projectAction(
        "accept",
        async () => ({
          requestId: request.requestId,
          send: async () => {
            if (fail) throw Error("unknown");
            return { receipt: f.commit(request) };
          },
        }),
        true,
      ),
    );
    f.prefs.update({ saveMode: "after_delay", saveDelaySeconds: 5 });
    f.save.updateSource([{ from: 8, to: 8, insert: " later" }]);
    context.mock.timers.tick(1000);
    for (let n = 0; n < 50; n++) await Promise.resolve();
    fail = false;
    await f.save.retryProjectAction();
    context.mock.timers.tick(3999);
    for (let n = 0; n < 50; n++) await Promise.resolve();
    assert.equal(f.calls.length, 0);
    context.mock.timers.tick(1);
    for (let n = 0; n < 100; n++) await Promise.resolve();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].source, "Accepted later\r\n");
  } finally {
    f.save.dispose();
    context.mock.timers.reset();
  }
});

for (const key of ["rename", "graph-name"])
  test(`ambiguous legacy ${key} response retains original identity through metadata readback`, async () => {
    const f = sessionFixture(),
      request = { requestId: randomUUID() };
    const ids = [];
    let lost = true,
      projected;
    f.client.readProject = async () => ({
      project: {
        id: f.save.projectId,
        title: "Current",
        workingRevision: 1,
        approvedBaseline: null,
      },
    });
    f.save.onProjectMetadata = (next) => (projected = next);
    try {
      await assert.rejects(
        f.save.projectAction(key, async () => ({
          requestId: request.requestId,
          legacyMetadata: true,
          send: async () => {
            ids.push(request.requestId);
            if (lost) throw Error("lost ACK");
            return {
              project: {
                id: f.save.projectId,
                title: "Original",
                workingRevision: 1,
              },
            };
          },
        })),
      );
      assert.equal(f.save.hasExternalRecovery, true);
      lost = false;
      const value = await f.save.retryProjectAction();
      assert.equal(value.project.title, "Original");
      assert.equal(projected.title, "Current");
      assert.deepEqual(ids, [request.requestId, request.requestId]);
      assert.equal(f.save.hasExternalRecovery, false);
    } finally {
      f.save.dispose();
    }
  });

for (const composing of [false, true])
  test(`known-applied text acceptance installs verified checkpoint, preserves raw input and permits explicit merge (IME=${composing})`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
    const f = sessionFixture(),
      held = gate(),
      request = { requestId: randomUUID() };
    let sends = 0,
      original;
    try {
      const task = f.save.projectAction(
        "accept-text",
        async () => ({
          requestId: request.requestId,
          send: async () => {
            sends++;
            const receipt = f.commit(request, "External accepted\r\n");
            original = { receipt };
            await held.promise;
            return original;
          },
        }),
        true,
      );
      for (let n = 0; n < 50; n++) await Promise.resolve();
      f.save.composition(composing);
      f.save.updateSource([{ from: 8, to: 8, insert: " later 中😀" }]);
      const raw = f.save.sourceLocal,
        identity = f.save.visibleInputIdentity;
      held.resolve();
      assert.equal(await task, original);
      assert.equal(f.save.hasExternalRecovery, false);
      assert.equal(f.save.appliedSourceConflict.requestId, request.requestId);
      assert.equal(f.save.appliedSourceConflict.result, original);
      assert.equal(f.save.sourceLocal, raw);
      assert.equal(f.save.visibleInputIdentity, identity);
      assert.equal(f.save.source.source, "External accepted\r\n");
      assert.equal(f.save.state.workingRevision, 2);
      assert.equal(f.save.history.workingRevision, 2);
      assert.equal(f.save.businessReceipt.requestId, request.requestId);
      assert.equal(f.save.status, "conflict");
      assert.equal(f.save.error, "EXTERNAL_APPLIED_SOURCE_CONFLICT");
      assert.equal(f.save.segments.length, 0);
      assert.equal(f.save.sourcePending, null);
      assert.equal(f.save.deferredSourceAck, null);
      assert.equal(await f.save.flush(true), false);
      assert.equal(await f.save.retryProjectAction(), null);
      assert.equal(sends, 1);
      f.save.composition(false);
      f.prefs.update({ saveMode: "after_delay", saveDelaySeconds: 5 });
      context.mock.timers.tick(60000);
      for (let n = 0; n < 50; n++) await Promise.resolve();
      assert.equal(f.calls.length, 0);
      assert.equal(f.save.sourceLocal, raw);
      const combined = "External accepted\r\nManual combination 中😀\r\n";
      const merge = f.save.saveSourceProposal(combined);
      for (let n = 0; n < 100; n++) await Promise.resolve();
      assert.equal(await merge, true);
      assert.equal(f.calls.length, 1);
      assert.notEqual(f.calls[0].requestId, request.requestId);
      assert.equal(f.calls[0].expectedWorkingRevision, 2);
      assert.equal(f.calls[0].expectedHash, hash("External accepted\r\n"));
      assert.equal(f.save.appliedSourceConflict, null);
      assert.equal(f.save.sourceLocal, combined);
      assert.equal(f.save.status, "saved");
      assert.equal(sends, 1);
    } finally {
      f.save.dispose();
      context.mock.timers.reset();
    }
  });

test("known receipt without complete verified text readback remains fenced until the original readback succeeds", async () => {
  const f = sessionFixture(),
    request = { requestId: randomUUID() };
  let sends = 0,
    fail = true;
  const read = f.client.readHistory;
  f.client.readHistory = async () => {
    if (fail) throw Error("history readback lost");
    return read();
  };
  try {
    await assert.rejects(
      f.save.projectAction(
        "accept-text",
        async () => ({
          requestId: request.requestId,
          send: async () => {
            sends++;
            return { receipt: f.commit(request, "External accepted\r\n") };
          },
        }),
        true,
      ),
    );
    f.save.updateSource([{ from: 8, to: 8, insert: " later" }]);
    assert.equal(f.save.hasExternalRecovery, true);
    assert.equal(f.save.source.source, "Accepted\r\n");
    assert.equal(f.save.appliedSourceConflict ?? null, null);
    assert.equal(await f.save.saveSourceProposal("must not apply"), false);
    assert.equal(await f.save.reload(), false);
    fail = false;
    await f.save.retryProjectAction();
    assert.equal(sends, 1);
    assert.equal(f.save.hasExternalRecovery, false);
    assert.equal(f.save.source.source, "External accepted\r\n");
    assert.ok(f.save.appliedSourceConflict);
  } finally {
    f.save.dispose();
  }
});

test("reload choice captures input/context before queueing and cannot wipe later input", async () => {
  const f = sessionFixture(),
    held = gate();
  try {
    const queued = f.save.enqueue(() => held.promise);
    const reload = f.save.reload();
    f.save.updateSource([{ from: 8, to: 8, insert: " after click" }]);
    held.resolve();
    await queued;
    assert.equal(await reload, false);
    assert.equal(f.save.sourceLocal, "Accepted after click\r\n");
    const cancelled = f.save.reload();
    f.save.actions.cancel();
    assert.equal(await cancelled, false);
    assert.equal(f.save.sourceLocal, "Accepted after click\r\n");
    assert.equal(await f.save.reload(), true);
  } finally {
    f.save.dispose();
  }
});

test("a proved applied conflict permits an explicit saved-version choice without replaying the external action", async () => {
  const f = sessionFixture(),
    held = f.holdRead(),
    request = { requestId: randomUUID() };
  let sends = 0;
  try {
    const action = f.save.projectAction(
      "accept-text",
      async () => ({
        requestId: request.requestId,
        send: async () => {
          sends++;
          return { receipt: f.commit(request, "Applied saved text\r\n") };
        },
      }),
      true,
    );
    await turn();
    f.save.updateSource([{ from: 8, to: 8, insert: " later raw" }]);
    held.resolve();
    await action;
    assert.ok(f.save.appliedSourceConflict);
    assert.equal(f.save.hasExternalRecovery, false);
    assert.equal(await f.save.reload(), true);
    assert.equal(f.save.appliedSourceConflict, null);
    assert.equal(f.save.sourceLocal, "Applied saved text\r\n");
    assert.equal(f.save.status, "saved");
    assert.equal(sends, 1);
    assert.equal(f.calls.length, 0);
  } finally {
    f.save.dispose();
  }
});
