import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  PackageFileUpload,
  PACKAGE_CHUNK_BYTES,
} from "../../packages/platform-client/src/package-file.ts";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("browser package upload uses bounded slices, exact incremental digest and resumes original intake after lost chunk ACK", async () => {
  const bytes = Buffer.alloc(2 * PACKAGE_CHUNK_BYTES + 17, 123),
    reads = [],
    chunks = [],
    creates = [];
  const file = {
    size: bytes.length,
    name: "fixture.zip",
    arrayBuffer() {
      throw Error("whole file forbidden");
    },
    slice(start, end) {
      reads.push(end - start);
      return new Blob([bytes.subarray(start, end)]);
    },
  };
  let received = 0,
    lost = true;
  const intakeId = randomUUID(),
    ownerProjectId = randomUUID();
  const view = () => ({
    intakeId,
    ownerProjectId,
    receivedBytes: received,
    revision: 0,
    state: "open",
    filename: file.name,
    length: bytes.length,
    hash: hash(bytes),
  });
  const client = {
    createPackageIntake: async (request) => {
      creates.push(request);
      return view();
    },
    readPackageIntake: async () => view(),
    uploadPackageChunk: async (request, chunk) => {
      assert.equal(hash(chunk), request.hash);
      assert.equal(chunk.length, request.length);
      assert.ok(chunk.length <= PACKAGE_CHUNK_BYTES);
      chunks.push(request);
      received = request.offset + chunk.length;
      if (lost) {
        lost = false;
        throw Error("lost ACK");
      }
      return { ...request, acknowledgedEnd: received };
    },
  };
  const upload = new PackageFileUpload(client, ownerProjectId, file);
  await assert.rejects(
    upload.run(() => {}),
    /lost ACK/,
  );
  const original = upload.request;
  await upload.run(() => {});
  assert.equal(upload.request, original);
  assert.equal(creates[0], creates[1]);
  assert.equal(original.hash, hash(bytes));
  assert.equal(received, bytes.length);
  assert.ok(reads.every((size) => size <= PACKAGE_CHUNK_BYTES));
  assert.deepEqual(
    chunks.map((chunk) => chunk.offset),
    [0, PACKAGE_CHUNK_BYTES, 2 * PACKAGE_CHUNK_BYTES],
  );
});
test("selection invalidation after a slice prevents intake creation or stale progress", async () => {
  let release,
    valid = true,
    creates = 0,
    progress = 0;
  const file = {
    name: "changed.zip",
    size: 1,
    slice() {
      return {
        arrayBuffer: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      };
    },
  };
  const upload = new PackageFileUpload(
    {
      createPackageIntake: async () => {
        creates++;
      },
    },
    randomUUID(),
    file,
    () => valid,
  );
  const running = upload.run(() => progress++);
  valid = false;
  release(new ArrayBuffer(1));
  await assert.rejects(running, /PACKAGE_CANCELLED/);
  assert.equal(creates, 0);
  assert.equal(progress, 0);
});

test("browser cancellation reconciles an intake whose create ACK was lost using the original ID", async () => {
  let cancelled;
  const upload = new PackageFileUpload(
    {
      createPackageIntake: async () => {
        throw Error("lost create ACK");
      },
      readPackageIntake: async (id) => ({ intakeId: id, revision: 1 }),
      controlPackageIntake: async (request) => {
        cancelled = request;
        return {};
      },
    },
    randomUUID(),
    new File(["zip"], "test.zip"),
  );
  await assert.rejects(
    upload.run(() => {}),
    /lost create ACK/,
  );
  await upload.cancel();
  assert.equal(cancelled.intakeId, upload.request.requestId);
});
test("shared filename policy bounds UTF-8 without splitting CJK/emoji graphemes and sanitizes quotes", async () => {
  const { safePackageFilename } =
    await import("../../packages/platform-client/src/package-name.mjs");
  const name = safePackageFilename('目录/"项目👩‍💻'.repeat(30) + ".zip");
  assert.ok(Buffer.byteLength(name) <= 120);
  assert.equal(name.includes('"'), false);
  assert.equal(name.includes("/"), false);
  assert.equal(name.includes("�"), false);
});

test("browser intake cancellation deduplicates clicks and replays the original control DTO after a lost ACK", async () => {
  const ownerProjectId = randomUUID(),
    intakeId = randomUUID(),
    file = new File(["zip"], "cancel.zip"),
    controls = [];
  let release,
    statusReads = 0;
  const view = {
    intakeId,
    ownerProjectId,
    receivedBytes: 0,
    revision: 1,
    state: "open",
    filename: file.name,
    length: file.size,
    hash: hash(Buffer.from("zip")),
  };
  const client = {
    createPackageIntake: async () => view,
    readPackageIntake: async () => {
      statusReads++;
      return view;
    },
    uploadPackageChunk: async () => {
      throw Error("upload paused");
    },
    controlPackageIntake: async (request) => {
      controls.push(request);
      if (controls.length === 1)
        await new Promise(
          (_resolve, reject) =>
            (release = () => reject(Error("lost cancel ACK"))),
        );
      return { ...view, state: "cancelled", revision: 2 };
    },
  };
  const upload = new PackageFileUpload(client, ownerProjectId, file);
  await assert.rejects(
    upload.run(() => {}),
    /upload paused/,
  );
  const first = upload.cancel(),
    duplicate = upload.cancel();
  assert.equal(first, duplicate);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await assert.rejects(first, /lost cancel ACK/);
  const readsBeforeRetry = statusReads;
  await upload.cancel();
  assert.equal(statusReads, readsBeforeRetry);
  assert.equal(controls.length, 2);
  assert.deepEqual(controls[0], controls[1]);
  assert.equal(upload.intake.state, "cancelled");
  await upload.cancel();
  assert.equal(controls.length, 2);
});
