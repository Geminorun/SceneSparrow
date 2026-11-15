import test from "node:test";
import assert from "node:assert/strict";
import { parse, decode, readDocx } from "../../workers/document/src/parser.mjs";
import { docx, pdf, zip } from "../fixtures/documents.mjs";
test("strict Unicode text decoders reject replacement and accept BOM UTF16", async () => {
  assert.equal(decode(Buffer.from([0xff, 0xfe, 0x2d, 0x4e])), "中");
  assert.equal(decode(Buffer.from([0xfe, 0xff, 0x4e, 0x2d])), "中");
  assert.equal(decode(Buffer.from([0xef, 0xbb, 0xbf, 65])), "A");
  for (const bytes of [
    Buffer.from([0xff]),
    Buffer.from([0xff, 0xfe, 65]),
    Buffer.from([0xc0, 0xaf]),
  ])
    assert.throws(
      () => decode(bytes),
      (e) => e.code === "TEXT_ENCODING_UNSUPPORTED",
    );
  const result = await parse(Buffer.from("中文 🐦\nline\n\nSecond"), "a.txt");
  assert.equal(result.blocks.length, 2);
  assert.equal(result.blocks[0].runs[0].text, "中文 🐦\nline");
});
test("Markdown AST preserves supported marks/lists and ignores raw HTML without fetching", async () => {
  const result = await parse(
    Buffer.from(
      "# Heading\n\n**Bold** *italic* `code` [link](https://example.com)\n\n3. Ordered\n   - Nested\n\n![diagram][fig]\n\n[fig]: https://invalid.example/private.png\n\n<script>throw 1</script>\n\n```js\nfallback\n```",
    ),
    "a.md",
  );
  assert.equal(result.blocks[0].kind, "heading");
  assert.deepEqual(
    result.blocks[1].runs
      .filter((r) => r.marks.length)
      .map((r) => r.marks[0].type),
    ["bold", "italic", "code", "link"],
  );
  assert.equal(result.blocks[2].attrs.listKind, "ordered");
  assert.equal(result.blocks[3].attrs.depth, 1);
  assert.ok(result.hasImages);
  assert.deepEqual(result.references, ["https://invalid.example/private.png"]);
  assert.ok(result.warnings.includes("RAW_HTML_IGNORED"));
  assert.ok(!result.text.includes("throw 1"));
  assert.ok(result.text.includes("fallback"));
});
test("DOCX semantics decode entities, honor false marks, headings and decimal numbering", async () => {
  const result = await parse(
    docx(
      '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:rPr><w:b/><w:i w:val="false"/></w:rPr><w:t>A&amp;B&lt;C &#x1F426;</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>Item</w:t></w:r></w:p>',
      {
        "word/numbering.xml":
          '<w:numbering><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="1"/></w:num></w:numbering>',
        "word/media/image.png": Buffer.from([1]),
      },
    ),
    "a.docx",
  );
  assert.equal(result.blocks[0].attrs.level, 2);
  assert.equal(result.blocks[0].runs[0].text, "A&B<C 🐦");
  assert.deepEqual(result.blocks[0].runs[0].marks, [{ type: "bold" }]);
  assert.equal(result.blocks[1].attrs.listKind, "ordered");
  assert.deepEqual(result.blocks[1].runs[0].marks, []);
  assert.ok(result.hasImages);
  assert.deepEqual(result.references, ["paragraph:1", "paragraph:2"]);
});
test("DOCX strict XML encoding and entity gates never execute external entities", async () => {
  const xml =
    '<?xml version="1.0" encoding="UTF-16"?><w:document><w:body><w:p><w:r><w:t>中文</w:t></w:r></w:p></w:body></w:document>';
  const result = await parse(
    docx(
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]),
    ),
    "utf16.docx",
  );
  assert.equal(result.text, "中文");
  await assert.rejects(
    parse(docx(Buffer.from([0xff])), "corrupt.docx"),
    (e) => e.code === "TEXT_ENCODING_UNSUPPORTED",
  );
  await assert.rejects(
    parse(
      docx(
        '<!DOCTYPE x [<!ENTITY x SYSTEM "https://invalid.example/private">]><w:p><w:r><w:t>&x;</w:t></w:r></w:p>',
      ),
      "a.docx",
    ),
    (e) => e.code === "DOCUMENT_PARSE_FAILED",
  );
  await assert.rejects(
    parse(Buffer.from("bad"), "bad.docx"),
    (e) => e.code === "DOCUMENT_PARSE_FAILED",
  );
});
test("actual DOCX decompression counts expanded bytes and rejects a zip bomb", async () => {
  await assert.rejects(
    readDocx(
      zip({
        "word/media/bomb1": Buffer.alloc(51 * 1024 * 1024),
        "word/media/bomb2": Buffer.alloc(51 * 1024 * 1024),
      }),
    ),
    (e) => e.code === "DOCUMENT_RESOURCE_LIMIT",
  );
});
test("PDF text stays in page order, image-only and mixed pages are explicit, encryption is typed", async () => {
  const text = await parse(
    pdf([{ text: "First page" }, { text: "Second page" }]),
    "a.pdf",
  );
  assert.ok(text.text.indexOf("First") < text.text.indexOf("Second"));
  assert.deepEqual(text.references, ["page:1", "page:2"]);
  const scanned = await parse(pdf([{ image: true }]), "scan.pdf");
  assert.equal(scanned.text, "");
  assert.ok(scanned.hasImages);
  assert.ok(scanned.warnings.includes("PDF_PAGE_TEXT_UNAVAILABLE:1"));
  const mixed = await parse(
    pdf([{ text: "Words" }, { image: true }]),
    "mixed.pdf",
  );
  assert.ok(mixed.text.includes("Words"));
  assert.ok(mixed.warnings.includes("PDF_PAGE_TEXT_UNAVAILABLE:2"));
  await assert.rejects(
    parse(pdf([{ text: "Secret" }], true), "secret.pdf"),
    (e) => e.code === "SOURCE_ENCRYPTED",
  );
  await assert.rejects(
    parse(Buffer.from("bad pdf"), "bad.pdf"),
    (e) => e.code === "DOCUMENT_PARSE_FAILED",
  );
});
test("nested first-wins Markdown references and unsupported DOCX character/list styles stay explicit", async () => {
  const md = await parse(
    Buffer.from(
      "> [fig]: https://example.com/first.png\n>\n> ![diagram][fig]\n\n[fig]: https://example.com/second.png",
    ),
    "a.md",
  );
  assert.ok(md.hasImages);
  assert.deepEqual(md.references, ["https://example.com/first.png"]);
  const word = await parse(
    docx(
      '<w:p><w:pPr><w:pStyle w:val="CustomHeading"/><w:numPr><w:numId w:val="0"/></w:numPr></w:pPr><w:r><w:rPr><w:rStyle w:val="Emphasis"/></w:rPr><w:t>Plain fallback</w:t></w:r></w:p>',
    ),
    "style.docx",
  );
  assert.equal(word.blocks[0].kind, "paragraph");
  assert.ok(word.warnings.includes("UNSUPPORTED_FORMAT_PLAIN_TEXT"));
  const numbered = await parse(
    docx(
      '<w:p><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Starts at five</w:t></w:r></w:p>',
      {
        "word/numbering.xml":
          '<w:numbering><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="5"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>',
      },
    ),
    "numbered.docx",
  );
  assert.equal(numbered.blocks[0].attrs.listKind, "ordered");
  assert.ok(numbered.warnings.includes("ORDERED_LIST_RENUMBERED"));
});
