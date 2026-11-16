import { toMarkdown } from "mdast-util-to-markdown";
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
function inline(runs) {
  return contiguous(runs).flatMap(({ href, runs }) => {
    const children = runs.flatMap((r) =>
      newline(r.text)
        .split("\n")
        .flatMap((part, i) => {
          let n = {
            type: r.marks.some((m) => m.type === "code")
              ? "inlineCode"
              : "text",
            value: part,
          };
          if (r.marks.some((m) => m.type === "bold"))
            n = { type: "strong", children: [n] };
          if (r.marks.some((m) => m.type === "italic"))
            n = { type: "emphasis", children: [n] };
          if (r.marks.some((m) => m.type === "code"))
            return [...(i ? [{ type: "break" }] : []), ...(part ? [n] : [])];
          const prefix = /^\s+/u.exec(part)?.[0] ?? "";
          const suffix = /\s+$/u.exec(part.slice(prefix.length))?.[0] ?? "";
          const middle = part.slice(
            prefix.length,
            suffix ? -suffix.length : undefined,
          );
          // CommonMark emphasis cannot enclose edge whitespace. Keep it as literal
          // neighboring text while preserving the marked semantic run in the middle.
          let marked = {
            type: r.marks.some((m) => m.type === "code")
              ? "inlineCode"
              : "text",
            value: middle,
          };
          if (r.marks.some((m) => m.type === "bold"))
            marked = { type: "strong", children: [marked] };
          if (r.marks.some((m) => m.type === "italic"))
            marked = { type: "emphasis", children: [marked] };
          return [
            ...(i ? [{ type: "break" }] : []),
            ...(prefix ? [{ type: "text", value: prefix }] : []),
            ...(middle ? [marked] : []),
            ...(suffix ? [{ type: "text", value: suffix }] : []),
          ];
        }),
    );
    return href ? [{ type: "link", url: href, children }] : children;
  });
}
export function markdown(snapshot) {
  validateBody(snapshot);
  const root = { type: "root", children: [] };
  const stack = [];
  for (const b of snapshot.blocks) {
    const node = {
      type: b.kind === "heading" ? "heading" : "paragraph",
      ...(b.kind === "heading" ? { depth: b.attrs.level } : {}),
      children: inline(b.runs),
    };
    if (b.kind !== "list_item") {
      stack.length = 0;
      root.children.push(node);
      continue;
    }
    const depth = b.attrs.depth ?? 0;
    const ordered = b.attrs.listKind === "ordered";
    stack.length = Math.min(stack.length, depth + 1);
    let list = stack[depth];
    if (!list || list.ordered !== ordered) {
      list = {
        type: "list",
        ordered,
        ...(ordered ? { start: 1 } : {}),
        spread: false,
        children: [],
      };
      const parent = depth ? stack[depth - 1]?.children.at(-1) : root;
      if (!parent) fail();
      parent.children.push(list);
      stack[depth] = list;
    }
    list.children.push({ type: "listItem", spread: false, children: [node] });
  }
  return (
    toMarkdown(root, {
      bullet: "-",
      fences: true,
      emphasis: "*",
      strong: "*",
    }).replace(/\n*$/, "") + "\n"
  );
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
