import { toMarkdown } from "mdast-util-to-markdown";
import { writeInline } from "./index.ts";
import type { NewBlock } from "@scenesparrow/contracts";

type Root = Extract<Parameters<typeof toMarkdown>[0], { type: "root" }>;
type List = Extract<Root["children"][number], { type: "list" }>;
const id =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const migrationSerializer = "legacy-mdast-2.1.2-markers-v1";

/** Derived normalized spelling. The native caller must prove canonical equality. */
export function serializeMigrationMarkdown(blocks: NewBlock[]): string {
  if (!blocks.length) return "";
  const root: Root = { type: "root", children: [] };
  const stack: List[] = [];
  const ids = new Set<string>();
  for (const block of blocks) {
    if (!id.test(block.id) || ids.has(block.id))
      throw Error("MIGRATION_UNSUPPORTED");
    ids.add(block.id);
    const empty = block.runs.every((r) => r.text === "");
    const marker = {
      type: "html" as const,
      value: `<!-- scenesparrow:${empty ? "empty" : "block"}=${block.id} -->`,
    };
    const children = writeInline(block.runs);
    if (block.kind !== "list_item") {
      stack.length = 0;
      root.children.push(marker);
      if (!empty)
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
        if (!parent) throw Error("MIGRATION_UNSUPPORTED");
        parent.children.push(list);
      } else root.children.push(list);
      stack[depth] = list;
    }
    list.children.push({
      type: "listItem",
      spread: false,
      children: empty ? [marker] : [marker, { type: "paragraph", children }],
    });
  }
  return toMarkdown(root, {
    bullet: "-",
    emphasis: "*",
    strong: "*",
    listItemIndent: "one",
  });
}
