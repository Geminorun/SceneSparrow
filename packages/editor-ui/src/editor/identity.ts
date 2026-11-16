import UniqueID from "@tiptap/extension-unique-id";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

// UniqueID's paste/drop handlers remain in use. Its default empty-first split
// heuristic transfers identity to the second result, so establish canonical IDs
// before that plugin runs instead.
export const CanonicalIdentity = UniqueID.extend({
  addProseMirrorPlugins() {
    const attributeName = this.options.attributeName;
    const types = this.options.types;
    if (!Array.isArray(types))
      throw Error("Canonical identity needs explicit block types");
    const rows = (doc: ProseMirrorNode) => {
      const result: {
        node: ProseMirrorNode;
        pos: number;
        id: string | null;
      }[] = [];
      doc.descendants((node, pos) => {
        if (types.includes(node.type.name))
          result.push({ node, pos, id: node.attrs[attributeName] ?? null });
      });
      return result;
    };
    return [
      new Plugin({
        key: new PluginKey("canonicalIdentity"),
        appendTransaction: (transactions, oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged))
            return;
          const oldRows = rows(oldState.doc);
          const newRows = rows(newState.doc);
          const tr = newState.tr;
          const repaired = new Map<number, string>();
          // Joining at an empty boundary can remove the first ProseMirror node.
          // Restore its identity when the collapsed caret joins that adjacent pair.
          if (
            !transactions.some(
              (transaction) => transaction.getMeta("preventUpdate") === true,
            ) &&
            oldState.selection.empty &&
            oldState.selection.$from.parentOffset === 0 &&
            oldRows.length === newRows.length + 1
          ) {
            const caretId =
              oldState.selection.$from.parent.attrs[attributeName];
            for (let i = 0; i < oldRows.length - 1; i++) {
              const first = oldRows[i]!;
              const second = oldRows[i + 1]!;
              if (
                !first.id ||
                !second.id ||
                ![first.id, second.id].includes(caretId) ||
                newRows.some((row) => row.id === first.id)
              )
                continue;
              const merged = newRows.find(
                (row) =>
                  row.id === second.id &&
                  row.node.textContent ===
                    first.node.textContent + second.node.textContent,
              );
              if (merged) {
                repaired.set(merged.pos, first.id);
                tr.setNodeMarkup(merged.pos, undefined, {
                  ...merged.node.attrs,
                  [attributeName]: first.id,
                });
              }
            }
          }
          const seen = new Set<string>();
          for (const { node, pos } of newRows) {
            const id = repaired.get(pos) ?? node.attrs[attributeName];
            if (!id || seen.has(id)) {
              const fresh = crypto.randomUUID();
              tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                [attributeName]: fresh,
              });
              seen.add(fresh);
            } else seen.add(id);
          }
          if (!tr.docChanged) return;
          tr.setStoredMarks(newState.storedMarks);
          tr.setMeta("__uniqueIDTransaction", true);
          tr.setMeta("addToHistory", false);
          return tr;
        },
      }),
      ...(this.parent?.() ?? []),
    ];
  },
});
