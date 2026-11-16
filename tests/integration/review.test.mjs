import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { waitFor } from "../../scripts/processes.mjs";
import { planningProvider, configurePlanning } from "../fixtures/planning.mjs";
const pause = () => new Promise((r) => setTimeout(r, 40));
test("manual draft review uses counted actual SDK question, follow-up context, revision and atomic acceptance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scenesparrow-review-")),
    provider = await planningProvider(),
    token = randomBytes(32).toString("hex");
  let child,
    base,
    logs = "",
    project;
  const inputs = [];
  let failNext = false;
  provider.setHandler(async (_req, res, body) => {
    const content = body.messages.find((m) => m.role === "user").content;
    const input = JSON.parse(
      typeof content === "string"
        ? content
        : content.find((p) => p.type === "text").text,
    );
    inputs.push(input);
    if (failNext) {
      failNext = false;
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ error: { message: "Controlled local failure" } }),
      );
      return;
    }
    const result =
      input.thread.kind === "question"
        ? {
            schemaVersion: 1,
            answer: `Answer ${input.thread.requestVersion} 中文`,
            evidenceReferences: [],
          }
        : {
            schemaVersion: 1,
            mode: "replace_ranges",
            explanation: "Use clearer wording in the selected range.",
            replacements: input.thread.anchor.ranges.map((_, rangeIndex) => ({
              rangeIndex,
              runs: [{ text: "Accepted clearer 中文 🐦", marks: [] }],
            })),
          };
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: { content: JSON.stringify(result) },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  const req = async (path, body, method) => {
    const r = await fetch(base + path, {
      method: method ?? (body ? "POST" : "GET"),
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: await r.json() };
  };
  const boot = async () => {
    const socket = createServer();
    await new Promise((r) => socket.listen(0, "127.0.0.1", r));
    const port = socket.address().port;
    await new Promise((r) => socket.close(r));
    base = `http://127.0.0.1:${port}/v1`;
    child = spawn("./target/debug/scenesparrow-service", [], {
      env: {
        ...process.env,
        SCENESPARROW_APP_DATA_DIR: join(dir, "app"),
        SCENESPARROW_PROJECT_DIR: join(dir, "project"),
        SCENESPARROW_SESSION_TOKEN: token,
        SCENESPARROW_CORE_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (b) => (logs += b));
    child.stderr.on("data", (b) => (logs += b));
    await waitFor(
      base + "/health",
      { Authorization: `Bearer ${token}` },
      child,
    );
  };
  const stop = async () => {
    if (child?.exitCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGINT");
      await exit;
    }
  };
  const command = async (type, payload) => {
    const state = (await req("/manuscript")).data;
    const body = {
      type,
      requestId: randomUUID(),
      projectId: project.id,
      expectedWorkingRevision: state.workingRevision,
      payload,
    };
    return { ...(await req("/manuscript/commands", body)), body };
  };
  const card = async (id) =>
    (await req("/reviews")).data.cards.find((c) => c.thread.id === id);
  const wait = async (id) => {
    for (let n = 0; n < 180; n++) {
      const c = await card(id);
      if (c.task && c.task.application !== "pending") return c;
      await pause();
    }
    throw Error("Review timeout " + logs);
  };
  const save = async (kind, text) => {
    const b = (await req("/manuscript")).data.blocks[0],
      quote = b.runs.map((r) => r.text).join("");
    const thread = {
      id: randomUUID(),
      kind,
      requestVersion: 0,
      text,
      anchor: {
        ranges: [
          {
            blockId: b.id,
            revision: b.revision,
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
      language: "zh-CN",
      evidence: [],
      decision: null,
      userMessageIds: [],
    };
    assert.equal(
      (await command("SaveReview", { thread, expectedRequestVersion: 0 }))
        .status,
      200,
    );
    return thread.id;
  };
  try {
    await boot();
    project = (
      await req("/project", {
        requestId: randomUUID(),
        title: "Manual review integration",
      })
    ).data.project;
    await configurePlanning(req, provider.root);
    assert.equal((await command("StartManualDraft", {})).status, 200);
    const b = randomUUID();
    assert.equal(
      (
        await command("ApplyDocumentEdit", {
          operations: [
            {
              op: "insertBlock",
              after: null,
              block: {
                id: b,
                kind: "paragraph",
                attrs: {},
                runs: [
                  { text: "Manual source 中文 🐦", marks: [{ type: "bold" }] },
                ],
              },
            },
          ],
          expectedBlockRevisions: [],
          group: {
            groupId: randomUUID(),
            clientSessionId: randomUUID(),
            groupSequence: 1,
            kind: "discrete",
          },
        })
      ).status,
      200,
    );
    const question = await save("question", "Explain this source");
    await req("/reviews");
    assert.equal(provider.calls.length, 0);
    const before = (await req("/manuscript")).data.blocks;
    assert.equal(
      (
        await command("StartReviewTask", {
          threadId: question,
          requestVersion: 1,
        })
      ).status,
      200,
    );
    let q = await wait(question);
    assert.equal(q.task.answer, "Answer 1 中文");
    assert.equal(q.thread.handled, false);
    assert.deepEqual((await req("/manuscript")).data.blocks, before);
    const messages = (await req(`/reviews/${question}/messages`)).data.messages;
    assert.equal(messages.length, 2);
    q.thread.text = "Follow up using the chosen conversation";
    assert.equal(
      (
        await command("SaveReview", {
          thread: q.thread,
          expectedRequestVersion: 1,
        })
      ).status,
      200,
    );
    assert.equal(provider.calls.length, 1);
    assert.equal(
      (
        await command("StartReviewTask", {
          threadId: question,
          requestVersion: 2,
          messageIds: messages.map((m) => m.id),
        })
      ).status,
      200,
    );
    q = await wait(question);
    assert.equal(q.task.answer, "Answer 2 中文");
    assert.equal(inputs[1].conversation.length, 2);
    const note = await save("revision_note", "Make this clearer");
    assert.equal(provider.calls.length, 2);
    assert.equal(
      (await command("StartReviewTask", { threadId: note, requestVersion: 1 }))
        .status,
      200,
    );
    const n = await wait(note);
    assert.equal(n.candidate.status, "pending");
    assert.deepEqual((await req("/manuscript")).data.blocks, before);
    const history = (await req("/history")).data;
    const accepted = await command("AcceptReviewCandidates", {
      candidates: [{ id: n.candidate.id, version: n.candidate.version }],
      expectedHistoryRevision: history.historyRevision,
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted));
    assert.equal(accepted.data.historyRevision, history.historyRevision + 1);
    assert.deepEqual(
      (await req("/manuscript/commands", accepted.body)).data,
      accepted.data,
    );
    assert.equal((await card(note)).thread.handled, true);
    assert.equal(
      (await req("/manuscript")).data.blocks[0].runs[0].text,
      "Accepted clearer 中文 🐦",
    );
    assert.equal(provider.calls.length, 3);
    const retryQuestion = await save(
      "question",
      "Question with controlled failure",
    );
    failNext = true;
    assert.equal(
      (
        await command("StartReviewTask", {
          threadId: retryQuestion,
          requestVersion: 1,
        })
      ).status,
      200,
    );
    const failed = await wait(retryQuestion);
    assert.equal(failed.task.run.status, "failed");
    assert.equal(provider.calls.length, 4);
    await configurePlanning(req, provider.root);
    assert.equal(
      (
        await command("StartReviewTask", {
          threadId: retryQuestion,
          requestVersion: 1,
          retryOfRunId: failed.task.run.runId,
        })
      ).status,
      200,
    );
    const retried = await wait(retryQuestion);
    assert.equal(retried.task.application, "applied");
    assert.equal(retried.task.run.retryOfRunId, failed.task.run.runId);
    assert.notEqual(
      retried.task.run.configuration.fingerprint,
      failed.task.run.configuration.fingerprint,
    );
    assert.equal(provider.calls.length, 5);
    await stop();
    await boot();
    assert.equal((await card(note)).thread.handled, true);
    assert.equal(
      (await req(`/reviews/${question}/messages`)).data.messages.length,
      4,
    );
    assert.equal(provider.calls.length, 5);
    assert.ok(!logs.includes("Bearer"));
  } finally {
    await stop();
    await provider.close();
    await rm(dir, { recursive: true, force: true });
  }
});
