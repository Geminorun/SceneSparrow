import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
export const reviewDecorationKey = new PluginKey<DecorationSet>(
  "review-highlights",
);
export const ReviewDecorations = Extension.create({
  name: "reviewDecorations",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: reviewDecorationKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const ranges = tr.getMeta(reviewDecorationKey) as
              Array<{ from: number; to: number; id: string }> | undefined;
            return ranges
              ? DecorationSet.create(
                  tr.doc,
                  ranges
                    .filter(
                      (r) =>
                        r.to > r.from &&
                        r.from >= 0 &&
                        r.to <= tr.doc.content.size,
                    )
                    .map((r) =>
                      Decoration.inline(r.from, r.to, {
                        class: "review-highlight",
                        "data-review-id": r.id,
                      }),
                    ),
                )
              : old.map(tr.mapping, tr.doc);
          },
        },
        props: { decorations: (state) => reviewDecorationKey.getState(state) },
      }),
    ];
  },
});
