import { randomUUID } from "node:crypto";
import { fromMarkdown } from "mdast-util-from-markdown";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import yauzl from "yauzl";
export const PARSER =
  "scenesparrow-document/1;mdast-2.0.2;xml-5.3.6;yauzl-3.2.0;pdfjs-5.4.624";
const TEXT_LIMIT = 10 * 1024 * 1024;
export class ParseError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
function fail(code) {
  throw new ParseError(code);
}
export function decode(bytes) {
  try {
    let encoding = "utf-8";
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
    if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
    return new TextDecoder(encoding, { fatal: true })
      .decode(bytes)
      .replace(/\r\n?/g, "\n");
  } catch {
    fail("TEXT_ENCODING_UNSUPPORTED");
  }
}
export async function parse(bytes, name) {
  if (bytes.length > 25 * 1024 * 1024) fail("INPUT_TOO_LARGE");
  const blocks = [],
    warnings = new Set(),
    references = [];
  let hasImages = false,
    total = 0;
  const add = (runs, kind = "paragraph", attrs = {}) => {
    if (!runs.some((r) => r.text.trim())) return;
    total += runs.reduce((n, r) => n + Buffer.byteLength(r.text), 0);
    if (total > TEXT_LIMIT || blocks.length >= 100000)
      fail("DOCUMENT_RESOURCE_LIMIT");
    blocks.push({ id: randomUUID(), kind, attrs, runs });
  };
  const plain = (text) => [{ text, marks: [] }];
  const href = (url) => {
    try {
      const u = new URL(url);
      return (
        ["https:", "http:", "mailto:"].includes(u.protocol) &&
        !/[\u0000-\u001f]/u.test(url)
      );
    } catch {
      return false;
    }
  };
  const ext = name.toLowerCase().split(".").at(-1);
  if (ext === "txt" || ext === "md" || ext === "markdown") {
    const text = decode(bytes);
    if (ext === "txt") text.split(/\n\s*\n/).forEach((t) => add(plain(t)));
    else {
      const ast = fromMarkdown(text);
      const definitions = new Map();
      function collectDefinitions(nodes) {
        for (const node of nodes) {
          if (
            node.type === "definition" &&
            !definitions.has(node.identifier.toLowerCase())
          )
            definitions.set(node.identifier.toLowerCase(), node.url);
          if (node.children) collectDefinitions(node.children);
        }
      }
      collectDefinitions(ast.children);
      function inline(nodes, marks = []) {
        return nodes.flatMap((n) => {
          if (n.type === "html") {
            warnings.add("RAW_HTML_IGNORED");
            return [];
          }
          if (n.type === "image" || n.type === "imageReference") {
            hasImages = true;
            warnings.add("IMAGES_UNPROCESSED");
            if (n.url) references.push(n.url);
            else if (
              n.identifier &&
              definitions.has(n.identifier.toLowerCase())
            )
              references.push(definitions.get(n.identifier.toLowerCase()));
            return [];
          }
          if (n.type === "text" || n.type === "inlineCode")
            return [
              {
                text: n.value,
                marks:
                  n.type === "inlineCode"
                    ? [...marks, { type: "code" }]
                    : marks,
              },
            ];
          if (n.type === "break") return [{ text: "\n", marks }];
          if (n.type === "strong" || n.type === "emphasis")
            return inline(n.children, [
              ...marks,
              { type: n.type === "strong" ? "bold" : "italic" },
            ]);
          if (n.type === "link") {
            if (href(n.url))
              return inline(n.children, [
                ...marks,
                { type: "link", href: n.url },
              ]);
            warnings.add("UNSAFE_LINK_IGNORED");
          }
          if (n.type === "linkReference") {
            const url = definitions.get(n.identifier.toLowerCase());
            if (url && href(url))
              return inline(n.children, [
                ...marks,
                { type: "link", href: url },
              ]);
            warnings.add("UNSUPPORTED_FORMAT_PLAIN_TEXT");
          }
          return n.children
            ? inline(n.children, marks)
            : n.value
              ? [{ text: n.value, marks }]
              : [];
        });
      }
      function visit(nodes, depth = 0) {
        for (const n of nodes) {
          if (n.type === "heading")
            add(inline(n.children), "heading", { level: n.depth });
          else if (n.type === "paragraph") add(inline(n.children));
          else if (n.type === "list") {
            if (n.start && n.start !== 1)
              warnings.add("ORDERED_LIST_RENUMBERED");
            for (const item of n.children) {
              let first = true;
              for (const part of item.children) {
                if (part.type === "list") visit([part], Math.min(depth + 1, 3));
                else {
                  if (depth > 3 || !first)
                    warnings.add("UNSUPPORTED_FORMAT_PLAIN_TEXT");
                  add(inline(part.children ?? [part]), "list_item", {
                    listKind: n.ordered ? "ordered" : "bullet",
                    depth: Math.min(depth, 3),
                  });
                  first = false;
                }
              }
            }
          } else if (n.type === "html") warnings.add("RAW_HTML_IGNORED");
          else if (n.type === "definition") {
            /* Definitions never fetch resources. */
          } else {
            warnings.add("UNSUPPORTED_FORMAT_PLAIN_TEXT");
            if (n.children) visit(n.children, depth);
            else if (n.value) add(plain(n.value));
          }
        }
      }
      visit(ast.children);
    }
  } else if (ext === "docx") {
    const entries = await readDocx(bytes);
    const xml = entries.get("word/document.xml");
    if (!xml) fail("DOCUMENT_PARSE_FAILED");
    hasImages = [...entries.keys()].some((k) => k.startsWith("word/media/"));
    const parser = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      processEntities: false,
      htmlEntities: false,
      trimValues: false,
      parseTagValue: false,
    });
    let tree;
    try {
      const decoded = decode(xml);
      if (/<!DOCTYPE|<!ENTITY/i.test(decoded)) fail("DOCUMENT_PARSE_FAILED");
      const declared = /<\?xml[^>]*encoding=["']([^"']+)["']/i
        .exec(decoded)?.[1]
        ?.toLowerCase();
      if (
        declared &&
        !["utf-8", "utf-16", "utf-16le", "utf-16be"].includes(declared)
      )
        fail("TEXT_ENCODING_UNSUPPORTED");
      if (XMLValidator.validate(decoded) !== true)
        fail("DOCUMENT_PARSE_FAILED");
      const utf16BOM =
        (xml[0] === 0xff && xml[1] === 0xfe) ||
        (xml[0] === 0xfe && xml[1] === 0xff);
      if (
        declared &&
        ((declared === "utf-8" && utf16BOM) ||
          (declared.startsWith("utf-16") && !utf16BOM))
      )
        fail("TEXT_ENCODING_UNSUPPORTED");
      tree = parser.parse(decoded);
    } catch (e) {
      if (e instanceof ParseError) throw e;
      fail("DOCUMENT_PARSE_FAILED");
    }
    const find = (nodes, tag) =>
      nodes.flatMap((n) =>
        n[tag]
          ? [n]
          : Object.entries(n)
              .filter(([k, v]) => k !== ":@" && Array.isArray(v))
              .flatMap(([, v]) => find(v, tag)),
      );
    const numbering = new Map();
    if (entries.get("word/numbering.xml")) {
      const numberingText = decode(entries.get("word/numbering.xml"));
      if (/<!DOCTYPE|<!ENTITY/i.test(numberingText))
        fail("DOCUMENT_PARSE_FAILED");
      if (
        /<w:(?:start|startOverride)\b[^>]*w:val=["'](?!1["'])/.test(
          numberingText,
        )
      )
        warnings.add("ORDERED_LIST_RENUMBERED");
      const nTree = parser.parse(numberingText),
        abstracts = new Map();
      for (const a of find(nTree, "w:abstractNum")) {
        const levels = new Map();
        for (const level of find(a["w:abstractNum"], "w:lvl")) {
          const fmt = find(level["w:lvl"], "w:numFmt")[0]?.[":@"]?.["@_w:val"];
          levels.set(Number(level[":@"]?.["@_w:ilvl"] ?? 0), fmt);
        }
        abstracts.set(a[":@"]?.["@_w:abstractNumId"], levels);
      }
      for (const n of find(nTree, "w:num")) {
        const key = find(n["w:num"], "w:abstractNumId")[0]?.[":@"]?.["@_w:val"];
        numbering.set(n[":@"]?.["@_w:numId"], abstracts.get(key));
      }
    }
    const decodeXmlText = (text) =>
      text.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (_, v) => {
        const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
        if (v[0] !== "#") return named[v];
        const point =
          v[1].toLowerCase() === "x"
            ? parseInt(v.slice(2), 16)
            : Number(v.slice(1));
        if (
          !Number.isInteger(point) ||
          point > 0x10ffff ||
          point < 0 ||
          (point >= 0xd800 && point <= 0xdfff)
        )
          fail("DOCUMENT_PARSE_FAILED");
        return String.fromCodePoint(point);
      });
    const value = (nodes) =>
      nodes
        .map((n) =>
          typeof n["#text"] === "string"
            ? decodeXmlText(n["#text"])
            : Object.entries(n)
                .filter(([k, v]) => k !== ":@" && Array.isArray(v))
                .map(([, v]) => value(v))
                .join(""),
        )
        .join("");
    for (const p of find(tree, "w:p")) {
      const children = p["w:p"],
        runs = [];
      for (const r of find(children, "w:r")) {
        const props = find(r["w:r"], "w:rPr")[0]?.["w:rPr"] ?? [];
        const runStyle = find(props, "w:rStyle")[0]?.[":@"]?.["@_w:val"];
        if (runStyle) warnings.add("UNSUPPORTED_FORMAT_PLAIN_TEXT");
        const marks = ["b", "i"]
          .filter((k) => {
            const node = find(props, "w:" + k)[0];
            return (
              node &&
              !["0", "false", "off"].includes(
                String(node[":@"]?.["@_w:val"] ?? "true").toLowerCase(),
              )
            );
          })
          .map((k) => ({ type: k === "b" ? "bold" : "italic" }));
        let text = "";
        for (const part of r["w:r"]) {
          if (part["w:t"]) text += value(part["w:t"]);
          if (part["w:tab"]) text += "\t";
          if (part["w:br"]) text += "\n";
        }
        if (text) runs.push({ text, marks });
      }
      const style = find(children, "w:pStyle")[0]?.[":@"]?.["@_w:val"] ?? "";
      if (
        style &&
        !/^Heading[1-6]$/i.test(style) &&
        !["Normal", "BodyText", "ListParagraph"].includes(style)
      )
        warnings.add("UNSUPPORTED_FORMAT_PLAIN_TEXT");
      const level = /^Heading([1-6])$/i.exec(style)?.[1];
      if (
        find(children, "w:numPr").length &&
        find(children, "w:numId")[0]?.[":@"]?.["@_w:val"] !== "0"
      ) {
        const num = find(children, "w:numId")[0]?.[":@"]?.["@_w:val"];
        const requested = Number(
          find(children, "w:ilvl")[0]?.[":@"]?.["@_w:val"] ?? 0,
        );
        const fmt = numbering.get(num)?.get(requested);
        if (!fmt || !["bullet", "decimal"].includes(fmt))
          warnings.add("DOCX_LIST_NORMALIZED");
        let depth = Math.min(requested, 3);
        const previous = blocks.at(-1);
        depth = Math.min(
          depth,
          previous?.kind === "list_item" ? (previous.attrs.depth ?? 0) + 1 : 0,
        );
        if (depth !== requested) warnings.add("DOCX_LIST_NORMALIZED");
        add(runs, "list_item", {
          listKind: fmt === "decimal" ? "ordered" : "bullet",
          depth,
        });
      } else
        add(
          runs,
          level ? "heading" : "paragraph",
          level ? { level: Number(level) } : {},
        );
      references.push(`paragraph:${references.length + 1}`);
    }
    if (find(tree, "w:tbl").length)
      warnings.add("UNSUPPORTED_FORMAT_PLAIN_TEXT");
    if (find(tree, "w:hyperlink").length) warnings.add("DOCX_LINK_PLAIN_TEXT");
  } else if (ext === "pdf") {
    warnings.add("PDF_LAYOUT_REVIEW_REQUIRED");
    try {
      const { getDocument, OPS } =
        await import("pdfjs-dist/legacy/build/pdf.mjs");
      const pdf = await getDocument({
        data: new Uint8Array(bytes),
        isEvalSupported: false,
        disableFontFace: true,
        useSystemFonts: false,
        disableAutoFetch: true,
        verbosity: 0,
      }).promise;
      let empty = 0;
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number),
          content = await page.getTextContent();
        let text = "";
        for (const item of content.items)
          if ("str" in item) text += item.str + (item.hasEOL ? "\n" : " ");
        references.push(`page:${number}`);
        if (text.trim()) add(plain(text.trim()));
        else {
          empty++;
          warnings.add(`PDF_PAGE_TEXT_UNAVAILABLE:${number}`);
        }
        const ops = await page.getOperatorList();
        if (
          ops.fnArray.some((fn) =>
            [
              OPS.paintImageXObject,
              OPS.paintInlineImageXObject,
              OPS.paintImageMaskXObject,
            ].includes(fn),
          )
        )
          hasImages = true;
        page.cleanup();
      }
      await pdf.destroy();
      if (empty) warnings.add("PDF_PAGES_WITHOUT_TEXT");
    } catch (e) {
      if (e instanceof ParseError) throw e;
      fail(
        e.name === "PasswordException"
          ? "SOURCE_ENCRYPTED"
          : "DOCUMENT_PARSE_FAILED",
      );
    }
  } else fail("SOURCE_UNSUPPORTED");
  if (hasImages) warnings.add("IMAGES_UNPROCESSED");
  const text = blocks
    .map((b) => b.runs.map((r) => r.text).join(""))
    .join("\n\n");
  if (Buffer.byteLength(text) > TEXT_LIMIT) fail("DOCUMENT_RESOURCE_LIMIT");
  return {
    parser: PARSER,
    text,
    blocks,
    warnings: [...warnings],
    hasImages,
    references,
  };
}
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  return n >>> 0;
});
export function readDocx(bytes) {
  return new Promise((resolve, reject) => {
    let expanded = 0,
      count = 0;
    const entries = new Map();
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true },
      (err, zip) => {
        if (err) return reject(new ParseError("DOCUMENT_PARSE_FAILED"));
        const abort = (code) => {
          zip.close();
          reject(new ParseError(code));
        };
        zip.on("error", () => abort("DOCUMENT_PARSE_FAILED"));
        zip.on("end", () => resolve(entries));
        zip.on("entry", (entry) => {
          if (++count > 10000 || entry.uncompressedSize > 100 * 1024 * 1024)
            return abort("DOCUMENT_RESOURCE_LIMIT");
          if (entry.generalPurposeBitFlag & 1) return abort("SOURCE_ENCRYPTED");
          zip.openReadStream(entry, (err, stream) => {
            if (err) return abort("DOCUMENT_PARSE_FAILED");
            const chunks = [];
            let length = 0,
              crc = 0xffffffff;
            stream.on("error", () => abort("DOCUMENT_PARSE_FAILED"));
            stream.on("data", (chunk) => {
              for (const byte of chunk)
                crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
              expanded += chunk.length;
              length += chunk.length;
              if (expanded > 100 * 1024 * 1024) {
                stream.destroy();
                abort("DOCUMENT_RESOURCE_LIMIT");
                return;
              }
              if (
                ["word/document.xml", "word/numbering.xml"].includes(
                  entry.fileName,
                )
              )
                chunks.push(chunk);
            });
            stream.on("end", () => {
              if (
                (crc ^ 0xffffffff) >>> 0 !== entry.crc32 ||
                length !== entry.uncompressedSize
              )
                return abort("DOCUMENT_PARSE_FAILED");
              entries.set(entry.fileName, Buffer.concat(chunks));
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}
