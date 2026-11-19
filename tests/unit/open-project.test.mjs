import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  inspectProjectManifest,
  validatePortablePaths,
  validateMediaDeclaration,
} from "../../packages/contracts/src/open-project.ts";

const fixtures = JSON.parse(
  await readFile(
    new URL("../fixtures/open-project/validation.json", import.meta.url),
    "utf8",
  ),
);
for (const fixture of fixtures)
  test(`OPF-AC01/02/03 declarations: ${fixture.name}`, () => {
    const value = fixture.json ? JSON.parse(fixture.json) : fixture.value;
    const run = () =>
      fixture.kind === "manifest"
        ? inspectProjectManifest(value).kind
        : fixture.kind === "paths"
          ? (validatePortablePaths(value), "valid")
          : (validateMediaDeclaration(value, fixture.kind), "valid");
    if (["supported", "future-read-only", "valid"].includes(fixture.result))
      assert.equal(run(), fixture.result);
    else assert.throws(run, { code: fixture.result });
  });
test("opaque extension values survive inspection and generated type consumers", () => {
  const value = fixtures.find(
    (f) => f.name === "all optional declarations and opaque JSON",
  ).value;
  assert.deepEqual(inspectProjectManifest(value).manifest, value);
  const future = {
    format: "scenesparrow",
    formatVersion: 19,
    formatUnknown: { raw: [null] },
  };
  assert.equal(inspectProjectManifest(future).raw, future);
});
test("extensions have explicit depth, key-count and byte budgets", () => {
  const base = fixtures[0].value;
  const rejects = (extensions) =>
    assert.throws(() => inspectProjectManifest({ ...base, extensions }), {
      code: "EXTENSIONS_INVALID",
    });
  rejects({ "org.example:large": "雀".repeat(22000) });
  rejects(
    Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [`org.example:key${i}`, i]),
    ),
  );
  let deep = null;
  for (let i = 0; i < 17; i++) deep = [deep];
  rejects({ "org.example:deep": deep });
});
test("text-only and standalone fixture manifests pass without runtime initialization", async () => {
  for (const name of ["text-only", "remotion"]) {
    const value = JSON.parse(
      await readFile(
        new URL(
          `../fixtures/open-project/${name}/project.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    assert.equal(inspectProjectManifest(value).kind, "supported");
  }
});
