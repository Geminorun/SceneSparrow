import test from "node:test";
import assert from "node:assert/strict";
import { Autosave } from "../../packages/editor-ui/src/editor/autosave.ts";
import {
  ApiError,
  TransportError,
} from "../../packages/platform-client/src/index.ts";
const id = () => crypto.randomUUID();
const block = (text = "Text") => ({
  id: id(),
  kind: "paragraph",
  attrs: {},
  runs: [{ text, marks: [] }],
  revision: 1,
});
function setup() {
  const original = block();
  const state = {
    manuscriptId: id(),
    schemaVersion: 1,
    workspaceStage: "draft",
    blocks: [original],
    workingRevision: 1,
  };
  const calls = [];
  const client = {
    executeManuscript: async (c) => {
      calls.push(c);
      return receipt(c);
    },
    readManuscript: async () => state,
    readHistory: async () => ({
      ...save.history,
      workingRevision: save.state.workingRevision,
    }),
    commandReceipt: async () => {
      throw new ApiError("COMMAND_NOT_FOUND");
    },
  };
  const save = new Autosave(state, id(), client, () => {});
  return { save, state, client, calls };
}
function receipt(c) {
  return {
    requestId: c.requestId,
    workingRevision:
      c.expectedWorkingRevision + (c.type === "CloseEditGroup" ? 0 : 1),
    blockRevisions: (c.payload.expectedBlockRevisions ?? []).map((b) => ({
      ...b,
      revision: b.revision + 1,
    })),
    historyRevision:
      c.type === "CloseEditGroup" ? c.expectedHistoryRevision + 1 : 0,
    cursor: 0,
    undoCount: 0,
    redoCount: 0,
    eventSequence: 1,
    normalized: false,
  };
}
function local(save, text) {
  return save.local.map((b) => ({ ...b, runs: [{ text, marks: [] }] }));
}
const tick = () => new Promise((r) => setTimeout(r, 20));
const settle = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};
test("reopened editor flush without typing sends no command", async () => {
  const { save, calls } = setup();
  assert.equal(await save.flush(), true);
  assert.equal(await save.flush(), true);
  assert.equal(save.status, "saved");
  assert.equal(calls.length, 0);
  save.dispose();
});
test("serialized delayed receipt preserves later input and disposed controller schedules no work", async () => {
  const { save, client, calls } = setup();
  let release;
  client.executeManuscript = (c) => {
    calls.push(c);
    return new Promise((r) => {
      release = () => r(receipt(c));
    });
  };
  save.update(local(save, "first"));
  const pending = save.flush();
  await settle();
  save.update(local(save, "second"));
  assert.equal(calls.length, 1);
  assert.equal(save.status, "saving");
  save.dispose();
  release();
  await pending;
  assert.equal(save.local[0].runs[0].text, "second");
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(calls.length, 1);
});
test("lost committed response and transient receipt error preserve the original identity", async () => {
  const { save, client, calls } = setup();
  let first = true;
  client.executeManuscript = async (c) => {
    calls.push(c);
    if (first) {
      first = false;
      throw new TypeError("connection lost after commit");
    }
    return receipt(c);
  };
  let receiptReads = 0;
  client.commandReceipt = async (requestId) => {
    assert.equal(requestId, calls[0].requestId);
    if (++receiptReads === 1) throw new ApiError("SERVICE_UNAVAILABLE");
    return receipt(calls[0]);
  };
  save.update(local(save, "committed once"));
  assert.equal(await save.flush(), false);
  save.update(local(save, "new buffered text"));
  assert.equal(await save.flush(true), true);
  assert.equal(receiptReads, 2);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1].requestId, calls[0].requestId);
  assert.equal(save.status, "saved");
  save.dispose();
});
test("known semantic rejection permits fixed local content and explicit retry at the same group sequence", async () => {
  const { save, client, calls } = setup();
  client.executeManuscript = async (c) => {
    calls.push(c);
    if (calls.length === 1) throw new ApiError("DOCUMENT_INVALID");
    return receipt(c);
  };
  save.update(local(save, "bad"));
  assert.equal(await save.flush(), false);
  save.update(local(save, "fixed"));
  assert.equal(await save.flush(true), true);
  assert.notEqual(calls[0].requestId, calls[1].requestId);
  assert.equal(calls[0].payload.group.groupSequence, 1);
  assert.equal(calls[1].payload.group.groupSequence, 1);
  assert.equal(save.status, "saved");
  save.dispose();
});
test("IME composition blocks explicit flush until the final composition", async () => {
  const { save, calls } = setup();
  save.composition(true);
  save.update(local(save, "输入"));
  assert.equal(await save.flush(), false);
  assert.equal(calls.length, 0);
  save.composition(false);
  assert.equal(await save.flush(), true);
  assert.equal(calls.length, 1);
  save.dispose();
});
test("continuous local typing flushes by two seconds even without a debounce gap", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
  const { save, calls } = setup();
  for (let n = 0; n < 10; n++) {
    save.update(local(save, `typing ${n}`));
    context.mock.timers.tick(200);
  }
  await settle();
  assert.equal(calls.length, 1);
  await Promise.resolve();
  await Promise.resolve();
  save.dispose();
  context.mock.timers.reset();
});
test("normalization reconciliation refuses an unknown newer core revision and retains the local buffer", async () => {
  const { save, client, state } = setup();
  client.executeManuscript = async (c) => ({ ...receipt(c), normalized: true });
  client.readManuscript = async () => ({ ...state, workingRevision: 99 });
  save.update(local(save, "local must survive"));
  assert.equal(await save.flush(), false);
  assert.equal(save.status, "conflict");
  assert.equal(save.local[0].runs[0].text, "local must survive");
  assert.equal(save.latest.workingRevision, 99);
  save.dispose();
});
test("unconvertible idle input blocks retry and close until successful correction", async () => {
  const { save, calls } = setup();
  save.invalidate("DOCUMENT_TOO_LARGE", "oversized visible input");
  assert.equal(await save.flush(), false);
  assert.equal(await save.flush(true), false);
  assert.equal(save.status, "error");
  assert.equal(save.recoveryText, "oversized visible input");
  assert.equal(calls.length, 0);
  save.update(local(save, "corrected input"));
  assert.equal(await save.flush(true), true);
  assert.equal(save.recoveryText, null);
  assert.equal(save.status, "saved");
  assert.equal(calls.length, 1);
  save.dispose();
});
test("conversion failure cancels an older scheduled save and explicit discard clears recovery", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
  const { save, calls, state } = setup();
  save.update(local(save, "valid pending buffer"));
  save.invalidate("DOCUMENT_INVALID", "unsupported current input");
  context.mock.timers.tick(3000);
  assert.equal(calls.length, 0);
  assert.equal(await save.flush(true), false);
  assert.equal(await save.reload(), true);
  assert.deepEqual(
    save.local,
    state.blocks.map(({ revision: _, ...b }) => b),
  );
  assert.equal(save.recoveryText, null);
  assert.equal(await save.flush(), true);
  assert.equal(calls.length, 0);
  save.dispose();
  context.mock.timers.reset();
});
test("late acknowledgment advances the valid base but cannot save invalid visible input or authorize close", async () => {
  const { save, client, calls } = setup();
  let release;
  client.executeManuscript = (c) => {
    calls.push(c);
    return new Promise((resolve) => {
      release = () => resolve(receipt(c));
    });
  };
  save.update(local(save, "valid in flight"));
  const pending = save.flush();
  await settle();
  save.invalidate("DOCUMENT_INVALID", "unconvertible visible buffer");
  assert.equal(await save.flush(true), false);
  release();
  assert.equal(await pending, false);
  assert.equal(save.state.workingRevision, 2);
  assert.equal(save.status, "error");
  assert.equal(save.error, "DOCUMENT_INVALID");
  assert.equal(save.recoveryText, "unconvertible visible buffer");
  assert.equal(await save.flush(), false);
  assert.equal(calls.length, 1);
  client.executeManuscript = async (c) => {
    calls.push(c);
    return receipt(c);
  };
  save.update(local(save, "corrected after receipt"));
  assert.equal(await save.flush(true), true);
  assert.equal(calls[1].expectedWorkingRevision, 2);
  assert.equal(save.status, "saved");
  save.dispose();
});
test("normalized late receipt cannot replace recovery for unconvertible visible input", async () => {
  const { save, client } = setup();
  let release;
  const valid = local(save, "valid before normalization");
  client.executeManuscript = (c) =>
    new Promise((resolve) => {
      release = () => resolve({ ...receipt(c), normalized: true });
    });
  client.readManuscript = async () => ({
    ...save.state,
    workingRevision: 2,
    blocks: valid.map((b) => ({ ...b, revision: 2 })),
  });
  save.update(valid);
  const pending = save.flush();
  await settle();
  save.invalidate("DOCUMENT_TOO_LARGE", "oversized current buffer");
  release();
  assert.equal(await pending, false);
  assert.equal(save.state.workingRevision, 2);
  assert.equal(save.status, "error");
  assert.equal(save.recoveryText, "oversized current buffer");
  assert.equal(await save.flush(true), false);
  save.dispose();
});

function historySetup() {
  const fixture = setup();
  const { save, client, calls } = fixture;
  let h = {
    workingRevision: 1,
    historyRevision: 2,
    cursor: 2,
    undoCount: 2,
    redoCount: 0,
    undoLabel: "typing",
    redoLabel: null,
  };
  let canonical = structuredClone(save.state);
  client.executeManuscript = async (c) => {
    calls.push(c);
    if (c.type === "ApplyDocumentEdit") {
      const r = receipt(c);
      h = {
        ...h,
        workingRevision: r.workingRevision,
        historyRevision: h.historyRevision + 1,
      };
      canonical = {
        ...canonical,
        workingRevision: r.workingRevision,
        blocks: save.local.map((b) => ({
          ...b,
          revision: r.blockRevisions.find((v) => v.id === b.id)?.revision ?? 1,
        })),
      };
      return { ...r, ...h, requestId: c.requestId };
    }
    const close = c.type === "CloseEditGroup";
    h = {
      ...h,
      workingRevision: h.workingRevision + (close ? 0 : 1),
      historyRevision: h.historyRevision + 1,
      cursor: h.cursor + (close ? 0 : c.type === "UndoProject" ? -1 : 1),
    };
    h.undoCount = h.cursor;
    h.redoCount = 2 - h.cursor;
    if (!close)
      canonical = {
        ...canonical,
        workingRevision: h.workingRevision,
        blocks: canonical.blocks.map((b) => ({
          ...b,
          revision: b.revision + 1,
          runs: [{ text: "history result", marks: [] }],
        })),
      };
    return {
      requestId: c.requestId,
      ...h,
      blockRevisions: [],
      eventSequence: 1,
      normalized: false,
    };
  };
  client.readHistory = async () => structuredClone(h);
  client.readManuscript = async () => structuredClone(canonical);
  save.history = structuredClone(h);
  return fixture;
}
test("continuous typing across two-second saved batches uses one group until actual idle", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
  const { save, calls } = setup();
  for (let n = 0; n < 25; n++) {
    save.update(local(save, `continuous ${n}`));
    context.mock.timers.tick(200);
    for (let k = 0; k < 8; k++) await Promise.resolve();
  }
  const edits = calls.filter((c) => c.type === "ApplyDocumentEdit");
  assert.ok(edits.length >= 2);
  assert.equal(new Set(edits.map((c) => c.payload.group.groupId)).size, 1);
  assert.deepEqual(
    edits.map((c) => c.payload.group.groupSequence),
    edits.map((_, n) => n + 1),
  );
  save.dispose();
  context.mock.timers.reset();
});
test("discrete actions preserve typing before, structure at action, and later visible input while writes are delayed", async () => {
  const { save, client, calls } = setup();
  let release;
  client.executeManuscript = (c) => {
    calls.push(c);
    if (calls.length === 1)
      return new Promise((r) => (release = () => r(receipt(c))));
    return Promise.resolve(receipt(c));
  };
  save.update(local(save, "before"));
  const first = save.flush();
  await settle();
  const action = save.discrete(() => save.update(local(save, "structure")));
  save.update(local(save, "later"));
  assert.equal(save.local[0].runs[0].text, "later");
  release();
  assert.equal(await first, true);
  assert.equal(await action, true);
  const edits = calls.filter((c) => c.type === "ApplyDocumentEdit");
  assert.deepEqual(
    edits.map(
      (c) =>
        c.payload.operations.find((o) => o.op === "setBlockContent").runs[0]
          .text,
    ),
    ["before", "structure", "later"],
  );
  assert.deepEqual(
    edits.map((c) => c.payload.group.kind),
    ["typing", "discrete", "typing"],
  );
  assert.equal(calls.filter((c) => c.type === "CloseEditGroup").length, 2);
  assert.equal(new Set(edits.map((c) => c.payload.group.groupId)).size, 3);
  assert.equal(save.local[0].runs[0].text, "later");
  save.dispose();
});
test("ambiguous committed undo resolves the original receipt without a second undo", async () => {
  const { save, client, calls } = historySetup();
  const execute = client.executeManuscript;
  let outcome;
  let first = true;
  client.executeManuscript = async (c) => {
    if (first) {
      first = false;
      outcome = await execute(c);
      throw new TypeError("lost committed undo");
    }
    calls.push(c);
    return outcome;
  };
  let receiptReads = 0;
  client.commandReceipt = async (requestId) => {
    assert.equal(requestId, calls[0].requestId);
    if (++receiptReads === 1) throw new ApiError("SERVICE_UNAVAILABLE");
    return outcome;
  };
  assert.equal(await save.navigate("UndoProject", () => {}), false);
  assert.equal(save.status, "error");
  assert.equal(await save.flush(), false);
  assert.equal(await save.flush(true), true);
  assert.equal(calls.length, 1);
  assert.equal(receiptReads, 2);
  assert.equal(save.history.cursor, 1);
  assert.equal(save.canonicalVersion, 1);
  assert.equal(save.local[0].runs[0].text, "history result");
  save.dispose();
});
test("delayed metadata-only group close cannot acknowledge invalid visible input or authorize close", async () => {
  const { save, client, calls } = historySetup();
  save.update(local(save, "acknowledged"));
  assert.equal(await save.flush(), true);
  const execute = client.executeManuscript;
  let release;
  client.executeManuscript = (c) =>
    c.type === "CloseEditGroup"
      ? new Promise((r) => (release = async () => r(await execute(c))))
      : execute(c);
  const closing = save.controlledClose();
  for (let n = 0; n < 8; n++) await Promise.resolve();
  assert.ok(release);
  save.invalidate("DOCUMENT_INVALID", "unsupported visible during close");
  await release();
  assert.equal(await closing, false);
  assert.equal(save.status, "error");
  assert.equal(save.recoveryText, "unsupported visible during close");
  assert.equal(await save.controlledClose(true), false);
  assert.equal(calls.filter((c) => c.type === "CloseEditGroup").length, 1);
  save.dispose();
});
test("project history preserves later visible input by entering conflict instead of replacing it", async () => {
  const { save, client } = historySetup();
  const execute = client.executeManuscript;
  let release;
  client.executeManuscript = (c) =>
    new Promise((r) => (release = async () => r(await execute(c))));
  const navigation = save.navigate("UndoProject", () =>
    assert.fail("must not reload editor"),
  );
  for (let n = 0; n < 8; n++) await Promise.resolve();
  save.update(local(save, "later visible input"));
  await release();
  assert.equal(await navigation, false);
  assert.equal(save.status, "conflict");
  assert.equal(save.local[0].runs[0].text, "later visible input");
  save.dispose();
});
test("controlled close drains newer valid input arriving during a delayed group close before authorizing exit", async () => {
  const { save, client, calls } = historySetup();
  save.update(local(save, "first acknowledged"));
  assert.equal(await save.flush(), true);
  const execute = client.executeManuscript;
  let release;
  let held = false;
  client.executeManuscript = (c) => {
    if (c.type === "CloseEditGroup" && !held) {
      held = true;
      return new Promise((r) => (release = async () => r(await execute(c))));
    }
    return execute(c);
  };
  let completed = false;
  const closing = save.controlledClose().then((ok) => {
    completed = true;
    return ok;
  });
  await settle();
  assert.ok(release);
  save.update(local(save, "newer visible during close"));
  assert.equal(completed, false);
  await release();
  assert.equal(await closing, true);
  assert.equal(save.status, "saved");
  assert.equal(save.local[0].runs[0].text, "newer visible during close");
  assert.equal(calls.filter((c) => c.type === "ApplyDocumentEdit").length, 2);
  assert.equal(calls.filter((c) => c.type === "CloseEditGroup").length, 2);
  save.dispose();
});
test("repeated selection boundaries coalesce unchanged large pending captures", async (context) => {
  const { save, client } = setup();
  let release;
  const execute = client.executeManuscript;
  let first = true;
  client.executeManuscript = (c) => {
    if (first) {
      first = false;
      return new Promise((r) => (release = () => r(receipt(c))));
    }
    return execute(c);
  };
  save.update(local(save, "x".repeat(500000)));
  const writing = save.flush();
  await settle();
  const clone = globalThis.structuredClone;
  let captures = 0;
  context.mock.method(globalThis, "structuredClone", (...args) => {
    captures++;
    return clone(...args);
  });
  const boundaries = Array.from({ length: 100 }, () => save.boundary());
  assert.ok(captures <= 1);
  release();
  assert.equal(await writing, true);
  await Promise.all(boundaries);
  assert.equal(save.status, "saved");
  save.dispose();
});
test("input after an undo gesture while an earlier save drains is retained without dispatching history", async () => {
  const { save, client, calls } = historySetup();
  const execute = client.executeManuscript;
  let release;
  let held = false;
  client.executeManuscript = (c) => {
    if (c.type === "ApplyDocumentEdit" && !held) {
      held = true;
      return new Promise((r) => (release = async () => r(await execute(c))));
    }
    return execute(c);
  };
  save.update(local(save, "before undo gesture"));
  const writing = save.flush();
  await settle();
  const undo = save.navigate("UndoProject", () =>
    assert.fail("cannot replace newer visible input"),
  );
  save.update(local(save, "after undo gesture"));
  await release();
  await writing;
  assert.equal(await undo, false);
  assert.equal(save.local[0].runs[0].text, "after undo gesture");
  assert.equal(save.status, "conflict");
  assert.equal(calls.filter((c) => c.type === "UndoProject").length, 0);
  save.dispose();
});
test("event resync rechecks visible input after delayed metadata and refreshes metadata-only changes", async () => {
  const { save, state, client } = setup();
  let release;
  const remote = { ...state, workingRevision: 2, blocks: [block("Remote")] };
  client.readManuscript = async () => remote;
  client.readHistory = () =>
    new Promise((r) => {
      release = () =>
        r({ ...save.history, workingRevision: 2, historyRevision: 9 });
    });
  const pending = save.resync();
  await settle();
  save.update(local(save, "Newer visible input"));
  release();
  assert.equal(await pending, false);
  assert.equal(save.local[0].runs[0].text, "Newer visible input");
  assert.equal(save.status, "conflict");
  assert.equal(save.canonicalVersion, 0);
  save.dispose();
  const second = setup();
  second.client.readHistory = async () => ({
    ...second.save.history,
    historyRevision: 12,
  });
  assert.equal(await second.save.resync(), true);
  assert.equal(second.save.history.historyRevision, 12);
  second.save.dispose();
});
test("a new source action cannot claim success from reconciling an earlier uncertain command", async () => {
  const { save, state, client, calls } = setup();
  let first = true;
  let stored;
  client.executeManuscript = async (c) => {
    calls.push(c);
    stored ??= receipt(c);
    if (first) {
      first = false;
      throw Error("transport lost");
    }
    return stored;
  };
  let receiptReads = 0;
  client.commandReceipt = async (requestId) => {
    assert.equal(requestId, calls[0].requestId);
    if (++receiptReads === 1) throw Error("receipt unavailable");
    return stored;
  };
  client.readManuscript = async () => ({ ...state, workingRevision: 2 });
  client.readHistory = async () => ({ ...save.history, workingRevision: 2 });
  const source = () => ({
    type: "AddSourceLink",
    requestId: id(),
    projectId: id(),
    expectedWorkingRevision: 1,
    payload: { sourceId: id(), url: "https://example.com", title: "Reference" },
  });
  assert.equal(await save.business(source), false);
  assert.equal(save.hasUnresolvedBusiness, true);
  let built = 0;
  assert.equal(
    await save.business(() => {
      built++;
      return source();
    }),
    false,
  );
  assert.equal(built, 0);
  assert.equal(save.hasUnresolvedBusiness, false);
  assert.equal(calls.length, 1);
  assert.equal(receiptReads, 2);
  assert.equal(save.status, "saved");
  save.dispose();
});
test("source receipt retains newer invalid visible input and never reloads over it", async () => {
  const { save, state, client } = setup();
  let release;
  client.executeManuscript = (c) =>
    new Promise((r) => {
      release = () => r(receipt(c));
    });
  client.readManuscript = async () => ({ ...state, workingRevision: 2 });
  const pending = save.business(() => ({
    type: "AddSourceLink",
    requestId: id(),
    projectId: id(),
    expectedWorkingRevision: 1,
    payload: { sourceId: id(), url: "https://example.com", title: "Reference" },
  }));
  await settle();
  save.invalidate("DOCUMENT_INVALID", "visible invalid source-time input");
  release();
  assert.equal(await pending, false);
  assert.equal(save.recoveryText, "visible invalid source-time input");
  assert.equal(save.status, "error");
  assert.equal(save.canonicalVersion, 0);
  save.dispose();
});
test("cancelling a queued file or import intent while autosave drains never dispatches its business command", async () => {
  const { save, client, calls } = setup();
  let release;
  let built = 0,
    dispatched = 0;
  client.executeManuscript = (c) => {
    calls.push(c);
    if (c.type === "ApplyDocumentEdit")
      return new Promise((r) => {
        release = () => r(receipt(c));
      });
    return Promise.resolve(receipt(c));
  };
  save.update(local(save, "Visible input before reference"));
  const abort = new AbortController();
  const pending = save.business(
    () => {
      built++;
      return {
        type: "AddSourceFile",
        requestId: id(),
        projectId: id(),
        expectedWorkingRevision: 1,
        payload: { sourceId: id(), intakeId: id(), hash: "verified" },
      };
    },
    { signal: abort.signal, dispatched: () => dispatched++ },
  );
  await settle();
  abort.abort();
  release();
  assert.equal(await pending, false);
  assert.equal(built, 0);
  assert.equal(dispatched, 0);
  assert.ok(calls.every((c) => c.type !== "AddSourceFile"));
  assert.equal(save.local[0].runs[0].text, "Visible input before reference");
  save.dispose();
});
test("task cancellation preserves a private rejected body buffer and exact cancellation receipt", async () => {
  const { save, client, calls } = setup();
  save.update(local(save, "Private unsaved text"));
  client.executeManuscript = async (command) => {
    calls.push(command);
    if (command.type === "ApplyDocumentEdit")
      throw new ApiError("TASK_USING_CONTENT");
    return { ...receipt(command), workingRevision: save.state.workingRevision };
  };
  assert.equal(await save.flush(), false);
  assert.equal(save.error, "TASK_USING_CONTENT");
  const before = JSON.stringify(save.local),
    state = JSON.stringify(save.state),
    command = {
      type: "CancelReviewTask",
      requestId: id(),
      projectId: id(),
      expectedWorkingRevision: save.state.workingRevision,
      payload: { threadId: id(), requestVersion: 1 },
    };
  assert.equal(await save.cancelReviewCommand(command), true);
  assert.equal(JSON.stringify(save.local), before);
  assert.equal(JSON.stringify(save.state), state);
  assert.equal(save.error, "TASK_USING_CONTENT");
  assert.equal(save.status, "error");
  assert.equal(calls.at(-1).type, "CancelReviewTask");
  assert.equal(save.businessReceipt.requestId, command.requestId);
  save.dispose();
});
test("unsent review guards stage-changing history and controlled close without clearing text", async () => {
  const { save, calls } = setup();
  let dirty = true;
  save.reviewDirty = () => dirty;
  assert.equal(await save.navigate("UndoProject", () => assert.fail()), false);
  assert.equal(save.operationError.code, "UNSENT_REVIEW");
  assert.equal(await save.controlledClose(), false);
  assert.equal(calls.length, 0);
  dirty = false;
  assert.equal(await save.controlledClose(), true);
  save.dispose();
});
test("new review input during delayed body settlement blocks queued history and close", async () => {
  for (const action of ["history", "close"]) {
    const { save, client, calls } = setup();
    let dirty = false,
      release;
    save.reviewDirty = () => dirty;
    save.update(local(save, "body"));
    client.executeManuscript = async (command) => {
      calls.push(command);
      if (command.type === "ApplyDocumentEdit")
        await new Promise((r) => (release = r));
      return receipt(command);
    };
    const pending =
      action === "history"
        ? save.navigate("UndoProject", () => assert.fail())
        : save.controlledClose();
    await settle();
    dirty = true;
    release();
    assert.equal(await pending, false);
    assert(!calls.some((c) => c.type === "UndoProject"));
    save.dispose();
  }
});
test("uncertain cancellation blocks other controllers until the exact identity resolves", async () => {
  const { save, client, calls } = setup();
  const command = {
    type: "CancelReviewTask",
    requestId: id(),
    projectId: id(),
    expectedWorkingRevision: 1,
    payload: { threadId: id(), requestVersion: 1 },
  };
  client.executeManuscript = async (c) => {
    calls.push(c);
    throw new Error("connection lost");
  };
  client.commandReceipt = async () => {
    throw new Error("connection lost");
  };
  assert.equal(await save.cancelReviewCommand(command), false);
  assert.equal(save.hasUnresolvedBusiness, true);
  assert.equal(await save.navigate("UndoProject", () => assert.fail()), false);
  assert.equal(await save.controlledClose(), false);
  assert.equal(await save.businessCore(() => assert.fail()), false);
  assert.equal(calls.length, 1);
  client.commandReceipt = async () => ({
    ...receipt(command),
    workingRevision: 1,
  });
  assert.equal(await save.cancelReviewCommand(command), true);
  assert.equal(save.hasUnresolvedBusiness, false);
  save.dispose();
});
test("IME beginning after a business dispatch prevents canonical replacement on late acknowledgment", async () => {
  const { save, client } = setup();
  let release;
  let firstRead = true;
  client.readManuscript = () => {
    if (!firstRead)
      return Promise.resolve({ ...save.state, workingRevision: 2 });
    firstRead = false;
    return new Promise(
      (r) => (release = () => r({ ...save.state, workingRevision: 2 })),
    );
  };
  client.readHistory = async () => ({ ...save.history, workingRevision: 2 });
  const before = save.canonicalVersion,
    pending = save.businessCore((revision) => ({
      type: "SetUserLocks",
      requestId: id(),
      projectId: id(),
      expectedWorkingRevision: revision,
      payload: {
        blockIds: [save.state.blocks[0].id],
        locked: true,
        all: false,
      },
    }));
  await settle();
  save.composition(true);
  release();
  assert.equal(await pending, true);
  assert.equal(save.canonicalVersion, before);
  assert.equal(save.composing, true);
  save.dispose();
});
test("proven cancel or unlock receipt releases the shared fence even if canonical GET fails", async () => {
  for (const type of ["CancelReviewTask", "SetUserLocks"]) {
    const { save, client, calls } = setup();
    save.update(local(save, "Private text"));
    client.executeManuscript = async (c) => {
      calls.push(c);
      return receipt(c);
    };
    client.readManuscript = async () => {
      throw new Error("GET failed");
    };
    const command = {
      type,
      requestId: id(),
      projectId: id(),
      expectedWorkingRevision: 1,
      payload:
        type === "CancelReviewTask"
          ? { threadId: id(), requestVersion: 1 }
          : { blockIds: [save.state.blocks[0].id], locked: false, all: false },
    };
    assert.equal(await save.cancelReviewCommand(command), true);
    assert.equal(save.hasUnresolvedBusiness, false);
    assert.equal(save.local[0].runs[0].text, "Private text");
    assert.equal(save.status, "pending");
    assert.equal(calls.length, 1);
    save.dispose();
  }
});
test("review typed after a committed stage-changing undo dispatch survives its delayed canonical acknowledgment", async () => {
  const { save, client } = setup();
  save.history = {
    ...save.history,
    undoCount: 1,
    cursor: 1,
    historyRevision: 1,
  };
  let release,
    dirty = false;
  save.reviewDirty = () => dirty;
  client.executeManuscript = (command) =>
    new Promise((r) => (release = () => r(receipt(command))));
  client.readManuscript = async () => ({
    ...save.state,
    workspaceStage: "outline",
    blocks: [],
    workingRevision: 2,
  });
  const pending = save.navigate("UndoProject", () =>
    assert.fail("must retain draft composer"),
  );
  await settle();
  dirty = true;
  release();
  assert.equal(await pending, false);
  assert.equal(save.state.workspaceStage, "draft");
  assert.equal(save.status, "conflict");
  assert.equal(await save.controlledClose(), false);
  save.dispose();
});
test("cancel and unlock cannot bypass an unknown body command receipt", async () => {
  const { save, client, calls } = setup();
  save.update(local(save, "unknown body"));
  client.executeManuscript = async (command) => {
    calls.push(command);
    throw Error("lost response");
  };
  client.commandReceipt = async () => {
    throw Error("receipt unavailable");
  };
  assert.equal(await save.flush(), false);
  for (const type of ["CancelReviewTask", "SetUserLocks"]) {
    const command = {
      type,
      requestId: id(),
      projectId: id(),
      expectedWorkingRevision: 1,
      payload:
        type === "CancelReviewTask"
          ? { threadId: id(), requestVersion: 1 }
          : { blockIds: [save.state.blocks[0].id], locked: false, all: false },
    };
    assert.equal(await save.cancelReviewCommand(command), false);
  }
  assert.equal(calls.length, 1);
  assert.equal(save.local[0].runs[0].text, "unknown body");
  save.dispose();
});
test("body-changing candidate acknowledgment cannot replace a newly started IME composition", async () => {
  const { save, client } = setup();
  let release,
    first = true;
  const replacement = {
    ...save.state,
    workingRevision: 2,
    blocks: save.state.blocks.map((b) => ({
      ...b,
      revision: 2,
      runs: [{ text: "Accepted candidate", marks: [] }],
    })),
  };
  client.readManuscript = () => {
    if (!first) return Promise.resolve(replacement);
    first = false;
    return new Promise((r) => (release = () => r(replacement)));
  };
  const pending = save.businessCore((revision) => ({
    type: "AcceptReviewCandidates",
    requestId: id(),
    projectId: id(),
    expectedWorkingRevision: revision,
    payload: {
      expectedHistoryRevision: 0,
      candidates: [{ id: id(), version: 1 }],
    },
  }));
  await settle();
  save.composition(true);
  release();
  assert.equal(await pending, false);
  assert.equal(save.canonicalVersion, 0);
  assert.equal(save.state.blocks[0].runs[0].text, "Text");
  assert.equal(save.composing, true);
  save.dispose();
});
test("history metadata held after canonical read cannot publish an older body over new input or IME", async () => {
  for (const ime of [false, true]) {
    const { save, client, calls } = historySetup();
    const readHistory = client.readHistory;
    let release;
    client.readHistory = async () => {
      const value = await readHistory();
      return new Promise((r) => (release = () => r(value)));
    };
    let applied = 0;
    const before = save.canonicalVersion;
    const pending = save.navigate("UndoProject", () => applied++);
    await settle();
    assert.equal(typeof release, "function");
    assert.equal(save.canonicalVersion, before);
    if (ime) save.composition(true);
    else save.update(local(save, "Private input during history read"));
    release();
    assert.equal(await pending, false);
    assert.equal(applied, 0);
    assert.equal(save.canonicalVersion, before);
    assert.equal(save.status, "conflict");
    assert.equal(
      save.businessReceipt?.requestId,
      calls.find((c) => c.type === "UndoProject").requestId,
    );
    if (ime) assert.equal(save.composing, true);
    else
      assert.equal(
        save.local[0].runs[0].text,
        "Private input during history read",
      );
    save.dispose();
  }
});
test("cheap identity resync rechecks late input and never fetches a whole unchanged body", async () => {
  const { save, client } = setup();
  const before = save.state;
  const token = `canonical-1|${before.manuscriptId}|${before.schemaVersion}|${before.blocks.map((b) => `${b.id}:${b.revision}`).join("|")}`;
  const hash = [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  let bodies = 0,
    release,
    entered;
  const enteredHistory = new Promise((r) => (entered = r));
  client.readManuscript = async () => {
    bodies++;
    return before;
  };
  client.readManuscriptIdentity = async () => ({
    bodyHash: hash,
    workingRevision: 2,
    workspaceStage: "draft",
  });
  client.readHistory = () =>
    new Promise((r) => {
      release = () => r({ ...save.history, workingRevision: 2 });
      entered();
    });
  const pending = save.resync();
  await enteredHistory;
  save.update(local(save, "New private input"));
  release();
  assert.equal(await pending, false);
  assert.equal(save.local[0].runs[0].text, "New private input");
  assert.equal(save.state.workingRevision, 1);
  assert.equal(bodies, 0);
  save.dispose();
});

for (const code of [
  "RESPONSE_NOT_JSON",
  "RESPONSE_EMPTY",
  "RESPONSE_INVALID_JSON",
  "AUTH_REQUIRED",
  "HTTP_ERROR",
  "NETWORK_TIMEOUT",
  "NETWORK_FAILED",
]) {
  test(`ambiguous ${code} queries the committed receipt without replacing command identity`, async () => {
    const { save, client, calls } = setup();
    client.executeManuscript = async (command) => {
      calls.push(command);
      throw new TransportError(code, 200, "a".repeat(32));
    };
    const queries = [];
    client.commandReceipt = async (requestId) => {
      queries.push(requestId);
      return receipt(calls[0]);
    };
    save.update(local(save, "committed once"));
    assert.equal(await save.flush(), true);
    assert.equal(calls.length, 1);
    assert.deepEqual(queries, [calls[0].requestId]);
    assert.equal(save.status, "saved");
    save.dispose();
  });
}
test("uncertain transport receipt keeps its identity and queries again before explicit retry", async () => {
  const { save, client, calls } = setup();
  client.executeManuscript = async (command) => {
    calls.push(command);
    throw new TransportError("RESPONSE_INVALID_JSON", 200);
  };
  let available = false;
  const queries = [];
  client.commandReceipt = async (requestId) => {
    queries.push(requestId);
    if (!available) throw new TransportError("NETWORK_TIMEOUT");
    return receipt(calls[0]);
  };
  save.update(local(save, "pending"));
  assert.equal(await save.flush(), false);
  assert.equal(await save.flush(true), false);
  assert.equal(calls.length, 1);
  available = true;
  assert.equal(await save.flush(true), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(queries, Array(3).fill(calls[0].requestId));
  save.dispose();
});
test("only proven command absence allows replay with the identical original request", async () => {
  const { save, client, calls } = setup();
  client.executeManuscript = async (command) => {
    calls.push(command);
    if (calls.length === 1) throw new TransportError("NETWORK_FAILED");
    return receipt(command);
  };
  const queries = [];
  client.commandReceipt = async (requestId) => {
    queries.push(requestId);
    throw new ApiError("COMMAND_NOT_FOUND");
  };
  save.update(local(save, "pending"));
  assert.equal(await save.flush(), true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(queries, [calls[0].requestId]);
  save.dispose();
});
