import test from "node:test";
import assert from "node:assert/strict";
import { Autosave } from "../../packages/editor-ui/src/editor/autosave.ts";
import { ApiError } from "../../packages/platform-client/src/index.ts";
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
    workingRevision: c.expectedWorkingRevision + 1,
    blockRevisions: c.payload.expectedBlockRevisions.map((b) => ({
      ...b,
      revision: b.revision + 1,
    })),
    historyRevision: 0,
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
  client.commandReceipt = async () => {
    throw new ApiError("SERVICE_UNAVAILABLE");
  };
  save.update(local(save, "committed once"));
  assert.equal(await save.flush(), false);
  save.update(local(save, "new buffered text"));
  assert.equal(await save.flush(true), true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1], calls[0]);
  assert.notEqual(calls[2].requestId, calls[0].requestId);
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
  save.invalidate("DOCUMENT_TOO_LARGE", "oversized current buffer");
  release();
  assert.equal(await pending, false);
  assert.equal(save.state.workingRevision, 2);
  assert.equal(save.status, "error");
  assert.equal(save.recoveryText, "oversized current buffer");
  assert.equal(await save.flush(true), false);
  save.dispose();
});
