import test from "node:test";
import assert from "node:assert/strict";
import {
  serializeMarkdown,
  parseMarkdown,
} from "../../packages/editor-ui/src/manuscript/markdown.ts";
import {
  plain,
  markdown,
  word,
  serializerVersion,
} from "../../workers/document/src/export.mjs";
import { fromMarkdown } from "../../workers/document/node_modules/mdast-util-from-markdown/index.js";
import yauzl from "../../workers/document/node_modules/yauzl/index.js";
const run = (text, marks = []) => ({ text, marks });
const block = (kind, runs, attrs = {}) => ({
  kind,
  runs,
  attrs,
  id: crypto.randomUUID(),
  revision: 1,
});
const snapshot = {
  version: 1,
  blocks: [
    block("heading", [run("中文 👩‍💻 é 🔒 comment [x] # * _ `")], { level: 2 }),
    block("paragraph", [
      run("first", [
        { type: "bold" },
        { type: "link", href: "https://example.com/a_(b)?x=1&y=2" },
      ]),
      run(" second", [
        { type: "italic" },
        { type: "link", href: "https://example.com/a_(b)?x=1&y=2" },
      ]),
      run(" code\nline", [{ type: "code" }]),
    ]),
    block("list_item", [run("parent")], { listKind: "ordered", depth: 0 }),
    block("list_item", [run("child")], { listKind: "bullet", depth: 1 }),
    block("list_item", [run("next")], { listKind: "ordered", depth: 0 }),
    block("paragraph", [
      run("plain ! [literal](https://invalid.example) **not bold**"),
    ]),
    block("list_item", [run("restart")], { listKind: "ordered", depth: 0 }),
  ],
};
function text(n) {
  if (n.type === "break") return "\n";
  return n.value ?? (n.children ?? []).map(text).join("");
}
async function unzip(bytes) {
  return new Promise((resolve, reject) =>
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (e, zip) => {
      if (e) return reject(e);
      const entries = new Map();
      zip.readEntry();
      zip.on("entry", (entry) =>
        zip.openReadStream(entry, (error, stream) => {
          if (error) return reject(error);
          const chunks = [];
          stream.on("data", (c) => chunks.push(c));
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks).toString("utf8"));
            zip.readEntry();
          });
        }),
      );
      zip.on("end", () => resolve(entries));
      zip.on("error", reject);
    }),
  );
}
test("canonical TXT flattens marks and one contiguous link only once without filtering literal review words", () => {
  const output = plain(snapshot);
  assert.match(output, /中文 👩‍💻 é 🔒 comment/);
  assert.equal(output.match(/https:\/\/example.com/g).length, 1);
  assert.match(output, /first second \(https/);
  assert.match(output, /1\. parent\n\n  - child\n\n2\. next/);
  assert.ok(output.endsWith("\n") && !output.endsWith("\n\n"));
});
test("maintained Markdown writer independently parses literal syntax, Unicode, code soft breaks and mixed nested/restarted lists", () => {
  const output = markdown(snapshot);
  const ast = fromMarkdown(output);
  assert.equal(ast.children[0].type, "heading");
  assert.equal(text(ast.children[0]), snapshot.blocks[0].runs[0].text);
  assert.equal(text(ast.children[1]), "first second code\nline");
  assert.equal(ast.children[1].children[0].type, "link");
  assert.equal(
    ast.children[1].children[0].url,
    "https://example.com/a_(b)?x=1&y=2",
  );
  assert.equal(ast.children[2].type, "list");
  assert.equal(ast.children[2].children[0].children[1].ordered, false);
  assert.equal(ast.children[2].children.length, 2);
  assert.equal(ast.children[4].start, 1);
  assert.equal(text(ast.children[3]), snapshot.blocks[5].runs[0].text);
});
test("DOCX independently exposes headings, nested numbering, hyperlink relations, code style and no review/private metadata", async () => {
  const files = await unzip(await word(snapshot));
  const document = files.get("word/document.xml");
  assert.match(document, /Heading2/);
  assert.match(document, /w:hyperlink/);
  assert.match(document, /w:br/);
  assert.match(document, /w:rStyle w:val="Code"/);
  assert.match(document, /w:ilvl w:val="1"/);
  assert.match(
    files.get("word/_rels/document.xml.rels"),
    /Target="https:\/\/example.com\/a_\(b\)\?x=1&amp;y=2" TargetMode="External"/,
  );
  assert.match(files.get("word/numbering.xml"), /w:numFmt w:val="bullet"/);
  assert.match(
    files.get("docProps/core.xml"),
    /<dc:creator>SceneSparrow<\/dc:creator>/,
  );
  for (const [name, xml] of files) {
    assert.doesNotMatch(name, /vbaProject|customXml/i);
    assert.doesNotMatch(
      xml,
      /w:comment\b|w:commentRangeStart\b|w:ins\b|w:del\b|attachedTemplate|PRIVATE_REVIEW_CANARY|PROVIDER_SECRET_CANARY/,
    );
  }
});
test("canonical-invalid C0 controls reject serializers instead of deleting body characters", async () => {
  const bad = {
    version: 1,
    blocks: [block("paragraph", [run("before\u0001after")])],
  };
  assert.throws(() => plain(bad), /EXPORT_INVALID/);
  assert.throws(() => markdown(bad), /EXPORT_INVALID/);
  await assert.rejects(word(bad), /EXPORT_INVALID/);
});
test("Markdown inline code preserves edge/all whitespace and backticks across independent parse", () => {
  for (const value of [" a ", "   ", " `backtick` ", "a``b", " a \n b "]) {
    const s = {
      version: 1,
      blocks: [block("paragraph", [run(value, [{ type: "code" }])])],
    };
    const ast = fromMarkdown(markdown(s));
    assert.equal(text(ast.children[0]), value);
    const code = ast.children[0].children.filter(
      (n) => n.type === "inlineCode",
    );
    assert.ok(code.length);
  }
});

test("canonical UTF-8 noncharacters remain in TXT/Markdown while DOCX rejects unrepresentable XML", async () => {
  const value = "before\ufffe middle \uffff after";
  const s = { version: 1, blocks: [block("paragraph", [run(value)])] };
  assert.equal(plain(s), value + "\n");
  assert.equal(text(fromMarkdown(markdown(s)).children[0]), value);
  await assert.rejects(word(s), /EXPORT_INVALID/);
});

test("real UI and worker Markdown consumers share overlapping marks, list and hard-break semantics", () => {
  const overlap = block("paragraph", [
    run("bold", [{ type: "bold" }]),
    run("code", [{ type: "bold" }, { type: "italic" }, { type: "code" }]),
    run("tail", [{ type: "bold" }]),
    run("link", [{ type: "link", href: "https://example.com" }]),
    run("marked", [
      { type: "bold" },
      { type: "link", href: "https://example.com" },
    ]),
    run("\r\nnext\rline\r\n \t"),
  ]);
  const blocks = [overlap, ...snapshot.blocks.slice(2)];
  const output = markdown({ version: 1, blocks });
  assert.equal(output, serializeMarkdown(blocks));
  const parsed = parseMarkdown(output);
  assert.deepEqual(parsed[0].runs, [
    run("bold", [{ type: "bold" }]),
    run("code", [{ type: "bold" }, { type: "italic" }, { type: "code" }]),
    run("tail", [{ type: "bold" }]),
    run("link", [{ type: "link", href: "https://example.com" }]),
    run("marked", [
      { type: "bold" },
      { type: "link", href: "https://example.com" },
    ]),
    run("\nnext\nline"),
  ]);
  assert.deepEqual(
    parsed.filter((b) => b.kind === "list_item").map((b) => b.attrs),
    [
      { listKind: "ordered", depth: 0 },
      { listKind: "bullet", depth: 1 },
      { listKind: "ordered", depth: 0 },
      { listKind: "ordered", depth: 0 },
    ],
  );
  for (const value of ["a\n", "a\n\n", "a\n \t", "a\nb\n", "\n\n"]) {
    const blocks = [block("paragraph", [run(value)])];
    const output = markdown({ version: 1, blocks });
    assert.equal(output, serializeMarkdown(blocks).replace(/\n*$/, "") + "\n");
    assert.equal(
      fromMarkdown(output).children.map(text).join("\n\n"),
      value.replace(/(?:\n[ \t]*)+$/u, ""),
    );
  }
  assert.equal(serializeMarkdown([]), "");
  assert.equal(markdown({ version: 1, blocks: [] }), "\n");
  assert.equal(serializerVersion, "canonical-1");
});

test("worker Markdown retains validation and maps shared writer failures to EXPORT_INVALID", () => {
  for (const invalid of [
    { version: 2, blocks: [] },
    { version: 1, blocks: null },
  ])
    assert.throws(() => markdown(invalid), /^Error: EXPORT_INVALID$/);
  for (const href of [
    "javascript:alert(1)",
    "/relative",
    "https://",
    "https://example.com/ bad",
  ]) {
    const blocks = [
      block("paragraph", [run("label", [{ type: "link", href }])]),
    ];
    assert.throws(
      () => markdown({ version: 1, blocks }),
      /^Error: EXPORT_INVALID$/,
    );
  }
  const orphan = block("list_item", [run("orphan")], {
    listKind: "bullet",
    depth: 1,
  });
  assert.throws(
    () => markdown({ version: 1, blocks: [orphan] }),
    /^Error: EXPORT_INVALID$/,
  );
});
