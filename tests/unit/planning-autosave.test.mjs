import test from "node:test";
import assert from "node:assert/strict";
import { ApplicationPreferencesStore } from "../../packages/editor-ui/src/app-preferences.ts";
import { ProjectSession } from "../../packages/editor-ui/src/project-session/project-session.ts";
import { ApiError } from "../../packages/platform-client/src/index.ts";
import {
  PlanningAutosave,
  normalizePlanningLanguage,
} from "../../packages/editor-ui/src/planning/planning-autosave.ts";
const clone = structuredClone;
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
function fixture(preferences) {
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
      if (command.type === "ApplyDocumentEdit") {
        for (const op of command.payload.operations) {
          if (op.op === "insertBlock")
            document.blocks.push({ ...clone(op.block), revision: 1 });
          else if (op.op === "setBlockContent") {
            const block = document.blocks.find((b) => b.id === op.blockId);
            block.runs = clone(op.runs);
            block.revision++;
          }
        }
        document.workspaceStage = "draft";
        document.workingRevision++;
        history.workingRevision++;
        history.historyRevision++;
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
  const save = new ProjectSession(
    clone(document),
    crypto.randomUUID(),
    client,
    () => {},
    clone(history),
    preferences,
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
test("correcting a known planning validation rejection automatically resumes saving with a new identity", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
  const f = fixture();
  try {
    topic(f, "x".repeat(501));
    assert.equal(await f.planning.flush(), false);
    assert.equal(f.planning.error, "BRIEF_INVALID");
    const rejected = f.commands.find((c) => c.type === "SavePlanning");
    topic(f, "Corrected");
    context.mock.timers.tick(10000);
    for (let n = 0; n < 100; n++) await Promise.resolve();
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
test("composition without an input event fences refresh and resumes pending body autosave", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
  const f = fixture();
  try {
    f.save.update([
      {
        id: crypto.randomUUID(),
        kind: "paragraph",
        attrs: {},
        runs: [{ text: "Pending body", marks: [] }],
      },
    ]);
    const hold = deferred();
    f.setReadGate(hold);
    const reading = f.planning.refresh();
    f.planning.composition(true);
    hold.resolve();
    await reading;
    context.mock.timers.tick(20000);
    assert.equal(f.commands.length, 0);
    f.planning.composition(false);
    context.mock.timers.tick(10000);
    for (let n = 0; n < 100; n++) await Promise.resolve();
    assert.equal(f.save.composing, false);
    assert.ok(f.commands.some((c) => c.type === "ApplyDocumentEdit"));
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
    await new Promise((resolve) => setTimeout(resolve, 5));
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

for (const seconds of [5, 10, 30])
  test(`planning shares ${seconds}s save policy and never flushes body early`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
    const prefs = new ApplicationPreferencesStore(() => undefined);
    prefs.update({ saveDelaySeconds: seconds });
    const f = fixture(prefs);
    try {
      topic(f, "plan");
      context.mock.timers.tick(seconds * 1000 - 1000);
      f.save.update([
        {
          id: crypto.randomUUID(),
          kind: "paragraph",
          attrs: {},
          runs: [{ text: "later body", marks: [] }],
        },
      ]);
      context.mock.timers.tick(seconds * 1000 - 1);
      for (let n = 0; n < 100; n++) await Promise.resolve();
      assert.equal(f.commands.length, 0);
      context.mock.timers.tick(1);
      for (let n = 0; n < 200; n++) await Promise.resolve();
      assert.equal(f.planning.status, "saved");
      assert.equal(f.save.status, "saved");
      assert.ok(f.commands.some((c) => c.type === "SavePlanning"));
      assert.ok(f.commands.some((c) => c.type === "ApplyDocumentEdit"));
    } finally {
      f.dispose();
    }
  });
test("new body and planning input during a scheduled planning save wait for their delay", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
  const f = fixture();
  const hold = deferred();
  try {
    topic(f, "old plan");
    f.setSaveGate(hold);
    context.mock.timers.tick(10000);
    for (let n = 0; n < 100; n++) await Promise.resolve();
    assert.equal(f.commands.filter((c) => c.type === "SavePlanning").length, 1);
    topic(f, "new plan");
    f.save.update([
      {
        id: crypto.randomUUID(),
        kind: "paragraph",
        attrs: {},
        runs: [{ text: "new body", marks: [] }],
      },
    ]);
    context.mock.timers.tick(1000);
    hold.resolve();
    for (let n = 0; n < 200; n++) await Promise.resolve();
    assert.equal(f.commands.filter((c) => c.type === "SavePlanning").length, 1);
    assert.equal(
      f.commands.filter((c) => c.type === "ApplyDocumentEdit").length,
      0,
    );
    assert.equal(f.planning.status, "pending");
    context.mock.timers.tick(8999);
    for (let n = 0; n < 100; n++) await Promise.resolve();
    assert.equal(f.commands.filter((c) => c.type === "SavePlanning").length, 1);
    context.mock.timers.tick(1);
    for (let n = 0; n < 300; n++) await Promise.resolve();
    assert.equal(f.planning.status, "saved");
    assert.equal(f.save.status, "saved");
    assert.equal(f.state.content.brief.topic, "new plan");
  } finally {
    hold.resolve();
    f.dispose();
  }
});
test("planning off mode bounds unsent groups while preserving an unresolved captured payload", async () => {
  const prefs = new ApplicationPreferencesStore(() => undefined);
  prefs.update({ saveMode: "off" });
  const f = fixture(prefs),
    hold = deferred();
  try {
    topic(f, "original");
    f.setSaveGate(hold);
    const writing = f.planning.flush();
    for (let n = 0; n < 100; n++) await Promise.resolve();
    const original = f.planning.pendingSave;
    for (let n = 0; n < 100; n++) {
      f.planning.edit(
        { ...structuredClone(f.planning.local), instruction: `edit ${n}` },
        `scope:${n}`,
        true,
      );
      assert.ok(f.planning.segments.length <= 7);
      assert.equal(f.planning.pendingSave, original);
      assert.equal(f.planning.segments[0].content.brief.topic, "original");
    }
    hold.resolve();
    assert.equal(await writing, true);
    assert.equal(f.state.content.instruction, "edit 99");
  } finally {
    hold.resolve();
    f.dispose();
  }
});

test("failed planning read is not retried by background timers and healthy body still saves", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
  const f = fixture();
  let reads = 0;
  const read = f.client.readPlanning;
  f.client.readPlanning = async () => {
    reads++;
    throw Error("STORAGE_UNAVAILABLE");
  };
  try {
    topic(f, "Committed plan");
    context.mock.timers.tick(10000);
    for (let n = 0; n < 100; n++) await Promise.resolve();
    assert.equal(f.planning.status, "error");
    assert.equal(reads, 1);
    context.mock.timers.tick(120000);
    for (let n = 0; n < 100; n++) await Promise.resolve();
    assert.equal(reads, 1);
    f.save.update([
      {
        id: crypto.randomUUID(),
        kind: "paragraph",
        attrs: {},
        runs: [{ text: "Healthy body", marks: [] }],
      },
    ]);
    context.mock.timers.tick(9999);
    for (let n = 0; n < 100; n++) await Promise.resolve();
    assert.equal(
      f.commands.filter((c) => c.type === "ApplyDocumentEdit").length,
      0,
    );
    context.mock.timers.tick(1);
    for (let n = 0; n < 100; n++) await Promise.resolve();
    assert.equal(f.save.status, "saved");
    assert.equal(f.planning.status, "error");
    assert.equal(reads, 1);
    f.client.readPlanning = read;
    assert.equal(await f.planning.flush(true, true), true);
    assert.equal(f.commands.filter((c) => c.type === "SavePlanning").length, 1);
  } finally {
    f.dispose();
  }
});
test("an unknown planning receipt fences new body background writes", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
  const f = fixture();
  try {
    topic(f, "Unknown plan");
    f.setLose(true);
    context.mock.timers.tick(10000);
    for (let n = 0; n < 100; n++) await Promise.resolve();
    assert.equal(f.save.hasUnresolvedBusiness, true);
    f.save.update([
      {
        id: crypto.randomUUID(),
        kind: "paragraph",
        attrs: {},
        runs: [{ text: "Fenced body", marks: [] }],
      },
    ]);
    context.mock.timers.tick(120000);
    for (let n = 0; n < 100; n++) await Promise.resolve();
    assert.equal(
      f.commands.filter((c) => c.type === "ApplyDocumentEdit").length,
      0,
    );
    assert.equal(f.save.local[0].runs[0].text, "Fenced body");
  } finally {
    f.dispose();
  }
});

test("planning-only held receipt and group close leave newer body input for its own delay", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
  const f = fixture(),
    hold = deferred();
  try {
    topic(f, "Original plan");
    f.setSaveGate(hold);
    context.mock.timers.tick(10000);
    for (let n = 0; n < 100; n++) await Promise.resolve();
    f.save.update([
      {
        id: crypto.randomUUID(),
        kind: "paragraph",
        attrs: {},
        runs: [{ text: "New body during plan receipt", marks: [] }],
      },
    ]);
    context.mock.timers.tick(1000);
    hold.resolve();
    for (let n = 0; n < 200; n++) await Promise.resolve();
    assert.equal(
      f.commands.filter((c) => c.type === "ApplyDocumentEdit").length,
      0,
    );
    assert.equal(f.save.status, "pending");
    context.mock.timers.tick(8999);
    for (let n = 0; n < 100; n++) await Promise.resolve();
    assert.equal(
      f.commands.filter((c) => c.type === "ApplyDocumentEdit").length,
      0,
    );
    context.mock.timers.tick(1);
    for (let n = 0; n < 200; n++) await Promise.resolve();
    assert.equal(f.save.status, "saved");
    assert.equal(
      f.commands.filter((c) => c.type === "ApplyDocumentEdit").length,
      1,
    );
  } finally {
    hold.resolve();
    f.dispose();
  }
});

test("invalid outline blocks stale plan saves and controls, including unrelated brief/evidence edits", async () => {
  const f = fixture();
  try {
    f.planning.editOutline([
      {
        id: crypto.randomUUID(),
        revision: 0,
        depth: 0,
        title: "Valid",
        keyPoints: [],
      },
    ]);
    await f.planning.flush();
    const before = f.commands.length;
    f.planning.invalidate("# Valid\nunsupported local text");
    assert.equal(f.planning.status, "pending");
    assert.equal(f.planning.error, "");
    const invalidIdentity = f.planning.identity();
    topic(f, "New brief while outline is invalid");
    f.planning.edit(
      {
        ...clone(f.planning.local),
        evidence: [
          {
            sourceId: crypto.randomUUID(),
            mode: "link_only",
            start: 0,
            end: 0,
            visualId: null,
            allowUnknownImages: false,
          },
        ],
      },
      "evidence",
      true,
    );
    assert.equal(f.planning.recoveryText, "# Valid\nunsupported local text");
    assert.notEqual(f.planning.identity(), invalidIdentity);
    assert.equal(await f.planning.flush(), false);
    assert.equal(
      await f.planning.control(() => {
        throw Error("stale dispatch");
      }),
      false,
    );
    assert.equal(f.planning.status, "error");
    assert.equal(f.commands.length, before);
    await f.planning.refresh();
    assert.equal(f.planning.recoveryText, "# Valid\nunsupported local text");
    f.planning.editOutline([
      { ...f.planning.local.nodes[0], title: "Corrected" },
    ]);
    assert.equal(f.planning.recoveryText, null);
    assert.equal(await f.planning.flush(), true);
    assert.equal(f.state.content.nodes[0].title, "Corrected");
    assert.equal(
      f.state.content.brief.topic,
      "New brief while outline is invalid",
    );
  } finally {
    f.dispose();
  }
});

test("invalid outline retains raw input across a late acknowledged valid receipt and discard restores canonical content", async () => {
  const f = fixture();
  try {
    const gate = deferred();
    f.setSaveGate(gate);
    f.planning.editOutline([
      {
        id: crypto.randomUUID(),
        revision: 0,
        depth: 0,
        title: "Saved heading",
        keyPoints: [],
      },
    ]);
    const saving = f.planning.flush(false);
    await new Promise((resolve) => setTimeout(resolve, 5));
    f.planning.invalidate("#");
    gate.resolve();
    await saving;
    assert.equal(f.planning.recoveryText, "#");
    assert.equal(f.planning.status, "pending");
    assert.equal(await f.planning.flush(), false);
    assert.equal(await f.planning.discard(), true);
    assert.equal(f.planning.recoveryText, null);
    assert.equal(f.planning.local.nodes[0].title, "Saved heading");
  } finally {
    f.dispose();
  }
});

test("explicit planning cancellation remains possible while an invalid outline is retained", async () => {
  const f = fixture();
  try {
    f.planning.invalidate("# Unfinished\nunsupported syntax");
    const ok = await f.save.cancelOrUnlock({
      type: "CancelPlanningTask",
      requestId: crypto.randomUUID(),
      projectId: "project",
      expectedWorkingRevision: 0,
      payload: { taskId: crypto.randomUUID() },
    });
    assert.equal(ok, true);
    assert.equal(f.planning.recoveryText, "# Unfinished\nunsupported syntax");
    assert.equal(
      f.commands.filter((command) => command.type === "SavePlanning").length,
      0,
    );
    assert.equal(
      f.commands.filter((command) => command.type === "CancelPlanningTask")
        .length,
      1,
    );
  } finally {
    f.dispose();
  }
});

test("clean review input clears only its local unsent-history guard without commands or receipt changes", async () => {
  const f = fixture();
  try {
    let dirty = true;
    f.save.reviewDirty = () => dirty;
    assert.equal(await f.save.navigate("UndoProject", () => {}), false);
    assert.equal(f.save.operationError.code, "UNSENT_REVIEW");
    f.save.reviewInputChanged();
    assert.equal(f.save.operationError.code, "UNSENT_REVIEW");
    dirty = false;
    f.save.reviewInputChanged();
    assert.equal(f.save.operationError, null);
    f.save.operationError = { code: "REVISION_CONFLICT", details: undefined };
    f.save.reviewInputChanged();
    assert.equal(f.save.operationError.code, "REVISION_CONFLICT");
    assert.equal(f.commands.length, 0);
  } finally {
    f.dispose();
  }
});
