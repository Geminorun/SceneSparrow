import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProjectSession } from "../../packages/editor-ui/src/project-session/project-session.ts";
import { ApplicationPreferencesStore } from "../../packages/editor-ui/src/app-preferences.ts";
import { ApiError } from "../../packages/platform-client/src/errors.ts";
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
function fixture(initial = "Original\n") {
  let snapshot = {
    projectId: randomUUID(),
    workingRevision: 1,
    generation: 1,
    acceptedHash: "base",
    source: initial,
    bindings: [],
    semanticBlockIds: [],
    externalStatus: "unchanged",
    externalHash: null,
  };
  let canonical = {
    manuscriptId: randomUUID(),
    schemaVersion: 1,
    workingRevision: 1,
    workspaceStage: "draft",
    blocks: [],
  };
  let history = {
    workingRevision: 1,
    historyRevision: 0,
    cursor: 0,
    undoCount: 0,
    redoCount: 0,
  };
  const commands = [],
    receipts = new Map();
  const client = {
    async saveAuthoredSource(request) {
      commands.push(request);
      if (receipts.has(request.requestId))
        return {
          receipt: receipts.get(request.requestId),
          snapshot: structuredClone(snapshot),
        };
      snapshot = {
        ...snapshot,
        workingRevision: snapshot.workingRevision + 1,
        generation: snapshot.generation + 1,
        acceptedHash: randomUUID(),
        source: request.source,
      };
      canonical = { ...canonical, workingRevision: snapshot.workingRevision };
      history = {
        ...history,
        workingRevision: snapshot.workingRevision,
        historyRevision: history.historyRevision + 1,
      };
      const receipt = {
        ...history,
        requestId: request.requestId,
        blockRevisions: [],
        eventSequence: 1,
      };
      receipts.set(request.requestId, receipt);
      return { receipt, snapshot: structuredClone(snapshot) };
    },
    async commandReceipt(requestId) {
      if (!receipts.has(requestId)) throw new ApiError("COMMAND_NOT_FOUND");
      return receipts.get(requestId);
    },
    async readAuthoredSource() {
      return structuredClone(snapshot);
    },
    async readAuthoredSourceStatus() {
      return {
        generation: snapshot.generation,
        acceptedHash: snapshot.acceptedHash,
        externalStatus: "unchanged",
      };
    },
    async readManuscript() {
      return structuredClone(canonical);
    },
    async readHistory() {
      return structuredClone(history);
    },
    async executeManuscript(command) {
      history = { ...history, historyRevision: history.historyRevision + 1 };
      return {
        ...history,
        requestId: command.requestId,
        blockRevisions: [],
        eventSequence: 1,
      };
    },
  };
  const preferences = new ApplicationPreferencesStore(null);
  preferences.update({ saveMode: "off" });
  const save = new ProjectSession(
    canonical,
    snapshot.projectId,
    client,
    () => {},
    history,
    preferences,
  );
  save.initializeSource(snapshot);
  const type = (text) =>
    save.updateSource([{ from: 0, to: save.sourceLocal.length, insert: text }]);
  return {
    save,
    client,
    commands,
    type,
    foreign(source = "Foreign\n") {
      snapshot = {
        ...snapshot,
        workingRevision: snapshot.workingRevision + 1,
        generation: snapshot.generation + 1,
        acceptedHash: "foreign",
        source,
      };
      canonical = { ...canonical, workingRevision: snapshot.workingRevision };
      history = {
        ...history,
        workingRevision: snapshot.workingRevision,
        historyRevision: history.historyRevision + 1,
      };
    },
  };
}
test("captured source reconciles original uncertain A, settles through B and leaves later IME C pending", async () => {
  const f = fixture();
  try {
    const submit = f.client.saveAuthoredSource;
    let uncertain = true,
      receiptUnavailable = true;
    f.client.saveAuthoredSource = async (request) => {
      const result = await submit(request);
      if (uncertain) {
        uncertain = false;
        throw Error("lost ACK");
      }
      return result;
    };
    const lookup = f.client.commandReceipt;
    f.client.commandReceipt = async (id) => {
      if (receiptUnavailable) {
        receiptUnavailable = false;
        throw Error("lookup failed");
      }
      return lookup(id);
    };
    f.type("A\n");
    assert.equal(await f.save.flush(), false);
    const first = f.commands[0].requestId;
    f.type("B captured\n");
    const hold = deferred(),
      entered = deferred();
    f.client.commandReceipt = async (id) => {
      assert.equal(id, first);
      entered.resolve();
      await hold.promise;
      return lookup(id);
    };
    let exported;
    const capturing = f.save.capturedAction("uncertain", async () => {
      exported = f.save.source.source;
      return true;
    });
    await entered.promise;
    f.save.composition(true);
    f.type("C later 中文\n");
    f.save.boundary();
    hold.resolve();
    assert.equal(await capturing, true);
    assert.equal(exported, "B captured\n");
    assert.deepEqual(
      f.commands.map((command) => command.source),
      ["A\n", "B captured\n"],
    );
    assert.equal(f.save.sourceLocal, "C later 中文\n");
    assert.equal(f.save.status, "pending");
  } finally {
    f.save.dispose();
  }
});
test("foreign accepted checkpoint during captured source readback refuses export and preserves local input", async () => {
  const f = fixture();
  try {
    const submit = f.client.saveAuthoredSource;
    f.client.saveAuthoredSource = async (request) => {
      const result = await submit(request);
      f.foreign();
      return result;
    };
    f.type("Captured\n");
    let exports = 0;
    assert.equal(
      await f.save.capturedAction("foreign", async () => {
        exports++;
        return true;
      }),
      null,
    );
    assert.equal(exports, 0);
    assert.equal(f.save.error, "REVISION_CONFLICT");
    assert.equal(f.save.sourceLocal, "Captured\n");
  } finally {
    f.save.dispose();
  }
});

test("captured action admission counts queued live owners and releases every fence after cancellation", async () => {
  const f = fixture();
  try {
    const held = deferred(),
      started = deferred();
    const first = f.save.capturedAction("cap-0", async () => {
      started.resolve();
      await held.promise;
      return true;
    });
    await started.promise;
    const queued = Array.from({ length: 7 }, (_, index) =>
      f.save.capturedAction(`cap-${index + 1}`, async () => true),
    );
    assert.equal(f.save.capturedInputFences.size, 8);
    await assert.rejects(
      f.save.capturedAction("cap-9", async () => true),
      /CAPTURE_BUSY/,
    );
    assert.equal(f.save.capturedInputFences.size, 8);
    held.resolve();
    assert.equal(await first, true);
    await Promise.all(queued);
    assert.equal(f.save.capturedInputFences.size, 0);
    assert.equal(
      await f.save.capturedAction("cap-after", async () => true),
      true,
    );
  } finally {
    f.save.dispose();
  }
});

test("ordinary source predecessor cannot adopt a foreign accepted readback while a capture waits", async () => {
  const f = fixture("Original\n\nIndependent\n"),
    entered = deferred(),
    held = deferred();
  const submit = f.client.saveAuthoredSource;
  f.client.saveAuthoredSource = async (request) => {
    const result = await submit(request);
    entered.resolve();
    await held.promise;
    return result;
  };
  try {
    f.save.updateSource([{ from: 0, to: 8, insert: "A predecessor" }]);
    const preceding = f.save.flush();
    await entered.promise;
    f.save.updateSource([{ from: 0, to: 13, insert: "B captured" }]);
    let exports = 0;
    const capturing = f.save.capturedAction("pending-foreign", async () => {
      exports++;
      return true;
    });
    f.foreign("A predecessor\n\nForeign independent\n");
    held.resolve();
    assert.equal(await preceding, false);
    assert.equal(await capturing, null);
    assert.equal(exports, 0);
    assert.equal(f.save.source.acceptedHash, "base");
    assert.equal(f.save.sourceLocal, "B captured\n\nIndependent\n");
    assert.equal(f.save.error, "REVISION_CONFLICT");
    assert.deepEqual(
      f.commands.map((command) => command.source),
      ["A predecessor\n\nIndependent\n"],
    );
  } finally {
    held.resolve();
    f.save.dispose();
  }
});

test("distinct native source captures hand off after ACK with snapshots B then D and later E pending", async () => {
  const f = fixture(),
    entered = deferred(),
    held = deferred(),
    snapshots = [];
  try {
    f.type("B first\n");
    const first = f.save.capturedAction("source-first", async () => {
      snapshots.push(f.save.source.source);
      entered.resolve();
      await held.promise;
      return true;
    });
    await entered.promise;
    f.type("D second\n");
    const second = f.save.capturedAction("source-second", async () => {
      assert.equal(f.save.capturedInputFences.size, 1);
      snapshots.push(f.save.source.source);
      return true;
    });
    f.type("E later\n");
    assert.equal(f.save.capturedInputFences.size, 2);
    assert.equal(f.save.actions.captured.size, 2);
    assert.deepEqual(
      f.commands.map((c) => c.source),
      ["B first\n"],
    );
    held.resolve();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.deepEqual(snapshots, ["B first\n", "D second\n"]);
    assert.deepEqual(
      f.commands.map((c) => c.source),
      ["B first\n", "D second\n"],
    );
    assert.equal(f.save.sourceLocal, "E later\n");
    assert.equal(f.save.status, "pending");
    assert.equal(f.save.capturedInputFences.size, 0);
    assert.equal(f.save.actions.captured.size, 0);
  } finally {
    held.resolve();
    f.save.dispose();
  }
});
test("cancelled never-entered capture releases custody before a different source action", async () => {
  const f = fixture();
  try {
    f.type("B cancelled\n");
    const cancelled = f.save.capturedAction("never-entered", async () =>
      assert.fail("cancelled callback"),
    );
    f.save.actions.cancel("capture-never-entered");
    f.type("D second\n");
    let captured;
    const second = f.save.capturedAction("after-never-entered", async () => {
      captured = f.save.source.source;
      return true;
    });
    f.type("E later\n");
    assert.deepEqual(await Promise.all([cancelled, second]), [null, true]);
    assert.equal(captured, "D second\n");
    assert.equal(f.save.sourceLocal, "E later\n");
    assert.equal(f.save.status, "pending");
    assert.equal(f.save.capturedInputFences.size, 0);
    assert.equal(f.save.actions.captured.size, 0);
  } finally {
    f.save.dispose();
  }
});

test("checkpoint capture failure leaves no manuscript fence or admission before the next source action", async () => {
  const f = fixture();
  try {
    f.type("B failed capture\n");
    f.save.planningAdapter = {
      captureCheckpoint: () => {
        throw Error("checkpoint unavailable");
      },
      flush: async () => true,
      identity: () => "",
      dirty: () => false,
      autosave: async () => true,
      busy: () => false,
      canAutosave: () => false,
    };
    await assert.rejects(
      f.save.capturedAction("failed-checkpoint", async () =>
        assert.fail("must not run"),
      ),
      /checkpoint unavailable/,
    );
    assert.equal(f.save.capturedInputFences.size, 0);
    assert.equal(f.save.actions.captured.size, 0);
    f.save.planningAdapter = undefined;
    f.type("D after failure\n");
    let captured;
    const next = f.save.capturedAction("after-checkpoint-failure", async () => {
      captured = f.save.source.source;
      return true;
    });
    f.type("E later\n");
    assert.equal(await next, true);
    assert.equal(captured, "D after failure\n");
    assert.equal(f.save.sourceLocal, "E later\n");
    assert.equal(f.save.status, "pending");
  } finally {
    f.save.dispose();
  }
});
