import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ProjectRegistry,
  inspectRememberedProject,
  prepareInitialProject,
  writeRegistryAtomically,
} from "../../apps/desktop/src/project-registry.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "scenesparrow-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new ProjectRegistry(join(root, "project-registry.json"));
  await registry.load();
  return {
    root,
    registry,
    defaultDirectory: join(root, "projects", "default"),
  };
}
async function project(directory) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "project.sqlite"), "fixture database");
  return directory;
}

test("first-run default and explicit override preserve native directory compatibility", async (t) => {
  const { root, registry, defaultDirectory } = await fixture(t);
  const inspected = [];
  const inspect = async (path) => inspected.push(path);
  assert.equal(registry.status, "missing");
  assert.deepEqual(
    await prepareInitialProject(registry, defaultDirectory, undefined, inspect),
    {
      directory: defaultDirectory,
      create: true,
    },
  );
  assert.deepEqual(inspected, []);
  await project(defaultDirectory);
  assert.deepEqual(
    await prepareInitialProject(registry, defaultDirectory, undefined, inspect),
    {
      directory: defaultDirectory,
      create: false,
    },
  );
  const remembered = await project(join(root, "写作 project 🌱"));
  await registry.record(remembered, { id: "core-id", title: "幕雀" });
  const reopened = new ProjectRegistry(registry.path);
  await reopened.load();
  assert.deepEqual(
    await prepareInitialProject(reopened, defaultDirectory, undefined, inspect),
    {
      directory: remembered,
      create: false,
    },
  );
  const override = join(root, "explicit");
  assert.deepEqual(
    await prepareInitialProject(reopened, defaultDirectory, override, inspect),
    {
      directory: override,
      create: true,
    },
  );
  assert.equal(reopened.lastDirectory, remembered);
  assert.deepEqual(inspected, [defaultDirectory, remembered]);
});

test("registry bounds/dedupes locators, preserves stable opaque IDs across title changes and copied project IDs", async (t) => {
  const { root, registry } = await fixture(t);
  for (let i = 0; i < 12; i++)
    await registry.record(join(root, String(i)), {
      id: "same-copied-core-id",
      title: `Project ${i}`,
    });
  assert.equal(registry.recentProjects().length, 10);
  assert.deepEqual(
    registry.recentProjects().map((p) => p.title),
    Array.from({ length: 10 }, (_, i) => `Project ${11 - i}`),
  );
  const previous = registry.recentProjects()[3];
  const path = registry.resolveRecent(previous.id);
  await registry.record(path, { id: "same-copied-core-id", title: "Renamed" });
  assert.deepEqual(registry.recentProjects()[0], {
    id: previous.id,
    title: "Renamed",
  });
  assert.equal(registry.recentProjects().length, 10);
  assert.equal(new Set(registry.recentProjects().map((p) => p.id)).size, 10);
  assert.deepEqual(Object.keys(registry.recentProjects()[0]), ["id", "title"]);
  for (const invalid of [
    path,
    "../project.sqlite",
    null,
    {},
    "same-copied-core-id",
  ])
    assert.throws(() => registry.resolveRecent(invalid), /INVALID_REQUEST/);
  assert.throws(
    () => registry.resolveRecent(randomUUID()),
    /PROJECT_NOT_FOUND/,
  );
  const reopened = new ProjectRegistry(registry.path);
  await reopened.load();
  assert.deepEqual(reopened.recentProjects(), registry.recentProjects());
  assert.equal(reopened.lastDirectory, path);
});

test("empty active core selection persists before ensure, then gains its core identity/title", async (t) => {
  const { root, registry } = await fixture(t);
  const path = await project(join(root, "empty"));
  await registry.record(path, null);
  assert.deepEqual(registry.recentProjects(), []);
  const reopened = new ProjectRegistry(registry.path);
  await reopened.load();
  assert.equal(reopened.lastDirectory, path);
  await reopened.record(path, { id: "ensured-project", title: "Untitled" });
  assert.equal(reopened.recentProjects()[0].title, "Untitled");
  assert.equal(
    JSON.parse(await readFile(registry.path, "utf8")).entries[0].projectId,
    "ensured-project",
  );
});

test("missing/empty remembered project and inspection refusal preserve selection and never create replacement data", async (t) => {
  const { root, registry, defaultDirectory } = await fixture(t);
  const path = await project(join(root, "original"));
  await registry.record(path, { id: "original", title: "Original" });
  const before = await readFile(registry.path, "utf8");
  await rm(path, { recursive: true });
  let inspected = 0;
  const inspect = async () => {
    inspected++;
  };
  await assert.rejects(
    prepareInitialProject(registry, defaultDirectory, undefined, inspect),
  );
  // Explicitly using this same disappeared locator is also refused.
  await assert.rejects(
    prepareInitialProject(registry, defaultDirectory, path, inspect),
  );
  assert.equal(inspected, 0);
  await mkdir(path);
  await assert.rejects(inspectRememberedProject(path, inspect));
  assert.equal(inspected, 0);
  await project(path);
  for (const reason of [
    "PROJECT_OWNED",
    "PROJECT_INTEGRITY_FAILED",
    "SCHEMA_UNSUPPORTED",
  ])
    await assert.rejects(
      prepareInitialProject(registry, defaultDirectory, undefined, async () => {
        throw Error(reason);
      }),
      new RegExp(reason),
    );
  assert.equal(await readFile(registry.path, "utf8"), before);
  assert.equal(registry.lastDirectory, path);
  assert.deepEqual(await readdir(path), ["project.sqlite"]);
});

test("corrupt/unsupported registry requires explicit selection and preserves exact original on successful replacement", async (t) => {
  const { root, registry, defaultDirectory } = await fixture(t);
  for (const invalid of [
    "{broken",
    '{"version":2}',
    JSON.stringify({ version: 1, lastId: randomUUID(), entries: [] }),
    "x".repeat(128 * 1024 + 1),
  ]) {
    await writeFile(registry.path, invalid);
    await registry.load();
    assert.equal(registry.status, "corrupt");
    await assert.rejects(
      prepareInitialProject(
        registry,
        defaultDirectory,
        undefined,
        async () => {},
      ),
      /REGISTRY_INVALID/,
    );
    assert.equal(await readFile(registry.path, "utf8"), invalid);
  }
  const original = await readFile(registry.path, "utf8");
  const selected = await project(join(root, "selected"));
  assert.deepEqual(
    await prepareInitialProject(
      registry,
      defaultDirectory,
      selected,
      async () => {},
    ),
    { directory: selected, create: false },
  );
  await registry.record(selected, { id: "selected", title: "Selected" });
  assert.equal(registry.status, "ready");
  const backup = (await readdir(root)).find((p) => p.includes(".corrupt-"));
  assert.equal(await readFile(join(root, backup), "utf8"), original);
});

test("failed atomic promotion preserves last good bytes, removes temporary file, and keeps registry retryable", async (t) => {
  const { root, registry } = await fixture(t);
  await registry.record(join(root, "original"), { id: "old", title: "Old" });
  const before = await readFile(registry.path, "utf8");
  let fail = true;
  const reopened = new ProjectRegistry(registry.path, (path, data) =>
    writeRegistryAtomically(path, data, async (temporary, destination) => {
      assert.equal(await readFile(temporary, "utf8"), data);
      if (fail) throw Error("EPERM");
      const { rename } = await import("node:fs/promises");
      await rename(temporary, destination);
    }),
  );
  await reopened.load();
  await assert.rejects(
    reopened.record(join(root, "candidate"), { id: "new", title: "New" }),
    /EPERM/,
  );
  assert.equal(await readFile(registry.path, "utf8"), before);
  assert.equal(reopened.lastDirectory, join(root, "original"));
  assert.deepEqual(await readdir(root), ["project-registry.json"]);
  fail = false;
  await reopened.record(join(root, "candidate"), { id: "new", title: "New" });
  assert.equal(reopened.lastDirectory, join(root, "candidate"));
});
