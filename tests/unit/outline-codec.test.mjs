import test from "node:test";
import assert from "node:assert/strict";
import {
  outlineDocument,
  outlineLines,
  outlineSource,
  parseOutline,
  readOutlineLines,
} from "../../packages/editor-ui/src/editor/outline-codec.ts";
const node = (title, depth = 0, keyPoints = []) => ({
  id: crypto.randomUUID(),
  revision: 7,
  title,
  depth,
  keyPoints,
});
test("outline codec preserves all supported hierarchy, Unicode and escaped multiline values", () => {
  const nodes = [
    node("鸟鸣 🐦\n标题\\n", 0, ["第一条\n第二行", "\\n"]),
    node("Child", 1),
    node("Deep", 2),
    node("Leaf", 3),
  ];
  assert.deepEqual(
    parseOutline(readOutlineLines(outlineDocument(nodes)), nodes),
    nodes,
  );
  assert.match(outlineSource(nodes), /#### Leaf/u);
});
test("continuous heading and key-point changes and reordering retain original node identities", () => {
  const nodes = [node("One", 0, ["old"]), node("Two")];
  const lines = [
    { id: nodes[1].id, text: "# Renamed two" },
    { text: "- New point" },
    { id: nodes[0].id, text: "# Changed one" },
  ];
  const result = parseOutline(lines, nodes);
  assert.deepEqual(
    result.map((n) => n.id),
    [nodes[1].id, nodes[0].id],
  );
  assert.equal(result[0].keyPoints[0], "New point");
});
test("new duplicate headings cannot steal IDs reserved by surviving later lines", () => {
  const nodes = [node("Duplicate"), node("Duplicate")];
  const lines = [{ text: "# Duplicate" }, ...outlineLines(nodes)];
  const result = parseOutline(lines, nodes);
  assert.notEqual(result[0].id, nodes[0].id);
  assert.notEqual(result[0].id, nodes[1].id);
  assert.deepEqual(
    result.slice(1).map((n) => n.id),
    nodes.map((n) => n.id),
  );
  const copied = parseOutline(
    [
      { id: nodes[0].id, text: "# Duplicate" },
      { id: nodes[0].id, text: "# Duplicate" },
    ],
    nodes,
  );
  assert.notEqual(copied[0].id, copied[1].id);
});
test("incomplete, unsupported, excessive and invalid source is rejected without a lossy projection", () => {
  for (const source of [
    "#",
    "# ",
    "## Missing parent",
    "# One\n### Skipped level",
    "# One\nordinary paragraph",
    "# One\n  - nested",
    "# One\n```json",
    "# One\n![image](https://example.test)",
    `# ${"x".repeat(301)}`,
    `# One\n${Array(21).fill("- point").join("\n")}`,
  ])
    assert.throws(
      () =>
        parseOutline(
          source.split("\n").map((text) => ({ text })),
          [],
        ),
      /OUTLINE_INVALID/u,
    );
  assert.throws(
    () =>
      readOutlineLines({
        type: "doc",
        content: [
          { type: "heading", content: [{ type: "text", text: "unsupported" }] },
        ],
      }),
    /OUTLINE_INVALID/u,
  );
  assert.deepEqual(parseOutline([{ text: "" }], []), []);
});

test("section reordering preserves duplicated node identities and entire nested subtree", async () => {
  const { moveOutlineSection } =
    await import("../../packages/editor-ui/src/editor/outline-codec.ts");
  const nodes = [node("Same"), node("Child", 1), node("Same")];
  const moved = moveOutlineSection(nodes, 0, "down");
  assert.deepEqual(
    moved.map((n) => n.id),
    [nodes[2].id, nodes[0].id, nodes[1].id],
  );
  assert.deepEqual(moveOutlineSection(moved, 1, "up"), nodes);
  assert.equal(moveOutlineSection(nodes, 0, "up"), nodes);
});
