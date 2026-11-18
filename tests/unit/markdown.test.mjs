import test from "node:test";
import assert from "node:assert/strict";
import {
  parseMarkdown,
  serializeMarkdown,
} from "../../packages/editor-ui/src/editor/markdown.ts";
const semantic = (blocks) => blocks.map(({ id: _, ...block }) => block);
const text = (block) => block.runs.map((run) => run.text).join("");
test("browser Markdown codec preserves headings, Unicode, soft/hard breaks, safe links and nested list semantics", () => {
  const source =
    "# 中文 👩‍💻 é\n\nA soft\nbreak and a hard  \nbreak with **bold *italic*** and [`code`](https://example.com).\n\n- Parent\n  1. Child\n     - Grandchild\n       - Depth three\n\n## End";
  const blocks = parseMarkdown(source);
  assert.equal(blocks[0].kind, "heading");
  assert.equal(text(blocks[0]), "中文 👩‍💻 é");
  assert.equal(
    text(blocks[1]),
    "A soft\nbreak and a hard\nbreak with bold italic and code.",
  );
  assert.deepEqual(
    blocks.filter((b) => b.kind === "list_item").map((b) => b.attrs.depth),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    semantic(parseMarkdown(serializeMarkdown(blocks))),
    semantic(blocks),
  );
});
test("normalized Markdown preserves shared strong/italic/code/link overlaps and code edge whitespace/backticks", () => {
  const blocks = [
    {
      id: crypto.randomUUID(),
      kind: "paragraph",
      attrs: {},
      runs: [
        { text: "Bold ", marks: [{ type: "bold" }] },
        {
          text: " `中文` ",
          marks: [
            { type: "bold" },
            { type: "italic" },
            { type: "code" },
            { type: "link", href: "mailto:writer@example.com" },
          ],
        },
        { text: " tail", marks: [{ type: "bold" }] },
      ],
    },
  ];
  const reparsed = parseMarkdown(serializeMarkdown(blocks));
  assert.equal(text(reparsed[0]), text(blocks[0]));
  assert.deepEqual(
    reparsed[0].runs.find((run) =>
      run.marks.some((mark) => mark.type === "code"),
    ).marks,
    blocks[0].runs[1].marks,
  );
  assert.deepEqual(semantic(parseMarkdown("**`code`**")), [
    {
      kind: "paragraph",
      attrs: {},
      runs: [{ text: "code", marks: [{ type: "bold" }, { type: "code" }] }],
    },
  ]);
});
test("unsupported syntax and unrepresentable attributes remain literal containing blocks without dropping source", () => {
  const cases = [
    "<script>alert('no')</script>",
    "A ![image](https://invalid.example/pixel) stays.",
    "> quoted\n> lines",
    "```js\nfetch('https://invalid.example')\n```",
    "---",
    "3. Third\n4. Fourth",
    "- First\n\n  Second paragraph",
    '[label](https://example.com "title")',
    '[empty title](https://example.com "")',
    "[bad](javascript:alert%281%29)",
    "[relative](/private)",
    "[reference][r]\n\n[r]: https://example.com",
    "- one\n  - two\n    - three\n      - four\n        - too deep",
  ];
  for (const source of cases) {
    const blocks = parseMarkdown(source);
    assert.ok(
      blocks.every((block) => block.kind === "paragraph"),
      source,
    );
    assert.ok(
      blocks.every((block) =>
        block.runs.every((run) => run.marks.length === 0),
      ),
      source,
    );
    // Definition separators normalize to paragraph boundaries; node source is intact.
    assert.equal(blocks.map(text).join("\n\n"), source, source);
    assert.equal(
      parseMarkdown(serializeMarkdown(blocks)).map(text).join("\n\n"),
      source,
      source,
    );
  }
});
test("plain text and incomplete Markdown remain text and every parsed insertion gets fresh identities", () => {
  for (const source of [
    "**unfinished",
    "[unfinished](https://",
    "#",
    "中文 🐦",
    "\n\n",
  ]) {
    assert.equal(parseMarkdown(source).map(text).join("\n\n"), source);
  }
  const first = parseMarkdown("# Same\n\n- Item");
  const second = parseMarkdown("# Same\n\n- Item");
  assert.deepEqual(semantic(first), semantic(second));
  assert.equal(new Set([...first, ...second].map((block) => block.id)).size, 4);
});
test("source escapes literal Markdown and HTML instead of activating unsupported input", () => {
  const source =
    "<img src='https://invalid.example/pixel'>\n**literal** [x](javascript:bad)";
  const literal = [
    {
      id: crypto.randomUUID(),
      kind: "paragraph",
      attrs: {},
      runs: [{ text: source, marks: [] }],
    },
  ];
  const normalized = serializeMarkdown(literal);
  assert.deepEqual(semantic(parseMarkdown(normalized)), semantic(literal));
});

test("nested identical marks deduplicate and invalid URL authorities stay literal", () => {
  const blocks = parseMarkdown("__outer **inner** end__");
  for (const run of blocks[0].runs)
    assert.equal(run.marks.filter((mark) => mark.type === "bold").length, 1);
  for (const source of [
    "[x](https://)",
    "[x](https://#fragment)",
    "[x](http://[invalid)",
  ])
    assert.equal(text(parseMarkdown(source)[0]), source);
});
test("Windows line endings normalize before literal unsupported block ranges are sliced", () => {
  const source = "> quoted\r\n> 中文\r\n\r\n```js\r\ncode\r\n```";
  const blocks = parseMarkdown(source);
  assert.equal(blocks.map(text).join("\n\n"), source.replace(/\r\n?/g, "\n"));
  assert.ok(blocks.every((block) => !text(block).includes("\r")));
});

test("source terminal empty lines normalize away without producing a visible backslash", () => {
  for (const text of ["a\n", "a\n\n", "a\n \t", "a\nb\n", "\n\n"]) {
    const source = serializeMarkdown([
      {
        id: crypto.randomUUID(),
        kind: "paragraph",
        attrs: {},
        runs: [{ text, marks: [] }],
      },
    ]);
    const reparsed = parseMarkdown(source)
      .map((block) => block.runs.map((run) => run.text).join(""))
      .join("\n\n");
    assert.equal(reparsed, text.replace(/(?:\n[ \t]*)+$/u, ""));
    assert.ok(!reparsed.endsWith("\\"));
  }
});

test("Markdown source normalizes canonical CRLF and rejects unsafe canonical links", () => {
  const block = {
    id: crypto.randomUUID(),
    kind: "paragraph",
    attrs: {},
    runs: [{ text: "first\r\nsecond\rthird\r\n \t", marks: [] }],
  };
  assert.equal(
    text(parseMarkdown(serializeMarkdown([block]))[0]),
    "first\nsecond\nthird",
  );
  assert.equal(block.runs[0].text, "first\r\nsecond\rthird\r\n \t");
  for (const href of [
    "javascript:alert(1)",
    "/relative",
    "https://",
    "https://example.com/ bad",
  ]) {
    assert.throws(
      () =>
        serializeMarkdown([
          {
            ...block,
            runs: [{ text: "label", marks: [{ type: "link", href }] }],
          },
        ]),
      /DOCUMENT_INVALID/,
    );
  }
});
