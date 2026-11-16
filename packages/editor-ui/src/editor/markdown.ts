import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import type { Mark, NewBlock, TextRun } from "@scenesparrow/contracts";

type Root = ReturnType<typeof fromMarkdown>;
type BlockNode = Root["children"][number];
type InlineNode = Extract<BlockNode, { type: "paragraph" }>["children"][number];
type ListNode = Extract<BlockNode, { type: "list" }>;
const rank = { bold: 0, italic: 1, code: 2, link: 3 };
export const safeMarkdownLink = (href: string) => {
  if (
    !/^(https?:\/\/|mailto:)/i.test(href) ||
    /[\u0000-\u0020\u007f]/u.test(href)
  )
    return false;
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(href).protocol);
  } catch {
    return false;
  }
};
class UnsupportedMarkdown extends Error {}

function readInline(
  nodes: InlineNode[],
  source: string,
  marks: Mark[] = [],
): TextRun[] {
  const result: TextRun[] = [];
  const append = (text: string, active: Mark[]) => {
    if (!text) return;
    const sorted = [
      ...new Map(active.map((mark) => [mark.type, mark])).values(),
    ].sort((a, b) => rank[a.type] - rank[b.type]);
    const previous = result.at(-1);
    if (previous && JSON.stringify(previous.marks) === JSON.stringify(sorted))
      previous.text += text;
    else result.push({ text, marks: sorted });
  };
  for (const node of nodes) {
    switch (node.type) {
      case "text":
      case "inlineCode":
        append(
          node.value,
          node.type === "inlineCode" ? [...marks, { type: "code" }] : marks,
        );
        break;
      case "break":
        append("\n", marks);
        break;
      case "strong":
      case "emphasis":
        for (const run of readInline(node.children, source, [
          ...marks,
          { type: node.type === "strong" ? "bold" : "italic" },
        ]))
          append(run.text, run.marks);
        break;
      case "link":
        // mdast normalizes an explicitly empty title to null; preserve that
        // unsupported attribute too instead of silently discarding its syntax.
        if (
          node.title != null ||
          /\s+(?:""|''|\(\))\s*\)$/u.test(
            source.slice(
              node.position?.start.offset,
              node.position?.end.offset,
            ),
          ) ||
          !safeMarkdownLink(node.url)
        )
          throw new UnsupportedMarkdown();
        for (const run of readInline(node.children, source, [
          ...marks,
          { type: "link", href: node.url },
        ]))
          append(run.text, run.marks);
        break;
      default:
        throw new UnsupportedMarkdown();
    }
  }
  return result;
}

/** Parse only representable semantics. Unsupported containing blocks stay literal. */
export function parseMarkdown(source: string): NewBlock[] {
  source = source.replace(/\r\n?/g, "\n");
  const root = fromMarkdown(source);
  const block = (
    kind: NewBlock["kind"],
    attrs: NewBlock["attrs"],
    runs: TextRun[],
  ): NewBlock => ({
    id: crypto.randomUUID(),
    kind,
    attrs,
    runs,
  });
  const list = (node: ListNode, depth: number): NewBlock[] => {
    if (depth > 3 || (node.ordered && node.start !== 1))
      throw new UnsupportedMarkdown();
    return node.children.flatMap((item) => {
      if (
        item.checked != null ||
        item.children[0]?.type !== "paragraph" ||
        item.children.slice(1).some((child) => child.type !== "list")
      )
        throw new UnsupportedMarkdown();
      return [
        block(
          "list_item",
          { listKind: node.ordered ? "ordered" : "bullet", depth },
          readInline(item.children[0].children, source),
        ),
        ...item.children.slice(1).flatMap((child) => {
          if (child.type !== "list") throw new UnsupportedMarkdown();
          return list(child, depth + 1);
        }),
      ];
    });
  };
  const literal = (node: BlockNode) =>
    block("paragraph", {}, [
      {
        text: source.slice(
          node.position!.start.offset,
          node.position!.end.offset,
        ),
        marks: [],
      },
    ]);
  const blocks = root.children.flatMap((node): NewBlock[] => {
    try {
      if (node.type === "heading" && !node.children.length)
        return [literal(node)];
      if (node.type === "paragraph" || node.type === "heading")
        return [
          block(
            node.type,
            node.type === "heading" ? { level: node.depth } : {},
            readInline(node.children, source),
          ),
        ];
      if (node.type === "list") return list(node, 0);
      return [literal(node)];
    } catch (error) {
      if (!(error instanceof UnsupportedMarkdown)) throw error;
      return [literal(node)];
    }
  });
  return blocks.length || !source
    ? blocks
    : [block("paragraph", {}, [{ text: source, marks: [] }])];
}

type Atom = { text: string; marks: Mark[] };
function writeInline(runs: TextRun[]): InlineNode[] {
  // A terminal CommonMark hard break has no following line and would become a
  // visible backslash on reparse. Normalize terminal empty lines in source only.
  let remaining = runs
    .map((run) => run.text)
    .join("")
    .replace(/(?:\n[ \t]*)+$/u, "").length;
  runs = runs.flatMap((run) => {
    const text = run.text.slice(0, remaining);
    remaining -= text.length;
    return text ? [{ ...run, text }] : [];
  });
  const atoms: Atom[] = runs.flatMap((run) =>
    run.text
      .split("\n")
      .flatMap((text, i) => [
        ...(i ? [{ text: "\n", marks: run.marks }] : []),
        ...(text ? [{ text, marks: run.marks }] : []),
      ]),
  );
  // Shared wrappers keep bold/code overlaps and adjacent differently marked runs
  // together. Code is a leaf, never an HTML escape hatch.
  const layers = ["link", "bold", "italic"] as const;
  const nest = (items: Atom[], layer = 0): InlineNode[] => {
    const kind = layers[layer];
    if (!kind)
      return items.map(({ text, marks }): InlineNode =>
        text === "\n"
          ? { type: "break" }
          : marks.some((mark) => mark.type === "code")
            ? { type: "inlineCode", value: text }
            : { type: "text", value: text },
      );
    const output: InlineNode[] = [];
    for (let i = 0; i < items.length;) {
      const mark = items[i]!.marks.find((active) => active.type === kind);
      let end = i + 1;
      while (
        end < items.length &&
        JSON.stringify(
          items[end]!.marks.find((active) => active.type === kind),
        ) === JSON.stringify(mark)
      )
        end++;
      const children = nest(items.slice(i, end), layer + 1);
      if (!mark) output.push(...children);
      else if (mark.type === "link") {
        if (!mark.href || !safeMarkdownLink(mark.href))
          throw Error("DOCUMENT_INVALID");
        output.push({ type: "link", url: mark.href, children });
      } else {
        // CommonMark emphasis cannot wrap edge whitespace. Normalize that
        // whitespace outside the emphasis while retaining every text character.
        const first = children[0],
          last = children.at(-1);
        const prefix =
          first?.type === "text" ? (/^\s+/u.exec(first.value)?.[0] ?? "") : "";
        if (prefix && first?.type === "text")
          first.value = first.value.slice(prefix.length);
        const suffix =
          last?.type === "text" ? (/\s+$/u.exec(last.value)?.[0] ?? "") : "";
        if (suffix && last?.type === "text")
          last.value = last.value.slice(0, -suffix.length);
        if (prefix) output.push({ type: "text", value: prefix });
        const nonempty = children.filter(
          (child) => child.type !== "text" || child.value.length,
        );
        if (nonempty.length)
          output.push({
            type: kind === "bold" ? "strong" : "emphasis",
            children: nonempty,
          });
        if (suffix) output.push({ type: "text", value: suffix });
      }
      i = end;
    }
    return output;
  };
  return nest(atoms);
}

/** A normalized Markdown projection of the current canonical buffer, not raw storage. */
export function serializeMarkdown(blocks: NewBlock[]): string {
  if (!blocks.length) return "";
  const root: Root = { type: "root", children: [] };
  const stack: ListNode[] = [];
  for (const block of blocks) {
    const children = writeInline(block.runs);
    if (block.kind !== "list_item") {
      stack.length = 0;
      root.children.push(
        block.kind === "heading"
          ? {
              type: "heading",
              depth: block.attrs.level as 1 | 2 | 3 | 4 | 5 | 6,
              children,
            }
          : { type: "paragraph", children },
      );
      continue;
    }
    const depth = block.attrs.depth ?? 0;
    const ordered = block.attrs.listKind === "ordered";
    stack.length = Math.min(stack.length, depth + 1);
    let list = stack[depth];
    if (!list || list.ordered !== ordered) {
      list = {
        type: "list",
        ordered,
        start: ordered ? 1 : null,
        spread: false,
        children: [],
      };
      if (depth) {
        const parent = stack[depth - 1]?.children.at(-1);
        if (!parent) throw Error("DOCUMENT_INVALID");
        parent.children.push(list);
      } else root.children.push(list);
      stack[depth] = list;
    }
    list.children.push({
      type: "listItem",
      spread: false,
      children: [{ type: "paragraph", children }],
    });
  }
  return toMarkdown(root, {
    bullet: "-",
    emphasis: "*",
    strong: "*",
    listItemIndent: "one",
  });
}
