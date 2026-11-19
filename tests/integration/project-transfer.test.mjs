import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { randomUUID, randomBytes } from "node:crypto";
import { waitFor } from "../../scripts/processes.mjs";
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "scenesparrow-transfer-")),
    source = join(directory, "source"),
    app = join(directory, "app"),
    token = randomBytes(32).toString("hex"),
    nativeToken = randomBytes(32).toString("hex");
  let child, base;
  const headers = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  async function stop() {
    if (child?.exitCode === null && child?.signalCode === null) {
      const done = once(child, "exit");
      child.kill("SIGINT");
      await done;
    }
  }
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  async function boot(mode = "existing", selected = source, noNode = false) {
    const socket = createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const port = socket.address().port;
    await new Promise((done) => socket.close(done));
    base = `http://127.0.0.1:${port}/v1`;
    child = spawn(resolve("target/debug/scenesparrow-service"), [], {
      env: {
        ...process.env,
        ...(noNode ? { PATH: "/scenesparrow-no-node" } : {}),
        SCENESPARROW_PROJECT_DIR: selected,
        SCENESPARROW_APP_DATA_DIR: app,
        SCENESPARROW_SESSION_TOKEN: token,
        SCENESPARROW_NATIVE_TOKEN: nativeToken,
        SCENESPARROW_CORE_PORT: String(port),
        SCENESPARROW_PROJECT_OPEN_MODE: mode,
      },
      stdio: "ignore",
    });
    await waitFor(base + "/health", headers, child);
  }
  async function raw(path, body, extra = {}) {
    return fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { ...headers, ...extra },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function req(path, body) {
    const response = await raw(path, body),
      data = await response.json();
    if (!response.ok)
      throw Object.assign(Error(data.code), { status: response.status, data });
    return data;
  }
  await boot("create");
  const project = (
    await req("/project", {
      requestId: randomUUID(),
      title: "Legacy migration fixture",
    })
  ).project;
  async function seed(text = "Source stays selected") {
    const current = await req("/manuscript");
    const block = randomUUID();
    return req("/manuscript/commands", {
      type: "ApplyDocumentEdit",
      requestId: randomUUID(),
      projectId: project.id,
      expectedWorkingRevision: current.workingRevision,
      payload: {
        operations: [
          {
            op: "insertBlock",
            after: null,
            block: {
              id: block,
              kind: "paragraph",
              attrs: {},
              runs: [{ text, marks: [] }],
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
      },
    });
  }
  async function ready(id) {
    for (let n = 0; n < 300; n++) {
      const view = await req(`/project/migrations/${id}`);
      if (!["queued", "running"].includes(view.state)) return view;
      await new Promise((done) => setTimeout(done, 25));
    }
    throw Error("migration did not finish");
  }
  return {
    directory,
    source,
    app,
    project,
    raw,
    req,
    seed,
    ready,
    boot,
    stop,
    nativeToken,
  };
}
test("OP5-A named conversion preserves source, original acknowledgments and durable managed result without activation", async (t) => {
  const f = await fixture(t);
  const receipt = await f.seed();
  const inspection = await f.req("/project/migration");
  assert.equal(inspection.legacySchema, 14);
  assert.equal(inspection.blockCount, 1);
  assert.match(inspection.contentBase, /^[a-f0-9]{64}$/);
  const issuance = {
    requestId: randomUUID(),
    projectId: f.project.id,
    destination: "managed",
  };
  const target = await f.req("/project/migration-targets", issuance);
  assert.deepEqual(target, await f.req("/project/migration-targets", issuance));
  assert.deepEqual(Object.keys(target).sort(), [
    "destination",
    "projectId",
    "targetId",
  ]);
  const request = {
    requestId: randomUUID(),
    projectId: f.project.id,
    contentBase: inspection.contentBase,
    targetId: target.targetId,
  };
  const original = await f.req("/project/migrations", request);
  assert.equal(original.operation.state, "queued");
  const view = await f.ready(request.requestId);
  assert.equal(view.state, "succeeded", JSON.stringify(view));
  assert.equal(view.phase, "ready");
  assert.match(view.backupId, /^[a-f0-9]{64}$/);
  assert.match(view.resultId, /^[a-f0-9]{64}$/);
  assert.ok(view.completedBytes > 0);
  assert.equal((await f.req("/project/migration")).projectId, f.project.id);
  assert.deepEqual(await f.req(`/commands/${receipt.requestId}`), receipt);
  const native = join(f.app, "project-roots", target.targetId);
  assert.match(
    await readFile(join(native, "manuscript.md"), "utf8"),
    /Source stays selected/,
  );
  assert.ok((await readdir(f.source)).includes("project.sqlite"));
  assert.ok(!(await readdir(f.source)).includes(".scenesparrow"));
  const control = {
    requestId: randomUUID(),
    projectId: f.project.id,
    operationId: request.requestId,
    expectedOperationRevision: view.operationRevision,
    action: "cancel",
  };
  const controlled = await f.req(
    `/project/migrations/${request.requestId}/control`,
    control,
  );
  assert.equal(controlled.state, "succeeded");
  assert.deepEqual(
    await f.req(`/project/migrations/${request.requestId}/control`, control),
    controlled,
  );
  const changedControl = await f.raw(
    `/project/migrations/${request.requestId}/control`,
    { ...control, action: "retry" },
  );
  assert.equal(changedControl.status, 409);
  await f.seed("Later source only");
  assert.deepEqual(await f.req("/project/migrations", request), original);
  const conflict = await f.raw("/project/migrations", {
    ...request,
    contentBase: "f".repeat(64),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "MIGRATION_REQUEST_CONFLICT");
  assert.ok(!JSON.stringify(view).includes(f.directory));
  assert.ok(!JSON.stringify(view).includes("Source stays selected"));
  await f.stop();
  await f.boot();
  assert.equal(
    (await f.req(`/project/migrations/${request.requestId}`)).resultId,
    view.resultId,
  );
  assert.deepEqual(await f.req("/project/migrations", request), original);
  await f.stop();
  await f.boot("existing", native);
  assert.equal((await f.req("/project/format")).status, "managed");
  assert.equal((await f.req("/manuscript")).blocks.length, 1);
  const backupResponse = await f.raw(
    "/project/backup",
    {},
    { "x-scenesparrow-native": f.nativeToken },
  );
  assert.equal(backupResponse.status, 200);
  const backup = await backupResponse.json();
  assert.ok(
    (await readFile(join(native, ".scenesparrow", backup.id, "manifest.json")))
      .length > 0,
  );
});
test("OP5-A requests remain closed/authenticated/exact-origin and stale failures replay", async (t) => {
  const f = await fixture(t);
  const inspection = await f.req("/project/migration");
  const target = await f.req("/project/migration-targets", {
    requestId: randomUUID(),
    projectId: f.project.id,
    destination: "managed",
  });
  const request = {
    requestId: randomUUID(),
    projectId: f.project.id,
    contentBase: "a".repeat(64),
    targetId: target.targetId,
  };
  let response = await f.raw("/project/migrations", request);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "MIGRATION_BASE_MISMATCH");
  await f.seed();
  response = await f.raw("/project/migrations", request);
  assert.equal((await response.json()).code, "MIGRATION_BASE_MISMATCH");
  response = await f.raw("/project/migrations", {
    ...request,
    requestId: randomUUID(),
    contentBase: inspection.contentBase,
    path: "/tmp/renderer-choice",
  });
  assert.equal(response.status, 400);
  response = await f.raw("/project/migration", undefined, {
    Authorization: "Bearer wrong",
  });
  assert.equal(response.status, 401);
  response = await f.raw(
    "/project/migration-targets",
    {
      requestId: randomUUID(),
      projectId: f.project.id,
      destination: "managed",
    },
    { Origin: "https://foreign.example" },
  );
  assert.equal(response.status, 403);
  response = await f.raw("/project/migrations/not-a-uuid");
  assert.equal(response.status, 400);
});

test("OP5-A absent Node refuses conversion while legacy source editing and verified backup survive", async (t) => {
  const f = await fixture(t);
  await f.seed("No Node legacy fixture");
  await f.stop();
  await f.boot("existing", f.source, true);
  const inspected = await f.req("/project/migration");
  const target = await f.req("/project/migration-targets", {
    requestId: randomUUID(),
    projectId: f.project.id,
    destination: "managed",
  });
  const request = {
    requestId: randomUUID(),
    projectId: f.project.id,
    contentBase: inspected.contentBase,
    targetId: target.targetId,
  };
  await f.req("/project/migrations", request);
  const view = await f.ready(request.requestId);
  assert.equal(view.state, "failed");
  assert.equal(view.failureCode, "MIGRATION_WORKER_UNAVAILABLE");
  assert.match(view.backupId, /^[0-9a-f]{64}$/);
  assert.equal(
    (await f.req("/manuscript")).blocks[0].runs[0].text,
    "No Node legacy fixture",
  );
  await f.seed("Source remains editable");
  assert.equal((await f.req("/manuscript")).blocks.length, 2);
  assert.ok(
    !(await readdir(join(f.app, "project-roots"))).includes(target.targetId),
  );
  const backup = (await readdir(join(f.app, "project-transfers"))).find((n) =>
    n.startsWith(`backup-${request.requestId}`),
  );
  assert.ok(backup);
  assert.ok(
    (await readFile(join(f.app, "project-transfers", backup, "manifest.json")))
      .length > 0,
  );
});
