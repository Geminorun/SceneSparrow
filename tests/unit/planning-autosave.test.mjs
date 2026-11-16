import test from "node:test";
import assert from "node:assert/strict";
import { Autosave } from "../../packages/editor-ui/src/editor/autosave.ts";
import { ApiError } from "../../packages/platform-client/src/index.ts";
import {
  PlanningAutosave,
  normalizePlanningLanguage,
} from "../../packages/editor-ui/src/editor/planning-autosave.ts";
const clone = structuredClone;
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
function fixture() {
  let document = {
    manuscriptId: crypto.randomUUID(),
    schemaVersion: 1,
    workspaceStage: "outline",
    workingRevision: 0,
    blocks: [],
  };
  let state = {
    revision: 0,
    content: {
      brief: {
        topic: "Topic",
        language: "zh-CN",
        audience: "",
        style: "",
        lengthHint: "",
      },
      nodes: [],
      instruction: "",
      evidence: [],
    },
    reserved: false,
    tasks: [],
  };
  let history = {
    workingRevision: 0,
    historyRevision: 0,
    cursor: 0,
    undoCount: 0,
    redoCount: 0,
    undoLabel: null,
    redoLabel: null,
  };
  const receipts = new Map();
  const commands = [];
  let gate,
    readGate,
    manuscriptGate,
    saveGate,
    lose = false;
  const client = {
    async readManuscript() {
      const value = clone(document);
      if (manuscriptGate) {
        const hold = manuscriptGate;
        manuscriptGate = null;
        await hold.promise;
      }
      return value;
    },
    async readHistory() {
      return clone(history);
    },
    async readPlanning() {
      const value = clone(state);
      if (readGate) {
        const hold = readGate;
        readGate = null;
        await hold.promise;
      }
      return value;
    },
    async commandReceipt(id) {
      if (lose) throw Error("lost");
      if (!receipts.has(id)) throw Error("COMMAND_NOT_FOUND");
      return clone(receipts.get(id));
    },
    async executeManuscript(command) {
      commands.push(clone(command));
      if (receipts.has(command.requestId))
        return clone(receipts.get(command.requestId));
      if (
        command.type === "SavePlanning" &&
        command.payload.content.brief.topic.length > 500
      )
        throw new ApiError("BRIEF_INVALID");
      if (command.type === "SavePlanning") {
        state.content = clone(command.payload.content);
        state.revision++;
        document.workingRevision++;
        history.workingRevision++;
        history.historyRevision++;
        history.cursor++;
        history.undoCount++;
      }
      if (command.type === "StartManualDraft") {
        document.workspaceStage = "draft";
        document.workingRevision++;
        history.workingRevision++;
        history.historyRevision++;
      }
      if (command.type === "CloseEditGroup") {
        history.historyRevision++;
      }
      const receipt = {
        requestId: command.requestId,
        workingRevision: document.workingRevision,
        blockRevisions: [],
        historyRevision: history.historyRevision,
        cursor: history.cursor,
        undoCount: history.undoCount,
        redoCount: history.redoCount,
        eventSequence: commands.length,
        normalized: false,
      };
      receipts.set(command.requestId, receipt);
      if (gate && command.type === "CloseEditGroup") {
        const hold = gate;
        gate = null;
        await hold.promise;
      }
      if (saveGate && command.type === "SavePlanning") {
        const hold = saveGate;
        saveGate = null;
        await hold.promise;
      }
      if (lose) throw Error("lost");
      return clone(receipt);
    },
  };
  const save = new Autosave(
    clone(document),
    crypto.randomUUID(),
    client,
    () => {},
    clone(history),
  );
  const planning = new PlanningAutosave(
    clone(state),
    save,
    client,
    "project",
    () => {},
  );
  return {
    save,
    planning,
    client,
    commands,
    get state() {
      return state;
    },
    setCloseGate(v) {
      gate = v;
    },
    setReadGate(v) {
      readGate = v;
    },
    setManuscriptGate(v) {
      manuscriptGate = v;
    },
    setSaveGate(v) {
      saveGate = v;
    },
    setLose(v) {
      lose = v;
    },
    dispose() {
      planning.dispose();
      save.dispose();
    },
  };
}
const topic = (f, text) =>
  f.planning.edit(
    {
      ...clone(f.planning.local),
      brief: { ...f.planning.local.brief, topic: text },
    },
    "brief:topic",
  );
test("planning IME never sends intermediate text and multiline key points persist", async () => {
  const f = fixture();
  try {
    f.planning.composition(true);
    topic(f, "中");
    assert.equal(await f.planning.flush(), false);
    assert.equal(f.commands.length, 0);
    topic(f, "中文 🐦");
    f.planning.composition(false);
    assert.equal(await f.planning.flush(), true);
    assert.equal(f.state.content.brief.topic, "中文 🐦");
    const node = {
      id: crypto.randomUUID(),
      revision: 0,
      depth: 0,
      title: "One",
      keyPoints: ["First line", "第二行"],
    };
    f.planning.edit(
      { ...clone(f.planning.local), nodes: [node] },
      "structure",
      true,
    );
    assert.equal(await f.planning.flush(), true);
    assert.deepEqual(f.state.content.nodes[0].keyPoints, [
      "First line",
      "第二行",
    ]);
  } finally {
    f.dispose();
  }
});
test("input entered during delayed group close is saved in a fresh group before flush returns", async () => {
  const f = fixture();
  try {
    topic(f, "A");
    await f.planning.flush(false);
    const hold = deferred();
    f.setCloseGate(hold);
    const closing = f.planning.flush();
    await new Promise((r) => setTimeout(r, 5));
    topic(f, "B");
    hold.resolve();
    assert.equal(await closing, true);
    assert.equal(f.state.content.brief.topic, "B");
    const saves = f.commands.filter((c) => c.type === "SavePlanning");
    assert.notEqual(
      saves[0].payload.group.groupId,
      saves[1].payload.group.groupId,
    );
  } finally {
    f.dispose();
  }
});
test("an older planning snapshot cannot overwrite a later acknowledged save", async () => {
  const f = fixture();
  try {
    const hold = deferred();
    f.setReadGate(hold);
    const refresh = f.planning.refresh();
    topic(f, "New acknowledged text");
    assert.equal(await f.planning.flush(), true);
    hold.resolve();
    await refresh;
    assert.equal(f.planning.local.brief.topic, "New acknowledged text");
    assert.equal(f.state.content.brief.topic, "New acknowledged text");
  } finally {
    f.dispose();
  }
});
test("uncertain committed planning save reuses the exact original command and advances the segment once", async () => {
  const f = fixture();
  try {
    topic(f, "A");
    f.setLose(true);
    assert.equal(await f.planning.flush(), false);
    const original = f.commands.find((c) => c.type === "SavePlanning");
    f.setLose(false);
    assert.equal(await f.planning.flush(true, true), true);
    assert.equal(f.state.revision, 1);
    assert.equal(f.planning.status, "saved");
    assert.equal(
      f.commands
        .filter((c) => c.type === "SavePlanning")
        .every((c) => c.requestId === original.requestId),
      true,
    );
    topic(f, "B");
    assert.equal(await f.planning.flush(), true);
    assert.equal(f.state.revision, 2);
  } finally {
    f.dispose();
  }
});
test("queued manual-start captures planning intent at dispatch and controlled close drains late input", async () => {
  const f = fixture();
  try {
    let hold = deferred();
    f.setManuscriptGate(hold);
    const resync = f.save.resync();
    await new Promise((r) => setTimeout(r, 5));
    const start = f.save.business((revision) => ({
      type: "StartManualDraft",
      requestId: crypto.randomUUID(),
      projectId: "project",
      expectedWorkingRevision: revision,
      payload: {},
    }));
    await new Promise((r) => setTimeout(r, 5));
    topic(f, "Late visible input");
    hold.resolve();
    await resync;
    assert.equal(await start, false);
    assert.equal(
      f.commands.some((c) => c.type === "StartManualDraft"),
      false,
    );
    await f.planning.flush();
    hold = deferred();
    f.setManuscriptGate(hold);
    const sync = f.save.resync();
    await new Promise((r) => setTimeout(r, 5));
    const close = f.save.controlledClose();
    await new Promise((r) => setTimeout(r, 5));
    topic(f, "Typed while close waits");
    hold.resolve();
    await sync;
    assert.equal(await close, true);
    assert.equal(f.state.content.brief.topic, "Typed while close waits");
  } finally {
    f.dispose();
  }
});
test("correcting a known planning validation rejection automatically resumes saving with a new identity", async () => {
  const f = fixture();
  try {
    topic(f, "x".repeat(501));
    assert.equal(await f.planning.flush(), false);
    assert.equal(f.planning.error, "BRIEF_INVALID");
    const rejected = f.commands.find((c) => c.type === "SavePlanning");
    topic(f, "Corrected");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(f.planning.status, "saved");
    assert.equal(f.state.content.brief.topic, "Corrected");
    assert.notEqual(
      f.commands.filter((c) => c.type === "SavePlanning").at(-1).requestId,
      rejected.requestId,
    );
  } finally {
    f.dispose();
  }
});
test("IME beginning during an older save receipt never queues intermediate composition", async () => {
  const f = fixture();
  try {
    const hold = deferred();
    f.setSaveGate(hold);
    topic(f, "A");
    const saving = f.planning.flush();
    await new Promise((r) => setTimeout(r, 5));
    f.planning.composition(true);
    topic(f, "中");
    hold.resolve();
    assert.equal(await saving, false);
    topic(f, "中文");
    f.planning.composition(false);
    assert.equal(await f.planning.flush(), true);
    assert.deepEqual(
      f.commands
        .filter((c) => c.type === "SavePlanning")
        .map((c) => c.payload.content.brief.topic),
      ["A", "中文"],
    );
  } finally {
    f.dispose();
  }
});

test("discard refuses an ambiguous uncommitted write and retains its exact identity and newer draft", async () => {
  const f = fixture();
  try {
    let command;
    f.client.executeManuscript = async (value) => {
      command = clone(value);
      throw Error("offline before commit");
    };
    f.client.commandReceipt = async () => {
      throw Error("offline");
    };
    topic(f, "Original uncertain write");
    assert.equal(await f.planning.flush(), false);
    topic(f, "Newer private draft");
    assert.equal(await f.planning.discard(), false);
    assert.equal(f.planning.local.brief.topic, "Newer private draft");
    assert.equal(f.save.hasUnresolvedBusiness, true);
    assert.equal(await f.save.reload(), false);
    assert.equal(f.state.content.brief.topic, "Topic");
    assert.equal(
      command.payload.content.brief.topic,
      "Original uncertain write",
    );
    // The original request can still land after the refused discard.
    f.state.content = clone(command.payload.content);
    assert.equal(f.planning.local.brief.topic, "Newer private draft");
  } finally {
    f.dispose();
  }
});
test("plan-only discard preserves an invalid body buffer and its recovery status", async () => {
  const f = fixture();
  try {
    f.save.invalidate("DOCUMENT_INVALID", "Private invalid body");
    topic(f, "Unsaved plan");
    assert.equal(await f.planning.discard(), true);
    assert.equal(f.planning.local.brief.topic, "Topic");
    assert.equal(f.save.recoveryText, "Private invalid body");
    assert.equal(f.save.status, "error");
    assert.equal(f.save.error, "DOCUMENT_INVALID");
  } finally {
    f.dispose();
  }
});
test("composition without an input event fences refresh and resumes pending body autosave", async () => {
  const f = fixture();
  try {
    const hold = deferred();
    f.setReadGate(hold);
    const reading = f.planning.refresh();
    f.planning.composition(true);
    hold.resolve();
    await reading;
    assert.equal(f.save.composing, true);
    let flushes = 0;
    const flush = f.save.flush.bind(f.save);
    f.save.flush = (...args) => {
      flushes++;
      return flush(...args);
    };
    f.planning.composition(false);
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(f.save.composing, false);
    assert.ok(flushes > 0);
  } finally {
    f.dispose();
  }
});
test("unsafe planning actions wait for composition end without disabling inputs", async () => {
  const f = fixture();
  try {
    let actions = 0;
    f.planning.composition(true);
    f.planning.afterComposition(() => actions++);
    assert.equal(actions, 0);
    topic(f, "Final IME text");
    f.planning.composition(false);
    await Promise.resolve();
    assert.equal(actions, 1);
    assert.equal(f.planning.local.brief.topic, "Final IME text");
  } finally {
    f.dispose();
  }
});

test("a refresh begun before discard cannot replace the newer discarded-to plan", async () => {
  const f = fixture();
  try {
    const hold = deferred();
    f.setReadGate(hold);
    const refresh = f.planning.refresh();
    f.state.content.brief.topic = "Newer canonical plan";
    assert.equal(await f.planning.discard(), true);
    hold.resolve();
    await refresh;
    assert.equal(f.planning.local.brief.topic, "Newer canonical plan");
    assert.equal(f.planning.status, "saved");
  } finally {
    f.dispose();
  }
});

test("a plan blocked before dispatch retains pending segments and cannot take ownership of body errors", async () => {
  const f = fixture();
  try {
    f.save.invalidate("DOCUMENT_INVALID", "Private body text");
    topic(f, "Pending plan while body needs correction");
    assert.equal(await f.planning.flush(), false);
    assert.equal(f.planning.status, "pending");
    assert.equal(f.planning.error, "");
    assert.equal(f.commands.length, 0);
    assert.equal(f.save.error, "DOCUMENT_INVALID");
    f.save.update([]);
    assert.equal(await f.save.flush(true), true);
    assert.equal(await f.planning.flush(), true);
    assert.equal(
      f.state.content.brief.topic,
      "Pending plan while body needs correction",
    );
  } finally {
    f.dispose();
  }
});
test("known Chinese legacy aliases normalize without changing other stored manuscript languages", async () => {
  for (const alias of [
    "zh_CN",
    "zh-cn",
    "zh-Hans",
    "zh-Hans-CN",
    "Chinese",
    "中文",
  ])
    assert.equal(normalizePlanningLanguage(alias), "zh-CN");
  for (const language of ["en", "fr-CA", "en-US", "zh-TW", "x-private"])
    assert.equal(normalizePlanningLanguage(language), language);
  const f = fixture();
  try {
    f.state.content.brief.language = "zh";
    assert.equal(await f.planning.discard(), true);
    assert.equal(f.planning.local.brief.language, "zh-CN");
    assert.equal(f.state.content.brief.language, "zh");
  } finally {
    f.dispose();
  }
});

test("a proven planning write with a failed read retries only the read, even after body failure with the same code", async () => {
  const f = fixture();
  try {
    const read = f.client.readPlanning;
    let fail = true;
    f.client.readPlanning = async () => {
      if (fail) throw new ApiError("STORAGE_UNAVAILABLE");
      return read();
    };
    topic(f, "Acknowledged plan");
    assert.equal(await f.planning.flush(false), false);
    assert.equal(f.save.status, "saved");
    assert.equal(f.planning.error, "STORAGE_UNAVAILABLE");
    f.save.invalidate("STORAGE_UNAVAILABLE", "Private body recovery");
    assert.equal(f.save.failureOwner, "manuscript");
    fail = false;
    await f.planning.refresh();
    assert.equal(f.planning.status, "error");
    assert.equal(f.planning.error, "STORAGE_UNAVAILABLE");
    assert.equal(f.planning.state.content.brief.topic, "Topic");
    assert.equal(f.planning.local.brief.topic, "Acknowledged plan");
    assert.equal(f.save.failureOwner, "manuscript");
    assert.equal(await f.planning.flush(false, true), true);
    assert.equal(
      f.commands.filter((command) => command.type === "SavePlanning").length,
      1,
    );
    assert.equal(f.planning.local.brief.topic, "Acknowledged plan");
    assert.equal(f.save.error, "STORAGE_UNAVAILABLE");
    assert.equal(f.save.failureOwner, "manuscript");
    assert.equal(f.save.recoveryText, "Private body recovery");
  } finally {
    f.dispose();
  }
});
test("refresh still conflicts on different canonical content after an acknowledged plan read failure", async () => {
  const f = fixture();
  try {
    const read = f.client.readPlanning;
    f.client.readPlanning = async () => {
      throw new ApiError("STORAGE_UNAVAILABLE");
    };
    topic(f, "Acknowledged plan");
    assert.equal(await f.planning.flush(false), false);
    f.client.readPlanning = read;
    f.state.content.brief.topic = "External canonical plan";
    f.state.revision++;
    await f.planning.refresh();
    assert.equal(f.planning.status, "conflict");
    assert.equal(f.planning.error, "REVISION_CONFLICT");
    assert.equal(f.planning.local.brief.topic, "Acknowledged plan");
    assert.equal(await f.planning.flush(false, true), false);
    assert.equal(
      f.commands.filter((command) => command.type === "SavePlanning").length,
      1,
    );
  } finally {
    f.dispose();
  }
});
test("discard serializes a later navigation intent and fences adoption if shared history changes during its read", async () => {
  const f = fixture();
  try {
    topic(f, "Private plan before discard");
    const held = deferred();
    f.setReadGate(held);
    const discarding = f.planning.discard();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const navigation = f.save.navigate("UndoProject", () => {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      f.commands.some((command) => command.type === "UndoProject"),
      false,
    );
    f.save.history.historyRevision++;
    held.resolve();
    assert.equal(await discarding, false);
    // A shared epoch changed; the held snapshot cannot mark the private plan saved.
    assert.equal(f.planning.local.brief.topic, "Private plan before discard");
    await navigation;
    assert.equal(f.state.content.brief.topic, f.planning.local.brief.topic);
  } finally {
    f.dispose();
  }
});
