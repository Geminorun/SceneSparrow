import { useMemo, useRef, type RefObject } from "react";
import { useEditor, type UseEditorOptions } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Code from "@tiptap/extension-code";
import { TextSelection } from "@tiptap/pm/state";
import { Slice } from "@tiptap/pm/model";
import type { ManuscriptState } from "@scenesparrow/contracts";
import type { ProjectSession } from "../project-session/project-session";
import { ReviewDecorations } from "../review/review-decorations";
import { CanonicalIdentity } from "./identity";
import { ContentProtection } from "./content-protection";
import { MarkdownLink } from "./markdown-link";
import { parseMarkdown } from "./markdown";
import { canonicalTransaction } from "./canonical-transaction";
import { fromEditorNode, toEditor } from "./canonical";

export function useManuscriptEditor({
  initial,
  save,
  label,
  protectionReady,
  sourceVisible,
}: {
  initial: ManuscriptState;
  save: ProjectSession;
  label: string;
  protectionReady: boolean;
  sourceVisible: RefObject<boolean>;
}) {
  const forwardingKey = useRef(false);
  const liveEditor = useRef<Editor | null>(null);
  const editor = useEditor(
    useMemo<UseEditorOptions>(
      () => ({
        editable: protectionReady,
        extensions: [
          ReviewDecorations,
          ContentProtection,
          StarterKit.configure({
            undoRedo: false,
            code: false,
            blockquote: false,
            codeBlock: false,
            horizontalRule: false,
            strike: false,
            underline: false,
            trailingNode: false,
            link: {
              openOnClick: false,
              protocols: ["http", "https", "mailto"],
              isAllowedUri: (url) => /^(https?:\/\/|mailto:)/i.test(url),
            },
          }),
          Code.extend({ excludes: "" }),
          MarkdownLink,
          CanonicalIdentity.configure({
            attributeName: "blockId",
            types: ["paragraph", "heading"],
          }),
        ],
        content: toEditor(initial.blocks),
        editorProps: {
          handlePaste: (view, event) => {
            const data = event.clipboardData;
            // Keep the established internal clipboard path (including ID repair).
            // External mixed-MIME copies use their explicit plain Markdown text.
            if (
              !data ||
              /\bdata-(?:pm-slice|blockid)\s*=/i.test(data.getData("text/html"))
            )
              return false;
            const text = data.getData("text/plain");
            if (!text) return false;
            const document = view.state.schema.nodeFromJSON(
              toEditor(parseMarkdown(text)),
            );
            const slice =
              view.state.selection.$from.parent.content.size === 0
                ? new Slice(document.content, 0, 0)
                : Slice.maxOpen(document.content);
            void save.discrete(() =>
              view.dispatch(
                view.state.tr
                  .replaceSelection(slice)
                  .scrollIntoView()
                  // The codec already interpreted the source. Do not run the
                  // generic inline paste rules/autolinker over literal fallback.
                  .setMeta("uiEvent", "markdownPaste")
                  .setMeta("preventAutolink", true),
              ),
            );
            return true;
          },
          handleKeyDown: (view, event) => {
            if (
              forwardingKey.current ||
              event.isComposing ||
              save.composing ||
              event.keyCode === 229
            )
              return false;
            // Native caret movement can precede ProseMirror's selectionchange
            // observer. Read that visible selection before replaying a discrete key.
            const domSelection = view.dom.ownerDocument.getSelection();
            if (
              view.state.selection instanceof TextSelection &&
              domSelection?.anchorNode &&
              domSelection.focusNode &&
              view.dom.contains(domSelection.anchorNode) &&
              view.dom.contains(domSelection.focusNode)
            ) {
              const anchor = view.posAtDOM(
                domSelection.anchorNode,
                domSelection.anchorOffset,
              );
              const head = view.posAtDOM(
                domSelection.focusNode,
                domSelection.focusOffset,
              );
              const selection = TextSelection.between(
                view.state.doc.resolve(anchor),
                view.state.doc.resolve(head),
              );
              if (!selection.eq(view.state.selection))
                view.dispatch(view.state.tr.setSelection(selection));
            }
            const mod = event.ctrlKey || event.metaKey;
            const key = event.key.toLowerCase();
            if (mod && !event.altKey && ["home", "end"].includes(key)) {
              const edge =
                key === "home"
                  ? TextSelection.atStart(view.state.doc)
                  : TextSelection.atEnd(view.state.doc);
              view.dispatch(
                view.state.tr.setSelection(
                  event.shiftKey
                    ? TextSelection.create(
                        view.state.doc,
                        view.state.selection.anchor,
                        edge.head,
                      )
                    : edge,
                ),
              );
              return true;
            }
            if (mod && !event.altKey && ["z", "y"].includes(key)) {
              void save.navigate(
                key === "y" || event.shiftKey ? "RedoProject" : "UndoProject",
                () => {
                  const current = liveEditor.current;
                  if (
                    current &&
                    !current.isDestroyed &&
                    save.canPresentCanonical
                  ) {
                    const transaction = canonicalTransaction(
                      current.state,
                      current.schema.nodeFromJSON(toEditor(save.state.blocks)),
                    );
                    if (transaction) current.view.dispatch(transaction);
                  }
                },
              );
              return true;
            }
            const selection = view.state.selection;
            const structural =
              event.key === "Enter" ||
              event.key === "Tab" ||
              (event.key === "Backspace" &&
                (selection.$from.parentOffset === 0 || !selection.empty)) ||
              (event.key === "Delete" &&
                (selection.$to.parentOffset ===
                  selection.$to.parent.content.size ||
                  !selection.empty));
            if (structural || (mod && ["b", "i"].includes(key))) {
              const forwarded = new KeyboardEvent("keydown", {
                key: event.key,
                code: event.code,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                shiftKey: event.shiftKey,
                altKey: event.altKey,
                bubbles: true,
                cancelable: true,
              });
              let handled = false;
              void save.discrete(() => {
                forwardingKey.current = true;
                try {
                  const before = view.state;
                  handled = !!view.someProp("handleKeyDown", (handler) =>
                    handler(view, forwarded),
                  );
                  handled ||=
                    !before.doc.eq(view.state.doc) ||
                    !before.selection.eq(view.state.selection);
                  return handled;
                } finally {
                  forwardingKey.current = false;
                }
              });
              return handled;
            }
            return false;
          },
          attributes: {
            role: protectionReady ? "textbox" : "presentation",
            "aria-busy": protectionReady ? "false" : "true",
            "aria-multiline": "true",
            "aria-label": label,
          },
          handleDOMEvents: {
            paste: (view, event) => {
              if (!save.composing) return false;
              const text = event.clipboardData?.getData("text/plain");
              if (!text) return false;
              // ProseMirror bypasses handlePaste during composition. Preserve
              // explicit clipboard text here without conversion or an early save.
              event.preventDefault();
              view.dispatch(
                view.state.tr
                  .insertText(text.replace(/\r\n?/g, "\n"))
                  .setMeta("uiEvent", "markdownPaste")
                  .setMeta("preventAutolink", true),
              );
              return true;
            },
            compositionstart: () => {
              save.composition(true);
              return false;
            },
            compositionend: () => {
              queueMicrotask(() => {
                const editor = liveEditor.current;
                if (editor) {
                  try {
                    save.update(
                      fromEditorNode(
                        editor.state.doc,
                        new Set(save.state.blocks.map((b) => b.id)),
                      ),
                    );
                  } catch (error) {
                    save.invalidate(
                      error instanceof Error
                        ? error.message
                        : "DOCUMENT_INVALID",
                      editor.getText({ blockSeparator: "\n" }),
                    );
                  }
                }
                save.composition(false);
              });
              return false;
            },
            blur: (_view, event) => {
              save.actions.blur("manuscript", () => {
                if (!liveEditor.current || liveEditor.current.isDestroyed)
                  return;
                try {
                  save.update(
                    fromEditorNode(
                      liveEditor.current.state.doc,
                      new Set(save.state.blocks.map((b) => b.id)),
                    ),
                  );
                } catch (error) {
                  save.invalidate(
                    error instanceof Error ? error.message : "DOCUMENT_INVALID",
                    liveEditor.current.getText({ blockSeparator: "\n" }),
                  );
                }
                save.composition(false);
                void save.boundary();
              });
              if (
                sourceVisible.current ||
                (event.relatedTarget instanceof Element &&
                  event.relatedTarget.closest(".document-menu"))
              )
                return false;
              void save.boundary();
              return false;
            },
          },
        },
        onSelectionUpdate: ({ transaction }) => {
          if (!transaction.docChanged && !save.composing && !save.acting)
            void save.boundary();
        },
        onUpdate: ({ editor }) => {
          try {
            save.update(
              fromEditorNode(
                editor.state.doc,
                new Set(save.state.blocks.map((b) => b.id)),
              ),
            );
          } catch (error) {
            save.invalidate(
              error instanceof Error ? error.message : "DOCUMENT_INVALID",
              editor.getText({ blockSeparator: "\n" }),
            );
          }
        },
      }),
      [save, label, protectionReady],
    ),
  );
  liveEditor.current = editor;
  return { editor, liveEditor };
}
