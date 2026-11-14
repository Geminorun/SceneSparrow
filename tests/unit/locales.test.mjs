import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("English and Chinese catalogs cover the same nonempty UI strings", async () => {
  const read = async (locale) =>
    JSON.parse(
      await readFile(
        new URL(
          `../../packages/editor-ui/src/locales/${locale}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
  const en = await read("en");
  const zh = await read("zh-CN");
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const catalog of [en, zh])
    for (const text of Object.values(catalog))
      assert.ok(typeof text === "string" && text.trim().length > 0);
});
