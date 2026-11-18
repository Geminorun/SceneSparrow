import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
/** Present live Markdown hierarchy without changing the recoverable source. */
export const OutlineDecorations = Extension.create({
  name: "outlinePresentation",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (!node.isTextblock) return true;
              const heading = /^(#{1,4}) /u.exec(node.textContent);
              const bullet = /^- /u.test(node.textContent);
              decorations.push(
                Decoration.node(pos, pos + node.nodeSize, {
                  class: heading
                    ? `outline-heading outline-depth-${heading[1]!.length - 1}`
                    : bullet
                      ? "outline-point"
                      : "outline-line",
                }),
              );
              if (heading || bullet)
                decorations.push(
                  Decoration.inline(
                    pos + 1,
                    pos + 1 + (heading?.[0].length ?? 2),
                    { class: "outline-syntax" },
                  ),
                );
              return false;
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
