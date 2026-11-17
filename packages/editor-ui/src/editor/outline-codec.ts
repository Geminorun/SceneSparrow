import type { JSONContent } from "@tiptap/core";
import type { OutlineNode } from "@scenesparrow/contracts";

export type OutlineLine = { text: string; id?: string | null };
const escape = (text: string) =>
  text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
const unescape = (text: string) =>
  text.replace(/\\(\\|n)/g, (_, value: string) =>
    value === "n" ? "\n" : "\\",
  );
const validText = (text: string, limit: number) =>
  [...text].length <= limit &&
  !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(text);
export function outlineLines(nodes: OutlineNode[]): OutlineLine[] {
  return nodes.flatMap((node) => [
    {
      text: `${"#".repeat(node.depth + 1)} ${escape(node.title)}`,
      id: node.id,
    },
    ...node.keyPoints.map((point) => ({ text: `- ${escape(point)}` })),
  ]);
}
export const outlineSource = (nodes: OutlineNode[]) =>
  outlineLines(nodes)
    .map((line) => line.text)
    .join("\n");
export function outlineDocument(nodes: OutlineNode[]): JSONContent {
  const lines = outlineLines(nodes);
  return {
    type: "doc",
    content: (lines.length ? lines : [{ text: "" }]).map((line) => ({
      type: "paragraph",
      attrs: { outlineId: line.id ?? crypto.randomUUID() },
      ...(line.text ? { content: [{ type: "text", text: line.text }] } : {}),
    })),
  };
}
export function readOutlineLines(document: JSONContent): OutlineLine[] {
  if (document.type !== "doc") throw Error("OUTLINE_INVALID");
  return (document.content ?? []).flatMap((node) => {
    if (
      node.type !== "paragraph" ||
      node.content?.some(
        (inline) => inline.type !== "text" || inline.marks?.length,
      )
    )
      throw Error("OUTLINE_INVALID");
    return (node.content ?? [])
      .map((inline) => inline.text ?? "")
      .join("")
      .split("\n")
      .map((text, index) => ({
        text,
        id: index ? null : node.attrs?.outlineId,
      }));
  });
}
/** Only headings #..#### and nonnested key-point bullets are representable. */
export function parseOutline(
  lines: OutlineLine[],
  previous: OutlineNode[],
): OutlineNode[] {
  const nodes: OutlineNode[] = [],
    used = new Set<string>();
  const reserved = new Set(
    lines
      .map((line) => line.id)
      .filter((id) => previous.some((node) => node.id === id)),
  );
  for (const line of lines) {
    if (!line.text.trim()) continue;
    const heading = /^(#{1,4}) (.+)$/u.exec(line.text);
    if (heading) {
      const depth = heading[1]!.length - 1,
        title = unescape(heading[2]!);
      if (
        !title.trim() ||
        !validText(title, 300) ||
        depth > (nodes.at(-1)?.depth ?? -1) + 1
      )
        throw Error("OUTLINE_INVALID");
      const exact = previous.filter(
        (node) =>
          !used.has(node.id) &&
          !reserved.has(node.id) &&
          node.title === title &&
          node.depth === depth,
      );
      const existing =
        previous.find((node) => node.id === line.id && !used.has(node.id)) ??
        (exact.length === 1 ? exact[0] : undefined);
      const id =
        existing?.id ??
        (line.id && !used.has(line.id) ? line.id : crypto.randomUUID());
      used.add(id);
      nodes.push({
        id,
        revision: existing?.revision ?? 0,
        depth,
        title,
        keyPoints: [],
      });
    } else {
      const point = /^- (.*)$/u.exec(line.text),
        node = nodes.at(-1);
      if (
        !point ||
        !node ||
        !validText(unescape(point[1]!), 1000) ||
        node.keyPoints.length >= 20
      )
        throw Error("OUTLINE_INVALID");
      node.keyPoints.push(unescape(point[1]!));
    }
  }
  if (
    nodes.length > 200 ||
    new TextEncoder().encode(JSON.stringify(nodes)).length > 262144
  )
    throw Error("OUTLINE_INVALID");
  return nodes;
}

/** Move one heading subtree across a sibling without allocating identities. */
export function moveOutlineSection(
  nodes: OutlineNode[],
  index: number,
  direction: "up" | "down",
): OutlineNode[] {
  const current = nodes[index];
  if (!current) return nodes;
  const endOf = (at: number) => {
    let end = at + 1;
    while (end < nodes.length && nodes[end]!.depth > nodes[at]!.depth) end++;
    return end;
  };
  const end = endOf(index),
    moved = nodes.slice(index, end),
    result = [...nodes.slice(0, index), ...nodes.slice(end)];
  if (direction === "up") {
    let previous = index - 1;
    while (previous >= 0 && nodes[previous]!.depth > current.depth) previous--;
    if (previous < 0 || nodes[previous]!.depth !== current.depth) return nodes;
    result.splice(previous, 0, ...moved);
  } else {
    if (end >= nodes.length || nodes[end]!.depth !== current.depth)
      return nodes;
    result.splice(endOf(end) - moved.length, 0, ...moved);
  }
  return result;
}
