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

const pause = () => new Promise((resolve) => setTimeout(resolve, 40));
const inputFrom = (body) => {
  const content = body.messages.find(
    (message) => message.role === "user",
  ).content;
  return JSON.parse(
    typeof content === "string"
      ? content
      : content.find((part) => part.type === "text").text,
  );
};
const prose = (length) =>
  "清晨的小鸟停在枝头歌唱人们安静观察自然学习倾听".repeat(100).slice(0, length);
const draftFrom = (plan) => ({
  schemaVersion: 1,
  sections: plan.nodes.map((node, index) => ({
    outlineNodeId: node.id,
    blocks: [
      {
        kind: "paragraph",
        attrs: {},
        runs: [{ text: prose(index ? 650 : 700), marks: [] }],
      },
    ],
  })),
  evidenceReferences: [],
  verificationHints: [],
  planningNotes: [],
});

test("WIG-04: one complete 2000-character Chinese draft; counted token/size failures preserve content across history/restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scenesparrow-output-limits-"));
  const provider = await planningProvider();
  const token = randomBytes(32).toString("hex");
  let child,
    base,
    project,
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
    await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    base = `http://127.0.0.1:${port}/v1`;
    child = spawn(
      process.env.SCENESPARROW_CORE_BIN ??
        "./target/debug/scenesparrow-service",
      [],
      {
        env: {
          ...process.env,
          SCENESPARROW_APP_DATA_DIR: join(dir, "app"),
          SCENESPARROW_PROJECT_DIR: join(dir, "project"),
          SCENESPARROW_SESSION_TOKEN: token,
          SCENESPARROW_CORE_PORT: String(port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (bytes) => (logs += bytes));
    child.stderr.on("data", (bytes) => (logs += bytes));
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
    const result = await req("/manuscript/commands", body);
    assert.equal(result.status, 200, JSON.stringify(result));
    return body;
  };
  const startDraft = async () => {
    const prep = await req("/planning/preparations", {
      operation: "generate_initial_draft",
    });
    assert.equal(prep.status, 200, JSON.stringify(prep));
    return command("StartPlanningTask", {
      preparationId: prep.data.id,
      retryOfTaskId: null,
    });
  };
  const waitTask = async (id) => {
    for (let index = 0; index < 200; index++) {
      const task = (await req("/planning/tasks/" + id)).data;
      if (task.application !== "pending") return task;
      await pause();
    }
    throw Error("Task timeout " + logs);
  };
  const history = async (type) => {
    const state = (await req("/history")).data;
    await command(
      type,
      {},
      {
        expectedHistoryRevision: state.historyRevision,
        expectedCursor: state.cursor,
      },
    );
  };
  try {
    await boot();
    project = (
      await req("/project", {
        requestId: randomUUID(),
        title: "Uncapped output fixture",
      })
    ).data.project;
    await configurePlanning(req, provider.root);
    const plan = (await req("/planning")).data.content;
    plan.brief.topic = "观察小鸟与自然";
    plan.brief.language = "zh-CN";
    plan.brief.lengthHint = "约2000个汉字";
    plan.nodes = [0, 1, 0].map((depth, index) => ({
      id: randomUUID(),
      revision: 0,
      depth,
      title: ["开场", "倾听", "实践"][index],
      keyPoints: [],
    }));
    await command("SavePlanning", {
      content: plan,
      group: {
        clientSessionId: randomUUID(),
        groupId: randomUUID(),
        groupSequence: 1,
        kind: "discrete",
      },
    });
    const savedPlan = (await req("/planning")).data.content;
    let expectedPlan = savedPlan;
    const original = (await req("/manuscript")).data;
    let mode = "complete";
    provider.setHandler(async (_request, response, body) => {
      const input = inputFrom(body);
      assert.equal(input.operation, "generate_initial_draft");
      assert.deepEqual(input.planning, expectedPlan);
      assert.equal(Object.hasOwn(body, "max_tokens"), false);
      assert.equal(Object.hasOwn(body, "max_completion_tokens"), false);
      const output = draftFrom(input.planning);
      if (mode === "size")
        output.sections[0].blocks[0].runs[0].text = "字".repeat(
          Math.ceil((4 * 1024 * 1024) / 3),
        );
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: { content: JSON.stringify(output) },
              finish_reason: mode === "token" ? "length" : "stop",
            },
          ],
        }),
      );
    });
    const completeStart = await startDraft();
    const complete = await waitTask(completeStart.requestId);
    assert.equal(complete.application, "applied", JSON.stringify(complete));
    assert.equal(provider.calls.length, 1);
    assert.equal(
      Object.hasOwn(complete.run.configuration.parameters, "maxOutputTokens"),
      false,
    );
    assert.deepEqual(
      complete.metadata.sectionMapping.map((section) => section.outlineNodeId),
      savedPlan.nodes.map((node) => node.id),
    );
    const draft = (await req("/manuscript")).data;
    const spoken = draft.blocks
      .filter((block) => block.kind === "paragraph")
      .flatMap((block) => block.runs)
      .map((run) => run.text)
      .join("");
    assert.equal([...spoken].length, 2000);
    assert.match(spoken, /^[\p{Script=Han}]+$/u);
    assert.deepEqual(
      draft.blocks
        .filter((block) => block.kind === "heading")
        .map((block) => block.runs.map((run) => run.text).join("")),
      savedPlan.nodes.map((node) => node.title),
    );
    assert.deepEqual((await req("/planning")).data.content, savedPlan);
    const system = provider.calls[0].body.messages
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : message.content.map((part) => part.text ?? "").join(""),
      )
      .join(" ");
    assert.match(system, /scenesparrow-planning\/2/);
    assert.match(system, /saved language and lengthHint/);
    await history("UndoProject");
    assert.deepEqual((await req("/manuscript")).data.blocks, original.blocks);
    await stop();
    await boot();
    assert.equal(
      (await req("/planning/tasks/" + completeStart.requestId)).data
        .application,
      "applied",
    );
    assert.equal(
      (await req("/manuscript/commands", completeStart)).status,
      200,
    );
    await history("RedoProject");
    const restored = (await req("/manuscript")).data.blocks;
    assert.deepEqual(
      restored.map(({ revision, ...block }) => block),
      draft.blocks.map(({ revision, ...block }) => block),
    );
    assert.ok(
      restored.every(
        (block, index) => block.revision > draft.blocks[index].revision,
      ),
    );
    assert.equal(provider.calls.length, 1);
    await history("UndoProject");
    for (const [failureMode, code] of [
      ["token", "OUTPUT_TOKEN_LIMIT"],
      ["size", "OUTPUT_SIZE_LIMIT"],
    ]) {
      mode = failureMode;
      const beforeBody = (await req("/manuscript")).data;
      const beforePlan = (await req("/planning")).data.content;
      expectedPlan = beforePlan;
      const beforeHistory = (await req("/history")).data;
      const count = provider.calls.length;
      const failedStart = await startDraft();
      const failed = await waitTask(failedStart.requestId);
      assert.equal(failed.application, "failed", JSON.stringify(failed));
      assert.equal(failed.error, code);
      assert.equal(failed.run.error, code);
      assert.equal(failed.run.status, "failed");
      assert.equal(failed.run.result, null);
      assert.equal(provider.calls.length, count + 1);
      assert.deepEqual((await req("/manuscript")).data, beforeBody);
      assert.deepEqual((await req("/planning")).data.content, beforePlan);
      assert.equal((await req("/planning")).data.reserved, false);
      assert.deepEqual((await req("/history")).data, beforeHistory);
      await stop();
      await boot();
      assert.equal(
        (await req("/planning/tasks/" + failedStart.requestId)).data.error,
        code,
      );
      assert.equal(
        (await req("/manuscript/commands", failedStart)).status,
        200,
      );
      await pause();
      assert.equal(provider.calls.length, count + 1);
      assert.deepEqual((await req("/manuscript")).data, beforeBody);
      assert.deepEqual((await req("/planning")).data.content, beforePlan);
    }
    console.log(
      JSON.stringify({
        fixture: "WIG-04",
        chineseCharacters: 2000,
        applicationTokenBudget: false,
        completeDraftCalls: 1,
        tokenFailureCalls: 1,
        sizeFailureCalls: 1,
        totalProviderCalls: provider.calls.length,
      }),
    );
  } finally {
    await stop();
    await provider.close();
    await rm(dir, { recursive: true, force: true });
  }
});
