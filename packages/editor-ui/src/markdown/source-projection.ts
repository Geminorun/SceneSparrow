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
  items: Map<string, { source: string; signature: string }>;
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
  const items = new Map<string, { source: string; signature: string }>();
  const content = nodes.map((node: AstNode) => {
    const start = node.position!.start.offset! + bom;
    const end = node.position!.end.offset! + bom;
    const projected = toEditor(parseMarkdown(source.slice(start, end)))
      .content![0]!;
    function identify(ast: any, projected: JSONContent) {
      if (ast.type === "listItem") {
        const id = crypto.randomUUID();
        projected.attrs = { ...projected.attrs, blockId: id };
        items.set(id, {
          source: source.slice(
            ast.position.start.offset + bom,
            ast.position.end.offset + bom,
          ),
          signature: itemSignature(projected),
        });
      }
      if (ast.type === "list" || ast.type === "listItem")
        ast.children?.forEach((child: any, index: number) =>
          identify(child, projected.content![index]!),
        );
    }
    identify(node, projected);
    const id = crypto.randomUUID();
    projected.attrs = { ...projected.attrs, blockId: id };
    ranges.push({ id, start, end, signature: signature(projected) });
    return projected;
  });
  return {
    source,
    items,
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
  if (
    content.length === 1 &&
    ["paragraph", "heading"].includes(content[0]!.type ?? "") &&
    !content[0]!.content?.length
  )
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
        : preserveItems(
            value.replace(/\n$/, "").replace(/\n/g, newline),
            node,
            projection,
          );
  });
  return output + projection.suffix;
}

export type SourceBlock = {
  start: number;
  end: number;
  contentEnd: number;
  type: string;
  structure: string[];
  identity: string;
};
/** Source offsets are UTF-16 here; the API boundary converts them to UTF-8. */
export function sourceBlocks(source: string): SourceBlock[] {
  const bom = source.startsWith("\ufeff") ? 1 : 0;
  const result: SourceBlock[] = [];
  const headings: { depth: number; identity: string }[] = [];
  function walk(node: any, parents: string[] = []) {
    if (node.type === "heading") {
      while (headings.at(-1) && headings.at(-1)!.depth >= node.depth)
        headings.pop();
    }
    const itemLead = node.type === "listItem" ? node.children[0] : undefined;
    const itemIdentity = itemLead
      ? `item:${source.slice(itemLead.position.start.offset + bom, itemLead.position.end.offset + bom)}`
      : "item:";
    if (
      node.type === "heading" ||
      node.type === "listItem" ||
      (node.type === "paragraph" && !parents.some((p) => p.startsWith("item:")))
    ) {
      result.push({
        start: node.position.start.offset + bom,
        end: node.position.end.offset + bom,
        contentEnd:
          (node.type === "listItem"
            ? (node.children.find(
                (child: MarkdownNode) => child.type === "list",
              )?.position.start.offset ?? node.position.end.offset)
            : node.position.end.offset) + bom,
        type: node.type,
        structure: [...headings.map((h) => h.identity), ...parents],
        identity:
          node.type === "heading"
            ? `h${node.depth}:${source.slice(node.position.start.offset + bom, node.position.end.offset + bom)}`
            : node.type === "listItem"
              ? itemIdentity
              : "",
      });
    }
    if (node.type === "heading")
      headings.push({
        depth: node.depth,
        identity: `h${node.depth}:${source.slice(node.position.start.offset + bom, node.position.end.offset + bom)}`,
      });
    let context = parents;
    if (node.type === "list")
      context = [...parents, node.ordered ? "list:ordered" : "list:bullet"];
    if (node.type === "listItem") context = [...parents, itemIdentity];
    for (const child of node.children ?? []) walk(child, context);
  }
  walk(fromMarkdown(source.slice(bom)));
  return result;
}
export const utf8Offset = (source: string, offset: number) =>
  new TextEncoder().encode(source.slice(0, offset)).length;
export function utf16Offset(source: string, bytes: number) {
  return new TextDecoder().decode(
    new TextEncoder().encode(source).slice(0, bytes),
  ).length;
}

function itemSignature(node: JSONContent): string {
  return signature({ type: "bulletList", content: [node] });
}
function preserveItems(
  value: string,
  node: JSONContent,
  projection: SourceProjection,
): string {
  if (node.type !== "bulletList" && node.type !== "orderedList") return value;
  const ast = fromMarkdown(value).children[0];
  const replacements: { start: number; end: number; text: string }[] = [];
  function walk(ast: any, current: JSONContent) {
    const original = projection.items.get(current.attrs?.blockId);
    if (
      ast.type === "listItem" &&
      original?.signature === itemSignature(current)
    ) {
      replacements.push({
        start: ast.position.start.offset,
        end: ast.position.end.offset,
        text: original.source,
      });
      return;
    }
    if (ast.type === "list" || ast.type === "listItem")
      ast.children?.forEach((child: any, index: number) =>
        walk(child, current.content![index]!),
      );
  }
  if (ast) walk(ast, node);
  for (const edit of replacements.reverse())
    value = value.slice(0, edit.start) + edit.text + value.slice(edit.end);
  return value;
}

/** Map displayed text offsets through Markdown marks, escapes, entities and code. */
export function sourceTextRange(
  source: string,
  block: SourceBlock,
  from: number,
  to: number,
): { start: number; end: number } | null {
  const raw = source.slice(block.start, block.end);
  let root: any = fromMarkdown(raw).children[0];
  if (root?.type === "list") root = root.children[0]?.children[0];
  const spans: { start: number; end: number }[] = [];
  const containers: { start: number; end: number; from: number; to: number }[] =
    [];
  let valid = true;
  function walk(node: any) {
    const begin = spans.length;
    if (
      node.type === "text" ||
      node.type === "inlineCode" ||
      node.type === "break"
    ) {
      const start = node.position.start.offset;
      let literal = raw.slice(start, node.position.end.offset);
      let offset = start;
      const value: string = node.type === "break" ? "\n" : node.value;
      if (node.type === "inlineCode") {
        const ticks = /^`+/.exec(literal)![0].length;
        literal = literal.slice(ticks, -ticks);
        offset += ticks;
        if (
          literal.startsWith(" ") &&
          literal.endsWith(" ") &&
          literal.trim()
        ) {
          literal = literal.slice(1, -1);
          offset++;
        }
      }
      let index = 0;
      for (let i = 0; i < literal.length && index < value.length;) {
        let length = 1,
          decoded = literal[i]!;
        if (node.type === "break") {
          length = literal.length;
          decoded = "\n";
        } else if (
          node.type === "text" &&
          literal[i] === "\\" &&
          /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(literal[i + 1] ?? "")
        ) {
          length = 2;
          decoded = literal[i + 1]!;
        } else if (node.type === "text" && literal[i] === "&") {
          const entity = /^&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/i.exec(
            literal.slice(i),
          )?.[0];
          if (entity) {
            const parsed: any = fromMarkdown(entity).children[0];
            decoded = parsed?.children?.[0]?.value ?? entity;
            length = entity.length;
          }
        } else if (literal[i] === "\r") {
          length = literal[i + 1] === "\n" ? 2 : 1;
          decoded = node.type === "inlineCode" ? " " : "\n";
        } else if (literal[i] === "\n" && node.type === "inlineCode")
          decoded = " ";
        if (value.slice(index, index + decoded.length) !== decoded) {
          valid = false;
          return;
        }
        for (let j = 0; j < decoded.length; j++)
          spans.push({ start: offset + i, end: offset + i + length });
        index += decoded.length;
        i += length;
      }
      if (index !== value.length) valid = false;
    } else for (const child of node.children ?? []) walk(child);
    if (["strong", "emphasis", "inlineCode"].includes(node.type))
      containers.push({
        start: node.position.start.offset,
        end: node.position.end.offset,
        from: begin,
        to: spans.length,
      });
  }
  if (!root) return null;
  walk(root);
  from = Math.max(0, from);
  to = Math.min(spans.length, to);
  if (!valid || from >= to) return null;
  if (from === 0 && to === spans.length)
    return { start: block.start, end: block.start + root.position.end.offset };
  let start = spans[from]!.start,
    end = spans[to - 1]!.end;
  for (const node of containers)
    if (node.from >= from && node.to <= to) {
      start = Math.min(start, node.start);
      end = Math.max(end, node.end);
    }
  return { start: block.start + start, end: block.start + end };
}
