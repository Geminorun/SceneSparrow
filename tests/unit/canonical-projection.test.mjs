import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  fromEditor,
  fromEditorNode,
  toEditor,
} from "../../packages/editor-ui/src/manuscript/canonical.ts";
import { canonicalTransaction } from "../../packages/editor-ui/src/manuscript/canonical-transaction.ts";
const require = createRequire(
  new URL("../../packages/editor-ui/package.json", import.meta.url),
);
const { Schema } = require("@tiptap/pm/model"),
  { EditorState, TextSelection } = require("@tiptap/pm/state");
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      attrs: { blockId: { default: null } },
    },
    heading: {
      group: "block",
      content: "inline*",
      attrs: { blockId: { default: null }, level: { default: 1 } },
    },
    bulletList: { group: "block", content: "listItem+" },
    orderedList: { group: "block", content: "listItem+" },
    listItem: { content: "paragraph block*" },
    text: { group: "inline" },
    hardBreak: { group: "inline", inline: true },
  },
  marks: {
    bold: {},
    italic: {},
    code: { excludes: "" },
    link: { attrs: { href: { default: "" } } },
  },
});
const block = (text, kind = "paragraph", attrs = {}) => ({
  id: crypto.randomUUID(),
  kind,
  attrs,
  runs: [{ text, marks: [] }],
});
const doc = (blocks) => schema.nodeFromJSON(toEditor(blocks));
test("immutable node projection preserves nested context, marks/soft breaks and repaired identities with exact byte limits", () => {
  const first = block("中文 👩‍💻 é\nnext");
  first.runs[0].marks = [{ type: "bold" }, { type: "code" }];
  const blocks = [
    first,
    block("parent", "list_item", { listKind: "ordered", depth: 0 }),
    block("child", "list_item", { listKind: "bullet", depth: 1 }),
  ];
  const source = doc(blocks);
  assert.deepEqual(fromEditorNode(source), fromEditor(source.toJSON()));
  assert.ok(Object.isFrozen(fromEditorNode(source)[0].runs));
  assert.throws(() => {
    fromEditorNode(source)[0].runs[0].text = "bad";
  }, TypeError);
  const duplicate = source.child(0),
    duplicates = schema.node("doc", null, [duplicate, duplicate]);
  const converted = fromEditorNode(duplicates);
  assert.equal(converted[0].id, first.id);
  assert.notEqual(converted[1].id, first.id);
  const initial = {
    id: "",
    kind: "paragraph",
    attrs: {},
    runs: [
      { text: "x", marks: [{ type: "link", href: "https://example.test/" }] },
    ],
  };
  const overhead = Buffer.byteLength(
    JSON.stringify([{ ...initial, id: "0".repeat(36) }]),
  );
  for (const extra of [0, 1]) {
    const b = {
      ...initial,
      runs: [
        {
          text: "x",
          marks: [
            {
              type: "link",
              href:
                "https://example.test/" +
                "x".repeat(4 * 1024 * 1024 - overhead + extra),
            },
          ],
        },
      ],
    };
    const node = doc([b]);
    if (extra) assert.throws(() => fromEditorNode(node), /DOCUMENT_TOO_LARGE/);
    else
      assert.equal(
        Buffer.byteLength(JSON.stringify(fromEditorNode(node))),
        4 * 1024 * 1024,
      );
  }
});
test("canonical diff preserves unchanged subtrees and exact mixed structure/marks while mapping selection", () => {
  const before = [block("unchanged"), block("中文 👩‍💻 é\nlast")],
    oldDoc = doc(before),
    state = EditorState.create({
      schema,
      doc: oldDoc,
      selection: TextSelection.create(oldDoc, 2),
    });
  const after = structuredClone(before);
  after[1].runs[0].text += "z";
  const desired = doc(after),
    tr = canonicalTransaction(state, desired);
  assert.ok(tr.doc.eq(desired));
  assert.equal(tr.doc.firstChild, oldDoc.firstChild);
  assert.equal(tr.selection.from, 2);
  assert.equal(tr.getMeta("preventUpdate"), true);
  assert.equal(tr.getMeta("addToHistory"), false);
  let changed = 0;
  tr.mapping.maps[0].forEach((from, to) => (changed += to - from));
  assert.equal(changed, 0);
  assert.equal(canonicalTransaction(state, oldDoc), null);
  const mixed = [
    before[0],
    block("heading", "heading", { level: 2 }),
    block("ordered", "list_item", { listKind: "ordered", depth: 0 }),
    block("nested", "list_item", { listKind: "bullet", depth: 1 }),
    block("soft\nbreak"),
  ];
  mixed[4].runs[0].marks = [{ type: "italic" }];
  const target = doc(mixed);
  assert.ok(canonicalTransaction(state, target).doc.eq(target));
});
