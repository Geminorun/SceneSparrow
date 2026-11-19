import { toMarkdown } from "mdast-util-to-markdown";
import type { Mark, NewBlock, TextRun } from "@scenesparrow/contracts";

type Root = Extract<Parameters<typeof toMarkdown>[0], { type: "root" }>;
type BlockNode = Root["children"][number];
type InlineNode = Extract<BlockNode, { type: "paragraph" }>["children"][number];
type ListNode = Extract<BlockNode, { type: "list" }>;

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

type Atom = { text: string; marks: Mark[] };
function writeInline(runs: TextRun[]): InlineNode[] {
  runs = runs.map((run) => ({
    ...run,
    text: run.text.replace(/\r\n?/g, "\n"),
  }));
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
export function serializeMarkdown(
  blocks: Pick<NewBlock, "kind" | "attrs" | "runs">[],
): string {
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

// Source-preserving authoring is exposed separately via the ./source subpath.
