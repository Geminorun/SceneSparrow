import { useEffect, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Extension, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { useNoticeOwner } from "../feedback/NotificationPresenter";
import type en from "../locales/en.json";
import { CanonicalIdentity } from "../manuscript/identity";
import type { CompositionActions } from "../project-session/composition-actions";
import { sourceFromEditor, type SourceProjection } from "./source-projection";

export function MarkdownEditor({
  projection,
  t,
  composition,
  changed,
  save,
  ready,
  scope = "markdown",
  autofocus = true,
}: {
  projection: SourceProjection;
  scope?: string;
  autofocus?: boolean;
  t: typeof en;
  composition: CompositionActions;
  changed: (source: string) => void;
  save: () => void;
  ready: (editor: Editor | null) => void;
}) {
  const notice = useNoticeOwner();
  const callbacks = useRef({ changed, save });
  callbacks.current = { changed, save };
  const serialized = useRef<{ doc: ProseMirrorNode; source: string } | null>(
    null,
  );
  function serialize(doc: ProseMirrorNode) {
    if (serialized.current?.doc === doc) return serialized.current.source;
    const source = sourceFromEditor(projection, doc.toJSON());
    serialized.current = { doc, source };
    return source;
  }
  const editor = useEditor({
    extensions: [
      Extension.create({
        name: "markdownSourceGuard",
        addProseMirrorPlugins: () => [
          new Plugin({
            filterTransaction: (transaction) => {
              if (!transaction.docChanged) return true;
              try {
                serialize(transaction.doc);
                return true;
              } catch (error) {
                queueMicrotask(() =>
                  notice.report(
                    error instanceof Error &&
                      error.message === "DOCUMENT_TOO_LARGE"
                      ? "DOCUMENT_RESOURCE_LIMIT"
                      : "MARKDOWN_VISUAL_EDIT_UNSUPPORTED",
                  ),
                );
                return false;
              }
            },
          }),
        ],
      }),
      StarterKit.configure({
        codeBlock: false,
        blockquote: false,
        horizontalRule: false,
        strike: false,
        underline: false,
        link: false,
        trailingNode: false,
      }),
      CanonicalIdentity.configure({
        attributeName: "blockId",
        types: ["paragraph", "heading", "bulletList", "orderedList"],
      }),
    ],
    content: projection.document,
    autofocus: autofocus ? "start" : false,
    editorProps: {
      attributes: {
        id:
          scope === "markdown" ? "markdown-editor" : "markdown-outline-editor",
        role: "textbox",
        "aria-label": t.markdownText,
        "aria-multiline": "true",
      },
      handleKeyDown: (_view, event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          callbacks.current.save();
          return true;
        }
        return false;
      },
      handleDOMEvents: {
        compositionstart: () => {
          composition.composition(scope, true);
          return false;
        },
        compositionend: () => {
          queueMicrotask(() => {
            sync();
            composition.composition(scope, false);
          });
          return false;
        },
        blur: () => {
          composition.blur(scope, () => {
            sync();
            composition.composition(scope, false);
          });
          return false;
        },
      },
    },
    onUpdate: ({ editor }) =>
      callbacks.current.changed(serialize(editor.state.doc)),
  });
  function sync() {
    if (editor) callbacks.current.changed(serialize(editor.state.doc));
  }
  useEffect(() => {
    ready(editor);
    return () => {
      ready(null);
      composition.composition(scope, false);
    };
  }, [editor]);
  useEffect(() => {
    if (editor) editor.view.dom.setAttribute("aria-label", t.markdownText);
  }, [editor, t.markdownText]);
  return <EditorContent editor={editor} />;
}
