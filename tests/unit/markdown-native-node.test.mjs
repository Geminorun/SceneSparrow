import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// The supervised document worker clears its environment and uses bare Node,
// without the test runner's tsx loader or NODE_OPTIONS.
function nativeModule(script, cwd = new URL("../../", import.meta.url)) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd,
      env: {},
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
}

test("normalized Markdown and the real export worker load under bare Node", () => {
  nativeModule(`
    import assert from "node:assert/strict";
    import { serializeMarkdown } from "./packages/manuscript-format/src/index.ts";
    import { markdown } from "./workers/document/src/export.mjs";
    const blocks = [{ id: "11111111-1111-4111-8111-111111111111", kind: "paragraph", attrs: {}, runs: [{text: "Native 中文", marks: []}] }];
    assert.equal(serializeMarkdown(blocks), "Native 中文\\n");
    assert.equal(markdown({version: 1, blocks}), "Native 中文\\n");
  `);
});

test("source codec subpath and its errors support native Node type stripping", () => {
  nativeModule(
    `
    import assert from "node:assert/strict";
    import { readSourceDocument, SourceFormatError } from "@scenesparrow/manuscript-format/source";
    const source = "Plain 中文\\n";
    assert.equal(readSourceDocument(source).source, source);
    assert.equal(new SourceFormatError("IDENTITY_INVALID", "bad").code, "IDENTITY_INVALID");
  `,
    new URL("../../packages/manuscript-format/", import.meta.url),
  );
});
