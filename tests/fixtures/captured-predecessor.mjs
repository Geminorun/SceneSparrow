import assert from "node:assert/strict";
import { ProjectSession } from "../../packages/editor-ui/src/project-session/project-session.ts";
import { ApplicationPreferencesStore } from "../../packages/editor-ui/src/app-preferences.ts";
import { ApiError } from "../../packages/platform-client/src/index.ts";
const mode = process.argv[2],
  id = () => crypto.randomUUID();
const state = {
  manuscriptId: id(),
  schemaVersion: 1,
  workspaceStage: "draft",
  workingRevision: 1,
  blocks: [
    {
      id: id(),
      kind: "paragraph",
      attrs: {},
      runs: [{ text: "Initial", marks: [] }],
      revision: 1,
    },
  ],
};
const calls = [];
let enter, release;
const entered = new Promise((resolve) => (enter = resolve)),
  held = new Promise((resolve) => (release = resolve));
const client = {
  async executeManuscript(command) {
    calls.push(command);
    if (
      command.type === "ApplyDocumentEdit" &&
      calls.filter((c) => c.type === "ApplyDocumentEdit").length === 1
    ) {
      enter();
      await held;
    }
    return {
      requestId: command.requestId,
      workingRevision:
        command.expectedWorkingRevision +
        (command.type === "CloseEditGroup" ? 0 : 1),
      blockRevisions: (command.payload.expectedBlockRevisions ?? []).map(
        (b) => ({ ...b, revision: b.revision + 1 }),
      ),
      historyRevision:
        command.type === "CloseEditGroup"
          ? command.expectedHistoryRevision + 1
          : 0,
      cursor: 0,
      undoCount: 0,
      redoCount: 0,
      eventSequence: 1,
      normalized: false,
    };
  },
  async readManuscript() {
    return state;
  },
  async readHistory() {
    return { ...save.history, workingRevision: save.state.workingRevision };
  },
  async commandReceipt() {
    throw new ApiError("COMMAND_NOT_FOUND");
  },
};
const prefs = new ApplicationPreferencesStore(null);
prefs.update({ saveMode: "off" });
const save = new ProjectSession(
  state,
  id(),
  client,
  () => {},
  undefined,
  prefs,
);
const input = (text) =>
  save.update(save.local.map((b) => ({ ...b, runs: [{ text, marks: [] }] })));
let builds = 0;
const build = (revision) => {
  builds++;
  return {
    type: "SetUserLocks",
    requestId: id(),
    projectId: save.projectId,
    expectedWorkingRevision: revision,
    payload: { locked: true, all: true, blockIds: [] },
  };
};
try {
  input("A predecessor");
  const noop = mode === "noop" || mode === "multiple-noops";
  const predecessor =
    mode === "prepare"
      ? save.prepareInput()
      : mode === "manual"
        ? save.manualSave()
        : mode === "business"
          ? save.business(build)
          : mode === "preserving-business"
            ? save.businessCore(build, { bodyPreserving: true })
            : save.flush();
  await entered;
  if (mode === "multiple-noops")
    for (let n = 0; n < 3; n++) {
      input("A predecessor");
      await save.boundary();
    }
  if (!noop) input("B captured");
  let copied;
  const capturing = save.capturedAction("bounded-predecessor", async () => {
    copied = save.state.blocks[0].runs[0].text;
    return true;
  });
  input("C later");
  release();
  assert.equal(await predecessor, noop);
  assert.equal(await capturing, true);
  assert.equal(copied, noop ? "A predecessor" : "B captured");
  assert.equal(save.local[0].runs[0].text, "C later");
  assert.equal(save.status, "pending");
  assert.equal(builds, 0);
  assert.equal(
    calls.filter((c) => c.type === "ApplyDocumentEdit").length,
    noop ? 1 : 2,
  );
  console.log(
    JSON.stringify({
      mode,
      copied,
      status: save.status,
      writes: calls.filter((c) => c.type === "ApplyDocumentEdit").length,
    }),
  );
} finally {
  release();
  save.dispose();
}
