import type { Editor } from "@tiptap/core";
import type { NewBlock, ReviewCard } from "@scenesparrow/contracts";
import {
  canonicalPositions,
  captureReviewSelection,
  captureWholeManuscript,
} from "../review/review-selection";
import { contentProtectionKey } from "./content-protection";
import { reviewDecorationKey } from "../review/review-decorations";
export type SurfaceCapture = {
  blockId: string;
  text: string;
  start: number;
  end: number;
  quote: string;
  wholeBlock: boolean;
}[];
export interface ManuscriptSurface {
  readonly dom: HTMLElement;
  readonly empty: boolean;
  readonly selectionIdentity: string;
  capture(wholeBlock?: boolean): SurfaceCapture;
  captureDocument(): SurfaceCapture;
  positions(): { block: NewBlock; pos: number; size: number }[];
  blockRect(id: string): DOMRect | null;
  visibleBlockRects(): { id: string; rect: DOMRect }[];
  selectionRects(): { start: DOMRect; end: DOMRect } | null;
  scrollBlock(id: string): void;
  focus(): void;
  subscribe(
    event: "content" | "selection" | "viewport",
    changed: () => void,
  ): () => void;
  protect(ids: Set<string>): void;
  annotate(cards: ReviewCard[]): void;
}
export function legacySurface(
  editor: Editor,
  save: import("../project-session/project-session").ProjectSession,
): ManuscriptSurface {
  const nodes = new Map<string, Element>(),
    visible = new Set<string>();
  return {
    get dom() {
      return editor.view.dom;
    },
    get empty() {
      return editor.state.selection.empty;
    },
    get selectionIdentity() {
      return `${editor.state.selection.from}:${editor.state.selection.to}`;
    },
    capture: (whole) => captureReviewSelection(editor, whole),
    captureDocument: () => captureWholeManuscript(editor),
    positions: () => canonicalPositions(editor),
    blockRect: (id) =>
      (
        nodes.get(id) ?? editor.view.dom.querySelector(`[data-blockid="${id}"]`)
      )?.getBoundingClientRect() ?? null,
    visibleBlockRects: () =>
      [...visible].flatMap((id) => {
        const node = nodes.get(id);
        return node ? [{ id, rect: node.getBoundingClientRect() }] : [];
      }),
    selectionRects: () => {
      const rect = (pos: number) => {
        const b = editor.view.coordsAtPos(pos);
        return new DOMRect(b.left, b.top, b.right - b.left, b.bottom - b.top);
      };
      return {
        start: rect(editor.state.selection.from),
        end: rect(editor.state.selection.to),
      };
    },
    scrollBlock: (id) =>
      editor.view.dom
        .querySelector(`[data-blockid="${id}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" }),
    focus: () => {
      editor.commands.focus();
    },
    subscribe(event, changed) {
      if (event === "viewport") {
        const intersection = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const id = entry.target.getAttribute("data-blockid");
              if (!id) continue;
              if (entry.isIntersecting) visible.add(id);
              else visible.delete(id);
            }
            changed();
          },
          { rootMargin: "300px" },
        );
        const reconcile = () => {
          intersection.disconnect();
          nodes.clear();
          visible.clear();
          editor.view.dom.querySelectorAll("[data-blockid]").forEach((node) => {
            const id = node.getAttribute("data-blockid");
            if (id) {
              nodes.set(id, node);
              intersection.observe(node);
            }
          });
        };
        reconcile();
        const mutations = new MutationObserver(reconcile);
        mutations.observe(editor.view.dom, { childList: true, subtree: true });
        return () => {
          intersection.disconnect();
          mutations.disconnect();
          nodes.clear();
          visible.clear();
        };
      }
      const name = event === "selection" ? "selectionUpdate" : "update";
      editor.on(name, changed);
      return () => {
        editor.off(name, changed);
      };
    },
    protect: (ids) => {
      editor.view.dispatch(editor.state.tr.setMeta(contentProtectionKey, ids));
    },
    annotate(cards) {
      const positions = canonicalPositions(editor);
      for (const card of cards)
        if (!card.thread.handled && card.thread.anchor.state === "mapped")
          for (const range of card.thread.anchor.ranges) {
            const saved = save.state.blocks.find((b) => b.id === range.blockId),
              visible = positions.find((p) => p.block.id === range.blockId);
            if (
              !saved ||
              !visible ||
              saved.revision !== range.revision ||
              saved.runs.map((r) => r.text).join("") !==
                visible.block.runs.map((r) => r.text).join("")
            )
              return;
          }
      const ranges = cards
        .filter(
          (c) =>
            !c.thread.handled &&
            !c.thread.deleted &&
            c.thread.anchor.state === "mapped",
        )
        .flatMap((c) =>
          c.thread.anchor.ranges.flatMap((r) => {
            const p = positions.find((p) => p.block.id === r.blockId);
            return p
              ? [{ from: p.pos + r.start, to: p.pos + r.end, id: c.thread.id }]
              : [];
          }),
        );
      editor.view.dispatch(
        editor.state.tr.setMeta(reviewDecorationKey, ranges),
      );
    },
  };
}
