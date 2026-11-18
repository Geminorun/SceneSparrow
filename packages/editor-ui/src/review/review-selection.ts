import type { Editor } from "@tiptap/core";
import type {
  NewBlock,
  ReviewAnchor,
  ManuscriptState,
} from "@scenesparrow/contracts";
import { fromEditor } from "../manuscript/canonical";
// Pair canonical S1 preorder with actual textblocks. List identities come from
// fromEditor, never arbitrary outer or inner node attributes.
export function canonicalPositions(editor: Editor) {
  const blocks = fromEditor(editor.getJSON());
  const positions: Array<{ block: NewBlock; pos: number; size: number }> = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.isTextblock) {
      const block = blocks[positions.length];
      if (block)
        positions.push({ block, pos: pos + 1, size: node.content.size });
      return false;
    }
    return true;
  });
  if (positions.length !== blocks.length) throw Error("ANCHOR_INVALID");
  return positions;
}
export function captureReviewSelection(editor: Editor, wholeBlock = false) {
  let { from, to } = editor.state.selection;
  const dom = editor.view.dom,
    selection = dom.ownerDocument.getSelection();
  if (
    selection?.anchorNode &&
    selection.focusNode &&
    dom.contains(selection.anchorNode) &&
    dom.contains(selection.focusNode)
  ) {
    const anchor = editor.view.posAtDOM(
        selection.anchorNode,
        selection.anchorOffset,
      ),
      head = editor.view.posAtDOM(selection.focusNode, selection.focusOffset);
    from = Math.min(anchor, head);
    to = Math.max(anchor, head);
  }
  if (!wholeBlock && from === to) throw Error("ANCHOR_INVALID");
  const positions = canonicalPositions(editor);
  const selected = positions.filter(({ pos, size }) =>
    wholeBlock
      ? from >= pos && from <= pos + size
      : from < pos + size && to > pos,
  );
  if (!selected.length || selected.length > 100) throw Error("ANCHOR_INVALID");
  return selected.map(({ block, pos, size }) => {
    const text = block.runs.map((r) => r.text).join("");
    const start = wholeBlock ? 0 : Math.max(0, from - pos);
    const end = wholeBlock ? size : Math.min(size, to - pos);
    const boundaries = new Set([0, text.length]);
    for (const part of new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    }).segment(text))
      boundaries.add(part.index);
    if (!boundaries.has(start) || !boundaries.has(end))
      throw Error("ANCHOR_INVALID");
    return {
      blockId: block.id,
      text,
      start,
      end,
      quote: text.slice(start, end),
      wholeBlock,
    };
  });
}
export function bindReviewSelection(
  capture: ReturnType<typeof captureReviewSelection>,
  state: ManuscriptState,
): ReviewAnchor {
  return {
    state: "mapped",
    slot: null,
    ranges: capture.map(({ text, ...range }) => {
      const block = state.blocks.find((b) => b.id === range.blockId);
      if (!block || block.runs.map((r) => r.text).join("") !== text)
        throw Error("ANCHOR_STALE");
      return { ...range, revision: block.revision };
    }),
  };
}

/** Explicit document scope includes every supported textblock, including empty ones. */
export function captureWholeManuscript(
  editor: Editor,
): ReturnType<typeof captureReviewSelection> {
  const positions = canonicalPositions(editor);
  if (!positions.length || positions.length > 100)
    throw Error("REVIEW_SCOPE_TOO_LARGE");
  const capture = positions.map(({ block }) => {
    const text = block.runs.map((run) => run.text).join("");
    return {
      blockId: block.id,
      text,
      start: 0,
      end: text.length,
      quote: text,
      wholeBlock: true,
    };
  });
  if (
    new TextEncoder().encode(JSON.stringify(capture)).length >
    4 * 1024 * 1024
  )
    throw Error("REVIEW_SCOPE_TOO_LARGE");
  return capture;
}
