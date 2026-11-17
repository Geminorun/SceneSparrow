import { useEffect, useMemo, useRef } from "react";
import { EditorContent, useEditor, type UseEditorOptions } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection } from "@tiptap/pm/state";
import { Slice } from "@tiptap/pm/model";
import type en from "../locales/en.json";
import { OutlineDecorations } from "./outline-decorations";
import { CanonicalIdentity } from "./identity";
import { canonicalTransaction } from "./canonical-transaction";
import type { PlanningAutosave } from "./planning-autosave";
import {
  outlineDocument,
  outlineSource,
  parseOutline,
  readOutlineLines,
  moveOutlineSection,
} from "./outline-codec";

export function OutlineEditor({
  planning,
  t,
  history,
  frozen,
}: {
  planning: PlanningAutosave;
  t: typeof en;
  history: (direction: "UndoProject" | "RedoProject") => unknown;
  frozen: boolean;
}) {
  const historyRef = useRef(history);
  historyRef.current = history;
  const editor = useEditor(
    useMemo<UseEditorOptions>(
      () => ({
        extensions: [
          OutlineDecorations,
          StarterKit.configure({
            undoRedo: false,
            heading: false,
            bulletList: false,
            orderedList: false,
            listItem: false,
            listKeymap: false,
            bold: false,
            italic: false,
            code: false,
            codeBlock: false,
            blockquote: false,
            horizontalRule: false,
            strike: false,
            underline: false,
            link: false,
            hardBreak: false,
            trailingNode: false,
          }),
          CanonicalIdentity.configure({
            attributeName: "outlineId",
            types: ["paragraph"],
          }),
        ],
        content: outlineDocument(planning.local.nodes),
        editorProps: {
          attributes: {
            role: "textbox",
            "aria-label": t.writingOutline,
            "aria-multiline": "true",
            class: "outline-editor",
          },
          handleKeyDown: (_view, event) => {
            if (
              event.isComposing ||
              planning.composing ||
              event.keyCode === 229
            )
              return false;
            if (
              event.altKey &&
              ["ArrowUp", "ArrowDown"].includes(event.key) &&
              planning.recoveryText === null
            ) {
              event.preventDefault();
              let id: string | null = null;
              _view.state.doc.forEach((node, pos) => {
                if (
                  pos <= _view.state.selection.from &&
                  /^#{1,4} /u.test(node.textContent)
                )
                  id = node.attrs.outlineId;
              });
              const index = planning.local.nodes.findIndex(
                (node) => node.id === id,
              );
              const nodes = moveOutlineSection(
                planning.local.nodes,
                index,
                event.key === "ArrowUp" ? "up" : "down",
              );
              if (nodes !== planning.local.nodes) {
                planning.boundary();
                const desired = _view.state.schema.nodeFromJSON(
                  outlineDocument(nodes),
                );
                const transaction = canonicalTransaction(_view.state, desired);
                if (transaction) {
                  let caret = 1;
                  desired.forEach((node, pos) => {
                    if (node.attrs.outlineId === id) caret = pos + 1;
                  });
                  transaction.setSelection(
                    TextSelection.create(transaction.doc, caret),
                  );
                  _view.dispatch(transaction);
                }
                planning.editOutline(nodes, true);
              }
              return true;
            }
            if (
              (event.ctrlKey || event.metaKey) &&
              !event.altKey &&
              ["z", "y"].includes(event.key.toLowerCase())
            ) {
              event.preventDefault();
              void historyRef.current(
                event.key.toLowerCase() === "y" || event.shiftKey
                  ? "RedoProject"
                  : "UndoProject",
              );
              return true;
            }
            return false;
          },
          handlePaste: (view, event) => {
            if (planning.composing) return false;
            if (
              /\bdata-(?:pm-slice|outlineid)\s*=/iu.test(
                event.clipboardData?.getData("text/html") ?? "",
              )
            )
              return false;
            const text = event.clipboardData?.getData("text/plain");
            if (!text) return false;
            const doc = view.state.schema.nodeFromJSON({
              type: "doc",
              content: text
                .replace(/\r\n?/g, "\n")
                .split("\n")
                .map((line) => ({
                  type: "paragraph",
                  ...(line ? { content: [{ type: "text", text: line }] } : {}),
                })),
            });
            planning.boundary();
            view.dispatch(
              view.state.tr
                .replaceSelection(Slice.maxOpen(doc.content))
                .scrollIntoView(),
            );
            planning.boundary();
            return true;
          },
          handleDOMEvents: {
            compositionstart: () => {
              planning.composition(true);
              return false;
            },
            compositionend: () => {
              queueMicrotask(() => {
                sync();
                planning.composition(false);
              });
              return false;
            },
            blur: () => {
              planning.boundary();
              return false;
            },
          },
        },
        onUpdate: () => sync(),
      }),
      [planning, t.writingOutline],
    ),
  );
  const live = useRef(editor);
  live.current = editor;
  function sync() {
    const current = live.current;
    if (!current) return;
    try {
      const lines = readOutlineLines(current.getJSON());
      const nodes = parseOutline(lines, planning.local.nodes);
      planning.editOutline(nodes);
    } catch {
      planning.invalidate(current.getText({ blockSeparator: "\n" }));
    }
  }
  useEffect(() => {
    editor?.setEditable(!frozen && !planning.state.reserved, false);
  }, [editor, frozen, planning.state.reserved]);
  const canonical = outlineSource(planning.local.nodes);
  useEffect(() => {
    if (!editor || planning.composing || planning.recoveryText !== null) return;
    try {
      const visible = parseOutline(
        readOutlineLines(editor.getJSON()),
        planning.local.nodes,
      );
      if (
        outlineSource(visible) === canonical &&
        visible.every(
          (node, index) => node.id === planning.local.nodes[index]?.id,
        )
      )
        return;
    } catch {
      /* Explicit discard may replace a formerly invalid local buffer. */
    }
    const transaction = canonicalTransaction(
      editor.state,
      editor.schema.nodeFromJSON(outlineDocument(planning.local.nodes)),
    );
    if (transaction) editor.view.dispatch(transaction);
  }, [editor, canonical, planning.local.nodes, planning.recoveryText]);
  return (
    <div
      className="outline-surface"
      data-invalid={planning.recoveryText !== null}
    >
      <p className="outline-help muted">{t.writingOutlineHelp}</p>
      <EditorContent editor={editor} />
    </div>
  );
}
