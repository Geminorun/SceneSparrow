import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node } from "@tiptap/pm/model";
export const contentProtectionKey = new PluginKey<Set<string> | null>(
  "content-protection",
);
function protectedNodes(doc: Node, ids: Set<string>) {
  const nodes = new Map<string, { node: Node; ancestry: string }>();
  const headings: Array<{ id: string; level: number }> = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const id = node.attrs.blockId as string;
    if (node.type.name === "heading") {
      while (headings.length && headings.at(-1)!.level >= node.attrs.level)
        headings.pop();
    }
    if (ids.has(id)) {
      const resolved = doc.resolve(pos),
        parents: string[] = [];
      for (let depth = 1; depth <= resolved.depth; depth++) {
        const parent = resolved.node(depth);
        parents.push(
          parent.type.name +
            ":" +
            (parent.type.name === "listItem"
              ? (parent.firstChild?.attrs.blockId ?? "")
              : ""),
        );
      }
      nodes.set(id, { node, ancestry: JSON.stringify([headings, parents]) });
    }
    if (node.type.name === "heading")
      headings.push({ id, level: node.attrs.level });
    return false;
  });
  return nodes;
}
export const ContentProtection = Extension.create({
  name: "contentProtection",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: contentProtectionKey,
        state: {
          init: () => null,
          apply: (tr, prior) => tr.getMeta(contentProtectionKey) ?? prior,
        },
        filterTransaction(tr, state) {
          if (!tr.docChanged || tr.getMeta("preventUpdate")) return true;
          const ids = contentProtectionKey.getState(state);
          if (!ids) return false;
          if (!ids.size) return true;
          const before = protectedNodes(state.doc, ids),
            after = protectedNodes(tr.doc, ids);
          for (const [id, old] of before) {
            const next = after.get(id);
            if (
              !next ||
              !old.node.eq(next.node) ||
              old.ancestry !== next.ancestry
            )
              return false;
          }
          return true;
        },
        props: {
          decorations(state) {
            const ids = contentProtectionKey.getState(state),
              decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.isTextblock && (!ids || ids.has(node.attrs.blockId))) {
                decorations.push(
                  Decoration.node(pos, pos + node.nodeSize, {
                    contenteditable: "false",
                    "aria-readonly": "true",
                    class: "protected-block",
                  }),
                );
                return false;
              }
              return true;
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
