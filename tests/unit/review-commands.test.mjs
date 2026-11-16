import test from "node:test";
import assert from "node:assert/strict";
import { Autosave } from "../../packages/editor-ui/src/editor/autosave.ts";
import { ReviewCommands } from "../../packages/editor-ui/src/editor/review-commands.ts";
import { ApiError } from "../../packages/platform-client/src/index.ts";
function fixture() {
  const document = {
    manuscriptId: crypto.randomUUID(),
    schemaVersion: 1,
    workspaceStage: "draft",
    workingRevision: 0,
    blocks: [],
  };
  let revision = 0,
    lose = false,
    reject = "";
  const receipts = new Map(),
    calls = [],
    lookups = [],
    mutations = [];
  const client = {
    async executeManuscript(c) {
      calls.push(structuredClone(c));
      if (reject) throw new ApiError(reject);
      if (!receipts.has(c.requestId)) {
        if (c.type === "SaveReview") {
          revision++;
          mutations.push(c);
        }
        receipts.set(c.requestId, {
          requestId: c.requestId,
          workingRevision: revision,
          blockRevisions: [],
          historyRevision: revision,
          cursor: revision,
          undoCount: revision,
          redoCount: 0,
          eventSequence: revision,
          normalized: false,
        });
      }
      if (lose) throw Error("response lost");
      return receipts.get(c.requestId);
    },
    async commandReceipt(id) {
      lookups.push(id);
      if (lose) throw Error("lookup unavailable");
      if (!receipts.has(id)) throw new ApiError("COMMAND_NOT_FOUND");
      return receipts.get(id);
    },
    async readManuscript() {
      return { ...document, workingRevision: revision };
    },
    async readHistory() {
      return {
        workingRevision: revision,
        historyRevision: revision,
        cursor: revision,
        undoCount: revision,
        redoCount: 0,
        undoLabel: null,
        redoLabel: null,
      };
    },
  };
  const save = new Autosave(document, crypto.randomUUID(), client, () => {}),
    review = new ReviewCommands(save);
  const build = (rev) => ({
    type: "SaveReview",
    requestId: crypto.randomUUID(),
    projectId: save.projectId ?? crypto.randomUUID(),
    expectedWorkingRevision: rev,
    payload: { thread: { id: crypto.randomUUID() }, expectedRequestVersion: 0 },
  });
  return {
    save,
    review,
    build,
    calls,
    lookups,
    mutations,
    advance() {
      revision++;
    },
    setLose(v) {
      lose = v;
    },
    setReject(v) {
      reject = v;
    },
  };
}
test("uncertain committed review save resolves its exact receipt without resubmitting the command", async () => {
  const f = fixture();
  f.setLose(true);
  assert.equal((await f.review.run("composer:1", f.build)).ok, false);
  assert.equal(f.mutations.length, 1);
  const original = f.calls[0];
  f.setLose(false);
  assert.equal(
    (
      await f.review.run("composer:1", () => {
        throw Error("new builder must not run");
      })
    ).ok,
    true,
  );
  assert.equal(f.mutations.length, 1);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.lookups, [original.requestId, original.requestId]);
  f.save.dispose();
});
test("settling an older review action never evaluates or reports success for a new intent", async () => {
  const f = fixture();
  f.setLose(true);
  await f.review.run("composer:old", f.build);
  f.setLose(false);
  let builds = 0;
  const result = await f.review.run("composer:new", () => {
    builds++;
    return f.build(1);
  });
  assert.equal(result.ok, false);
  assert.ok(result.completed);
  assert.equal(builds, 0);
  assert.equal(f.mutations.length, 1);
  assert.equal((await f.review.run("composer:new", f.build)).ok, true);
  assert.equal(f.mutations.length, 2);
  f.save.dispose();
});
test("owned known context rejection allows explicit correction without clearing a body conversion error", async () => {
  const f = fixture();
  f.setReject("CONTEXT_LIMIT");
  const result = await f.review.run("start:a", f.build);
  assert.equal(result.error, "CONTEXT_LIMIT");
  assert.equal(f.save.status, "saved");
  f.setReject("");
  assert.equal((await f.review.run("start:b", f.build)).ok, true);
  f.save.invalidate("DOCUMENT_INVALID", "invalid visible buffer");
  let called = false;
  assert.equal(
    (
      await f.review.run("start:c", () => {
        called = true;
        return f.build(1);
      })
    ).ok,
    false,
  );
  assert.equal(called, false);
  assert.equal(f.save.status, "error");
  assert.equal(f.save.error, "DOCUMENT_INVALID");
  f.save.dispose();
});

test("known committed receipt survives unrelated revision before replay without duplicating its thread", async () => {
  const f = fixture();
  f.setLose(true);
  await f.review.run("composer:1", f.build);
  f.setLose(false);
  f.advance();
  const result = await f.review.run("composer:1", () => {
    throw Error("must replay original saved thread");
  });
  assert.equal(result.ok, true);
  assert.equal(f.mutations.length, 1);
  assert.equal(f.save.state.workingRevision, 2);
  f.save.dispose();
});

test("known reserved-history rejection leaves explicit review cancellation usable", async () => {
  const f = fixture();
  f.save.history = { ...f.save.history, undoCount: 1, cursor: 1 };
  f.setReject("HISTORY_BLOCKED");
  assert.equal(await f.save.navigate("UndoProject", () => {}), false);
  assert.equal(f.save.status, "saved");
  assert.equal(f.save.operationError.code, "HISTORY_BLOCKED");
  f.setReject("");
  assert.equal((await f.review.run("cancel:a", f.build)).ok, true);
  f.save.dispose();
});

test("proven review receipt never replaces newer local body input while reconciling", async () => {
  const f = fixture();
  f.setLose(true);
  await f.review.run("composer:1", f.build);
  f.setLose(false);
  const local = [
    {
      id: crypto.randomUUID(),
      kind: "paragraph",
      attrs: {},
      runs: [{ text: "Still visible", marks: [] }],
    },
  ];
  f.save.update(local);
  const result = await f.review.run("composer:1", () => {
    throw Error("must retain original");
  });
  assert.equal(result.ok, false);
  assert.equal(f.save.status, "conflict");
  assert.deepEqual(f.save.local, local);
  await f.review.run("composer:1", () => {
    throw Error("no duplicate");
  });
  assert.equal(f.mutations.length, 1);
  assert.deepEqual(f.save.local, local);
  f.save.dispose();
});

test("simultaneous identical review submissions reserve the intent before queued dispatch", async () => {
  const f = fixture();
  let builds = 0;
  const first = f.review.run("same", (rev) => {
    builds++;
    return f.build(rev);
  });
  const second = f.review.run("same", () => {
    throw Error("duplicate builder");
  });
  assert.equal(first, second);
  const results = await Promise.all([first, second]);
  assert.ok(results.every((r) => r.ok));
  assert.equal(builds, 1);
  assert.equal(f.mutations.length, 1);
  f.save.dispose();
});
test("simultaneous lost-response submissions retain one identity and a different intent cannot run", async () => {
  const f = fixture();
  f.setLose(true);
  const first = f.review.run("same", f.build),
    duplicate = f.review.run("same", () => {
      throw Error("duplicate");
    }),
    different = f.review.run("new", () => {
      throw Error("new intent must wait");
    });
  await Promise.all([first, duplicate, different]);
  assert.equal(f.mutations.length, 1);
  f.setLose(false);
  assert.equal(
    (
      await f.review.run("same", () => {
        throw Error("retry must replay");
      })
    ).ok,
    true,
  );
  assert.equal(f.mutations.length, 1);
  f.save.dispose();
});
