import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { waitFor } from "../../scripts/processes.mjs";
import {
  planningProvider,
  planningOutput,
  configurePlanning,
} from "../fixtures/planning.mjs";
const binary = resolve("target/debug/scenesparrow-service");
const group = () => ({
  groupId: randomUUID(),
  clientSessionId: randomUUID(),
  groupSequence: 1,
  kind: "discrete",
});
const pause = () => new Promise((resolve) => setTimeout(resolve, 40));
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "scenesparrow-source-"));
  const root = join(directory, "project");
  const token = randomBytes(32).toString("hex");
  let base,
    child,
    logs = "";
  const headers = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const stop = async () => {
    if (child?.exitCode === null && child?.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGINT");
      await exit;
    }
  };
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  const boot = async (mode = "existing", withoutNode = false) => {
    const socket = createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    base = `http://127.0.0.1:${port}/v1`;
    child = spawn(binary, [], {
      env: {
        ...process.env,
        SCENESPARROW_PROJECT_DIR: root,
        SCENESPARROW_APP_DATA_DIR: join(directory, "settings"),
        SCENESPARROW_SESSION_TOKEN: token,
        SCENESPARROW_CORE_PORT: String(port),
        SCENESPARROW_PROJECT_OPEN_MODE: mode,
        ...(withoutNode ? { PATH: "/nonexistent" } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", (chunk) => (logs += chunk));
    child.stdout.on("data", (chunk) => (logs += chunk));
    await waitFor(base + "/health", headers, child);
  };
  const req = async (path, body, method) => {
    const response = await fetch(base + path, {
      method: method ?? (body ? "POST" : "GET"),
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  const command = async (type, payload = {}, extra = {}) => {
    const state = (await req("/manuscript/source")).data;
    const body = {
      type,
      requestId: randomUUID(),
      projectId: state.projectId,
      expectedWorkingRevision: state.workingRevision,
      payload,
      ...extra,
    };
    return { ...(await req("/manuscript/commands", body)), body };
  };
  const save = async (source, overrides = {}) => {
    const before = (await req("/manuscript/source")).data;
    const body = {
      requestId: randomUUID(),
      projectId: before.projectId,
      expectedWorkingRevision: before.workingRevision,
      expectedGeneration: before.generation,
      expectedHash: before.acceptedHash,
      source,
      group: group(),
      ...overrides,
    };
    return { ...(await req("/manuscript/source", body)), body };
  };
  const wait = async (read, done) => {
    for (let count = 0; count < 250; count++) {
      const value = await read();
      if (done(value)) return value;
      await pause();
    }
    throw Error("Timeout " + logs);
  };
  return { root, boot, stop, req, command, save, wait, url: () => base };
}
test("OPF-AC01/03/06/19 authenticated raw source create/save/reopen needs no Node and keeps receipt identity", async (t) => {
  const f = await fixture(t);
  await f.boot("format-create", true);
  assert.equal((await fetch(f.url() + "/manuscript/source")).status, 401);
  assert.equal((await f.req("/project/format")).data.status, "managed");
  const created = await f.save(
    "# 中文\r\n\r\nText **bold** 🐦\r\n\r\n- first\r\n    1. child\r\n\r\n```text\r\nunknown\r\n```\r\n",
  );
  assert.equal(created.status, 200, JSON.stringify(created));
  assert.equal(created.data.snapshot.bindings.length, 5);
  assert.equal(
    created.data.snapshot.bindings.filter((b) => b.semanticEditable).length,
    4,
  );
  assert.equal(created.data.snapshot.generation, 1);
  const original = created.data.snapshot;
  assert.equal(
    await readFile(join(f.root, "manuscript.md"), "utf8"),
    original.source,
  );
  const next = await f.save(original.source.replace("Text", "New text"));
  assert.equal(next.status, 200);
  assert.deepEqual(
    (await f.req("/manuscript/source", created.body)).data.receipt,
    created.data.receipt,
  );
  assert.equal(
    (
      await f.req("/manuscript/source", {
        ...created.body,
        source: created.body.source + "\n",
      })
    ).data.code,
    "REQUEST_ID_CONFLICT",
  );
  const invalid = await f.req("/manuscript/source", {
    ...next.body,
    requestId: randomUUID(),
    source: next.data.snapshot.source,
    extra: true,
  });
  assert.equal(invalid.status, 400);
  const stale = await f.save(next.data.snapshot.source, {
    expectedHash: original.acceptedHash,
  });
  assert.equal(stale.data.code, "SOURCE_BASE_MISMATCH");
  const protectedId = next.data.snapshot.semanticBlockIds[1];
  assert.equal(
    (
      await f.command("SetUserLocks", {
        blockIds: [protectedId],
        locked: true,
        all: false,
      })
    ).status,
    200,
  );
  assert.equal((await f.req("/manuscript/finalization")).data.finalized, false);
  const locked = await f.save(
    next.data.snapshot.source.replace("unknown", "changed raw only"),
  );
  assert.equal(locked.data.code, "CONTENT_LOCKED");
  const lockedState = (await f.req("/manuscript")).data;
  const lockedBlock = lockedState.blocks.find(
    (block) => block.id === protectedId,
  );
  const independentBefore = (await f.req("/manuscript/source")).data;
  const independent = await f.save(
    independentBefore.source.replace("child", "independent child"),
  );
  assert.equal(independent.status, 200, JSON.stringify(independent));
  assert.deepEqual(
    (await f.req("/manuscript")).data.blocks.find(
      (block) => block.id === protectedId,
    ),
    lockedBlock,
  );
  const undo = (await f.req("/history")).data;
  assert.equal(
    (
      await f.command(
        "UndoProject",
        {},
        {
          expectedHistoryRevision: undo.historyRevision,
          expectedCursor: undo.cursor,
        },
      )
    ).status,
    200,
  );
  assert.equal(
    (await f.req("/manuscript/source")).data.source,
    independentBefore.source,
  );
  const redo = (await f.req("/history")).data;
  assert.equal(
    (
      await f.command(
        "RedoProject",
        {},
        {
          expectedHistoryRevision: redo.historyRevision,
          expectedCursor: redo.cursor,
        },
      )
    ).status,
    200,
  );
  assert.equal(
    (await f.req("/manuscript/source")).data.source,
    independent.data.snapshot.source,
  );
  assert.deepEqual(
    (await f.req("/manuscript")).data.blocks.find(
      (block) => block.id === protectedId,
    ),
    lockedBlock,
  );
  const accepted = (await f.req("/manuscript/source")).data;
  await writeFile(join(f.root, "manuscript.md"), "Outside file\n");
  const external = (await f.req("/manuscript/source")).data;
  assert.equal(external.source, accepted.source);
  assert.equal(external.externalStatus, "changed");
  await f.stop();
  await f.boot("existing", true);
  assert.equal(
    (await f.req("/manuscript/source")).data.source,
    accepted.source,
  );
  assert.equal(
    await readFile(join(f.root, "manuscript.md"), "utf8"),
    "Outside file\n",
  );
});
test("OPF-AC03 ordinary explicit adoption and future inspection do not initialize future metadata", async (t) => {
  const f = await fixture(t);
  await mkdir(f.root);
  const projectId = randomUUID();
  await writeFile(
    join(f.root, "project.json"),
    JSON.stringify({
      format: "scenesparrow",
      formatVersion: 1,
      projectId,
      manuscript: "draft.md",
    }),
  );
  await writeFile(
    join(f.root, "draft.md"),
    "- Ordinary\n    - Nested\n\n> preserved quote\n",
  );
  await f.boot("format-adopt", true);
  const source = (await f.req("/manuscript/source")).data;
  assert.equal(source.projectId, projectId);
  assert.equal(source.bindings.length, 3);
  await f.stop();
  await f.boot();
  assert.equal((await f.req("/manuscript/source")).data.source, source.source);
  await f.stop();
  const future = join(f.root, "future");
  await mkdir(future);
  await writeFile(
    join(future, "project.json"),
    JSON.stringify({ format: "scenesparrow", formatVersion: 42, future: true }),
  );
  const inspected = JSON.parse(
    execFileSync(binary, ["--inspect-format", future], { encoding: "utf8" }),
  );
  assert.equal(inspected.status, "futureReadOnly");
  assert.equal(inspected.formatVersion, 42);
  await assert.rejects(readFile(join(future, ".scenesparrow/project.sqlite")));
});
test("OPF-AC06/07 generated initial list draft and accepted AI edit share raw source history", async (t) => {
  const f = await fixture(t);
  const provider = await planningProvider();
  t.after(() => provider.close());
  await f.boot("format-create");
  await configurePlanning(f.req, provider.root);
  let plan = (await f.req("/planning")).data.content;
  plan.brief.topic = "A list draft";
  plan.brief.language = "en";
  assert.equal(
    (await f.command("SavePlanning", { content: plan, group: group() })).status,
    200,
  );
  const start = async (operation) => {
    const prepared = await f.req("/planning/preparations", { operation });
    assert.equal(prepared.status, 200, JSON.stringify(prepared));
    const started = await f.command("StartPlanningTask", {
      preparationId: prepared.data.id,
      retryOfTaskId: null,
    });
    assert.equal(started.status, 200, JSON.stringify(started));
    const task = await f.wait(
      async () =>
        (await f.req("/planning/tasks/" + started.body.requestId)).data,
      (value) => value.application !== "pending",
    );
    assert.equal(task.application, "applied", JSON.stringify(task));
    return task;
  };
  await start("generate_outline");
  provider.setHandler(async (_request, response, body) => {
    let output = planningOutput(body);
    for (const section of output.sections) {
      section.blocks = [
        {
          kind: "list_item",
          attrs: { listKind: "bullet", depth: 0 },
          runs: [{ text: "Parent 中文", marks: [] }],
        },
        {
          kind: "list_item",
          attrs: { listKind: "ordered", depth: 1 },
          runs: [{ text: "Nested child", marks: [] }],
        },
      ];
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: { content: JSON.stringify(output) },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  await start("generate_initial_draft");
  const generated = (await f.req("/manuscript/source")).data;
  assert.match(generated.source, /- Parent 中文<!-- scenesparrow:block=/);
  assert.match(generated.source, /    1\. Nested child/);
  assert.equal(
    (await f.req("/manuscript")).data.blocks.filter(
      (b) => b.kind === "list_item",
    ).length,
    4,
  );
  const state = (await f.req("/manuscript")).data;
  const block = state.blocks.find(
    (b) => b.kind === "list_item" && b.attrs.depth === 1,
  );
  const quote = block.runs.map((r) => r.text).join("");
  const thread = {
    id: randomUUID(),
    kind: "revision_note",
    requestVersion: 0,
    text: "Clarify nested text",
    anchor: {
      ranges: [
        {
          blockId: block.id,
          revision: block.revision,
          start: 0,
          end: quote.length,
          quote,
          wholeBlock: true,
        },
      ],
      state: "mapped",
      slot: null,
    },
    handled: false,
    deleted: false,
    language: "en",
    evidence: [],
    decision: null,
    userMessageIds: [],
  };
  assert.equal(
    (await f.command("SaveReview", { thread, expectedRequestVersion: 0 }))
      .status,
    200,
  );
  let releaseReview;
  const reviewBarrier = new Promise((resolve) => (releaseReview = resolve));
  provider.setHandler(async (_request, response) => {
    await reviewBarrier;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: {
              content: JSON.stringify({
                schemaVersion: 1,
                mode: "replace_ranges",
                explanation: "Clarify the selected child",
                replacements: [
                  {
                    rangeIndex: 0,
                    runs: [{ text: "Accepted child 🐦", marks: [] }],
                  },
                ],
              }),
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  assert.equal(
    (
      await f.command("StartReviewTask", {
        threadId: thread.id,
        requestVersion: 1,
      })
    ).status,
    200,
  );
  const active = (await f.req("/manuscript/source")).data;
  try {
    assert.equal(
      (await f.save(active.source + "\n")).data.code,
      "TASK_USING_CONTENT",
    );
  } finally {
    releaseReview();
  }
  const card = await f.wait(
    async () =>
      (await f.req("/reviews")).data.cards.find(
        (c) => c.thread.id === thread.id,
      ),
    (value) => value?.task && value.task.application !== "pending",
  );
  assert.equal(card.candidate.status, "pending", JSON.stringify(card));
  const beforeAcceptance = (await f.req("/manuscript/source")).data;
  const history = (await f.req("/history")).data;
  const accepted = await f.command("AcceptReviewCandidates", {
    candidates: [{ id: card.candidate.id, version: card.candidate.version }],
    expectedHistoryRevision: history.historyRevision,
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  const after = (await f.req("/manuscript/source")).data;
  assert.equal(
    after.source,
    beforeAcceptance.source.replace("Nested child", "Accepted child 🐦"),
  );
  assert.deepEqual(
    (await f.req("/manuscript/commands", accepted.body)).data,
    accepted.data,
  );
  const undoHistory = (await f.req("/history")).data;
  assert.equal(
    (
      await f.command(
        "UndoProject",
        {},
        {
          expectedHistoryRevision: undoHistory.historyRevision,
          expectedCursor: undoHistory.cursor,
        },
      )
    ).status,
    200,
  );
  assert.equal(
    (await f.req("/manuscript/source")).data.source,
    beforeAcceptance.source,
  );
  const redoHistory = (await f.req("/history")).data;
  assert.equal(
    (
      await f.command(
        "RedoProject",
        {},
        {
          expectedHistoryRevision: redoHistory.historyRevision,
          expectedCursor: redoHistory.cursor,
        },
      )
    ).status,
    200,
  );
  assert.equal((await f.req("/manuscript/source")).data.source, after.source);
  assert.equal(provider.calls.length, 3);
  await f.stop();
  await f.boot();
  assert.equal((await f.req("/manuscript/source")).data.source, after.source);
  assert.equal(provider.calls.length, 3);
});
test("OPF-AC06/07 accepted section insertion preserves unrelated unsupported source and exact Undo/Redo", async (t) => {
  const f = await fixture(t);
  const provider = await planningProvider();
  t.after(() => provider.close());
  await f.boot("format-create");
  await configurePlanning(f.req, provider.root);
  assert.equal(
    (
      await f.save(
        "# Empty section\n\n# Following section\n\n```unknown\nDo not rewrite this syntax.\n```\n",
      )
    ).status,
    200,
  );
  const source = (await f.req("/manuscript/source")).data;
  const blocks = (await f.req("/manuscript")).data.blocks;
  const heading = blocks[0],
    next = blocks[1],
    quote = heading.runs.map((r) => r.text).join("");
  const thread = {
    id: randomUUID(),
    kind: "revision_note",
    requestVersion: 0,
    text: "Fill the explicit empty section",
    anchor: {
      ranges: [
        {
          blockId: heading.id,
          revision: heading.revision,
          start: 0,
          end: quote.length,
          quote,
          wholeBlock: true,
        },
      ],
      state: "mapped",
      slot: { headingId: heading.id, beforeId: heading.id, afterId: next.id },
    },
    handled: false,
    deleted: false,
    language: "en",
    evidence: [],
    decision: null,
    userMessageIds: [],
  };
  assert.equal(
    (await f.command("SaveReview", { thread, expectedRequestVersion: 0 }))
      .status,
    200,
  );
  provider.setHandler(async (_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: {
              content: JSON.stringify({
                schemaVersion: 1,
                mode: "fill_section",
                explanation: "Fill only this empty section",
                blocks: [
                  {
                    kind: "paragraph",
                    attrs: {},
                    runs: [{ text: "Inserted paragraph", marks: [] }],
                  },
                  {
                    kind: "list_item",
                    attrs: { listKind: "bullet", depth: 0 },
                    runs: [{ text: "Added parent", marks: [] }],
                  },
                  {
                    kind: "list_item",
                    attrs: { listKind: "ordered", depth: 1 },
                    runs: [{ text: "Added child", marks: [] }],
                  },
                ],
              }),
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  assert.equal(
    (
      await f.command("StartReviewTask", {
        threadId: thread.id,
        requestVersion: 1,
      })
    ).status,
    200,
  );
  const card = await f.wait(
    async () =>
      (await f.req("/reviews")).data.cards.find(
        (c) => c.thread.id === thread.id,
      ),
    (value) => value?.task && value.task.application !== "pending",
  );
  assert.equal(card.candidate?.status, "pending", JSON.stringify(card));
  const history = (await f.req("/history")).data;
  const accepted = await f.command("AcceptReviewCandidates", {
    expectedHistoryRevision: history.historyRevision,
    candidates: [{ id: card.candidate.id, version: card.candidate.version }],
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  const after = (await f.req("/manuscript/source")).data;
  assert.ok(
    after.source.startsWith(
      source.source.slice(
        0,
        source.source.indexOf("<!-- scenesparrow:block=" + next.id),
      ),
    ),
  );
  assert.ok(
    after.source.endsWith(
      source.source.slice(
        source.source.indexOf("<!-- scenesparrow:block=" + next.id),
      ),
    ),
  );
  assert.match(after.source, /Inserted paragraph/);
  assert.match(after.source, /    1\. Added child/);
  const undo = (await f.req("/history")).data;
  assert.equal(
    (
      await f.command(
        "UndoProject",
        {},
        {
          expectedHistoryRevision: undo.historyRevision,
          expectedCursor: undo.cursor,
        },
      )
    ).status,
    200,
  );
  assert.equal((await f.req("/manuscript/source")).data.source, source.source);
  const redo = (await f.req("/history")).data;
  assert.equal(
    (
      await f.command(
        "RedoProject",
        {},
        {
          expectedHistoryRevision: redo.historyRevision,
          expectedCursor: redo.cursor,
        },
      )
    ).status,
    200,
  );
  assert.equal((await f.req("/manuscript/source")).data.source, after.source);
});
