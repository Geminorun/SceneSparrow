import type { Node as PMNode } from "@tiptap/pm/model";
import type { JSONContent } from "@tiptap/core";
import type {
  Block,
  BlockAttrs,
  BlockKind,
  Mark,
  NewBlock,
  Primitive,
  TextRun,
} from "@scenesparrow/contracts";
const attrs = (): BlockAttrs => ({});
const ranks = { bold: 0, italic: 1, code: 2, link: 3 };
function inline(runs: TextRun[]): JSONContent[] {
  return runs.flatMap((run) =>
    run.text.split("\n").flatMap((text, i) => {
      const marks = run.marks.map((mark) => ({
        type: mark.type,
        ...(mark.type === "link" ? { attrs: { href: mark.href } } : {}),
      }));
      return [
        ...(i ? [{ type: "hardBreak", marks }] : []),
        ...(text ? [{ type: "text", text, marks }] : []),
      ];
    }),
  );
}
export function toEditor(blocks: NewBlock[]): JSONContent {
  let i = 0;
  function list(depth: number): JSONContent {
    const kind = blocks[i]!.attrs.listKind;
    const content: JSONContent[] = [];
    while (i < blocks.length) {
      const b = blocks[i]!;
      if (
        b.kind !== "list_item" ||
        b.attrs.depth !== depth ||
        b.attrs.listKind !== kind
      )
        break;
      i++;
      const item: JSONContent = {
        type: "listItem",
        content: [
          {
            type: "paragraph",
            attrs: { blockId: b.id },
            content: inline(b.runs),
          },
        ],
      };
      while (
        i < blocks.length &&
        blocks[i]!.kind === "list_item" &&
        blocks[i]!.attrs.depth! > depth
      )
        item.content!.push(list(depth + 1));
      content.push(item);
    }
    return { type: kind === "ordered" ? "orderedList" : "bulletList", content };
  }
  const content: JSONContent[] = [];
  while (i < blocks.length) {
    const b = blocks[i]!;
    if (b.kind === "list_item") content.push(list(0));
    else {
      content.push({
        type: b.kind,
        attrs: {
          blockId: b.id,
          ...(b.kind === "heading" ? { level: b.attrs.level } : {}),
        },
        content: inline(b.runs),
      });
      i++;
    }
  }
  return {
    type: "doc",
    content: content.length ? content : [{ type: "paragraph" }],
  };
}
function runs(nodes: JSONContent[] = []): TextRun[] {
  const result: TextRun[] = [];
  for (const node of nodes) {
    if (!["text", "hardBreak"].includes(node.type ?? ""))
      throw Error("DOCUMENT_INVALID");
    const text = node.type === "hardBreak" ? "\n" : (node.text ?? "");
    const marks: Mark[] = (node.marks ?? [])
      .map((m) => {
        if (!(m.type in ranks)) throw Error("DOCUMENT_INVALID");
        return {
          type: m.type as Mark["type"],
          ...(m.type === "link" ? { href: String(m.attrs?.href ?? "") } : {}),
        };
      })
      .sort((a, b) => ranks[a.type] - ranks[b.type]);
    const last = result.at(-1);
    if (last && JSON.stringify(last.marks) === JSON.stringify(marks))
      last.text += text;
    else if (text) result.push({ text, marks });
  }
  return result;
}
export function fromEditor(
  doc: JSONContent,
  knownIds: Set<string> = new Set(),
): NewBlock[] {
  const blocks: NewBlock[] = [];
  const ids = new Set<string>();
  function add(
    node: JSONContent,
    kind: BlockKind,
    a: BlockAttrs,
    children = node.content,
  ) {
    let id = String(node.attrs?.blockId ?? "");
    if (!id || ids.has(id)) id = crypto.randomUUID();
    ids.add(id);
    blocks.push({ id, kind, attrs: a, runs: runs(children) });
  }
  function visit(
    nodes: JSONContent[],
    depth = 0,
    listKind: "bullet" | "ordered" | null = null,
  ) {
    for (const node of nodes) {
      switch (node.type) {
        case "paragraph":
          if (listKind) throw Error("DOCUMENT_INVALID");
          add(node, "paragraph", attrs());
          break;
        case "heading":
          add(node, "heading", {
            ...attrs(),
            level: Number(node.attrs?.level),
          });
          break;
        case "bulletList":
        case "orderedList":
          visit(
            node.content ?? [],
            depth,
            node.type === "bulletList" ? "bullet" : "ordered",
          );
          break;
        case "listItem": {
          if (!listKind || depth > 3 || node.content?.[0]?.type !== "paragraph")
            throw Error("DOCUMENT_INVALID");
          add(
            { ...node, attrs: node.content[0].attrs ?? {} },
            "list_item",
            { ...attrs(), listKind, depth },
            node.content[0].content ?? [],
          );
          visit(node.content.slice(1), depth + 1);
          break;
        }
        default:
          throw Error("DOCUMENT_INVALID");
      }
    }
  }
  visit(doc.content ?? []);
  if (
    blocks.length === 1 &&
    blocks[0]!.kind === "paragraph" &&
    !blocks[0]!.runs.length &&
    !knownIds.has(blocks[0]!.id)
  )
    return [];
  const bytes = new TextEncoder();
  if (
    blocks.length > 10000 ||
    bytes.encode(JSON.stringify(blocks)).length > 4 * 1024 * 1024 ||
    blocks.reduce(
      (n, b) => n + bytes.encode(b.runs.map((r) => r.text).join("")).length,
      0,
    ) >
      2 * 1024 * 1024 ||
    blocks.some(
      (b) =>
        bytes.encode(b.runs.map((r) => r.text).join("")).length > 1024 * 1024,
    )
  )
    throw Error("DOCUMENT_TOO_LARGE");
  return blocks;
}
export function edits(
  before: Block[],
  after: NewBlock[],
): {
  operations: Primitive[];
  expectedBlockRevisions: { id: string; revision: number }[];
} {
  const operations: Primitive[] = [];
  const order = before.map((b) => b.id);
  const old = new Map(before.map((b) => [b.id, b]));
  const afterIds = new Set(after.map((b) => b.id));
  for (const b of before)
    if (!afterIds.has(b.id)) {
      operations.push({ op: "deleteBlock", id: b.id });
      order.splice(order.indexOf(b.id), 1);
    }
  for (const [index, b] of after.entries()) {
    const previous = index ? after[index - 1]!.id : null;
    const existing = old.get(b.id);
    if (!existing) {
      operations.push({ op: "insertBlock", block: b, after: previous });
      order.splice(index, 0, b.id);
    } else {
      if (order[index] !== b.id) {
        operations.push({ op: "moveBlocks", ids: [b.id], after: previous });
        order.splice(order.indexOf(b.id), 1);
        order.splice(index, 0, b.id);
      }
      if (
        existing.kind !== b.kind ||
        JSON.stringify(existing.attrs) !== JSON.stringify(b.attrs)
      ) {
        operations.push({
          op: "setBlockAttributes",
          id: b.id,
          kind: b.kind,
          attrs: b.attrs,
        });
      }
      if (JSON.stringify(existing.runs) !== JSON.stringify(b.runs)) {
        operations.push({ op: "setBlockContent", id: b.id, runs: b.runs });
      }
    }
  }
  if (operations.length > 10000) throw Error("DOCUMENT_TOO_LARGE");
  return {
    operations,
    expectedBlockRevisions: before.map(({ id, revision }) => ({
      id,
      revision,
    })),
  };
}

// ProseMirror nodes are immutable. Cache only their derived projection and byte
// counts; a changed node gets a new identity and is revalidated independently.
const projectionCache = new WeakMap<
  PMNode,
  Map<string, { block: NewBlock; textBytes: number; jsonBytes: number }>
>();
export function fromEditorNode(
  doc: PMNode,
  knownIds: Set<string> = new Set(),
): NewBlock[] {
  const blocks: NewBlock[] = [];
  const ids = new Set<string>();
  let textBytes = 0,
    jsonBytes = 2;
  const encoder = new TextEncoder();
  const add = (node: PMNode, kind: BlockKind, attrs: BlockAttrs) => {
    const key = `${kind}:${attrs.level ?? ""}:${attrs.listKind ?? ""}:${attrs.depth ?? ""}`;
    let cache = projectionCache.get(node);
    if (!cache) {
      cache = new Map();
      projectionCache.set(node, cache);
    }
    let entry = cache.get(key);
    if (!entry) {
      const block: NewBlock = {
        id: String(node.attrs.blockId ?? ""),
        kind,
        attrs,
        runs: runs(node.toJSON().content),
      };
      entry = {
        block,
        textBytes: encoder.encode(block.runs.map((r) => r.text).join(""))
          .length,
        jsonBytes: encoder.encode(JSON.stringify(block)).length,
      };
      for (const run of block.runs) {
        for (const mark of run.marks) Object.freeze(mark);
        Object.freeze(run.marks);
        Object.freeze(run);
      }
      Object.freeze(block.runs);
      Object.freeze(block.attrs);
      Object.freeze(block);
      cache.set(key, entry);
    }
    let block = entry.block;
    if (!block.id || ids.has(block.id))
      block = { ...block, id: crypto.randomUUID() };
    ids.add(block.id);
    blocks.push(block);
    textBytes += entry.textBytes;
    jsonBytes +=
      (block === entry.block
        ? entry.jsonBytes
        : encoder.encode(JSON.stringify(block)).length) +
      (blocks.length > 1 ? 1 : 0);
    if (entry.textBytes > 1024 * 1024) throw Error("DOCUMENT_TOO_LARGE");
  };
  const visit = (
    node: PMNode,
    depth = 0,
    listKind: "ordered" | "bullet" | null = null,
  ) => {
    node.forEach((child) => {
      switch (child.type.name) {
        case "paragraph":
          if (listKind) throw Error("DOCUMENT_INVALID");
          add(child, "paragraph", {});
          break;
        case "heading":
          add(child, "heading", { level: Number(child.attrs.level) });
          break;
        case "bulletList":
        case "orderedList":
          visit(
            child,
            depth,
            child.type.name === "bulletList" ? "bullet" : "ordered",
          );
          break;
        case "listItem": {
          if (
            !listKind ||
            depth > 3 ||
            child.firstChild?.type.name !== "paragraph"
          )
            throw Error("DOCUMENT_INVALID");
          add(child.firstChild, "list_item", { listKind, depth });
          child.forEach((nested, _offset, index) => {
            if (index) {
              if (!["bulletList", "orderedList"].includes(nested.type.name))
                throw Error("DOCUMENT_INVALID");
              visit(
                nested,
                depth + 1,
                nested.type.name === "bulletList" ? "bullet" : "ordered",
              );
            }
          });
          break;
        }
        default:
          throw Error("DOCUMENT_INVALID");
      }
    });
  };
  visit(doc);
  if (
    blocks.length === 1 &&
    blocks[0]!.kind === "paragraph" &&
    !blocks[0]!.runs.length &&
    !knownIds.has(blocks[0]!.id)
  )
    return [];
  if (
    blocks.length > 10000 ||
    textBytes > 2 * 1024 * 1024 ||
    jsonBytes > 4 * 1024 * 1024
  )
    throw Error("DOCUMENT_TOO_LARGE");
  return blocks;
}
