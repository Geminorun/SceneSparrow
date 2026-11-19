import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import {
  readSourceDocument,
  sourceBytes,
  applySourcePatches,
  insertSourceIdentity,
  sourceMeaning,
} from "../../packages/manuscript-format/src/source.ts";
const bytes = (s) => new TextEncoder().encode(s);
const decode = (s) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(s);
const id = (n) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const marker = (n) => `<!-- scenesparrow:block=${id(n)} -->`;
const empty = (n) => `<!-- scenesparrow:empty=${id(n)} -->`;
const bindAll = (source) => {
  let document = readSourceDocument(source);
  let counter = 0;
  for (;;) {
    const block = document.blocks.find((block) => !block.id);
    if (!block) return document;
    document = insertSourceIdentity(document, block.address, id(++counter));
  }
};
const corpus = JSON.parse(
  await readFile(
    new URL("../fixtures/open-project/identity-corpus.json", import.meta.url),
    "utf8",
  ),
);
for (const [index, fixture] of corpus.entries())
  test(`OPF-AC04/05 insertion/read preserves native CommonMark meaning ${index}`, () => {
    const source = fixture.source;
    const document = bindAll(source);
    assert.equal(document.source, fixture.boundSource);
    assert.deepEqual(
      document.blocks.map((b) => b.id),
      fixture.expectedIds,
    );
    assert.deepEqual(
      document.blocks.map((b) => b.kind),
      fixture.expectedKinds,
    );
    assert.deepEqual(sourceMeaning(document.source), sourceMeaning(source));
    assert.ok(document.blocks.every((block) => block.id));
    assert.equal(
      new Set(document.blocks.map((block) => block.id)).size,
      document.blocks.length,
    );
    assert.deepEqual(
      sourceBytes(readSourceDocument(sourceBytes(document))),
      sourceBytes(document),
    );
    if (index === 1) {
      assert.equal(document.blocks.length, 4);
      assert.equal(
        new Set(document.blocks.map((b) => b.listItemAddress)).size,
        4,
      );
      assert.equal(
        document.source,
        `- Parent${marker(1)}\n  1. Ordered child${marker(2)}\n     - Grandchild${marker(3)}\n- Sibling${marker(4)}\n`,
      );
    }
    if (index === 5)
      assert.equal(
        document.source,
        `- ${marker(1)}\n  \`\`\`js\n  code\n  \`\`\`\n- next${marker(2)}\n`,
      );
  });
test("no-op preserves UTF-8 BOM, CRLF, unusual spaces and unsupported syntax byte-for-byte", () => {
  const raw = bytes(
    "\ufeff# Title\r\n\r\n  text\t  \r\nline\r\n\r\n| x | y |\r\n|---|---|\r\n<div data-z='a'>raw</div>\r\n",
  );
  const document = readSourceDocument(raw);
  assert.deepEqual(sourceBytes(document), raw);
  assert.deepEqual(applySourcePatches(document, raw, [], "utf8"), raw);
  const bound = bindAll(decode(raw));
  assert.ok(!/(?<!\r)\n/u.test(bound.source));
});
test("actual HTML comments bind; literal/code/escaped marker-looking text never binds", () => {
  const literal = marker(1);
  const source = `\`${literal}\`\n\n\`\`\`md\n${literal}\n\`\`\`\n\n    ${literal}\n\n\\${literal}\n\n<script>\n${literal}\n</script>\n`;
  const document = readSourceDocument(source);
  assert.equal(document.blocks.filter((block) => block.id).length, 0);
  assert.throws(() => readSourceDocument(source, [id(1)]), {
    code: "IDENTITY_MISSING",
  });
});
test("duplicate, malformed, lost and ambiguous IDs fail explicitly", () => {
  assert.throws(
    () => readSourceDocument(`${marker(1)}\n\nA\n\n${marker(1)}\n\nB`),
    { code: "IDENTITY_DUPLICATE" },
  );
  assert.throws(
    () => readSourceDocument("<!-- scenesparrow:block=not-uuid -->\n\nA"),
    { code: "IDENTITY_INVALID" },
  );
  assert.throws(() => readSourceDocument(`${marker(1)}\n\n- A\n- B`), {
    code: "IDENTITY_AMBIGUOUS",
  });
  assert.throws(() => readSourceDocument(`${marker(1)}\n${marker(2)}\n\nA`), {
    code: "IDENTITY_AMBIGUOUS",
  });
  assert.throws(() => readSourceDocument(`A ${marker(1)} B`), {
    code: "IDENTITY_AMBIGUOUS",
  });
  assert.throws(() => readSourceDocument(`**A${marker(1)}**`), {
    code: "IDENTITY_AMBIGUOUS",
  });
  assert.throws(() => readSourceDocument("A", [id(1)]), {
    code: "IDENTITY_MISSING",
  });
});
test("explicit empty identities preserve multiple legacy root paragraphs and empty list parents", () => {
  const source = `${empty(1)}\n\n${marker(2)}\n\nText\n\n${empty(3)}\n\n${empty(4)}\n`;
  const document = readSourceDocument(source, [id(1), id(2), id(3), id(4)]);
  assert.deepEqual(
    document.blocks.map((b) => [b.kind, b.id]),
    [
      ["empty", id(1)],
      ["paragraph", id(2)],
      ["empty", id(3)],
      ["empty", id(4)],
    ],
  );
  assert.deepEqual(sourceMeaning(source), sourceMeaning("Text\n"));
  assert.throws(() => readSourceDocument(`A${empty(1)}`), {
    code: "IDENTITY_AMBIGUOUS",
  });
  assert.throws(() => readSourceDocument(`- ${empty(1)}\n  nonempty`), {
    code: "IDENTITY_AMBIGUOUS",
  });
  const parent = bindAll("-\n  - child\n");
  assert.equal(parent.blocks[0].kind, "empty");
  assert.notEqual(
    parent.blocks[0].listItemAddress,
    parent.blocks[1].listItemAddress,
  );
});
test("source patches use checked UTF-8/UTF-16 scalar boundaries and retain every unrelated byte", () => {
  const raw = bytes(
    "\ufeffbefore\r\n\r\n雀 👩‍💻 é tail\r\n\r\n<table>raw</table>\r\n",
  );
  const document = readSourceDocument(raw);
  const start = document.source.indexOf("雀");
  const byteStart = bytes(document.source.slice(0, start)).length;
  const expected = bytes(document.source.replace("雀", "Bird"));
  assert.deepEqual(
    applySourcePatches(
      document,
      raw,
      [{ start, end: start + 1, replacement: "Bird" }],
      "utf16",
    ),
    expected,
  );
  assert.deepEqual(
    applySourcePatches(
      document,
      raw,
      [{ start: byteStart, end: byteStart + 3, replacement: "Bird" }],
      "utf8",
    ),
    expected,
  );
  for (const [unit, range] of [
    ["utf8", byteStart + 1],
    ["utf16", document.source.indexOf("👩") + 1],
  ])
    assert.throws(
      () =>
        applySourcePatches(
          document,
          raw,
          [{ start: range, end: range, replacement: "" }],
          unit,
        ),
      { code: "SOURCE_RANGE_INVALID" },
    );
  for (const patch of [
    { start: -1, end: 1, replacement: "" },
    { start: 3, end: 2, replacement: "" },
    { start: 0, end: 99999, replacement: "" },
  ])
    assert.throws(() => applySourcePatches(document, raw, [patch], "utf16"), {
      code: "SOURCE_RANGE_INVALID",
    });
  assert.throws(() => applySourcePatches(document, raw, [], "utf32"), {
    code: "SOURCE_RANGE_INVALID",
  });
  assert.throws(
    () => applySourcePatches(document, bytes("other"), [], "utf8"),
    { code: "SOURCE_BASE_MISMATCH" },
  );
  assert.throws(
    () =>
      applySourcePatches(
        document,
        raw,
        [
          { start: 0, end: 2, replacement: "" },
          { start: 1, end: 3, replacement: "" },
        ],
        "utf16",
      ),
    { code: "SOURCE_PATCH_OVERLAP" },
  );
  assert.throws(
    () =>
      applySourcePatches(
        document,
        raw,
        [
          { start: 0, end: 0, replacement: "" },
          { start: 0, end: 0, replacement: "" },
        ],
        "utf16",
      ),
    { code: "SOURCE_PATCH_OVERLAP" },
  );
});
test("invalid UTF-8 and ill-formed replacement strings are rejected without source loss", () => {
  assert.throws(() => readSourceDocument(new Uint8Array([0xc0, 0xaf])), {
    code: "SOURCE_UTF8_INVALID",
  });
  assert.throws(() => readSourceDocument("\ud800"), {
    code: "SOURCE_UTF8_INVALID",
  });
  const document = readSourceDocument("A");
  assert.throws(
    () =>
      applySourcePatches(
        document,
        bytes("A"),
        [{ start: 0, end: 1, replacement: "\udc00" }],
        "utf8",
      ),
    { code: "SOURCE_UTF8_INVALID" },
  );
});
test("bound content edit retains all required identities; deleting a marker is a binding failure", () => {
  const document = bindAll(
    "- First\n  - Child\n\n<table>unsupported</table>\n",
  );
  const required = document.blocks.map((b) => b.id);
  const offset = document.source.indexOf("First");
  const patched = applySourcePatches(
    document,
    sourceBytes(document),
    [{ start: offset, end: offset + 5, replacement: "Edited 👋" }],
    "utf16",
  );
  assert.deepEqual(
    readSourceDocument(patched, required).blocks.map((b) => b.id),
    required,
  );
  assert.ok(decode(patched).endsWith("<table>unsupported</table>\n"));
  assert.throws(
    () => readSourceDocument(decode(patched).replace(marker(1), ""), required),
    { code: "IDENTITY_MISSING" },
  );
});
test("large-input sanity: 2 MiB / 10k blocks and one patch per block use a batch coordinate index", () => {
  const source = Array.from(
    { length: 10000 },
    (_, i) => `Block ${i} 雀 ${"x".repeat(190)}\n\n`,
  ).join("");
  const begin = performance.now();
  const document = readSourceDocument(source);
  assert.equal(document.blocks.length, 10000);
  const patches = document.blocks.map((b) => ({
    start: b.startUtf8,
    end: b.startUtf8 + 5,
    replacement: "Entry",
  }));
  const edited = decode(
    applySourcePatches(document, sourceBytes(document), patches, "utf8"),
  );
  assert.equal(edited.match(/Entry /g).length, 10000);
  console.log(
    `OP1 sanity: ${bytes(source).length} bytes, 10000 blocks/patches, ${Math.round(performance.now() - begin)}ms`,
  );
});

const readCorpus = JSON.parse(
  await readFile(
    new URL(
      "../fixtures/open-project/identity-read-corpus.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
for (const fixture of readCorpus)
  test(`OPF-AC05 native reusable binding corpus: ${fixture.name}`, () => {
    const run = () =>
      readSourceDocument(fixture.source, fixture.requiredIds ?? []);
    if (fixture.error) assert.throws(run, { code: fixture.error });
    else {
      const document = run();
      assert.deepEqual(
        document.blocks.flatMap((b) => (b.id ? [b.id] : [])),
        fixture.expectedIds,
      );
      assert.deepEqual(
        document.blocks.map((b) => b.kind),
        fixture.expectedKinds,
      );
    }
  });
