import test from "node:test";
import assert from "node:assert/strict";
import {
  rawEditorMap,
  patchEditorSource,
  rebaseSourceAcknowledgment,
  captureSourceSelection,
} from "../../packages/manuscript-format/src/editor-source.ts";
import { readSourceDocument } from "../../packages/manuscript-format/src/source.ts";
import { ProjectSession } from "../../packages/editor-ui/src/project-session/project-session.ts";
import { ApplicationPreferencesStore } from "../../packages/editor-ui/src/app-preferences.ts";
const marker =
  "<!-- scenesparrow:block=11111111-1111-4111-8111-111111111111 -->\r\n\r\n";
test("normalized editor patches preserve BOM and untouched mixed endings", () => {
  const raw = "\uFEFFAlpha\r\nBeta\n中😀\rLast";
  const map = rawEditorMap(raw);
  assert.equal(map.text, "Alpha\nBeta\n中😀\nLast");
  assert.equal(patchEditorSource(raw, []).raw, raw);
  assert.equal(
    patchEditorSource(raw, [{ from: 6, to: 10, insert: "Edited" }]).raw,
    "\uFEFFAlpha\r\nEdited\n中😀\rLast",
  );
  assert.equal(
    patchEditorSource(raw, [{ from: 2, to: 2, insert: "\nX" }]).raw,
    "\uFEFFAl\r\nXpha\r\nBeta\n中😀\rLast",
  );
  assert.throws(() => map.rawAt(13), /SOURCE_RANGE_INVALID/);
});
test("held acknowledgment maps metadata insertions through later bounded changes", () => {
  const sent = "Body\r\n",
    accepted = marker + sent;
  assert.equal(
    rebaseSourceAcknowledgment(
      sent,
      accepted,
      [[{ from: 4, to: 4, insert: " 后😀" }]],
      "Body 后😀\r\n",
    ),
    marker + "Body 后😀\r\n",
  );
  assert.throws(
    () => rebaseSourceAcknowledgment("Body", "Changed", [], "Later"),
    /SOURCE_ACK_AMBIGUOUS/,
  );
});
test("ACK identities never move to newly inserted headings or orphaned leaves", () => {
  const twoLeaves = "First\n\nSecond\n";
  assert.throws(
    () =>
      rebaseSourceAcknowledgment(
        twoLeaves,
        marker + twoLeaves,
        [[{ from: 0, to: twoLeaves.length, insert: "New\n\nFirst\n" }]],
        "New\n\nFirst\n",
      ),
    /SOURCE_ACK_AMBIGUOUS/,
  );
  for (const [patch, current] of [
    [
      { from: 0, to: 0, insert: "# New heading\n\n" },
      "# New heading\n\nBody\r\n",
    ],
    [{ from: 0, to: 4, insert: "" }, "\r\n"],
  ]) {
    assert.throws(
      () =>
        rebaseSourceAcknowledgment(
          "Body\r\n",
          marker + "Body\r\n",
          [[patch]],
          current,
        ),
      /SOURCE_ACK_AMBIGUOUS|SOURCE_IDENTITY_AMBIGUOUS/,
    );
  }
});
function scope(raw, text) {
  const document = readSourceDocument(raw);
  const state = {
    blocks: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        kind: "paragraph",
        attrs: {},
        runs: [{ text, marks: [] }],
        revision: 1,
      },
    ],
  };
  const bindings = document.blocks.map((b) => ({
    ...b,
    startUtf8: b.startUtf8,
    endUtf8: b.endUtf8,
    id: b.id ?? null,
    semanticEditable: true,
  }));
  return { state, bindings };
}
test("token selections decode marks links escapes entities Chinese and emoji without text search", () => {
  const raw =
    "\uFEFF" +
    marker +
    "Repeat **中😀** [same](https://example.com) \\* &amp; `code` Repeat\r\n";
  const { state, bindings } = scope(raw, "Repeat 中😀 same * & code Repeat");
  const from = raw.indexOf("中"),
    to = from + 3;
  assert.deepEqual(captureSourceSelection(raw, bindings, state, from, to), [
    {
      blockId: "11111111-1111-4111-8111-111111111111",
      text: "Repeat 中😀 same * & code Repeat",
      start: 7,
      end: 10,
      quote: "中😀",
      wholeBlock: false,
    },
  ]);
  const entity = raw.indexOf("&amp;");
  assert.equal(
    captureSourceSelection(raw, bindings, state, entity, entity + 5)[0].quote,
    "&",
  );
  assert.throws(
    () => captureSourceSelection(raw, bindings, state, from + 2, to),
    /SOURCE_SELECTION_UNSUPPORTED/,
  );
  assert.equal(
    captureSourceSelection(raw, bindings, state, from, to, true)[0].wholeBlock,
    true,
  );
});
test("unknown leaves refuse semantic capture while raw patches remain lossless", () => {
  const raw = marker + "<widget>unknown</widget>\r\n";
  const { state, bindings } = scope(raw, "unknown");
  assert.throws(
    () =>
      captureSourceSelection(
        raw,
        bindings,
        state,
        marker.length,
        raw.length,
        true,
      ),
    /SOURCE_SELECTION_UNSUPPORTED/,
  );
  assert.equal(
    patchEditorSource(raw, [
      {
        from: rawEditorMap(raw).text.indexOf("unknown"),
        to: rawEditorMap(raw).text.indexOf("unknown") + 7,
        insert: "retained",
      },
    ]).raw,
    marker + "<widget>retained</widget>\r\n",
  );
});
function sessionFixture() {
  let snapshot = {
    projectId: "p",
    workingRevision: 1,
    generation: 1,
    acceptedHash: "base",
    source: "Body\r\n",
    bindings: [],
    semanticBlockIds: [],
    externalStatus: "unchanged",
    externalHash: null,
  };
  let state = {
    manuscriptId: "m",
    schemaVersion: 1,
    workingRevision: 1,
    workspaceStage: "draft",
    blocks: [],
  };
  const calls = [];
  let release;
  const held = new Promise((r) => (release = r));
  const client = {
    saveAuthoredSource: async (request) => {
      calls.push(structuredClone(request));
      await held;
      snapshot = {
        ...snapshot,
        source: request.source.includes("<!-- scenesparrow:")
          ? request.source
          : marker + request.source,
        acceptedHash: "next",
        generation: snapshot.generation + 1,
        workingRevision: 2,
      };
      state = { ...state, workingRevision: 2 };
      return {
        snapshot,
        receipt: {
          requestId: request.requestId,
          workingRevision: 2,
          historyRevision: 1,
          cursor: 1,
          undoCount: 1,
          redoCount: 0,
          blockRevisions: [],
          eventSequence: 1,
        },
      };
    },
    executeManuscript: async (command) => ({
      requestId: command.requestId,
      workingRevision: state.workingRevision,
      historyRevision: 1,
      cursor: 1,
      undoCount: 1,
      redoCount: 0,
      blockRevisions: [],
      eventSequence: 1,
    }),
    readManuscript: async () => state,
    readHistory: async () => ({
      workingRevision: state.workingRevision,
      historyRevision: 1,
      cursor: 1,
      undoCount: 1,
      redoCount: 0,
    }),
  };
  const preferences = new ApplicationPreferencesStore(null);
  preferences.update({ saveMode: "off" });
  const save = new ProjectSession(
    state,
    "p",
    client,
    () => {},
    undefined,
    preferences,
  );
  save.initializeSource(snapshot);
  return { save, calls, release };
}
test("ProjectSession held ACK retains newer raw input and input identity without another dispatch", async () => {
  const { save, calls, release } = sessionFixture();
  try {
    save.updateSource([{ from: 0, to: 4, insert: "Edited" }]);
    const saving = save.flush();
    await new Promise((r) => setTimeout(r, 0));
    const identity = save.exportInputIdentity;
    save.composition(true);
    save.updateSource([{ from: 6, to: 6, insert: " 中文😀" }]);
    release();
    assert.equal(await saving, true);
    assert.equal(calls.length, 1);
    assert.equal(save.sourceLocal, "Edited 中文😀\r\n");
    assert.notEqual(save.exportInputIdentity, identity);
    assert.equal(save.hasLocalBodyChanges, true);
    save.updateSource([{ from: 11, to: 11, insert: "后" }]);
    save.composition(false);
    assert.equal(save.sourceLocal, marker + "Edited 中文😀后\r\n");
    assert.equal(save.status, "pending");
  } finally {
    save.dispose();
  }
});

test("source ACK drops acknowledged checkpoints and stages all retained mappings atomically", async () => {
  for (const ambiguous of [false, true]) {
    const { save, release } = sessionFixture();
    try {
      save.updateSource([{ from: 0, to: 4, insert: "Edited" }]);
      const saving = save.flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const sentGeneration = save.sourcePending.generation;
      save.updateSource([{ from: 6, to: 6, insert: " newer" }]);
      const newer = {
        blocks: [],
        source: "Edited newer\r\n",
        generation: sentGeneration + 1,
        group: "newer",
        kind: "typing",
      };
      const invalid = {
        ...newer,
        source: "# New heading\n\nEdited newer\r\n",
        generation: sentGeneration + 2,
        group: "invalid",
      };
      save.segments = [
        {
          ...newer,
          source: "<!-- scenesparrow:block=bad -->",
          generation: sentGeneration,
        },
        newer,
        ...(ambiguous ? [invalid] : []),
      ];
      const originals = structuredClone(save.segments.slice(1));
      release();
      assert.equal(await saving, !ambiguous);
      if (ambiguous) {
        assert.equal(save.status, "conflict");
        assert.equal(save.sourceLocal, "Edited newer\r\n");
        assert.equal(save.source.source, marker + "Edited\r\n");
        assert.deepEqual(save.segments, originals);
        assert.equal(save.hasUnresolvedSource, false);
      } else {
        assert.equal(save.segments.length, 1);
        assert.equal(save.segments[0].source, marker + "Edited newer\r\n");
      }
    } finally {
      save.dispose();
    }
  }
});
test("a committed source ACK with failed readback keeps the original receipt and later input", async () => {
  const { save, calls, release } = sessionFixture();
  let failed = true;
  const original = save.client.readManuscript;
  save.client.readManuscript = async () => {
    if (failed) throw new Error("NETWORK_FAILED");
    return original();
  };
  save.client.readAuthoredSource = async () => ({
    ...save.source,
    source: marker + "Edited\r\n",
    acceptedHash: "next",
    generation: 2,
    workingRevision: 2,
  });
  try {
    save.updateSource([{ from: 0, to: 4, insert: "Edited" }]);
    const flight = save.flush();
    release();
    assert.equal(await flight, false);
    assert.equal(save.hasUnresolvedSource, true);
    save.updateSource([{ from: 6, to: 6, insert: " later" }]);
    failed = false;
    assert.equal(await save.flush(true), true);
    assert.equal(calls.length, 1);
    assert.equal(save.sourceLocal, marker + "Edited later\r\n");
    assert.equal(save.hasLocalBodyChanges, true);
    assert.equal(save.status, "pending");
    assert.equal(save.hasUnresolvedSource, false);
  } finally {
    save.dispose();
  }
});
test("generic NOT_FOUND receipt lookup retains the original lost save and newer input", async () => {
  const { save, release } = sessionFixture();
  const { ApiError } =
    await import("../../packages/platform-client/src/index.ts");
  release();
  const requests = [];
  let receiptAvailable = false;
  save.client.saveAuthoredSource = async (request) => {
    requests.push(structuredClone(request));
    throw new Error("NETWORK_FAILED");
  };
  save.client.commandReceipt = async (requestId) => {
    assert.equal(requestId, requests[0].requestId);
    if (!receiptAvailable) throw new ApiError("NOT_FOUND");
    return {
      requestId,
      workingRevision: 1,
      historyRevision: 1,
      cursor: 1,
      undoCount: 1,
      redoCount: 0,
    };
  };
  save.client.readAuthoredSourceStatus = async () => ({
    ...save.source,
    candidateId: null,
    pendingIntent: null,
  });
  save.client.readAuthoredSource = async () => ({
    ...save.source,
    source: marker + "Edited\r\n",
    generation: 2,
    acceptedHash: "committed",
  });
  try {
    save.updateSource([{ from: 0, to: 4, insert: "Edited" }]);
    assert.equal(await save.flush(), false);
    const original = structuredClone(save.sourcePending.request);
    save.updateSource([{ from: 6, to: 6, insert: " newer" }]);
    assert.equal(save.hasUnresolvedSource, true);
    assert.deepEqual(save.sourcePending.request, original);
    receiptAvailable = true;
    assert.equal(await save.flush(true), true);
    assert.equal(requests.length, 1);
    assert.equal(save.sourceLocal, marker + "Edited newer\r\n");
    assert.equal(save.hasUnresolvedSource, false);
    assert.equal(save.status, "pending");
  } finally {
    save.dispose();
  }
});
test("a post-promotion source failure with a pending intent retains the exact DTO and cannot mint another save", async () => {
  const { save, release } = sessionFixture();
  release();
  const calls = [];
  const { ApiError } =
    await import("../../packages/platform-client/src/index.ts");
  save.client.saveAuthoredSource = async (request) => {
    calls.push(structuredClone(request));
    throw new ApiError("SOURCE_EXTERNAL_CHANGE");
  };
  save.client.commandReceipt = async () => {
    throw new ApiError("COMMAND_NOT_FOUND");
  };
  save.client.readAuthoredSourceStatus = async () => ({
    generation: 1,
    acceptedHash: "base",
    pendingIntent: {
      requestId: calls[0].requestId,
      intentHash: "captured",
      version: 2,
    },
    externalStatus: "changed",
  });
  try {
    save.updateSource([{ from: 0, to: 4, insert: "Edited" }]);
    assert.equal(await save.flush(), false);
    const request = structuredClone(calls[0]);
    save.updateSource([{ from: 6, to: 6, insert: " later" }]);
    assert.equal(await save.flush(true), false);
    assert.equal(calls.length, 1);
    assert.deepEqual(save.sourcePending.request, request);
    assert.equal(save.sourceLocal, "Edited later\r\n");
    assert.equal(save.error, "SOURCE_RECOVERY_REQUIRED");
  } finally {
    save.dispose();
  }
});
test("lost source response resolves its exact committed receipt before adopting the current snapshot", async () => {
  const { save, release } = sessionFixture();
  release();
  const { ApiError } =
    await import("../../packages/platform-client/src/index.ts");
  let submitted,
    receipts = 0;
  save.client.saveAuthoredSource = async (request) => {
    submitted = structuredClone(request);
    throw new ApiError("SOURCE_EXTERNAL_CHANGE");
  };
  save.client.commandReceipt = async (id) => {
    assert.equal(id, submitted.requestId);
    receipts++;
    return {
      requestId: id,
      workingRevision: 1,
      historyRevision: 1,
      cursor: 1,
      undoCount: 1,
      redoCount: 0,
    };
  };
  save.client.readAuthoredSource = async () => ({
    ...save.source,
    source: marker + submitted.source,
    generation: 2,
    acceptedHash: "committed",
  });
  try {
    save.updateSource([{ from: 0, to: 4, insert: "Edited" }]);
    assert.equal(await save.flush(), true);
    assert.equal(receipts, 1);
    assert.equal(save.sourceLocal, marker + "Edited\r\n");
    assert.equal(save.hasUnresolvedSource, false);
  } finally {
    save.dispose();
  }
});
test("a raw-equivalent editor transaction advances visible input identity but sends no source mutation", async () => {
  const { save, calls, release } = sessionFixture();
  release();
  try {
    const identity = save.exportInputIdentity;
    save.updateSource([{ from: 0, to: 4, insert: "Body" }]);
    assert.notEqual(identity, save.exportInputIdentity);
    assert.equal(await save.flush(), true);
    assert.equal(save.status, "saved");
    assert.equal(calls.length, 0);
  } finally {
    save.dispose();
  }
});

test("ACK mapping rejects scalar splits and preserves prefix identity through insertion at its boundary", async () => {
  const { sourceAcknowledgmentInsertions } =
    await import("../../packages/manuscript-format/src/editor-source.ts");
  assert.equal(
    rebaseSourceAcknowledgment(
      "Body\r\n",
      marker + "Body\r\n",
      [[{ from: 0, to: 0, insert: "New " }]],
      "New Body\r\n",
    ),
    marker + "New Body\r\n",
  );
  const html = "<widget>body</widget>";
  const { insertSourceIdentity } =
    await import("../../packages/manuscript-format/src/source.ts");
  const accepted = insertSourceIdentity(
    readSourceDocument(html),
    "/0",
    "11111111-1111-4111-8111-111111111111",
  ).source;
  assert.equal(sourceAcknowledgmentInsertions(html, accepted)[0].at, 0);
  assert.throws(
    () =>
      rebaseSourceAcknowledgment(
        "中😀\r\n",
        marker + "中😀\r\n",
        [[{ from: 2, to: 2, insert: "x" }]],
        "中x😀\r\n",
      ),
    /SOURCE_RANGE_INVALID/,
  );
});
test("source mapping proves soft/hard breaks, wrapped selections and multiline code spans", () => {
  const raw =
    marker + "One\r\nsoft  \r\nhard `one\r\ntwo` **bold** &notanentity;\n";
  const text = "One\nsoft\nhard one two bold &notanentity;";
  const { state, bindings } = scope(raw, text);
  const start = raw.indexOf("one\r\n"),
    end = start + 8;
  assert.equal(
    captureSourceSelection(raw, bindings, state, start, end)[0].quote,
    "one two",
  );
  const bold = raw.indexOf("**bold**");
  assert.equal(
    captureSourceSelection(raw, bindings, state, bold, bold + 8)[0].quote,
    "bold",
  );
});
test("live source presentation hides only proved tokens and preserves literal markers and empty blocks", async () => {
  const { sourcePresentation } =
    await import("../../packages/manuscript-format/src/editor-source.ts");
  const raw =
    marker +
    "# Heading **bold** [link](https://example.com) &amp; `code`\r\n\r\n```md\n" +
    marker +
    "```\n";
  const view = sourcePresentation(raw);
  assert.ok(
    view.hidden.some(
      (range) => range.block && range.from === 0 && range.to === marker.length,
    ),
  );
  assert.ok(view.replacements.some((range) => range.text === "&"));
  assert.ok(
    !view.hidden.some(
      (range) =>
        range.from > raw.indexOf("```md") && range.to > raw.indexOf("```md"),
    ),
  );
  const empty =
    "<!-- scenesparrow:empty=11111111-1111-4111-8111-111111111111 -->\n";
  assert.ok(sourcePresentation(empty).hidden.every((range) => !range.block));
});
test("combined proposal editing preserves BOM and untouched mixed endings through normalized textarea input", async () => {
  const { patchNormalizedSourceInput, sourceDiff } =
    await import("../../packages/manuscript-format/src/editor-source.ts");
  const raw = "\uFEFF" + marker + "First\r\nSecond\nThird\r\n";
  const normalized = rawEditorMap(raw).text;
  assert.equal(patchNormalizedSourceInput(raw, normalized), raw);
  assert.equal(
    patchNormalizedSourceInput(raw, normalized.replace("Second", "Changed")),
    raw.replace("Second", "Changed"),
  );
  const diff = sourceDiff(raw, raw.replace("Second", "Changed"));
  assert.equal(diff.changed, true);
  assert.ok(
    diff.hunks
      .flat()
      .some((line) => line.kind === "added" && line.text === "Changed"),
  );
  const large = sourceDiff("a\n".repeat(30000), "b\n".repeat(30000), 20);
  assert.equal(large.truncated, true);
  assert.ok(large.hunks.flat().length <= 20);
});

test("a genuinely newer accepted snapshot retains local source and settles the original receipt for explicit recovery", async () => {
  const { save, release } = sessionFixture();
  let acknowledged;
  save.client.saveAuthoredSource = async (request) => {
    await new Promise((r) => (acknowledged = r));
    return {
      receipt: { requestId: request.requestId, workingRevision: 1 },
      snapshot: {
        ...save.source,
        generation: 3,
        acceptedHash: "foreign",
        source: marker + "Other client accepted\r\n",
      },
    };
  };
  save.client.readAuthoredSource = async () => save.source;
  try {
    save.updateSource([{ from: 0, to: 4, insert: "Mine" }]);
    const flight = save.flush();
    await new Promise((r) => setTimeout(r, 0));
    save.updateSource([{ from: 4, to: 4, insert: " newer" }]);
    acknowledged();
    release();
    assert.equal(await flight, false);
    assert.equal(save.hasUnresolvedSource, false);
    assert.equal(save.error, "SOURCE_ACK_AMBIGUOUS");
    assert.equal(save.sourceLocal, "Mine newer\r\n");
    assert.equal(save.source.source, marker + "Other client accepted\r\n");
    assert.equal(await save.reload(), true);
    assert.equal(save.sourceLocal, marker + "Other client accepted\r\n");
    assert.equal(save.status, "saved");
  } finally {
    save.dispose();
  }
});
test("a delayed explicit source reload cannot erase input typed during its read", async () => {
  const { save, release } = sessionFixture();
  release();
  let finish;
  save.client.readAuthoredSource = () => new Promise((r) => (finish = r));
  try {
    const reload = save.reload();
    await new Promise((r) => setTimeout(r, 0));
    save.updateSource([{ from: 4, to: 4, insert: " later" }]);
    finish(save.source);
    assert.equal(await reload, false);
    assert.equal(save.sourceLocal, "Body later\r\n");
  } finally {
    save.dispose();
  }
});
test("live empty-leaf repair and clipboard retain identity, exact outside bytes and code literal markers", async () => {
  const { repairLiveSourceInput, sourceClipboardText } =
    await import("../../packages/manuscript-format/src/editor-source.ts");
  const raw = "\uFEFF" + marker + "Body\r\n";
  const from = rawEditorMap(raw).text.indexOf("Body");
  const empty = repairLiveSourceInput(raw, [
    { from, to: from + 4, insert: "" },
  ]);
  assert.equal(
    empty.raw,
    "\uFEFF" + marker.replace("block=", "empty=").trimEnd() + "\r\n",
  );
  const map = rawEditorMap(empty.raw),
    retyped = repairLiveSourceInput(empty.raw, [
      {
        from: map.editorAt(empty.cursorRaw),
        to: map.editorAt(empty.cursorRaw),
        insert: "Retyped 中文",
      },
    ]);
  assert.equal(
    readSourceDocument(retyped.raw).blocks[0].id,
    "11111111-1111-4111-8111-111111111111",
  );
  assert.ok(retyped.raw.endsWith("Retyped 中文\r\n"));
  const copy = sourceClipboardText(
    marker + "Body\n\n```md\n" + marker + "```\n",
  );
  assert.equal(copy, "Body\n\n```md\n" + marker + "```\n");
});

for (const seconds of [5, 10, 30])
  test(`source autosave shares the ${seconds}s scheduler and a held ACK does not flush newer input early`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
    const { save, calls, release } = sessionFixture();
    save.preferences.update({
      saveMode: "after_delay",
      saveDelaySeconds: seconds,
    });
    const settle = async () => {
      for (let index = 0; index < 100; index++) await Promise.resolve();
    };
    try {
      save.updateSource([{ from: 0, to: 4, insert: "Edited" }]);
      context.mock.timers.tick(seconds * 1000);
      await settle();
      assert.equal(calls.length, 1);
      save.updateSource([{ from: 6, to: 6, insert: " later" }]);
      context.mock.timers.tick(1000);
      release();
      await settle();
      assert.equal(calls.length, 1);
      assert.equal(save.status, "pending");
      context.mock.timers.tick(seconds * 1000 - 1001);
      await settle();
      assert.equal(calls.length, 1);
      context.mock.timers.tick(1);
      await settle();
      assert.equal(calls.length, 2);
    } finally {
      save.dispose();
    }
  });
