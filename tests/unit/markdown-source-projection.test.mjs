import test from "node:test";
import { protectsSource } from "../../packages/editor-ui/src/markdown/annotations.ts";
import assert from "node:assert/strict";
import {
  projectSource,
  sourceFromEditor,
  sourceBlocks,
  sourceTextRange,
} from "../../packages/editor-ui/src/markdown/source-projection.ts";

test("MOR-AC04: editing a sibling preserves individually protected list item bytes", () => {
  const source = "\ufeff# Plan\r\n\r\n* **locked 中文**\r\n* editable\r\n";
  const projection = projectSource(source);
  const doc = JSON.parse(
    JSON.stringify(projection.document, (key, value) =>
      key === "marks" && !value.length ? undefined : value,
    ),
  );
  doc.content[1].content[1].content[0].content[0].text = "new sibling";
  assert.equal(
    sourceFromEditor(projection, doc),
    source.replace("* editable", "- new sibling"),
  );
  const chosen = sourceBlocks(source).filter(
    (block) => block.type === "listItem",
  );
  assert.equal(
    source.slice(chosen[0].start, chosen[0].end),
    "* **locked 中文**",
  );
});

test("MOR-AC01: deleting all formatted outline content clears a retained empty heading and BOM", () => {
  for (const type of ["heading", "paragraph"]) {
    const projection = projectSource("\ufeff# Existing\r\n\r\n* Bullet\r\n");
    assert.equal(
      sourceFromEditor(projection, {
        type: "doc",
        content: [{ type, attrs: type === "heading" ? { level: 1 } : {} }],
      }),
      "",
    );
  }
  const blank = projectSource("\ufeff\r\n\r\n");
  assert.equal(sourceFromEditor(blank, blank.document), "\ufeff\r\n\r\n");
});

test("MOR-AC05: text selections map exactly through marks, repeated words, escapes and entities", () => {
  for (const [source, from, to, expected] of [
    ["A **bold** and plain tail", 2, 16, "**bold** and plain"],
    ["same same same", 5, 9, "same"],
    ["A \\*literal\\* and &amp; tail", 2, 11, "\\*literal\\*"],
    ["A `code` tail", 2, 6, "`code`"],
  ]) {
    const block = sourceBlocks(source)[0];
    const range = sourceTextRange(source, block, from, to);
    assert.equal(source.slice(range.start, range.end), expected, source);
  }
});

test("MOR-AC04: visual protection permits an ancestor rename and rejects structural moves and new-neighbor moves", () => {
  const before = "# Parent\n\nProtected\n\nAfter";
  const start = before.indexOf("Protected");
  const annotations = {
    locks: [
      {
        anchors: [
          { quote: "Protected", resolvedStart: start, resolvedEnd: start + 9 },
        ],
      },
    ],
    comments: [],
  };
  assert.equal(
    protectsSource(before, before.replace("Parent", "Renamed"), annotations),
    true,
  );
  assert.equal(
    protectsSource(
      before,
      before.replace("Protected", "# New parent\n\nProtected"),
      annotations,
    ),
    false,
  );
  assert.equal(
    protectsSource(
      "New neighbor\n\nProtected",
      "Protected\n\nNew neighbor",
      annotations,
    ),
    false,
  );
  assert.equal(
    protectsSource(before, before.replace("Protected", "Changed"), annotations),
    false,
  );
});
