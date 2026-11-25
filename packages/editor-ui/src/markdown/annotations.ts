import type { MarkdownAnnotations } from "@scenesparrow/contracts";
import { sourceBlocks, utf16Offset } from "./source-projection";

export function protectsSource(
  before: string,
  after: string,
  annotations: MarkdownAnnotations,
): boolean {
  if (!annotations.locks.length || before === after) return true;
  const oldBlocks = sourceBlocks(before);
  const newBlocks = sourceBlocks(after);
  function index(source: string, blocks: typeof oldBlocks) {
    const map = new Map<string, (typeof oldBlocks)[number] | null>();
    for (const block of blocks) {
      const quote = source.slice(block.start, block.end);
      map.set(quote, map.has(quote) ? null : block);
    }
    return map;
  }
  const oldByQuote = index(before, oldBlocks);
  const newByQuote = index(after, newBlocks);
  return annotations.locks.every((lock) =>
    lock.anchors.every((anchor) => {
      if (anchor.resolvedStart === null || anchor.resolvedEnd === null)
        return false;
      const original = oldByQuote.get(anchor.quote);
      const old =
        original ??
        oldBlocks.find(
          (block) =>
            block.start === utf16Offset(before, anchor.resolvedStart!) &&
            before.slice(block.start, block.end) === anchor.quote,
        );
      const next = newByQuote.get(anchor.quote);
      if (!old || !next || old.type !== next.type) return false;
      if (
        old.structure.length !== next.structure.length ||
        old.structure.some((identity, index) => {
          const changed = next.structure[index]!;
          if (identity === changed) return false;
          return (
            identity.split(":")[0] !== changed.split(":")[0] ||
            newBlocks.some(
              (block) =>
                block.identity === identity ||
                block.structure.includes(identity),
            ) ||
            oldBlocks.some(
              (block) =>
                block.identity === changed || block.structure.includes(changed),
            )
          );
        })
      )
        return false;
      for (const [quote, block] of oldByQuote) {
        const survivor = newByQuote.get(quote);
        if (
          block &&
          survivor &&
          ((block.end <= old.start && survivor.start >= next.start) ||
            (block.start >= old.end && survivor.end <= next.end))
        )
          return false;
      }
      return true;
    }),
  );
}
export const emptyAnnotations = (): MarkdownAnnotations => ({
  locks: [],
  comments: [],
});
