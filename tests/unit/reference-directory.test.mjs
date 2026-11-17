import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
  lstat,
  truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ReferenceDirectoryRegistry,
  intakeReferenceDirectory,
  validReferencePath,
  REFERENCE_DIRECTORY_LIMITS,
} from "../../apps/desktop/src/reference-directory.ts";
import { registerReferenceDirectoryIpc } from "../../apps/desktop/src/reference-directory-ipc.ts";
import { intakeSelectedFile } from "../../apps/desktop/src/file-intake.ts";
import { createDesktopClient } from "../../packages/platform-client/src/index.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "scenesparrow-reference-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "selected");
  await mkdir(directory);
  return {
    root,
    directory,
    association: { id: randomUUID(), name: "selected" },
  };
}
function port() {
  const uploads = [],
    cancelled = [];
  return {
    uploads,
    cancelled,
    async upload(path, identity, signal) {
      signal.throwIfAborted();
      uploads.push({ path, identity });
      return {
        id: randomUUID(),
        hash: "a".repeat(64),
        size: identity.size,
        displayName: path.split("/").at(-1),
        mimeType: "text/plain",
      };
    },
    async cancel(id) {
      cancelled.push(id);
    },
  };
}

test("portable reference metadata rejects traversal, drives and control characters", () => {
  for (const path of [
    "",
    "/a",
    "../a",
    "a/../b",
    "a/./b",
    "a//b",
    "a/",
    "C:/a",
    "c:a",
    "a\\b",
    "a\nfile",
    "a\u0085b",
    "x".repeat(4097),
  ])
    assert.equal(validReferencePath(path), false, path);
  assert.equal(validReferencePath("research/中文 🐦/notes.md"), true);
});

test("registry persists project-scoped opaque associations and refuses symlink roots", async (t) => {
  const { root, directory } = await fixture(t);
  const registry = new ReferenceDirectoryRegistry(
    join(root, "host", "registry.json"),
  );
  await registry.load();
  const project = randomUUID();
  const association = await registry.record(project, directory);
  assert.deepEqual(Object.keys(association).sort(), ["id", "name"]);
  assert.equal(association.name, "selected");
  const reopened = new ReferenceDirectoryRegistry(registry.path);
  await reopened.load();
  assert.deepEqual(reopened.read(project), association);
  assert.equal(reopened.resolve(project, association.id), directory);
  assert.throws(
    () => reopened.resolve(randomUUID(), association.id),
    /OBJECT_NOT_FOUND/,
  );
  assert.throws(() => reopened.resolve(project, directory), /INVALID_REQUEST/);
  const link = join(root, "linked");
  await symlink(directory, link, "dir");
  await assert.rejects(reopened.record(project, link), /INVALID_REQUEST/);
  await writeFile(registry.path, '{"version":99}');
  const corrupt = new ReferenceDirectoryRegistry(registry.path);
  await corrupt.load();
  await assert.rejects(corrupt.record(project, directory), /REGISTRY_INVALID/);
});

test("bounded directory intake skips symlinks, unsupported types and oversized files", async (t) => {
  const { root, directory, association } = await fixture(t);
  await mkdir(join(directory, "中文"));
  await writeFile(join(directory, "中文", "notes.md"), "Evidence");
  await writeFile(join(directory, "unsupported.exe"), "No");
  await writeFile(join(root, "outside.txt"), "Secret");
  await symlink(join(root, "outside.txt"), join(directory, "outside.txt"));
  await symlink(root, join(directory, "cycle"), "dir");
  const large = join(directory, "large.txt");
  await writeFile(large, "");
  await truncate(large, REFERENCE_DIRECTORY_LIMITS.fileBytes + 1);
  const io = port();
  const batch = await intakeReferenceDirectory(
    directory,
    association,
    io,
    new AbortController().signal,
  );
  assert.deepEqual(
    batch.entries.map((e) => e.relativePath),
    ["中文/notes.md"],
  );
  assert.equal(io.uploads[0].identity.root, directory);
  assert.equal(
    batch.outcomes.filter((e) => e.code === "REFERENCE_SYMLINK").length,
    2,
  );
  assert.ok(batch.outcomes.some((e) => e.code === "REFERENCE_UNSUPPORTED"));
  assert.ok(batch.outcomes.some((e) => e.code === "INPUT_TOO_LARGE"));
  assert.equal(batch.truncated, false);
  const link = join(root, "root-link");
  await symlink(directory, link, "dir");
  await assert.rejects(
    intakeReferenceDirectory(
      link,
      association,
      io,
      new AbortController().signal,
    ),
    /INVALID_REQUEST/,
  );
});

test("file count, aggregate bytes, scan count and nesting bound every batch", async (t) => {
  const { directory, association } = await fixture(t);
  for (let i = 0; i < 101; i++)
    await writeFile(join(directory, `${i}.txt`), "One");
  let batch = await intakeReferenceDirectory(
    directory,
    association,
    port(),
    new AbortController().signal,
  );
  assert.equal(batch.entries.length, 100);
  assert.equal(batch.truncated, true);
  await rm(directory, { recursive: true });
  await mkdir(directory);
  for (let i = 0; i < 5; i++) {
    const path = join(directory, `${i}.txt`);
    await writeFile(path, "");
    await truncate(path, 25 * 1024 * 1024);
  }
  batch = await intakeReferenceDirectory(
    directory,
    association,
    port(),
    new AbortController().signal,
  );
  assert.equal(batch.entries.length, 4);
  assert.equal(batch.truncated, true);
  await rm(directory, { recursive: true });
  await mkdir(directory);
  for (let i = 0; i < 2002; i++)
    await writeFile(join(directory, `${i}.ignored`), "");
  batch = await intakeReferenceDirectory(
    directory,
    association,
    port(),
    new AbortController().signal,
  );
  assert.equal(batch.entries.length, 0);
  assert.ok(batch.outcomes.length <= 2001);
  assert.equal(batch.truncated, true);
  await rm(directory, { recursive: true });
  await mkdir(directory);
  let current = directory;
  for (let i = 0; i < 34; i++) {
    current = join(current, "nested");
    await mkdir(current);
  }
  await writeFile(join(current, "deep.txt"), "No");
  batch = await intakeReferenceDirectory(
    directory,
    association,
    port(),
    new AbortController().signal,
  );
  assert.equal(batch.entries.length, 0);
  assert.ok(batch.outcomes.some((e) => e.code === "REFERENCE_DEPTH_LIMIT"));
});

test("aborted batches reclaim every completed intake including the just-completed upload", async (t) => {
  const { directory, association } = await fixture(t);
  await writeFile(join(directory, "one.txt"), "One");
  await writeFile(join(directory, "two.txt"), "Two");
  const io = port(),
    abort = new AbortController();
  const upload = io.upload;
  const completed = [];
  io.upload = async (...args) => {
    const intake = await upload(...args);
    completed.push(intake.id);
    if (completed.length === 2) abort.abort();
    return intake;
  };
  await assert.rejects(
    intakeReferenceDirectory(directory, association, io, abort.signal),
    /abort/i,
  );
  assert.deepEqual(io.cancelled.sort(), completed.sort());
});

test("opened file identity and containment are checked before any authenticated upload", async (t) => {
  const { root, directory } = await fixture(t);
  const path = join(directory, "notes.txt");
  await writeFile(path, "Original");
  const stat = await lstat(path);
  const identity = {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    root: directory,
  };
  await writeFile(path, "Changed and longer");
  // Cleanup may attempt DELETE, but POST must never receive changed or outside bytes.
  const originalFetch = globalThis.fetch,
    methods = [];
  globalThis.fetch = async (_url, options) => {
    methods.push(options.method);
    return Response.json({});
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  await assert.rejects(
    intakeSelectedFile(
      path,
      "http://127.0.0.1/v1",
      "private-test-token",
      undefined,
      undefined,
      identity,
    ),
    /REFERENCE_FILE_CHANGED/,
  );
  const outside = join(root, "outside.txt");
  await writeFile(outside, "Outside");
  const outStat = await lstat(outside);
  await assert.rejects(
    intakeSelectedFile(
      outside,
      "http://127.0.0.1/v1",
      "private-test-token",
      undefined,
      undefined,
      {
        ...identity,
        dev: outStat.dev,
        ino: outStat.ino,
        size: outStat.size,
        mtimeMs: outStat.mtimeMs,
      },
    ),
    /REFERENCE_FILE_CHANGED/,
  );
  assert.ok(methods.every((method) => method === "DELETE"));
});

test("directory IPC validates sender, operation IDs, project capabilities and close cleanup", async (t) => {
  const { root, directory } = await fixture(t);
  await writeFile(join(directory, "one.txt"), "One");
  const registry = new ReferenceDirectoryRegistry(join(root, "registry.json"));
  await registry.load();
  const project = randomUUID(),
    handlers = new Map();
  const event = { sender: { id: 7, isDestroyed: () => false }, trusted: true };
  const io = port();
  let closing = false;
  const controller = registerReferenceDirectoryIpc(
    { handle: (name, callback) => handlers.set(name, callback) },
    {
      registry,
      projectId: async () => project,
      chooseDirectory: async () => directory,
      intakePort: () => io,
      checkSender(e, existing) {
        if (!e.trusted) throw Error("ORIGIN_DENIED");
        if (closing && !existing) throw Error("PROJECT_CLOSING");
      },
    },
  );
  const pick = handlers.get("reference-directory:pick");
  await assert.rejects(
    pick({ ...event, trusted: false }, randomUUID()),
    /ORIGIN_DENIED/,
  );
  assert.equal((await pick(event, directory)).code, "INVALID_REQUEST");
  const picked = await pick(event, randomUUID());
  assert.equal(picked.ok, true);
  assert.equal(picked.data.entries.length, 1);
  assert.deepEqual(
    (await handlers.get("reference-directory:read")(event)).data,
    picked.data.association,
  );
  const refresh = handlers.get("reference-directory:refresh");
  assert.equal(
    (await refresh(event, randomUUID(), directory)).code,
    "INVALID_REQUEST",
  );
  assert.equal(
    (await refresh(event, randomUUID(), randomUUID())).code,
    "OBJECT_NOT_FOUND",
  );
  io.upload = async (_path, _identity, signal) =>
    new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(Error("Aborted")), {
        once: true,
      });
      if (signal.aborted) reject(Error("Aborted"));
    });
  const pending = refresh(event, randomUUID(), picked.data.association.id);
  await new Promise((resolve) => setImmediate(resolve));
  closing = true;
  await controller.abortAndSettle();
  assert.equal((await pending).code, "DOCUMENT_JOB_INTERRUPTED");
  await assert.rejects(
    refresh(event, randomUUID(), picked.data.association.id),
    /PROJECT_CLOSING/,
  );
});

test("platform client reclaims returned intakes if abort races with the IPC reply", async () => {
  const abort = new AbortController(),
    cancelled = [];
  const id = randomUUID();
  const client = createDesktopClient({
    pickReferenceDirectory: async () => {
      abort.abort();
      return {
        ok: true,
        data: {
          association: { id: randomUUID(), name: "refs" },
          entries: [{ relativePath: "one.txt", intake: { id } }],
          outcomes: [],
          truncated: false,
        },
      };
    },
    cancelReferenceDirectoryBatch: async () => ({ ok: true, data: null }),
    cancelIntake: async (intakeId) => {
      cancelled.push(intakeId);
      return { ok: true };
    },
  });
  await assert.rejects(
    client.pickReferenceDirectory(abort.signal),
    (e) => e.code === "DOCUMENT_JOB_INTERRUPTED",
  );
  assert.deepEqual(cancelled, [id]);
});
