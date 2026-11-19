import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { waitFor } from "../../scripts/processes.mjs";
const grant = {
  wholeTree: true,
  files: [],
  directories: [],
  manuscriptScope: { kind: "all", blockIds: [] },
};
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "scenesparrow-work-")),
    root = join(directory, "project"),
    token = randomBytes(32).toString("hex"),
    native = randomBytes(32).toString("hex");
  let child, base;
  const headers = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const stop = async () => {
    if (child?.exitCode === null && child?.signalCode === null) {
      const done = once(child, "exit");
      child.kill("SIGINT");
      await done;
    }
  };
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  async function boot(mode = "existing") {
    const socket = createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const port = socket.address().port;
    await new Promise((done) => socket.close(done));
    base = `http://127.0.0.1:${port}/v1`;
    child = spawn(resolve("target/debug/scenesparrow-service"), [], {
      env: {
        ...process.env,
        SCENESPARROW_PROJECT_DIR: root,
        SCENESPARROW_APP_DATA_DIR: join(directory, "app"),
        SCENESPARROW_SESSION_TOKEN: token,
        SCENESPARROW_NATIVE_TOKEN: native,
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
    const response = await raw(path, body);
    const data = await response.json();
    if (!response.ok)
      throw Object.assign(Error(data.code), { status: response.status, data });
    return data;
  }
  async function action() {
    const graph = await req("/project/file-graph"),
      source = await req("/manuscript/source");
    return {
      requestId: randomUUID(),
      projectId: source.projectId,
      expectedWorkingRevision: source.workingRevision,
      expectedGraphHash: graph.graphHash,
      expectedGraphGeneration: graph.generation,
    };
  }
  async function waitItem(id, done) {
    for (let n = 0; n < 150; n++) {
      const item = await req(`/project/work-items/${id}`);
      if (done(item)) return item;
      await new Promise((done) => setTimeout(done, 30));
    }
    throw Error("operation did not finish");
  }
  async function create(options = {}) {
    const request = {
      ...(await action()),
      origin: "copy",
      grant,
      referenceIds: [],
      ...options,
    };
    const start = await req("/project/work-items", request);
    const item = await waitItem(
      start.item.workItemId,
      (item) => item.state !== "preparing",
    );
    return { item, request, start };
  }
  async function inspect(item) {
    const request = {
      ...(await action()),
      workItemId: item.workItemId,
      expectedItemRevision: item.itemRevision,
    };
    await req(`/project/work-items/${item.workItemId}/inspect`, request);
    return waitItem(item.workItemId, (item) => item.state !== "inspecting");
  }
  async function register() {
    const s = await req("/manuscript/source");
    return req("/project/file-graph/register", {
      requestId: randomUUID(),
      projectId: s.projectId,
      expectedWorkingRevision: s.workingRevision,
      expectedSourceHash: s.acceptedHash,
      expectedSourceGeneration: s.generation,
    });
  }
  return {
    root,
    directory,
    token,
    native,
    boot,
    stop,
    raw,
    req,
    action,
    create,
    inspect,
    register,
    copy: (item) =>
      join(root, ".scenesparrow/work-items", item.workItemId, "project"),
  };
}
test("OP4 HTTP recorded copy/raw preparation/stream/accept/full DTO replay/history survive reopen", async (t) => {
  const f = await fixture(t);
  await f.boot("format-create");
  await mkdir(join(f.root, "public"));
  await writeFile(join(f.root, "public/twin-a.bin"), Buffer.from([0, 255, 3]));
  await writeFile(join(f.root, "public/twin-b.bin"), Buffer.from([0, 255, 3]));
  await f.register();
  const { item: created, request, start } = await f.create();
  assert.deepEqual(
    (await f.req("/project/work-items", request)).operation.requestId,
    start.operation.requestId,
  );
  const text = JSON.stringify(await f.req("/project/work-items"));
  assert(!text.includes(f.directory));
  assert(!text.includes(f.token));
  const copy = f.copy(created);
  assert.notEqual(
    (await stat(join(copy, "public/twin-a.bin"))).ino,
    (await stat(join(f.root, "public/twin-a.bin"))).ino,
  );
  await writeFile(join(copy, "manuscript.md"), "External new paragraph\n");
  await writeFile(join(copy, "public/twin-a.bin"), Buffer.from([0, 255, 7, 8]));
  let item = await f.inspect(created);
  assert.equal(item.latestCandidate.assignedIds, 1);
  const originalPrepared = item.latestCandidate.preparedGraphHash;
  item = await f.inspect(item);
  assert.equal(item.latestCandidate.preparedGraphHash, originalPrepared);
  const page = await f.req(
    `/project/work-items/${item.workItemId}/candidates/${item.latestCandidate.candidateId}/changes`,
  );
  const binary = page.records.find((x) => x.path === "public/twin-a.bin");
  assert.equal(binary.text, null);
  const member = `/project/work-items/${item.workItemId}/candidates/${item.latestCandidate.candidateId}/members/${binary.memberId}/after/bytes`;
  const response = await f.raw(member);
  assert.equal(
    response.headers.get("content-type"),
    "application/octet-stream",
  );
  assert.match(response.headers.get("content-disposition"), /^attachment/);
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    Buffer.from([0, 255, 7, 8]),
  );
  assert.equal(
    (await f.raw(member.replace(binary.memberId, "f".repeat(64)))).status,
    404,
  );
  assert.equal(
    (await f.raw(`/project/work-items/${item.workItemId}/reveal`)).status,
    403,
  );
  assert.equal(
    (
      await f.raw(`/project/work-items/${item.workItemId}/reveal`, undefined, {
        "x-scenesparrow-native": f.native,
      })
    ).status,
    200,
  );
  const before = await f.req("/history");
  const accept = {
    ...(await f.action()),
    workItemId: item.workItemId,
    candidateId: item.latestCandidate.candidateId,
    candidateDigest: item.latestCandidate.candidateDigest,
    expectedItemRevision: item.itemRevision,
  };
  const result = await f.req(
    `/project/work-items/${item.workItemId}/accept`,
    accept,
  );
  assert.equal(result.receipt.undoCount, before.undoCount + 1);
  assert.equal(
    (await f.req(`/project/work-operations/${accept.requestId}`)).receipt
      .requestId,
    accept.requestId,
  );
  assert.deepEqual(
    (await f.req(`/project/work-items/${item.workItemId}/accept`, accept))
      .receipt,
    result.receipt,
  );
  await assert.rejects(
    f.req(`/project/work-items/${item.workItemId}/accept`, {
      ...accept,
      candidateDigest: "f".repeat(64),
    }),
    /REQUEST_ID_CONFLICT/,
  );
  await f.stop();
  await f.boot();
  assert.deepEqual(
    (await f.req(`/project/work-items/${item.workItemId}/accept`, accept))
      .receipt,
    result.receipt,
  );
  assert.match(
    (await f.req("/manuscript/source")).source,
    /External new paragraph/,
  );
});
test("OP4 HTTP scope and late production locks produce original durable rejection outcomes", async (t) => {
  const f = await fixture(t);
  await f.boot("format-create");
  await mkdir(join(f.root, "public"));
  await writeFile(join(f.root, "public/a.bin"), Buffer.from([0, 255]));
  await f.register();
  const { item: created } = await f.create({
    grant: {
      wholeTree: false,
      files: ["public/a.bin"],
      directories: [],
      manuscriptScope: { kind: "none", blockIds: [] },
    },
  });
  await writeFile(join(f.copy(created), "escape.txt"), "outside");
  const item = await f.inspect(created);
  assert(item.latestCandidate.blockers.includes("WORK_OUT_OF_SCOPE"));
  const body = {
    ...(await f.action()),
    workItemId: item.workItemId,
    candidateId: item.latestCandidate.candidateId,
    candidateDigest: item.latestCandidate.candidateDigest,
    expectedItemRevision: item.itemRevision,
  };
  for (let n = 0; n < 2; n++)
    await assert.rejects(
      f.req(`/project/work-items/${item.workItemId}/accept`, body),
      /WORK_OUT_OF_SCOPE/,
    );
  await assert.rejects(
    f.req(`/commands/${body.requestId}`),
    /WORK_OUT_OF_SCOPE/,
  );
  const second = (await f.create()).item;
  await writeFile(join(f.copy(second), "public/a.bin"), Buffer.from([1, 255]));
  const inspected = await f.inspect(second);
  const target = (await f.req("/project/file-graph/files")).records.find(
    (f) => f.path === "public/a.bin",
  );
  const lock = await f.req("/project/file-locks", {
    ...(await f.action()),
    locked: true,
    targets: [{ path: target.path, hash: target.hash }],
  });
  assert.equal(lock.receipt.blockRevisions.length, 0);
  const reinspected = await f.inspect(inspected);
  assert(
    reinspected.latestCandidate.blockers.includes("PRODUCTION_FILE_LOCKED"),
  );
  const locked = {
    ...(await f.action()),
    workItemId: second.workItemId,
    candidateId: reinspected.latestCandidate.candidateId,
    candidateDigest: reinspected.latestCandidate.candidateDigest,
    expectedItemRevision: reinspected.itemRevision,
  };
  await assert.rejects(
    f.req(`/project/work-items/${second.workItemId}/accept`, locked),
    /PRODUCTION_FILE_LOCKED/,
  );
  await assert.rejects(
    f.req(`/commands/${locked.requestId}`),
    /PRODUCTION_FILE_LOCKED/,
  );
});

test("OP4 HTTP v3 SQL interruption preserves exact path/role/version members behind authenticated streams", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const f = await fixture(t);
  await f.boot("format-create");
  await mkdir(join(f.root, "public"));
  const before = Buffer.from([0, 255, 0]);
  await writeFile(join(f.root, "public/a.bin"), before);
  await writeFile(join(f.root, "public/b.bin"), before);
  await f.register();
  const { item: created } = await f.create();
  await writeFile(
    join(f.copy(created), "public/a.bin"),
    Buffer.from([1, 255, 1]),
  );
  const item = await f.inspect(created);
  const accept = {
    ...(await f.action()),
    workItemId: item.workItemId,
    candidateId: item.latestCandidate.candidateId,
    candidateDigest: item.latestCandidate.candidateDigest,
    expectedItemRevision: item.itemRevision,
  };
  const db = new DatabaseSync(join(f.root, ".scenesparrow/project.sqlite"));
  t.after(() => db.close());
  db.exec(
    `CREATE TRIGGER work_receipt_failure BEFORE INSERT ON command_receipts WHEN NEW.request_id='${accept.requestId}' BEGIN SELECT RAISE(FAIL,'fixture SQL cut'); END;`,
  );
  await assert.rejects(
    f.req(`/project/work-items/${item.workItemId}/accept`, accept),
    /STORAGE_UNAVAILABLE/,
  );
  db.exec("DROP TRIGGER work_receipt_failure");
  await writeFile(join(f.root, "public/a.bin"), Buffer.from([2, 255, 2]));
  const status = await f.req("/manuscript/source/status");
  assert.equal(status.pendingIntent.version, 3);
  assert(status.observationFingerprint);
  const inspection = await f.req(
    `/project/file-recoveries/${status.pendingIntent.intentHash}`,
  );
  assert.equal(inspection.intentHash, status.pendingIntent.intentHash);
  assert.notEqual(
    inspection.observationFingerprint,
    status.observationFingerprint,
  );
  await f.req("/manuscript/source/recover", {
    projectId: item.projectId,
    intentHash: status.pendingIntent.intentHash,
    requestId: accept.requestId,
    disposition: "preserveExternal",
    observationFingerprint: inspection.observationFingerprint,
  });
  await assert.rejects(
    f.req(`/commands/${accept.requestId}`),
    /SOURCE_EXTERNAL_CHANGE/,
  );
  await assert.rejects(
    f.req(`/project/work-items/${item.workItemId}/accept`, accept),
    /SOURCE_EXTERNAL_CHANGE/,
  );
  const intent = status.pendingIntent.intentHash;
  const page = await f.req(`/project/file-recoveries/${intent}/members`);
  assert(page.records.length > 3);
  assert(
    (await f.req("/project/file-recoveries")).records.some(
      (row) => row.intentHash === intent,
    ),
  );
  const a = page.records.filter((row) => row.path === "public/a.bin");
  assert(new Set(a.map((row) => row.hash)).size >= 3);
  for (const member of a) {
    const response = await f.raw(
      `/project/file-recoveries/${intent}/members/${member.memberId}/bytes`,
    );
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash("sha256").update(bytes).digest("hex"), member.hash);
    assert.equal(bytes.length, member.size);
  }
  const sameHash = page.records.filter(
    (row) => row.role === "acceptedBefore" && row.path.startsWith("public/"),
  );
  assert.equal(sameHash.length, 2);
  assert.equal(sameHash[0].hash, sameHash[1].hash);
  assert.notEqual(sameHash[0].memberId, sameHash[1].memberId);
  assert.equal(
    (
      await f.raw(
        `/project/file-recoveries/${"f".repeat(64)}/members/${sameHash[0].memberId}/bytes`,
      )
    ).status,
    404,
  );
  assert.deepEqual(
    await readFile(join(f.root, "public/a.bin")),
    Buffer.from([2, 255, 2]),
  );
});
