import { fromMarkdown } from "mdast-util-from-markdown";
import { safeMarkdownLink } from "@scenesparrow/manuscript-format";
export {
  safeMarkdownLink,
  serializeMarkdown,
} from "@scenesparrow/manuscript-format";
import type { Mark, NewBlock, TextRun } from "@scenesparrow/contracts";

type Root = ReturnType<typeof fromMarkdown>;
type BlockNode = Root["children"][number];
type InlineNode = Extract<BlockNode, { type: "paragraph" }>["children"][number];
type ListNode = Extract<BlockNode, { type: "list" }>;
const rank = { bold: 0, italic: 1, code: 2, link: 3 };
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
