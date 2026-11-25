import { fromMarkdown } from "mdast-util-from-markdown";
import type { JSONContent } from "@tiptap/core";
import { parseMarkdown, serializeMarkdown } from "../manuscript/markdown";
import { fromEditor, toEditor } from "../manuscript/canonical";

type AstNode = ReturnType<typeof fromMarkdown>["children"][number];
type Range = { id: string; start: number; end: number; signature: string };
export type SourceProjection = {
  source: string;
  document: JSONContent;
  ranges: Range[];
  prefix: string;
  suffix: string;
  newline: string;
};
function checkListShape(node: JSONContent) {
  if (node.type === "listItem") {
    if (
      node.content?.[0]?.type !== "paragraph" ||
      node.content
        .slice(1)
        .some(
          (child) =>
            child.type !== "bulletList" && child.type !== "orderedList",
        )
    )
      throw Error("DOCUMENT_INVALID");
  } else if (node.type !== "bulletList" && node.type !== "orderedList") return;
  if (node.type === "orderedList" && (node.attrs?.start ?? 1) !== 1)
    throw Error("DOCUMENT_INVALID");
  node.content?.forEach(checkListShape);
}
function signature(node: JSONContent) {
  checkListShape(node);
  return serializeMarkdown(fromEditor({ type: "doc", content: [node] }));
}

type MarkdownNode = {
  type: string;
  ordered?: boolean | null | undefined;
  start?: number | null | undefined;
  checked?: boolean | null | undefined;
  children?: MarkdownNode[];
};
function safe(node: MarkdownNode, depth = 0): boolean {
  const children = node.children ?? [];
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "break":
      return true;
    case "paragraph":
    case "strong":
    case "emphasis":
      return children.every((child) => safe(child, depth));
    case "heading":
      return (
        children.length > 0 && children.every((child) => safe(child, depth))
      );
    case "list":
      return (
        depth <= 3 &&
        (!node.ordered || node.start === 1) &&
        children.every(
          (item) =>
            item.checked == null &&
            item.children?.[0]?.type === "paragraph" &&
            safe(item.children![0]!, depth) &&
            item
              .children!.slice(1)
              .every(
                (child) => child.type === "list" && safe(child, depth + 1),
              ),
        )
      );
    default:
      return false;
  }
}

/** Unsafe syntax stays in source mode; original ranges own all unedited bytes. */
export function projectSource(source: string): SourceProjection | null {
  try {
    return readProjection(source);
  } catch {
    return null;
  }
}
function readProjection(source: string): SourceProjection | null {
  const bom = source.startsWith("\ufeff") ? 1 : 0;
  const nodes = fromMarkdown(source.slice(bom)).children;
  if (!nodes.every((node) => safe(node))) return null;
  const ranges: Range[] = [];
  const content = nodes.map((node: AstNode) => {
    const start = node.position!.start.offset! + bom;
    const end = node.position!.end.offset! + bom;
    const projected = toEditor(parseMarkdown(source.slice(start, end)))
      .content![0]!;
    const id = crypto.randomUUID();
    projected.attrs = { ...projected.attrs, blockId: id };
    ranges.push({ id, start, end, signature: signature(projected) });
    return projected;
  });
  return {
    source,
    document: {
      type: "doc",
      content: content.length ? content : [{ type: "paragraph" }],
    },
    ranges,
    prefix: source.slice(0, ranges[0]?.start ?? source.length),
    suffix: ranges.length ? source.slice(ranges.at(-1)!.end) : "",
    newline: /\r\n|\r|\n/.exec(source)?.[0] ?? "\n",
  };
}

export function sourceFromEditor(
  projection: SourceProjection,
  document: JSONContent,
): string {
  const { source, ranges, newline } = projection;
  const content = document.content ?? [];
  const byId = new Map(
    ranges.map((range, index) => [range.id, { range, index }]),
  );
  if (content.length === 1 && !signature(content[0]!))
    return ranges.length ? "" : source;
  let output = projection.prefix;
  content.forEach((node, index) => {
    const match = byId.get(node.attrs?.blockId);
    const originalIndex = match?.index ?? -1;
    const original = match?.range;
    const value = signature(node);
    if (index) {
      const previous = content[index - 1]!;
      const adjacent =
        originalIndex > 0 &&
        previous.attrs?.blockId === ranges[originalIndex - 1]!.id;
      const gap = adjacent
        ? source.slice(ranges[originalIndex - 1]!.end, original!.start)
        : "";
      // A single newline can merge paragraphs after a structural edit.
      const safeGap =
        /\n[ \t]*\n/.test(gap.replace(/\r\n?/g, "\n")) ||
        (adjacent &&
          value === original!.signature &&
          signature(previous) === ranges[originalIndex - 1]!.signature);
      output += safeGap ? gap : newline + newline;
    }
    output +=
      original?.signature === value
        ? source.slice(original.start, original.end)
        : value.replace(/\n$/, "").replace(/\n/g, newline);
  });
  return output + projection.suffix;
}
