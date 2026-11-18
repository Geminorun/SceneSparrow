import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
/** Reconcile an acknowledged body without replacing every unaffected DOM subtree. */
export function canonicalTransaction(
  state: EditorState,
  desired: PMNode,
): Transaction | null {
  const start = state.doc.content.findDiffStart(desired.content);
  if (start === null) return null;
  const end = state.doc.content.findDiffEnd(desired.content)!;
  let oldEnd = end.a,
    newEnd = end.b;
  const overlap = start - Math.min(oldEnd, newEnd);
  if (overlap > 0) {
    oldEnd += overlap;
    newEnd += overlap;
  }
  let tr = state.tr;
  try {
    tr = tr.replace(start, oldEnd, desired.slice(start, newEnd));
  } catch {
    tr = state.tr.replaceWith(0, state.doc.content.size, desired.content);
  }
  // Structural/open-slice changes must still produce the exact canonical body.
  if (!tr.doc.eq(desired))
    tr = state.tr.replaceWith(0, state.doc.content.size, desired.content);
  return tr.setMeta("preventUpdate", true).setMeta("addToHistory", false);
}
