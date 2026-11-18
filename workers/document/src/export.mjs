import { serializeMarkdown } from "@scenesparrow/manuscript-format";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
} from "docx";
const fail = () => {
  throw new Error("EXPORT_INVALID");
};
export const serializerVersion = "canonical-1";
export function validateBody(snapshot) {
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.blocks)) fail();
  for (const b of snapshot.blocks)
    for (const r of b.runs) {
      if (
        typeof r.text !== "string" ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(r.text)
      )
        fail();
    }
}
const newline = (s) => s.replace(/\r\n?/g, "\n");
function contiguous(runs) {
  const groups = [];
  for (const r of runs) {
    const href = r.marks.find((m) => m.type === "link")?.href;
    const last = groups.at(-1);
    if (last && last.href === href) last.runs.push(r);
    else groups.push({ href, runs: [r] });
  }
  return groups;
}
export function plain(snapshot) {
  validateBody(snapshot);
  const counts = [];
  const blocks = snapshot.blocks.map((b) => {
    const text = contiguous(b.runs)
      .map(({ href, runs }) => {
        const label = newline(runs.map((r) => r.text).join(""));
        return href && href !== label ? `${label} (${href})` : label;
      })
      .join("");
    if (b.kind !== "list_item") {
      counts.length = 0;
      return text;
    }
    const depth = b.attrs.depth ?? 0;
    counts.length = depth + 1;
    const previous = counts[depth];
    const ordered = b.attrs.listKind === "ordered";
    counts[depth] = ordered ? (previous ?? 0) + 1 : undefined;
    return `${"  ".repeat(depth)}${ordered ? `${counts[depth]}.` : "-"} ${text}`;
  });
  return blocks.join("\n\n").replace(/\n*$/, "") + "\n";
}
export function markdown(snapshot) {
  validateBody(snapshot);
  try {
    return serializeMarkdown(snapshot.blocks).replace(/\n*$/, "") + "\n";
  } catch {
    fail();
  }
}
export async function word(snapshot) {
  validateBody(snapshot);
  // These canonical UTF-8 characters are legal in text/Markdown but cannot be
  // represented in XML 1.0. Reject DOCX explicitly rather than strip body text.
  for (const block of snapshot.blocks)
    for (const run of block.runs) if (/[\ufffe\uffff]/u.test(run.text)) fail();
  let run = 0;
  const listStack = [];
  const numbering = [];
  const paragraphs = snapshot.blocks.map((b) => {
    const isList = b.kind === "list_item";
    let reference;
    if (!isList) listStack.length = 0;
    else {
      const depth = b.attrs.depth ?? 0;
      listStack.length = Math.min(listStack.length, depth + 1);
      if (!listStack[depth] || listStack[depth].kind !== b.attrs.listKind) {
        reference = `list-${++run}`;
        listStack[depth] = { kind: b.attrs.listKind, reference };
        numbering.push({
          reference,
          levels: Array.from({ length: 4 }, (_, level) => ({
            level,
            format:
              b.attrs.listKind === "ordered"
                ? LevelFormat.DECIMAL
                : LevelFormat.BULLET,
            text: b.attrs.listKind === "ordered" ? `%${level + 1}.` : "•",
            start: 1,
            style: {
              paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } },
            },
          })),
        });
      } else reference = listStack[depth].reference;
    }
    const children = contiguous(b.runs).flatMap(({ href, runs }) => {
      const content = runs.flatMap((r) =>
        newline(r.text)
          .split("\n")
          .flatMap((text, i) => [
            new TextRun({
              text,
              ...(i ? { break: 1 } : {}),
              bold: r.marks.some((m) => m.type === "bold"),
              italics: r.marks.some((m) => m.type === "italic"),
              ...(r.marks.some((m) => m.type === "code")
                ? { style: "Code" }
                : {}),
            }),
          ]),
      );
      return href
        ? [new ExternalHyperlink({ link: href, children: content })]
        : content;
    });
    return new Paragraph({
      children,
      ...(b.kind === "heading"
        ? { heading: HeadingLevel[`HEADING_${b.attrs.level}`] }
        : {}),
      ...(isList
        ? { numbering: { reference, level: b.attrs.depth ?? 0 } }
        : {}),
    });
  });
  return Packer.toBuffer(
    new Document({
      creator: "SceneSparrow",
      lastModifiedBy: "SceneSparrow",
      title: "",
      description: "",
      styles: {
        characterStyles: [
          { id: "Code", name: "Code", run: { font: "monospace" } },
        ],
      },
      numbering: { config: numbering },
      sections: [{ children: paragraphs }],
    }),
  );
}
export async function serialize(snapshot, format) {
  if (format === "txt") return Buffer.from(plain(snapshot));
  if (format === "md") return Buffer.from(markdown(snapshot));
  if (format === "docx") return word(snapshot);
  throw Error("EXPORT_FORMAT_UNSUPPORTED");
}
