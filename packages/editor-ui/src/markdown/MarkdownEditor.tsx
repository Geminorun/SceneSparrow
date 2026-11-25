import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Extension, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { WorkspaceIcon } from "../ui/WorkspaceIcon";
import type { MarkdownAnnotations } from "@scenesparrow/contracts";
import { useNoticeOwner } from "../feedback/NotificationPresenter";
import type en from "../locales/en.json";
import { CanonicalIdentity } from "../manuscript/identity";
import type { CompositionActions } from "../project-session/composition-actions";
import {
  sourceBlocks,
  sourceTextRange,
  sourceFromEditor,
  utf8Offset,
  utf16Offset,
  type SourceProjection,
} from "./source-projection";

export function MarkdownEditor({
  projection,
  t,
  composition,
  changed,
  save,
  ready,
  scope = "markdown",
  autofocus = true,
  guard,
  selection,
  lock,
  locked = false,
  comment,
  annotations,
}: {
  projection: SourceProjection;
  guard?: (source: string) => boolean;
  lock?: () => void;
  comment?: () => void;
  annotations?: MarkdownAnnotations;
  locked?: boolean;
  selection?: (
    ranges: { start: number; end: number }[],
    range: { start: number; end: number },
    source: string,
  ) => void;
  scope?: string;
  autofocus?: boolean;
  t: typeof en;
  composition: CompositionActions;
  changed: (source: string) => void;
  save: () => void;
  ready: (editor: Editor | null) => void;
}) {
  const notice = useNoticeOwner();
  const shell = useRef<HTMLDivElement>(null);
  const [lockTop, setLockTop] = useState(0);
  const [markers, setMarkers] = useState<{ top: number; quote: string }[]>([]);
  const callbacks = useRef({ changed, save, guard, selection });
  callbacks.current = { changed, save, guard, selection };
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
                const source = serialize(transaction.doc);
                if (
                  callbacks.current.guard &&
                  !callbacks.current.guard(source)
                ) {
                  queueMicrotask(() => notice.report("MARKDOWN_LOCKED"));
                  return false;
                }
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
        types: [
          "paragraph",
          "heading",
          "bulletList",
          "orderedList",
          "listItem",
        ],
      }),
    ],
    content: projection.document,
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
    onSelectionUpdate: ({ editor }) => selected(editor),
    onUpdate: ({ editor }) => {
      callbacks.current.changed(serialize(editor.state.doc));
      selected(editor);
    },
  });
  function selected(editor: Editor) {
    if (!callbacks.current.selection) return;
    const source = serialize(editor.state.doc);
    const blocks = sourceBlocks(source);
    const positions: { start: number; end: number; textStart: number }[] = [];
    editor.state.doc.descendants((node, pos, parent) => {
      if (
        node.type.name === "heading" ||
        node.type.name === "listItem" ||
        (node.type.name === "paragraph" && parent?.type.name === "doc")
      ) {
        positions.push({
          start: pos,
          textStart: pos + (node.type.name === "listItem" ? 2 : 1),
          end:
            pos +
            (node.type.name === "listItem"
              ? node.firstChild!.nodeSize + 1
              : node.nodeSize),
        });
      }
    });
    const { from, to, empty } = editor.state.selection;
    const chosen = blocks
      .filter((_, index) => {
        const p = positions[index];
        return (
          p &&
          (empty
            ? from > p.start && from < p.end
            : from < p.end && to > p.start)
        );
      })
      .map((block) => ({
        start: utf8Offset(source, block.start),
        end: utf8Offset(source, block.end),
      }));
    if (chosen.length) {
      let range = { start: chosen[0]!.start, end: chosen.at(-1)!.end };
      if (!empty) {
        const indices = blocks
          .map((block, index) => ({ block, position: positions[index] }))
          .filter(
            ({ position }) =>
              position && from < position.end && to > position.start,
          );
        const first = indices[0],
          last = indices.at(-1);
        if (first?.position && last?.position) {
          const start = sourceTextRange(
            source,
            first.block,
            from - first.position.textStart,
            to - first.position.textStart,
          );
          const end = sourceTextRange(
            source,
            last.block,
            from - last.position.textStart,
            to - last.position.textStart,
          );
          if (!start || !end) range = { start: 0, end: 0 };
          else
            range = {
              start: utf8Offset(source, start.start),
              end: utf8Offset(source, end.end),
            };
        }
      }
      callbacks.current.selection(chosen, range, source);
      if (shell.current)
        setLockTop(
          Math.max(
            0,
            editor.view.coordsAtPos(from).top -
              shell.current.getBoundingClientRect().top,
          ),
        );
    }
  }
  function sync() {
    if (editor) callbacks.current.changed(serialize(editor.state.doc));
  }
  useLayoutEffect(() => {
    const view = editor?.view;
    // Focus the mounted view before an edit can change its selection.
    if (autofocus && view?.dom.isConnected) view.focus();
  }, [editor, autofocus]);
  useEffect(() => {
    ready(editor);
    if (editor) selected(editor);
    return () => {
      ready(null);
      composition.composition(scope, false);
    };
  }, [editor]);
  useEffect(() => {
    if (editor) editor.view.dom.setAttribute("aria-label", t.markdownText);
  }, [editor, t.markdownText]);
  useEffect(() => {
    if (!editor || !shell.current) return;
    const measure = () => {
      if (!shell.current) return;
      const source = serialize(editor.state.doc);
      const blocks = sourceBlocks(source);
      const positions: number[] = [];
      editor.state.doc.descendants((node, pos, parent) => {
        if (
          node.type.name === "heading" ||
          node.type.name === "listItem" ||
          (node.type.name === "paragraph" && parent?.type.name === "doc")
        )
          positions.push(pos + 1);
      });
      setMarkers(
        (annotations?.locks ?? []).flatMap((lock) =>
          lock.anchors.flatMap((anchor) => {
            const matches = blocks
              .map((block, index) => ({ block, index }))
              .filter(
                ({ block }) =>
                  source.slice(block.start, block.end) === anchor.quote,
              );
            const index =
              (matches.length === 1
                ? matches[0]
                : matches.find(
                    ({ block }) =>
                      anchor.resolvedStart !== null &&
                      block.start === utf16Offset(source, anchor.resolvedStart),
                  )
              )?.index ?? -1;
            const position = positions[index];
            return position === undefined
              ? []
              : [
                  {
                    top:
                      editor.view.coordsAtPos(position).top -
                      shell.current!.getBoundingClientRect().top,
                    quote: anchor.quote,
                  },
                ];
          }),
        ),
      );
    };
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(shell.current);
    schedule();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [editor, annotations, lockTop]);
  return (
    <div className="markdown-editor-shell" ref={shell}>
      <EditorContent editor={editor} />
      {markers.map((marker, index) => (
        <span
          key={index}
          className="markdown-lock-marker"
          style={{ top: marker.top }}
          title={`${t.markdownLocked}: ${marker.quote}`}
        >
          <WorkspaceIcon name="lock" />
        </span>
      ))}
      <div className="markdown-block-controls" style={{ top: lockTop }}>
        {lock && (
          <button
            aria-label={locked ? t.markdownUnlock : t.markdownLockSelection}
            title={locked ? t.markdownUnlock : t.markdownLockSelection}
            onMouseDown={(event) => event.preventDefault()}
            onClick={lock}
          >
            <WorkspaceIcon name={locked ? "lock" : "unlock"} />
          </button>
        )}
        {comment && (
          <button
            aria-label={t.markdownAddComment}
            title={t.markdownAddComment}
            onMouseDown={(event) => event.preventDefault()}
            onClick={comment}
          >
            <WorkspaceIcon name="comment" />
          </button>
        )}
      </div>
    </div>
  );
}
