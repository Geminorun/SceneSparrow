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

test("AWR-AC01: mixed visual Markdown preserves thematic break and untouched bytes", () => {
  for (const rule of ["---", "* * *", "___"]) {
    const source = `\ufeff# 中文 Outline\r\n\r\n${rule}\r\n\r\nA **bold** paragraph.\r\n\r\n* Parent\r\n  * *Nested* child\r\n\r\nTail.\r\n`;
    const projection = projectSource(source);
    assert.ok(projection);
    assert.equal(projection.document.content[1].type, "horizontalRule");
    assert.equal(sourceFromEditor(projection, projection.document), source);
    const document = structuredClone(projection.document);
    document.content.at(-1).content[0].text = "Edited tail.";
    assert.equal(
      sourceFromEditor(projection, document),
      source.replace("Tail.", "Edited tail."),
    );
  }
});

test("AWR-AC02: source comments highlight only anchored text through Markdown marks and shifted bytes", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(
    new URL("../../packages/editor-ui/package.json", import.meta.url),
  );
  const { Node, Schema } = require("@tiptap/pm/model");
  const { anchorRange, commentSpans } =
    await import("../../packages/editor-ui/src/markdown/editor-annotations.ts");
  const schema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { group: "block", content: "text*" },
      text: { group: "inline" },
    },
  });
  const source = "A **bold** and 中文 tail";
  const doc = Node.fromJSON(schema, {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "A bold and 中文 tail" }],
      },
    ],
  });
  const start = source.indexOf("**bold**");
  const end = source.indexOf(" tail");
  assert.deepEqual(commentSpans(doc, source, { start, end }), [
    { from: 3, to: 14 },
  ]);
  const anchor = {
    quote: "中文",
    resolvedStart: source.indexOf("中文"),
    resolvedEnd: source.indexOf("中文") + 6,
  };
  assert.deepEqual(anchorRange("Prefix\n\n" + source, anchor), {
    start: 23,
    end: 25,
  });
  assert.equal(
    anchorRange("中文 中文", { ...anchor, resolvedStart: 1, resolvedEnd: 2 }),
    null,
  );
});
