import type { Node } from "@tiptap/pm/model";
import type { MarkdownAnchor } from "@scenesparrow/contracts";
import {
  sourceBlocks,
  sourceTextRange,
  utf16Offset,
} from "./source-projection";

type EditorBlock = {
  block: ReturnType<typeof sourceBlocks>[number];
  position: {
    start: number;
    end: number;
    textStart: number;
    size: number;
    textSize: number;
  };
};
const blockMaps = new WeakMap<
  Node,
  { source: string; blocks: EditorBlock[] }
>();
export function editorBlocks(doc: Node, source: string): EditorBlock[] {
  const cached = blockMaps.get(doc);
  if (cached?.source === source) return cached.blocks;
  const blocks = sourceBlocks(source);
  const positions: {
    start: number;
    end: number;
    textStart: number;
    size: number;
    textSize: number;
  }[] = [];
  doc.descendants((node, pos, parent) => {
    if (
      node.type.name === "heading" ||
      node.type.name === "listItem" ||
      (node.type.name === "paragraph" && parent?.type.name === "doc")
    ) {
      const item = node.type.name === "listItem";
      positions.push({
        start: pos,
        textStart: pos + (item ? 2 : 1),
        end: pos + (item ? node.firstChild!.nodeSize + 1 : node.nodeSize),
        size: node.nodeSize,
        textSize: item ? node.firstChild!.content.size : node.content.size,
      });
    }
  });
  const mapping = blocks
    .map((block, index) => ({ block, position: positions[index]! }))
    .filter(({ position }) => position);
  blockMaps.set(doc, { source, blocks: mapping });
  return mapping;
}

export function anchorRange(source: string, anchor: MarkdownAnchor) {
  if (anchor.resolvedStart === null || anchor.resolvedEnd === null) return null;
  const start = utf16Offset(source, anchor.resolvedStart);
  const end = utf16Offset(source, anchor.resolvedEnd);
  if (source.slice(start, end) === anchor.quote) return { start, end };
  const first = source.indexOf(anchor.quote);
  return first >= 0 && source.indexOf(anchor.quote, first + 1) < 0
    ? { start: first, end: first + anchor.quote.length }
    : null;
}

/** Source spans may include mark delimiters; highlight only their displayed text. */
export function commentSpans(
  doc: Node,
  source: string,
  range: { start: number; end: number },
  blocks = editorBlocks(doc, source),
) {
  return blocks.flatMap(({ block, position }) => {
    if (range.start >= block.contentEnd || range.end <= block.start) return [];
    function boundary(offset: number, end: boolean) {
      let low = 0,
        high = position.textSize;
      while (low < high) {
        const mid = (low + high) >>> 1;
        const span = sourceTextRange(source, block, mid, mid + 1);
        if (span && (end ? span.start < offset : span.end <= offset))
          low = mid + 1;
        else high = mid;
      }
      return low;
    }
    const from = position.textStart + boundary(range.start, false);
    const to = position.textStart + boundary(range.end, true);
    return from < to ? [{ from, to }] : [];
  });
}
