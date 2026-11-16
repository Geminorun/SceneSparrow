import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createServer } from "node:net";
import { waitFor } from "../../scripts/processes.mjs";
const pause = () => new Promise((r) => setTimeout(r, 30));
test("fully offline copy/export, exact body capture and verified recovered copy preserve acknowledged state", async () => {
  const root = await mkdtemp(join(tmpdir(), "scenesparrow-offline-export-")),
    token = randomBytes(32).toString("hex"),
    native = randomBytes(32).toString("hex");
  let child;
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const base = `http://127.0.0.1:${port}/v1`;
  const env = {
    ...process.env,
    SCENESPARROW_PROJECT_DIR: join(root, "project"),
    SCENESPARROW_APP_DATA_DIR: join(root, "settings"),
    SCENESPARROW_SESSION_TOKEN: token,
    SCENESPARROW_NATIVE_TOKEN: native,
    SCENESPARROW_CORE_PORT: String(port),
  };
  const start = async (directory) => {
    child = spawn(resolve("target/debug/scenesparrow-service"), [], {
      env: { ...env, SCENESPARROW_PROJECT_DIR: directory },
      stdio: "pipe",
    });
    await waitFor(
      `${base}/health`,
      { Authorization: `Bearer ${token}` },
      child,
    );
  };
  const req = async (path, body, method) => {
    const response = await fetch(base + path, {
      method: method ?? (body ? "POST" : "GET"),
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-scenesparrow-native": native,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    return data;
  };
  const stop = async () => {
    if (child && child.exitCode === null) {
      const p = once(child, "exit");
      child.kill();
      await p;
    }
  };
  try {
    await start(join(root, "project"));
    const project = (
      await req("/project", { requestId: "offline", title: "正文 👩‍💻" })
    ).project;
    let state = await req("/manuscript");
    const command = async (type, payload) => {
      const r = await req("/manuscript/commands", {
        type,
        requestId: randomUUID(),
        projectId: project.id,
        expectedWorkingRevision: state.workingRevision,
        payload,
      });
      state = await req("/manuscript");
      return r;
    };
    await command("StartManualDraft", {});
    const blockId = randomUUID();
    await command("ApplyDocumentEdit", {
      operations: [
        {
          op: "insertBlock",
          after: null,
          block: {
            id: blockId,
            kind: "paragraph",
            attrs: {},
            runs: [{ text: "Offline 中文 👩‍💻 é 🔒 comment", marks: [] }],
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
    });
    const identity = () =>
      createHash("sha256")
        .update(
          `canonical-1|${state.manuscriptId}|${state.schemaVersion}|${state.blocks.map((b) => `${b.id}:${b.revision}`).join("|")}`,
        )
        .digest("hex");
    const beforeJobs = await req("/manuscript/exports"),
      beforeHistory = await req("/history");
    const copyRequest = {
      requestId: randomUUID(),
      expectedRevision: state.workingRevision,
      expectedBodyHash: identity(),
    };
    const copy = await req("/manuscript/copies", copyRequest);
    assert.equal(copy.text, "Offline 中文 👩‍💻 é 🔒 comment\n");
    assert.deepEqual(await req("/manuscript/copies", copyRequest), copy);
    assert.deepEqual(await req("/manuscript/exports"), beforeJobs);
    assert.deepEqual(await req("/history"), beforeHistory);
    const bodyHash = identity(),
      revision = state.workingRevision;
    await command("SetUserLocks", { locked: true, all: true, blockIds: [] });
    const artifacts = [];
    for (const format of ["txt", "md", "docx"]) {
      const action = {
        requestId: randomUUID(),
        expectedRevision: revision,
        expectedBodyHash: bodyHash,
        format,
      };
      let job = await req("/manuscript/exports", action);
      for (
        let n = 0;
        n < 400 && ["queued", "running"].includes(job.status);
        n++
      ) {
        await pause();
        job = await req(`/manuscript/exports/${job.id}`);
      }
      assert.equal(job.status, "ready", JSON.stringify(job));
      assert.equal(job.capturedFinalized, true);
      assert.deepEqual(await req("/manuscript/exports", action), job);
      const response = await fetch(
        base + `/manuscript/exports/${job.id}/artifact`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      assert.match(
        response.headers.get("content-disposition"),
        /filename\*=UTF-8/,
      );
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        job.artifactHash,
      );
      artifacts.push({ job, bytes });
    }
    const finalState = await req("/manuscript"),
      finalHistory = await req("/history"),
      locks = await req("/manuscript/finalization");
    const backup = await req("/project/backup", {});
    const backupPath = join(root, "project", backup.id),
      recovered = join(root, "recovered");
    const tool = spawn(
      resolve("target/debug/scenesparrow-service"),
      ["--recover-project", backupPath, recovered],
      { env, stdio: "pipe" },
    );
    const [exit] = await once(tool, "exit");
    assert.equal(exit, 0);
    await stop();
    await start(recovered);
    assert.deepEqual(await req("/manuscript"), finalState);
    assert.deepEqual(await req("/history"), finalHistory);
    assert.deepEqual(await req("/manuscript/finalization"), locks);
    for (const { job, bytes } of artifacts) {
      const response = await fetch(
        base + `/manuscript/exports/${job.id}/artifact`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    }
    await writeFile(
      join(backupPath, "exports", artifacts[0].job.id),
      "corruption",
    );
    const bad = spawn(
      resolve("target/debug/scenesparrow-service"),
      ["--recover-project", backupPath, join(root, "invalid")],
      { env, stdio: "pipe" },
    );
    assert.notEqual((await once(bad, "exit"))[0], 0);
    assert.equal(
      (await readFile(join(root, "project", "exports", artifacts[0].job.id)))
        .length,
      artifacts[0].bytes.length,
    );
  } finally {
    await stop();
    await rm(root, { recursive: true, force: true });
  }
});
