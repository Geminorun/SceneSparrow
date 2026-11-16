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
import {
  planningProvider,
  configurePlanning,
  planningOutput,
} from "../fixtures/planning.mjs";
import { pdf } from "../fixtures/documents.mjs";
const pause = () => new Promise((r) => setTimeout(r, 40));
test("saved planning uses the actual SDK exactly once per outline/draft; restart/history never redispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scenesparrow-planning-"));
  const provider = await planningProvider();
  const token = randomBytes(32).toString("hex");
  let child,
    base,
    logs = "";
  const req = async (path, body, method) => {
    const response = await fetch(base + path, {
      method: method ?? (body ? "POST" : "GET"),
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
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
  let project;
  const command = async (type, payload, extra = {}) => {
    const state = (await req("/manuscript")).data;
    const body = {
      type,
      requestId: randomUUID(),
      projectId: project.id,
      expectedWorkingRevision: state.workingRevision,
      payload,
      ...extra,
    };
    return { ...(await req("/manuscript/commands", body)), body };
  };
  const waitTask = async (id) => {
    for (let n = 0; n < 160; n++) {
      const result = (await req("/planning/tasks/" + id)).data;
      if (result.application !== "pending") return result;
      await pause();
    }
    throw Error("Task timeout " + logs);
  };
  try {
    await boot();
    project = (
      await req("/project", {
        requestId: randomUUID(),
        title: "Planning integration",
      })
    ).data.project;
    await configurePlanning(req, provider.root);
    const intakeId = randomUUID(),
      sourceId = randomUUID();
    const upload = await fetch(base + "/intakes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "x-intake-id": intakeId,
        "x-file-name": "scanned.pdf",
        "content-type": "application/pdf",
      },
      body: pdf([{ image: true }]),
    });
    assert.equal(upload.status, 200);
    const intake = await upload.json();
    assert.equal(
      (
        await command("AddSourceFile", {
          sourceId,
          intakeId,
          hash: intake.hash,
        })
      ).status,
      200,
    );
    const visualId = randomUUID();
    assert.equal(
      (await req("/planning/visuals", { id: visualId, sourceId, index: 1 }))
        .status,
      200,
    );
    let visual;
    for (let n = 0; n < 160; n++) {
      visual = (await req("/planning/visuals/" + visualId)).data;
      if (!["queued", "running"].includes(visual.status)) break;
      await pause();
    }
    assert.equal(visual.status, "ready", JSON.stringify(visual));
    assert.equal(visual.width, 600);
    assert.equal(visual.height, 600);
    const content = (await req("/planning")).data.content;
    content.evidence = [
      {
        sourceId,
        mode: "visual_input",
        start: 0,
        end: 0,
        visualId,
        allowUnknownImages: false,
      },
    ];
    content.brief.topic = "Why sparrows sing";
    content.brief.language = "zh-CN";
    assert.equal(
      (
        await command("SavePlanning", {
          content,
          group: {
            clientSessionId: randomUUID(),
            groupId: randomUUID(),
            groupSequence: 1,
            kind: "discrete",
          },
        })
      ).status,
      200,
    );
    assert.equal(
      (await req("/planning/preparations", { operation: "generate_outline" }))
        .data.code,
      "EVIDENCE_CHOICE_REQUIRED",
    );
    content.evidence[0].allowUnknownImages = true;
    assert.equal(
      (
        await command("SavePlanning", {
          content,
          group: {
            clientSessionId: randomUUID(),
            groupId: randomUUID(),
            groupSequence: 1,
            kind: "discrete",
          },
        })
      ).status,
      200,
    );
    const samples = { preparation: [], save: [], application: [] };
    let began = performance.now();
    const prep = (
      await req("/planning/preparations", { operation: "generate_outline" })
    ).data;
    samples.preparation.push(performance.now() - began);
    assert.equal(prep.evidence.length, 1);
    assert.equal(prep.evidence[0].level, "visual_input");
    assert.equal(provider.calls.length, 0);
    const started = await command("StartPlanningTask", {
      preparationId: prep.id,
      retryOfTaskId: null,
    });
    assert.equal(started.status, 200, JSON.stringify(started));
    const task = await waitTask(started.body.requestId);
    assert.equal(task.application, "applied", JSON.stringify(task));
    assert.equal(provider.calls.length, 1);
    const sent = provider.calls[0].body.messages.find(
      (m) => m.role === "user",
    ).content;
    assert.ok(
      sent.some(
        (p) =>
          p.type === "image_url" &&
          p.image_url.url.startsWith("data:image/png;base64,"),
      ),
    );
    assert.equal((await req("/manuscript/commands", started.body)).status, 200);
    assert.equal(provider.calls.length, 1);
    let plan = (await req("/planning")).data;
    assert.equal(plan.content.nodes.length, 2);
    assert.equal((await req("/manuscript")).data.workspaceStage, "outline");
    const draftPrep = (
      await req("/planning/preparations", {
        operation: "generate_initial_draft",
      })
    ).data;
    let releaseDraft;
    const draftBarrier = new Promise((resolve) => (releaseDraft = resolve));
    provider.setHandler(async (_request, response, body) => {
      await draftBarrier;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: { content: JSON.stringify(planningOutput(body)) },
              finish_reason: "stop",
            },
          ],
        }),
      );
    });
    const draftStart = await command("StartPlanningTask", {
      preparationId: draftPrep.id,
      retryOfTaskId: null,
    });
    assert.equal(draftStart.status, 200);
    for (let n = 0; n < 160 && provider.calls.length < 2; n++) await pause();
    assert.equal(provider.calls.length, 2);
    assert.equal(provider.calls[1].body.model, "planning-fixture");
    const future = (await req("/ai/settings")).data;
    future.settings.models.push({
      ...future.settings.models[0],
      id: "future-model",
    });
    future.settings.bindings[0].modelId = "future-model";
    assert.equal(
      (
        await req(
          "/ai/settings",
          {
            expectedRevision: future.settings.revision,
            settings: future.settings,
          },
          "PUT",
        )
      ).status,
      200,
    );
    releaseDraft();
    const done = await waitTask(draftStart.body.requestId);
    assert.equal(done.application, "applied", JSON.stringify(done));
    assert.equal(done.run.configuration.model.id, "planning-fixture");
    assert.equal(provider.calls.length, 2);
    const doc = (await req("/manuscript")).data;
    assert.equal(doc.blocks.length, 4);
    assert.equal(doc.blocks[1].runs[0].marks[0].type, "bold");
    assert.equal(doc.workspaceStage, "draft");
    const h = (await req("/history")).data;
    assert.equal(
      (
        await command(
          "UndoProject",
          {},
          {
            expectedHistoryRevision: h.historyRevision,
            expectedCursor: h.cursor,
          },
        )
      ).status,
      200,
    );
    assert.equal((await req("/manuscript")).data.workspaceStage, "outline");
    await stop();
    await boot();
    await pause();
    assert.equal(
      (await req("/planning/tasks/" + draftStart.body.requestId)).data
        .application,
      "applied",
    );
    assert.equal((await req("/manuscript")).data.workspaceStage, "outline");
    assert.equal(
      (await req("/manuscript/commands", draftStart.body)).status,
      200,
    );
    assert.equal(provider.calls.length, 2);
    const history = (await req("/history")).data;
    assert.equal(
      (
        await command(
          "RedoProject",
          {},
          {
            expectedHistoryRevision: history.historyRevision,
            expectedCursor: history.cursor,
          },
        )
      ).status,
      200,
    );
    assert.equal(provider.calls.length, 2);
    assert.equal((await req("/planning/tasks/" + done.id)).status, 200);
    // Continue the same real-core project through questions, individual and
    // batch acceptance, approval locks, clean delivery, then cold reopen.
    provider.setHandler(async (_request, response, body) => {
      const content = body.messages.find((m) => m.role === "user").content;
      const input = JSON.parse(
        typeof content === "string"
          ? content
          : content.find((p) => p.type === "text").text,
      );
      const result =
        input.thread.kind === "question"
          ? {
              schemaVersion: 1,
              answer: "Read-only answer 中文",
              evidenceReferences: [],
            }
          : {
              schemaVersion: 1,
              mode: "replace_ranges",
              explanation: "Scoped accepted revision",
              replacements: input.thread.anchor.ranges.map((_, rangeIndex) => ({
                rangeIndex,
                runs: [
                  { text: `Accepted ${input.thread.text} 中文 🐦`, marks: [] },
                ],
              })),
            };
      response.setHeader("content-type", "application/json");
      response.end(
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
    const review = async (kind, index, text) => {
      const b = (await req("/manuscript")).data.blocks[index],
        quote = b.runs.map((r) => r.text).join(""),
        id = randomUUID();
      const saved = await command("SaveReview", {
        expectedRequestVersion: 0,
        thread: {
          id,
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
        },
      });
      assert.equal(saved.status, 200, JSON.stringify(saved));
      assert.equal(
        (await command("StartReviewTask", { threadId: id, requestVersion: 1 }))
          .status,
        200,
      );
      for (let i = 0; i < 180; i++) {
        const card = (await req("/reviews")).data.cards.find(
          (c) => c.thread.id === id,
        );
        if (card.task && card.task.application !== "pending") {
          assert.equal(card.task.application, "applied", JSON.stringify(card));
          return card;
        }
        await pause();
      }
      throw Error("Composed review timeout");
    };
    const beforeQuestion = (await req("/manuscript")).data.blocks;
    const question = await review("question", 1, "Explain the draft");
    assert.equal(question.task.answer, "Read-only answer 中文");
    assert.deepEqual((await req("/manuscript")).data.blocks, beforeQuestion);
    const one = await review("revision_note", 1, "individual");
    const accept = async (cards) => {
      const h = (await req("/history")).data;
      const result = await command("AcceptReviewCandidates", {
        expectedHistoryRevision: h.historyRevision,
        candidates: cards.map((c) => ({
          id: c.candidate.id,
          version: c.candidate.version,
        })),
      });
      assert.equal(result.status, 200, JSON.stringify(result));
      return result;
    };
    await accept([one]);
    const batch = [
      await review("revision_note", 1, "batch A"),
      await review("revision_note", 3, "batch B"),
    ];
    const accepted = await accept(batch);
    assert.equal(
      (await req("/manuscript/commands", accepted.body)).status,
      200,
    );
    assert.equal(
      (await command("SetUserLocks", { all: true, blockIds: [], locked: true }))
        .status,
      200,
    );
    const finalBody = (await req("/manuscript")).data,
      finalHistory = (await req("/history")).data,
      finalLocks = (await req("/manuscript/finalization")).data;
    // The identity route supplies the ordered body hash, independent of locks.
    const identity = (await req("/manuscript/identity")).data;
    const preparedCopy = await req("/manuscript/copies", {
      requestId: randomUUID(),
      expectedRevision: finalBody.workingRevision,
      expectedBodyHash: identity.bodyHash,
    });
    assert.equal(preparedCopy.status, 200, JSON.stringify(preparedCopy));
    assert.match(preparedCopy.data.text, /Accepted batch A 中文 🐦/);
    assert.doesNotMatch(
      preparedCopy.data.text,
      /Read-only answer|Scoped accepted revision/,
    );
    const jobs = [];
    for (const format of ["txt", "md", "docx"]) {
      const begun = await req("/manuscript/exports", {
        requestId: randomUUID(),
        expectedRevision: finalBody.workingRevision,
        expectedBodyHash: identity.bodyHash,
        format,
      });
      assert.equal(begun.status, 200, JSON.stringify(begun));
      let job = begun.data;
      for (
        let i = 0;
        i < 180 && ["queued", "running"].includes(job.status);
        i++
      ) {
        await pause();
        job = (await req(`/manuscript/exports/${job.id}`)).data;
      }
      assert.equal(job.status, "ready", JSON.stringify(job));
      const response = await fetch(
        base + `/manuscript/exports/${job.id}/artifact`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.ok(bytes.length > 0);
      if (format !== "docx") {
        assert.match(bytes.toString(), /Accepted batch A 中文 🐦/);
        assert.doesNotMatch(
          bytes.toString(),
          /Read-only answer|Scoped accepted revision/,
        );
      }
      jobs.push(job);
    }
    assert.deepEqual((await req("/history")).data, finalHistory);
    await stop();
    await boot();
    assert.deepEqual((await req("/manuscript")).data, finalBody);
    assert.deepEqual((await req("/history")).data, finalHistory);
    assert.deepEqual((await req("/manuscript/finalization")).data, finalLocks);
    assert.equal((await req("/manuscript/exports")).data.length, 3);
    assert.equal(provider.calls.length, 6);
    console.log(
      JSON.stringify({
        fixture:
          "two outline sections; Unicode; marked draft; selected scanned PDF raster",
        providerCalls: provider.calls.length,
        preparationMs: samples.preparation,
      }),
    );
  } finally {
    await stop();
    await provider.close();
    await rm(dir, { recursive: true, force: true });
  }
});
