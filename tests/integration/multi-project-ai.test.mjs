import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { waitFor } from "../../scripts/processes.mjs";
import { planningProvider, configurePlanning } from "../fixtures/planning.mjs";
const pause = () => new Promise((r) => setTimeout(r, 20));
test("two actual cores share one global configuration and independently fence one active/eight pending fake runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "scenesparrow-two-cores-")),
    provider = await planningProvider(),
    nodes = [];
  let release;
  const barrier = new Promise((r) => (release = r));
  provider.setHandler(async (_req, res) => {
    await barrier;
    if (!res.destroyed) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: {
                content: JSON.stringify({
                  schemaVersion: 1,
                  answer: "Synthetic answer",
                  evidenceReferences: [],
                }),
              },
              finish_reason: "stop",
            },
          ],
        }),
      );
    }
  });
  try {
    for (const name of ["A", "B"]) {
      const socket = createServer();
      socket.listen(0, "127.0.0.1");
      await once(socket, "listening");
      const port = socket.address().port;
      await new Promise((r) => socket.close(r));
      const token = randomBytes(32).toString("hex"),
        native = randomBytes(32).toString("hex"),
        base = `http://127.0.0.1:${port}/v1`;
      const child = spawn(resolve("target/debug/scenesparrow-service"), [], {
        stdio: "pipe",
        env: {
          ...process.env,
          SCENESPARROW_PROJECT_DIR: join(root, name),
          SCENESPARROW_APP_DATA_DIR: join(root, "global"),
          SCENESPARROW_SESSION_TOKEN: token,
          SCENESPARROW_NATIVE_TOKEN: native,
          SCENESPARROW_CORE_PORT: String(port),
        },
      });
      const req = async (path, body, method) => {
        const r = await fetch(base + path, {
          method: method ?? (body ? "POST" : "GET"),
          headers: {
            Authorization: `Bearer ${token}`,
            "x-scenesparrow-native": native,
            "content-type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: r.status, data: await r.json() };
      };
      const node = { child, req, threads: [], runs: [] };
      nodes.push(node);
      await waitFor(
        base + "/health",
        { Authorization: `Bearer ${token}` },
        child,
      );
      const project = (
        await req("/project", {
          requestId: randomUUID(),
          title: `Project ${name}`,
        })
      ).data.project;
      node.project = project;
      node.command = async (type, payload) => {
        const state = (await req("/manuscript")).data;
        return req("/manuscript/commands", {
          type,
          payload,
          requestId: randomUUID(),
          projectId: project.id,
          expectedWorkingRevision: state.workingRevision,
        });
      };
      assert.equal((await node.command("StartManualDraft", {})).status, 200);
      const blockId = randomUUID();
      assert.equal(
        (
          await node.command("ApplyDocumentEdit", {
            operations: [
              {
                op: "insertBlock",
                after: null,
                block: {
                  id: blockId,
                  kind: "paragraph",
                  attrs: {},
                  runs: [{ text: "Question source 中文", marks: [] }],
                },
              },
            ],
            expectedBlockRevisions: [],
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
      const state = (await req("/manuscript")).data,
        b = state.blocks[0],
        quote = b.runs[0].text;
      for (let i = 0; i < 10; i++) {
        const id = randomUUID();
        node.threads.push(id);
        assert.equal(
          (
            await node.command("SaveReview", {
              expectedRequestVersion: 0,
              thread: {
                id,
                kind: "question",
                requestVersion: 0,
                text: `Question ${i}`,
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
                language: "en",
                evidence: [],
                decision: null,
                userMessageIds: [],
              },
            })
          ).status,
          200,
        );
      }
    }
    await configurePlanning(nodes[0].req, provider.root);
    const settings = (await nodes[0].req("/ai/settings")).data;
    assert.deepEqual(
      (await nodes[1].req("/ai/settings")).data.settings,
      settings.settings,
    );
    for (const node of nodes)
      assert.equal(
        (
          await node.command("StartReviewTask", {
            threadId: node.threads[0],
            requestVersion: 1,
          })
        ).status,
        200,
      );
    for (let i = 0; i < 300 && provider.calls.length < 2; i++) await pause();
    assert.equal(provider.calls.length, 2);
    for (const node of nodes) {
      for (const threadId of node.threads.slice(1, 9))
        assert.equal(
          (
            await node.command("StartReviewTask", {
              threadId,
              requestVersion: 1,
            })
          ).status,
          200,
        );
      const full = await node.command("StartReviewTask", {
        threadId: node.threads[9],
        requestVersion: 1,
      });
      assert.equal(full.status, 409);
      assert.equal(full.data.code, "QUEUE_FULL");
      const cards = (await node.req("/reviews")).data.cards;
      const runs = cards.filter((c) => c.task).map((c) => c.task.run);
      assert.equal(runs.filter((r) => r.status === "running").length, 1);
      assert.equal(runs.filter((r) => r.status === "queued").length, 8);
      assert.ok(
        runs.every((r) => r.configuration.model.id === "planning-fixture"),
      );
      node.runs = runs;
    }
    const changed = structuredClone(settings.settings);
    changed.models.push({ ...changed.models[0], id: "future-model" });
    changed.bindings[0].modelId = "future-model";
    assert.equal(
      (
        await nodes[1].req(
          "/ai/settings",
          { expectedRevision: changed.revision, settings: changed },
          "PUT",
        )
      ).status,
      200,
    );
    assert.equal(
      (await nodes[0].req("/ai/settings")).data.settings.bindings[0].modelId,
      "future-model",
    );
    assert.equal(
      (
        await nodes[0].command("CancelReviewTask", {
          threadId: nodes[0].threads[1],
          requestVersion: 1,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await nodes[0].command("StartReviewTask", {
          threadId: nodes[0].threads[9],
          requestVersion: 1,
        })
      ).status,
      200,
    );
    const latest = (await nodes[0].req("/reviews")).data.cards.find(
      (c) => c.thread.id === nodes[0].threads[9],
    );
    assert.equal(latest.task.run.configuration.model.id, "future-model");
    for (const node of nodes)
      for (const run of node.runs)
        assert.equal(
          (await node.req(`/ai/runs/${run.runId}`)).data.configuration.model.id,
          "planning-fixture",
        );
    assert.ok(provider.calls.every((c) => c.body.model === "planning-fixture"));
    const quiesced = await Promise.all(
      nodes.map((n) => n.req("/project/quiesce", {})),
    );
    assert.ok(quiesced.every((r) => r.status === 200));
    await pause();
    assert.equal(provider.calls.length, 2);
    for (const node of nodes) {
      const runs = (await node.req("/reviews")).data.cards
        .filter((c) => c.task)
        .map((c) => c.task.run);
      assert.ok(runs.some((r) => r.status === "interrupted"));
      assert.ok(runs.some((r) => r.status === "queued"));
    }
  } finally {
    release();
    for (const node of nodes)
      if (node.child.exitCode === null) {
        const ended = once(node.child, "exit");
        node.child.kill();
        await ended;
      }
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});
