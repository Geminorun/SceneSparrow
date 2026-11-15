import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  symlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  commitExportFile,
  prepareDestination,
  suggestedExportName,
} from "../../apps/desktop/src/export-files.ts";
const bytes = Buffer.from("中文 👩‍💻 é\n"),
  hash = createHash("sha256").update(bytes).digest("hex");
test("atomic native committer preserves old targets across faults and rejects detected identity races", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scenesparrow-delivery-"));
  const path = join(directory, "正文.txt");
  try {
    await writeFile(path, "old");
    for (const hooks of [
      {
        beforeWrite: async () => {
          throw Object.assign(Error(), { code: "ENOSPC" });
        },
      },
      {
        finalize: async () => {
          throw Object.assign(Error(), { code: "EBUSY" });
        },
      },
    ]) {
      const target = await prepareDestination(path, "txt");
      await assert.rejects(commitExportFile(target, bytes, hash, hooks));
      assert.equal(await readFile(path, "utf8"), "old");
      assert.deepEqual(await readdir(directory), ["正文.txt"]);
    }
    const target = await prepareDestination(path, "txt");
    await assert.rejects(
      commitExportFile(target, bytes, hash, {
        beforeFinalize: async () => writeFile(path, "external"),
      }),
      /DESTINATION_CHANGED/,
    );
    assert.equal(await readFile(path, "utf8"), "external");
    await assert.rejects(
      prepareDestination(path, "docx"),
      /DESTINATION_UNAVAILABLE/,
    );
    const absent = await prepareDestination(join(directory, "new.txt"), "txt");
    await assert.rejects(
      commitExportFile(absent, bytes, hash, {
        beforeFinalize: async () => writeFile(absent.path, "racer"),
      }),
      /DESTINATION_CHANGED/,
    );
    assert.equal(await readFile(absent.path, "utf8"), "racer");
    const link = join(directory, "link.txt");
    await symlink(path, link);
    await assert.rejects(
      prepareDestination(link, "txt"),
      /DESTINATION_CHANGED/,
    );
    await commitExportFile(await prepareDestination(path, "txt"), bytes, hash);
    assert.deepEqual(await readFile(path), bytes);
    await assert.rejects(
      commitExportFile(await prepareDestination(path, "txt"), bytes, hash, {
        afterFinalize: async () => {
          throw Error();
        },
      }),
      /DELIVERY_STATUS_UNKNOWN/,
    );
    assert.deepEqual(await readFile(path), bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("portable filename suggestions trim at grapheme boundaries and reject Windows reserved basenames", () => {
  for (const name of ["CON", "aux.foo", "  ", "../\\\u0001"]) {
    assert.match(suggestedExportName(name, "docx"), /^manuscript\.docx$/);
  }
  const title = "👩‍💻é中文".repeat(100);
  const file = suggestedExportName(title, "md"),
    base = file.slice(0, -3);
  assert.ok(base.length <= 120 && Buffer.byteLength(base) <= 180);
  assert.ok(
    [
      ...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(title),
    ].some(
      (_, i, a) =>
        a
          .slice(0, i + 1)
          .map((v) => v.segment)
          .join("") === base,
    ),
  );
});
test("detected parent replacement cannot redirect finalization or temporary cleanup", async () => {
  const { mkdir, rename } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "scenesparrow-parent-"));
  const parent = join(root, "chosen"),
    moved = join(root, "original");
  await mkdir(parent);
  const path = join(parent, "body.txt");
  await writeFile(path, "old");
  try {
    const target = await prepareDestination(path, "txt");
    let temp;
    await assert.rejects(
      commitExportFile(target, bytes, hash, {
        beforeFinalize: async () => {
          temp = (await readdir(parent)).find((n) => n.endsWith(".tmp"));
          await rename(parent, moved);
          await mkdir(parent);
          await writeFile(join(parent, temp), "external temporary canary");
          await writeFile(path, "external destination");
        },
      }),
      /DESTINATION_CHANGED/,
    );
    assert.equal(await readFile(path, "utf8"), "external destination");
    assert.equal(
      await readFile(join(parent, temp), "utf8"),
      "external temporary canary",
    );
    assert.equal(await readFile(join(moved, "body.txt"), "utf8"), "old");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("temporary byte/symlink substitution is rejected before existing or absent destination finalization", async () => {
  const root = await mkdtemp(join(tmpdir(), "scenesparrow-temp-race-"));
  try {
    for (const exists of [false, true])
      for (const substitute of ["bytes", "symlink"]) {
        const path = join(root, `${exists}-${substitute}.txt`);
        if (exists) await writeFile(path, "old target");
        const outside = join(root, `outside-${exists}-${substitute}`);
        await writeFile(outside, "outside canary");
        await assert.rejects(
          commitExportFile(await prepareDestination(path, "txt"), bytes, hash, {
            beforeFinalize: async () => {
              const temp = (await readdir(root)).find((n) =>
                n.endsWith(".tmp"),
              );
              if (substitute === "symlink") {
                await rm(join(root, temp));
                await symlink(outside, join(root, temp));
              } else await writeFile(join(root, temp), "substituted bytes");
            },
          }),
          /DESTINATION_CHANGED/,
        );
        if (exists) assert.equal(await readFile(path, "utf8"), "old target");
        else await assert.rejects(readFile(path), { code: "ENOENT" });
        assert.equal(await readFile(outside, "utf8"), "outside canary");
        for (const name of await readdir(root))
          if (name.endsWith(".tmp")) await rm(join(root, name));
      }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("post-close metadata publication is tolerated only for the same owned verified temporary file", async () => {
  const { utimes } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "scenesparrow-close-time-"));
  try {
    const target = await prepareDestination(join(root, "body.txt"), "txt");
    await commitExportFile(target, bytes, hash, {
      afterClose: async () => {
        const temp = (await readdir(root)).find((n) => n.endsWith(".tmp"));
        await utimes(join(root, temp), new Date(), new Date(Date.now() + 1000));
      },
    });
    assert.deepEqual(await readFile(target.path), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
