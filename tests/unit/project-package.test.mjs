import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createHttpClient } from "../../packages/platform-client/src/http.ts";
import { createDesktopClient } from "../../packages/platform-client/src/desktop.ts";
import { registerProjectPackageIpc } from "../../apps/desktop/src/project-package-ipc.ts";
const methods = [
  "readPackageBase",
  "startProjectPackageExport",
  "startWorkCopyPackageExport",
  "readPackageOperation",
  "controlPackageOperation",
  "createPackageIntake",
  "readPackageIntake",
  "uploadPackageChunk",
  "controlPackageIntake",
  "inspectPackage",
  "readPackageInspection",
  "issuePackageRestoreTarget",
  "restorePackage",
  "returnPackage",
];
test("package HTTP named capabilities preserve binary bytes and streaming response", async () => {
  const calls = [],
    prior = globalThis.fetch,
    id = randomUUID(),
    owner = randomUUID(),
    bytes = new Uint8Array([0, 255, 1]);
  globalThis.fetch = async (url, init) => {
    calls.push([url, init]);
    return new Response(
      url.endsWith(`/archives/${id}`)
        ? bytes
        : JSON.stringify({ accepted: true }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const c = createHttpClient("/api");
    await c.readPackageBase();
    await c.startProjectPackageExport({
      requestId: id,
      base: { projectId: owner },
    });
    await c.startWorkCopyPackageExport({
      requestId: id,
      ownerProjectId: owner,
      workItemId: id,
      expectedWorkItemRevision: 0,
    });
    await c.uploadPackageChunk(
      {
        ownerProjectId: owner,
        intakeId: id,
        offset: 4,
        length: 3,
        hash: "a".repeat(64),
      },
      bytes,
    );
    assert.equal(calls.at(-1)[1].method, "PUT");
    assert.equal(calls.at(-1)[1].body, bytes);
    assert.equal(calls.at(-1)[1].headers["x-scenesparrow-chunk-offset"], "4");
    const response = await c.openPackageArchive(id);
    assert.ok(response.body instanceof ReadableStream);
    assert.equal((await response.body.getReader().read()).value.length, 3);
    await assert.rejects(
      c.uploadPackageChunk(
        { intakeId: id, length: 3 },
        new Uint8Array(1024 * 1024 + 1),
      ),
      /INVALID_REQUEST/,
    );
  } finally {
    globalThis.fetch = prior;
  }
});
test("package desktop optional bridges and preload names stay closed", async () => {
  const calls = [],
    bridge = Object.fromEntries(
      methods.map((name) => [
        name,
        async (...args) => {
          calls.push([name, args]);
          return { ok: true, data: { name } };
        },
      ]),
    );
  const c = createDesktopClient(bridge);
  for (const method of methods) {
    assert.equal(typeof c[method], "function");
    await c[method]();
  }
  assert.equal(createDesktopClient({}).inspectPackage, undefined);
  const source = await readFile(
    new URL("../../apps/desktop/src/preload.cts", import.meta.url),
    "utf8",
  );
  for (const method of methods)
    assert.ok(source.includes(`project-package:${method}`));
  assert.equal(source.includes("openPackageArchive"), false);
});
test("package IPC enforces sender and UUID paths and bounds binary before native request", async () => {
  const handlers = new Map(),
    calls = [];
  let denied = false;
  registerProjectPackageIpc(
    { handle: (name, fn) => handlers.set(name, fn) },
    {
      checkSender: () => {
        if (denied) throw Error("ORIGIN_DENIED");
      },
      request: async (...args) => {
        calls.push(args);
        return { ok: true, data: {} };
      },
      uploadChunk: async (...args) => {
        calls.push(args);
        return { ok: true, data: {} };
      },
    },
  );
  const id = randomUUID();
  assert.equal(
    (
      await handlers.get("project-package:readPackageOperation")(
        {},
        "../escape",
      )
    ).code,
    "INVALID_REQUEST",
  );
  await handlers.get("project-package:readPackageOperation")({}, id);
  assert.equal(calls[0][0], `/project/packages/operations/${id}`);
  const metadata = {
    ownerProjectId: randomUUID(),
    intakeId: id,
    offset: 0,
    length: 1,
    hash: "a".repeat(64),
  };
  assert.equal(
    (
      await handlers.get("project-package:uploadPackageChunk")(
        {},
        metadata,
        new Uint8Array(1024 * 1024 + 1),
      )
    ).code,
    "INVALID_REQUEST",
  );
  assert.equal(calls.length, 1);
  await handlers.get("project-package:uploadPackageChunk")(
    {},
    metadata,
    new Uint8Array([0]),
  );
  assert.equal(calls.length, 2);
  denied = true;
  assert.equal(
    (await handlers.get("project-package:restorePackage")({}, {})).code,
    "ORIGIN_DENIED",
  );
  assert.equal(calls.length, 2);
});
