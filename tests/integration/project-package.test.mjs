import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { waitFor } from "../../scripts/processes.mjs";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const grant = {
  wholeTree: true,
  files: [],
  directories: [],
  manuscriptScope: { kind: "all", blockIds: [] },
};
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "scenesparrow-package-")),
    root = join(directory, "source"),
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
  async function boot(mode = "existing", selected = root) {
    const socket = createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const port = socket.address().port;
    await new Promise((done) => socket.close(done));
    base = `http://127.0.0.1:${port}/v1`;
    child = spawn(resolve("target/debug/scenesparrow-service"), [], {
      env: {
        ...process.env,
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
      method: body === undefined ? "GET" : "POST",
      headers: { ...headers, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function req(path, body) {
    const response = await raw(path, body),
      data = await response.json();
    if (!response.ok)
      throw Object.assign(Error(data.code), { status: response.status, data });
    return data;
  }
  async function operation(id) {
    for (let n = 0; n < 300; n++) {
      const v = await req(`/project/packages/operations/${id}`);
      if (!["capturing", "queued", "running"].includes(v.state)) return v;
      await new Promise((done) => setTimeout(done, 20));
    }
    throw Error("package operation did not finish");
  }
  async function chunk(metadata, bytes, extra = {}) {
    return fetch(
      base + `/project/package-intakes/${metadata.intakeId}/chunks`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/octet-stream",
          "x-scenesparrow-owner-project-id": metadata.ownerProjectId,
          "x-scenesparrow-chunk-offset": String(metadata.offset),
          "x-scenesparrow-chunk-length": String(metadata.length),
          "x-scenesparrow-chunk-sha256": metadata.hash,
          ...extra,
        },
        body: bytes,
      },
    );
  }
  async function upload(bytes) {
    const owner = (await req("/project/packages/base")).projectId;
    const i = await req("/project/package-intakes", {
      requestId: randomUUID(),
      ownerProjectId: owner,
      filename: "fixture.zip",
      length: bytes.length,
      hash: sha(bytes),
    });
    for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
      const b = bytes.subarray(offset, offset + 1024 * 1024),
        response = await chunk(
          {
            ownerProjectId: owner,
            intakeId: i.intakeId,
            offset,
            length: b.length,
            hash: sha(b),
          },
          b,
        );
      assert.equal(response.status, 200, await response.text());
    }
    return i;
  }
  async function inspect(bytes) {
    const intake = await upload(bytes),
      request = {
        requestId: randomUUID(),
        ownerProjectId: intake.ownerProjectId,
        intakeId: intake.intakeId,
      };
    await req("/project/packages/inspections", request);
    return { request, operation: await operation(request.requestId) };
  }
  await boot("format-create");
  await mkdir(join(root, "public"));
  await writeFile(join(root, "public/clip.bin"), Buffer.alloc(128 * 1024));
  const source = await req("/manuscript/source");
  await req("/project/file-graph/register", {
    requestId: randomUUID(),
    projectId: source.projectId,
    expectedWorkingRevision: source.workingRevision,
    expectedSourceHash: source.acceptedHash,
    expectedSourceGeneration: source.generation,
  });
  async function exported() {
    const request = {
      requestId: randomUUID(),
      base: await req("/project/packages/base"),
    };
    const start = await req("/project/packages/exports", request);
    const v = await operation(request.requestId);
    assert.equal(v.state, "succeeded", JSON.stringify(v));
    const response = await raw(
      `/project/packages/archives/${request.requestId}`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/zip");
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(sha(bytes), v.archive.hash);
    return { request, view: v, bytes, start };
  }
  return {
    nativeToken,
    root,
    app,
    boot,
    stop,
    req,
    raw,
    operation,
    chunk,
    upload,
    inspect,
    exported,
  };
}
function editStoredZip(bytes, path, replacement) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  let at = bytes.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    const n = bytes.readUInt16LE(at + 28),
      x = bytes.readUInt16LE(at + 30),
      c = bytes.readUInt16LE(at + 32),
      name = bytes.subarray(at + 46, at + 46 + n).toString(),
      offset32 = bytes.readUInt32LE(at + 42),
      size32 = bytes.readUInt32LE(at + 24);
    let offset = offset32,
      size = size32;
    for (let p = at + 46 + n; p < at + 46 + n + x;) {
      const tag = bytes.readUInt16LE(p),
        length = bytes.readUInt16LE(p + 2);
      let q = p + 4;
      if (tag === 1) {
        if (size32 === 0xffffffff) {
          size = Number(bytes.readBigUInt64LE(q));
          q += 8;
        }
        if (bytes.readUInt32LE(at + 20) === 0xffffffff) q += 8;
        if (offset32 === 0xffffffff) offset = Number(bytes.readBigUInt64LE(q));
      }
      p += 4 + length;
    }
    const start =
      offset +
      30 +
      bytes.readUInt16LE(offset + 26) +
      bytes.readUInt16LE(offset + 28);
    entries.push([
      name,
      name === path
        ? Buffer.from(replacement)
        : bytes.subarray(start, start + size),
    ]);
    at += 46 + n + x + c;
  }
  let offset = 0;
  const locals = [],
    centrals = [];
  function crc32(b) {
    let crc = 0xffffffff;
    for (const byte of b) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  for (const [name, body] of entries) {
    const n = Buffer.from(name),
      crc = crc32(body),
      local = Buffer.alloc(30),
      central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(n.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, body);
    centrals.push(central, n);
    offset += local.length + n.length + body.length;
  }
  const central = Buffer.concat(centrals),
    eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}
test("OP5-B HTTP fixed export streams and independent restore never retargets owner", async (t) => {
  const f = await fixture(t),
    out = await f.exported();
  const project = (await f.req("/project")).project;
  await f.req("/project/rename", {
    requestId: randomUUID(),
    projectId: project.id,
    previousTitle: project.title,
    title: "Later title",
  });
  assert.deepEqual(
    await f.req("/project/packages/exports", out.request),
    out.start,
  );
  const inspected = await f.inspect(out.bytes);
  assert.equal(
    inspected.operation.state,
    "succeeded",
    JSON.stringify(inspected.operation),
  );
  assert.equal(inspected.operation.inspection.verifiedRestore, true);
  const owner = out.request.base.projectId,
    inspectionId = inspected.request.requestId,
    target = await f.req("/project/packages/restore-targets", {
      requestId: randomUUID(),
      ownerProjectId: owner,
      inspectionId,
      destination: "managed",
    }),
    restore = {
      requestId: randomUUID(),
      ownerProjectId: owner,
      inspectionId,
      targetId: target.targetId,
    };
  await f.req("/project/packages/restores", restore);
  assert.equal((await f.operation(restore.requestId)).state, "succeeded");
  assert.equal((await f.req("/project")).project.title, "Later title");
  await f.stop();
  await f.boot("existing", join(f.app, "project-roots", target.targetId));
  assert.deepEqual(await f.req("/project/packages/base"), out.request.base);
});
test("OP5-B HTTP binary chunk replay, body limits, seal and durable owner failures", async (t) => {
  const f = await fixture(t),
    owner = (await f.req("/project/packages/base")).projectId,
    b = Buffer.alloc(64 * 1024, 7),
    request = {
      requestId: randomUUID(),
      ownerProjectId: owner,
      filename: "intake.zip",
      length: b.length * 2,
      hash: sha(Buffer.concat([b, b])),
    },
    i = await f.req("/project/package-intakes", request),
    m = {
      ownerProjectId: owner,
      intakeId: i.intakeId,
      offset: 0,
      length: b.length,
      hash: sha(b),
    };
  let response = await f.chunk(m, b);
  assert.equal(response.status, 200);
  const ack = await response.json();
  response = await f.chunk({ ...m, offset: b.length }, b);
  assert.equal(response.status, 200);
  assert.deepEqual(await (await f.chunk(m, b)).json(), ack);
  const wrong = Buffer.alloc(b.length, 9);
  assert.equal((await f.chunk({ ...m, hash: sha(wrong) }, wrong)).status, 409);
  const huge = Buffer.alloc(1024 * 1024 + 1);
  assert.equal(
    (await f.chunk({ ...m, length: huge.length, hash: sha(huge) }, huge))
      .status,
    413,
  );
  const inspection = {
    requestId: randomUUID(),
    ownerProjectId: owner,
    intakeId: i.intakeId,
  };
  await f.req("/project/packages/inspections", inspection);
  assert.equal((await f.operation(inspection.requestId)).state, "failed");
  assert.equal(
    (await f.req(`/project/package-intakes/${i.intakeId}`)).state,
    "sealed",
  );
  const invalid = {
    ...request,
    requestId: randomUUID(),
    ownerProjectId: randomUUID(),
  };
  for (let n = 0; n < 2; n++)
    await assert.rejects(
      f.req("/project/package-intakes", invalid),
      (e) => e.message === "PROJECT_NOT_FOUND",
    );
  assert.equal(
    (
      await f.raw("/project/packages/base", undefined, {
        Authorization: "Bearer wrong",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.raw(
        "/project/packages/exports",
        {
          requestId: randomUUID(),
          base: await f.req("/project/packages/base"),
        },
        { Origin: "https://evil.invalid" },
      )
    ).status,
    403,
  );
});
test("OP5-B HTTP management tamper refuses and complete return accepts one OP4 candidate", async (t) => {
  const f = await fixture(t),
    out = await f.exported(),
    owner = out.request.base.projectId,
    bad = await f.inspect(
      editStoredZip(out.bytes, ".scenesparrow/managed.json", "{}"),
    );
  assert.equal(bad.operation.failureCode, "PACKAGE_MANAGEMENT_CHANGED");
  const good = await f.inspect(
    editStoredZip(out.bytes, "public/clip.bin", "edited media"),
  );
  assert.equal(good.operation.inspection.trustedReturn, true);
  assert.equal(good.operation.inspection.verifiedRestore, false);
  const returned = {
    requestId: randomUUID(),
    ownerProjectId: owner,
    inspectionId: good.request.requestId,
    grant,
  };
  await f.req("/project/packages/returns", returned);
  const operation = await f.operation(returned.requestId);
  assert.equal(operation.state, "succeeded", JSON.stringify(operation));
  const candidate = operation.candidate,
    item = await f.req(`/project/work-items/${candidate.workItemId}`),
    accept = {
      requestId: randomUUID(),
      projectId: owner,
      expectedWorkingRevision: candidate.inspectedWorkingRevision,
      expectedGraphHash: item.baseGraphHash,
      expectedGraphGeneration: candidate.inspectedGraphGeneration,
      workItemId: item.workItemId,
      candidateId: candidate.candidateId,
      candidateDigest: candidate.candidateDigest,
      expectedItemRevision: item.itemRevision,
    };
  const result = await f.req(
    `/project/work-items/${item.workItemId}/accept`,
    accept,
  );
  assert.deepEqual(
    (await f.req(`/project/work-items/${item.workItemId}/accept`, accept))
      .receipt,
    result.receipt,
  );
  assert.equal(
    (await readFile(join(f.root, "public/clip.bin"))).toString(),
    "edited media",
  );
});
test("OP5-B HTTP recorded work-copy package returns through its actual item and grant", async (t) => {
  const f = await fixture(t),
    base = await f.req("/project/packages/base"),
    create = await f.req("/project/work-items", {
      requestId: randomUUID(),
      projectId: base.projectId,
      expectedWorkingRevision: base.workingRevision,
      expectedGraphHash: base.graphHash,
      expectedGraphGeneration: base.graphGeneration,
      origin: "copy",
      grant,
      referenceIds: [],
    });
  let item;
  for (let n = 0; n < 100; n++) {
    item = await f.req(`/project/work-items/${create.item.workItemId}`);
    if (item.state !== "preparing") break;
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.equal(item.state, "ready");
  const request = {
    requestId: randomUUID(),
    ownerProjectId: base.projectId,
    workItemId: item.workItemId,
    expectedWorkItemRevision: item.itemRevision,
  };
  await f.req(`/project/work-items/${item.workItemId}/package`, request);
  const exported = await f.operation(request.requestId);
  assert.equal(exported.state, "succeeded", JSON.stringify(exported));
  const response = await f.raw(
      `/project/packages/archives/${request.requestId}`,
    ),
    bytes = Buffer.from(await response.arrayBuffer()),
    edited = editStoredZip(
      bytes,
      "project/public/clip.bin",
      "returned work copy",
    ),
    inspected = await f.inspect(edited);
  assert.equal(inspected.operation.inspection.trustedReturn, true);
  const returned = {
    requestId: randomUUID(),
    ownerProjectId: base.projectId,
    inspectionId: inspected.request.requestId,
    workItemId: item.workItemId,
  };
  await f.req("/project/packages/returns", returned);
  const candidate = (await f.operation(returned.requestId)).candidate;
  assert.ok(candidate);
  assert.equal(candidate.workItemId, item.workItemId);
  assert.equal(
    (await f.req(`/project/work-items/${item.workItemId}`)).latestCandidate
      .candidateId,
    candidate.candidateId,
  );
});
test("OP5-B HTTP Ready archive reconciliation survives restart and unknown restore target is preserved", async (t) => {
  const f = await fixture(t),
    out = await f.exported(),
    path = join(
      f.app,
      "project-transfers",
      `package-operation-${out.request.requestId}.json`,
    ),
    journal = JSON.parse(await readFile(path, "utf8"));
  await f.stop();
  journal.view.state = "running";
  delete journal.view.archive;
  await writeFile(path, JSON.stringify(journal));
  const indexPath = join(f.app, "project-transfers", "active.json"),
    index = JSON.parse(await readFile(indexPath, "utf8"));
  index.package_ids = [out.request.requestId];
  await writeFile(indexPath, JSON.stringify(index));
  await f.boot();
  const recovered = await f.req(
    `/project/packages/operations/${out.request.requestId}`,
  );
  assert.equal(recovered.state, "succeeded");
  assert.equal(recovered.archive.hash, out.view.archive.hash);
  assert.deepEqual(
    await f.req("/project/packages/exports", out.request),
    out.start,
  );
  const inspected = await f.inspect(out.bytes),
    owner = out.request.base.projectId,
    inspectionId = inspected.request.requestId,
    target = await f.req("/project/packages/restore-targets", {
      requestId: randomUUID(),
      ownerProjectId: owner,
      inspectionId,
      destination: "managed",
    }),
    unknown = join(f.app, "project-roots", target.targetId);
  await mkdir(unknown);
  await writeFile(join(unknown, "sentinel"), "unknown preserved");
  const restore = {
    requestId: randomUUID(),
    ownerProjectId: owner,
    inspectionId,
    targetId: target.targetId,
  };
  await f.req("/project/packages/restores", restore);
  for (let n = 0; n < 2; n++) {
    assert.equal(
      (await f.operation(restore.requestId)).failureCode,
      "PACKAGE_TARGET_EXISTS",
    );
  }
  assert.equal(
    (await readFile(join(unknown, "sentinel"))).toString(),
    "unknown preserved",
  );
  assert.deepEqual(await f.req("/project/packages/base"), out.request.base);
});
test("OP5-B HTTP foreign package result identity never authorizes the current owner", async (t) => {
  const f = await fixture(t),
    out = await f.exported(),
    foreignRoot = join(f.app, "foreign-owner");
  await f.stop();
  await f.boot("format-create", foreignRoot);
  const source = await f.req("/manuscript/source");
  await f.req("/project/file-graph/register", {
    requestId: randomUUID(),
    projectId: source.projectId,
    expectedWorkingRevision: source.workingRevision,
    expectedSourceHash: source.acceptedHash,
    expectedSourceGeneration: source.generation,
  });
  assert.notEqual(source.projectId, out.request.base.projectId);
  const inspected = await f.inspect(out.bytes),
    view = inspected.operation.inspection;
  assert.equal(view.ownerProjectId, source.projectId);
  assert.equal(view.resultProjectId, out.request.base.projectId);
  assert.equal(view.verifiedRestore, true);
  assert.equal(view.trustedReturn, false);
  const wrong = {
    requestId: randomUUID(),
    ownerProjectId: out.request.base.projectId,
    inspectionId: inspected.request.requestId,
    destination: "managed",
  };
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      f.req("/project/packages/restore-targets", wrong),
      (e) => e.message === "PROJECT_NOT_FOUND",
    );
  const target = await f.req("/project/packages/restore-targets", {
    ...wrong,
    requestId: randomUUID(),
    ownerProjectId: source.projectId,
  });
  assert.equal(target.resultProjectId, out.request.base.projectId);
  assert.equal(target.ownerProjectId, source.projectId);
  const restore = {
    requestId: randomUUID(),
    ownerProjectId: source.projectId,
    inspectionId: inspected.request.requestId,
    targetId: target.targetId,
  };
  await f.req("/project/packages/restores", restore);
  assert.equal((await f.operation(restore.requestId)).state, "succeeded");
  assert.equal((await f.req("/project")).project.id, source.projectId);
});

test("OP5-B HTTP failed publication preserves original outcome and expired retry across restart", async (t) => {
  const f = await fixture(t);
  const request = {
    requestId: randomUUID(),
    base: await f.req("/project/packages/base"),
  };
  const directory = join(f.app, "project-transfers");
  await mkdir(directory, { recursive: true });
  const archive = join(directory, `archive-${request.requestId}.zip`);
  await writeFile(archive, "unknown archive must survive");
  const original = await f.req("/project/packages/exports", request);
  const failed = await f.operation(request.requestId);
  assert.equal(failed.state, "failed");
  assert.equal(failed.archive, undefined);
  assert.deepEqual(
    await f.req(`/project/packages/operations/${request.requestId}`),
    failed,
  );
  assert.deepEqual(await f.req("/project/packages/exports", request), original);
  await f.stop();
  const { DatabaseSync } = await import("node:sqlite");
  const sql = new DatabaseSync(join(f.root, ".scenesparrow", "project.sqlite"));
  sql
    .prepare(
      "UPDATE package_exports SET capture_expires_at=0 WHERE export_id=?",
    )
    .run(request.requestId);
  sql.close();
  await f.boot();
  const status = await f.req(
    `/project/packages/operations/${request.requestId}`,
  );
  assert.deepEqual(status, failed);
  const retry = {
    requestId: randomUUID(),
    ownerProjectId: request.base.projectId,
    operationId: request.requestId,
    expectedOperationRevision: status.operationRevision,
    action: "retry",
  };
  const path = `/project/packages/operations/${request.requestId}/control`;
  for (let n = 0; n < 2; n++)
    await assert.rejects(f.req(path, retry), { message: "PACKAGE_EXPIRED" });
  await f.stop();
  await f.boot();
  await assert.rejects(f.req(path, retry), { message: "PACKAGE_EXPIRED" });
  assert.deepEqual(await f.req("/project/packages/exports", request), original);
  assert.deepEqual(
    await f.req(`/project/packages/operations/${request.requestId}`),
    failed,
  );
  assert.equal(
    (await readFile(archive)).toString(),
    "unknown archive must survive",
  );
});

test("native package save-new requires both private credentials and closed main-only path body", async (t) => {
  const f = await fixture(t);
  const exported = await f.exported();
  const destinationPath = join(f.root, "new-package.zip");
  const request = { requestId: randomUUID(), destinationPath };
  const path = `/native/project/packages/${exported.request.requestId}/save-new`;
  assert.equal((await f.raw(path, request)).status, 403);
  assert.equal(
    (
      await f.raw(
        path,
        { ...request, hash: "override" },
        { "x-scenesparrow-native": f.nativeToken },
      )
    ).status,
    400,
  );
  const result = await f.raw(path, request, {
    "x-scenesparrow-native": f.nativeToken,
  });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).outcome, "saved");
  assert.deepEqual(await readFile(destinationPath), exported.bytes);
  await writeFile(destinationPath, "unknown later content");
  const replay = await f.raw(path, request, {
    "x-scenesparrow-native": f.nativeToken,
  });
  assert.equal((await replay.json()).outcome, "saved");
  assert.equal(
    (await readFile(destinationPath)).toString(),
    "unknown later content",
  );
});
