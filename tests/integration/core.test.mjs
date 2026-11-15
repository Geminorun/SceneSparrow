import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { start, waitFor } from "../../scripts/processes.mjs";

test("a real core process restores the same project after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scenesparrow-core-"));
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const token = randomBytes(32).toString("hex");
  const headers = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const base = `http://127.0.0.1:${port}/v1`;
  let child;
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGINT");
      await exit;
    }
  };
  const launch = async () => {
    child = start(
      `./target/debug/scenesparrow-service${process.platform === "win32" ? ".exe" : ""}`,
      [],
      {
        env: {
          ...process.env,
          SCENESPARROW_SESSION_TOKEN: token,
          SCENESPARROW_CORE_PORT: String(port),
          SCENESPARROW_PROJECT_DIR: directory,
        },
      },
    );
    await waitFor(`${base}/health`, headers, child);
  };
  try {
    await launch();
    assert.equal((await fetch(`${base}/project`)).status, 401);
    const command = { requestId: "restart-test", title: "幕雀 – Restart" };
    const response = await fetch(`${base}/project`, {
      method: "POST",
      headers,
      body: JSON.stringify(command),
    });
    assert.equal(response.status, 200);
    const original = await response.json();
    assert.equal(original.project.title, command.title);
    assert.equal(original.project.workingRevision, 0);
    assert.equal(original.project.approvedBaseline, null);
    const send = async (command) =>
      fetch(`${base}/manuscript/commands`, {
        method: "POST",
        headers,
        body: JSON.stringify(command),
      });
    const start = {
      type: "StartManualDraft",
      requestId: randomUUID(),
      projectId: original.project.id,
      expectedWorkingRevision: 0,
      payload: {},
    };
    assert.equal((await send(start)).status, 200);
    const blockId = randomUUID();
    const edit = {
      type: "ApplyDocumentEdit",
      requestId: randomUUID(),
      projectId: original.project.id,
      expectedWorkingRevision: 1,
      payload: {
        operations: [
          {
            op: "insertBlock",
            block: {
              id: blockId,
              kind: "paragraph",
              attrs: {},
              runs: [
                {
                  text: "中文 🐦 acknowledged manuscript " + "x".repeat(20000),
                  marks: [],
                },
              ],
            },
            after: null,
          },
        ],
        expectedBlockRevisions: [],
        group: {
          clientSessionId: randomUUID(),
          groupId: randomUUID(),
          groupSequence: 1,
          kind: "typing",
        },
      },
    };
    const editResponse = await send(edit);
    assert.equal(editResponse.status, 200);
    const receipt = await editResponse.json();
    const manuscript = await (
      await fetch(`${base}/manuscript`, { headers })
    ).json();
    assert.equal(manuscript.blocks[0].id, blockId);
    assert.equal(manuscript.workingRevision, 2);
    assert.equal((await fetch(`${base}/manuscript`)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/manuscript`, {
          headers: { ...headers, Origin: "https://untrusted.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await send({
          ...edit,
          payload: {
            ...edit.payload,
            operations: [{ op: "moveBlocks", ids: [blockId] }],
          },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await send({
          ...edit,
          payload: {
            ...edit.payload,
            operations: [{ op: "deleteBlock", id: blockId, unknown: true }],
          },
        })
      ).status,
      400,
    );
    assert.deepEqual(await (await send(edit)).json(), receipt);
    assert.equal(
      (await send({ ...edit, expectedWorkingRevision: 2 })).status,
      400,
    );
    original.project.workingRevision = 2;
    await stop();
    await launch();
    assert.deepEqual(
      await (await fetch(`${base}/manuscript`, { headers })).json(),
      manuscript,
    );
    assert.deepEqual(
      await (
        await fetch(`${base}/commands/${edit.requestId}`, { headers })
      ).json(),
      receipt,
    );
    assert.deepEqual(await (await send(edit)).json(), receipt);
    const restored = await (await fetch(`${base}/project`, { headers })).json();
    assert.deepEqual(restored, original);
    const repeated = await (
      await fetch(`${base}/project`, {
        method: "POST",
        headers,
        body: JSON.stringify(command),
      })
    ).json();
    assert.deepEqual(repeated, original);
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
