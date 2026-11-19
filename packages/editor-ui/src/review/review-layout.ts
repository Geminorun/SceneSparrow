import { useEffect, useRef, useState } from "react";
import type { ManuscriptSurface } from "../manuscript/surface";
import type { ReviewCard } from "@scenesparrow/contracts";
/** Geometry reads are bounded by the loaded review page; no document conversion
 * or thread serialization runs for typing/scroll decoration placement. */
export function useReviewLayout(
  editor: ManuscriptSurface | null,
  cards: ReviewCard[],
  visible = true,
) {
  const list = useRef<HTMLDivElement>(null),
    [layout, setLayout] = useState<{
      tops: Record<string, number>;
      height: number;
      offscreen: string[];
      wide: boolean;
    }>({ tops: {}, height: 0, offscreen: [], wide: false });
  useEffect(() => {
    if (!editor || !visible) return;
    let active = true,
      frame = 0;
    const measure = () => {
      frame = 0;
      if (!active || !list.current) return;
      const wide = window.matchMedia("(min-width:1001px)").matches,
        tops: Record<string, number> = {},
        offscreen: string[] = [];
      let bottom = 0;
      const origin = list.current.getBoundingClientRect().top;
      for (const card of cards) {
        const blockId = card.thread.anchor.ranges[0]?.blockId,
          box = blockId ? editor.blockRect(blockId) : null;
        if (!box) {
          if (blockId) offscreen.push(card.thread.id);
          continue;
        }
        if (box.bottom < 0 || box.top > window.innerHeight)
          offscreen.push(card.thread.id);
        const article = list.current.querySelector(
          `[data-review-thread="${card.thread.id}"]`,
        );
        if (article) {
          const top = Math.max(0, box.top - origin, bottom);
          tops[card.thread.id] = top;
          bottom = top + article.getBoundingClientRect().height + 12;
        }
      }
      setLayout((old) =>
        old.height === bottom &&
        old.wide === wide &&
        JSON.stringify(old.tops) === JSON.stringify(tops) &&
        old.offscreen.join() === offscreen.join()
          ? old
          : { tops, height: bottom, offscreen, wide },
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(editor.dom);
    if (list.current) observer.observe(list.current);
    const unsubscribe = editor.subscribe("content", schedule);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      unsubscribe();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [editor, cards, visible]);
  return { list, ...layout };
}
