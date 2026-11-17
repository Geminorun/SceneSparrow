import { Extension, InputRule } from "@tiptap/core";
import { safeMarkdownLink } from "./markdown";

/** Complete safe Markdown links only; incomplete/unsafe syntax remains text. */
export const MarkdownLink = Extension.create({
  name: "markdownLink",
  addInputRules() {
    return [
      new InputRule({
        find: /\[([^\]\n]+)\]\((https?:\/\/[^\s()]+|mailto:[^\s()]+)\)$/,
        handler: ({ state, range, match }) => {
          const before = state.doc.textBetween(
            state.selection.$from.start(),
            range.from,
          );
          let escapes = 0;
          for (let index = before.length - 1; before[index] === "\\"; index--)
            escapes++;
          if (before.endsWith("!") || escapes % 2) return null;
          const label = match[1]!,
            href = match[2]!;
          if (!safeMarkdownLink(href)) return null;
          state.tr
            .insertText(label, range.from, range.to)
            .addMark(
              range.from,
              range.from + label.length,
              this.editor.schema.marks.link!.create({ href }),
            )
            .removeStoredMark(this.editor.schema.marks.link!);
        },
      }),
    ];
  },
});
