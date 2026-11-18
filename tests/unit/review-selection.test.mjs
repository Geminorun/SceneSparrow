import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../packages/editor-ui/package.json", import.meta.url),
);
const { getSchema } = require("@tiptap/core");
const { default: StarterKit } = require("@tiptap/starter-kit");
import { CanonicalIdentity } from "../../packages/editor-ui/src/manuscript/identity.ts";
import { toEditor } from "../../packages/editor-ui/src/manuscript/canonical.ts";
import {
  captureWholeManuscript,
  bindReviewSelection,
} from "../../packages/editor-ui/src/review/review-selection.ts";
const block = (kind, text, attrs = {}) => ({
  id: crypto.randomUUID(),
  revision: 1,
  kind,
  attrs,
  runs: text ? [{ text, marks: [] }] : [],
});
const schema = getSchema([
  StarterKit,
  CanonicalIdentity.configure({
    attributeName: "blockId",
    types: ["paragraph", "heading"],
  }),
]);
const editor = (blocks) => {
  const doc = schema.nodeFromJSON(toEditor(blocks));
  return { getJSON: () => doc.toJSON(), state: { doc } };
};
test("whole manuscript captures contiguous canonical preorder including heading, empty paragraph and nested list", () => {
  const blocks = [
    block("heading", "标题 🐦", { level: 1 }),
    block("paragraph", ""),
    block("list_item", "First", { listKind: "bullet", depth: 0 }),
    block("list_item", "Nested", { listKind: "bullet", depth: 1 }),
    block("paragraph", "尾声"),
  ];
  const capture = captureWholeManuscript(editor(blocks));
  assert.deepEqual(
    capture.map((range) => range.blockId),
    blocks.map((item) => item.id),
  );
  assert.deepEqual(
    capture.map((range) => [
      range.start,
      range.end,
      range.quote,
      range.wholeBlock,
    ]),
    blocks.map((item) => {
      const text = item.runs.map((run) => run.text).join("");
      return [0, text.length, text, true];
    }),
  );
  assert.deepEqual(
    bindReviewSelection(capture, { blocks }).ranges.map(
      (range) => range.revision,
    ),
    [1, 1, 1, 1, 1],
  );
});
test("whole scope rejects excessive block/byte limits without truncating", () => {
  assert.equal(
    captureWholeManuscript(
      editor(Array.from({ length: 100 }, () => block("paragraph", "x"))),
    ).length,
    100,
  );
  assert.throws(
    () =>
      captureWholeManuscript(
        editor(Array.from({ length: 101 }, () => block("paragraph", "x"))),
      ),
    /REVIEW_SCOPE_TOO_LARGE/u,
  );
  assert.throws(
    () =>
      captureWholeManuscript(
        editor(
          Array.from({ length: 3 }, () =>
            block("paragraph", "文".repeat(233010)),
          ),
        ),
      ),
    /REVIEW_SCOPE_TOO_LARGE/u,
  );
});
