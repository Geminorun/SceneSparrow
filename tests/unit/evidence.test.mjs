import test from "node:test";
import assert from "node:assert/strict";
import {
  readEvidenceText,
  textRange,
  evidenceChoice,
  evidenceTextLimit,
} from "../../packages/editor-ui/src/library/evidence.ts";

test("reference selections convert DOM UTF-16 selections to complete UTF-8 ranges", () => {
  const text = "甲🐦乙";
  assert.deepEqual(textRange(text), { start: 0, end: 10 });
  assert.deepEqual(textRange(text, 1, 3), { start: 3, end: 7 });
  assert.deepEqual(textRange(text, 2, 3), { start: 3, end: 7 });
  assert.deepEqual(textRange(text, 2, 2), { start: 3, end: 3 });
  const item = { source: { id: "source", kind: "file" }, hasImages: true };
  assert.equal(evidenceChoice(item, text).end, 10);
  assert.equal(evidenceChoice(item, text).mode, "text_only");
});
test("full reference selection follows all extraction pages and rejects nonprogressing offsets", async () => {
  const offsets = [];
  const result = await readEvidenceText(
    {
      extractionPage: async (_, offset) => {
        offsets.push(offset);
        return offset === 0
          ? { offset, text: "中文", next: 6 }
          : { offset, text: " 🐦", next: null };
      },
    },
    "job",
  );
  assert.deepEqual(offsets, [0, 6]);
  assert.deepEqual(result, { text: "中文 🐦", truncated: false });
  await assert.rejects(
    readEvidenceText(
      { extractionPage: async () => ({ offset: 0, text: "", next: 0 }) },
      "job",
    ),
    /SOURCE_TEXT_UNAVAILABLE/,
  );
});
test("large reference context is explicitly bounded at a complete UTF-8 boundary", async () => {
  const value = await readEvidenceText(
    {
      extractionPage: async () => ({
        offset: 0,
        text: "甲".repeat(evidenceTextLimit),
        next: null,
      }),
    },
    "job",
  );
  assert.equal(value.truncated, true);
  assert.ok(new TextEncoder().encode(value.text).length <= evidenceTextLimit);
  assert.equal(value.text.includes("�"), false);
});
