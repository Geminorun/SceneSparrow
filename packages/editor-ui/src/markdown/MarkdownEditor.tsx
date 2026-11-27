import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Extension, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Plugin } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { ApiError } from "@scenesparrow/platform-client";
import { WorkspaceIcon } from "../ui/WorkspaceIcon";
import type {
  MarkdownAnnotations,
  MarkdownComment,
  MarkdownRange,
} from "@scenesparrow/contracts";
import { useNoticeOwner } from "../feedback/NotificationPresenter";
import type en from "../locales/en.json";
import { CanonicalIdentity } from "../manuscript/identity";
import type { CompositionActions } from "../project-session/composition-actions";
import {
  sourceTextRange,
  sourceFromEditor,
  utf8Offset,
  type SourceProjection,
} from "./source-projection";
import { anchorRange, editorBlocks, commentSpans } from "./editor-annotations";

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
  ask,
  comment,
  annotations,
}: {
  projection: SourceProjection;
  guard?: (source: string) => boolean;
  lock?: (ranges: MarkdownRange[], source: string) => void;
  ask?: () => void;
  comment?: (
    source: string,
    range: MarkdownRange,
    text: string,
    existing?: MarkdownComment,
    resolve?: boolean,
  ) => Promise<MarkdownComment | undefined>;
  annotations?: MarkdownAnnotations;
  selection?: (
    ranges: { start: number; end: number }[],
    range: { start: number; end: number },
    source: string,
    explicit: boolean,
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
  const [gutter, setGutter] = useState<
    {
      top: number;
      height: number;
      index: number;
      locked: boolean;
      quote: string;
      range: MarkdownRange;
      source: string;
    }[]
  >([]);
  const [toolbar, setToolbar] = useState<{ left: number; top: number } | null>(
    null,
  );
  const [note, setNote] = useState<{
    source: string;
    range: MarkdownRange;
    from: number;
    to: number;
    left: number;
    top: number;
    existing?: MarkdownComment;
  } | null>(null);
  const noteRef = useRef(note);
  noteRef.current = note;
  const [noteText, setNoteText] = useState("");
  const noteTextRef = useRef(noteText);
  noteTextRef.current = noteText;
  const [hoveredBlock, setHoveredBlock] = useState(-1);
  const [noteBusy, setNoteBusy] = useState(false);
  const noteInput = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const noteOpen = useRef(openNote);
  noteOpen.current = openNote;
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
      Extension.create({
        name: "markdownAnnotations",
        addProseMirrorPlugins: () => [
          new Plugin({
            props: {
              decorations(state) {
                const source = serialize(state.doc);
                const blocks = editorBlocks(state.doc, source);
                const decorations: Decoration[] = [];
                const lockedRanges = new Set(
                  annotationsRef.current?.locks.flatMap((lock) =>
                    lock.anchors.flatMap((anchor) => {
                      const range = anchorRange(source, anchor);
                      return range ? [`${range.start}:${range.end}`] : [];
                    }),
                  ),
                );
                for (const [index, { block, position }] of blocks.entries()) {
                  const locked = lockedRanges.has(
                    `${block.start}:${block.end}`,
                  );
                  decorations.push(
                    Decoration.node(
                      position.start,
                      position.start + position.size,
                      {
                        class: locked
                          ? "markdown-locked-block"
                          : "markdown-lockable-block",
                        "data-lock-block": String(index),
                      },
                    ),
                  );
                }
                for (const comment of annotationsRef.current?.comments ?? []) {
                  if (comment.status !== "open") continue;
                  const range = anchorRange(source, comment.anchor);
                  if (!range) continue;
                  const spans = commentSpans(state.doc, source, range, blocks);
                  for (const span of spans)
                    decorations.push(
                      Decoration.inline(span.from, span.to, {
                        class: "markdown-comment-highlight",
                        "data-comment-id": comment.id,
                      }),
                    );
                  const last = spans.at(-1);
                  if (last)
                    decorations.push(
                      Decoration.widget(
                        last.to,
                        () => {
                          const button = document.createElement("button");
                          button.type = "button";
                          button.className = "markdown-comment-marker";
                          button.setAttribute(
                            "aria-label",
                            `${t.markdownComments}: ${comment.text}`,
                          );
                          const icon = document.createElementNS(
                            "http://www.w3.org/2000/svg",
                            "svg",
                          );
                          icon.setAttribute("viewBox", "0 0 24 24");
                          icon.setAttribute("aria-hidden", "true");
                          const path = document.createElementNS(
                            icon.namespaceURI,
                            "path",
                          );
                          path.setAttribute("d", "M4 4h16v12H9l-5 4z");
                          icon.append(path);
                          button.append(icon);
                          button.addEventListener("mousedown", (event) =>
                            event.preventDefault(),
                          );
                          button.addEventListener("click", () =>
                            noteOpen.current(comment),
                          );
                          return button;
                        },
                        { key: `${comment.id}:${comment.text}`, side: 1 },
                      ),
                    );
                }
                return DecorationSet.create(state.doc, decorations);
              },
            },
          }),
        ],
      }),
      StarterKit.configure({
        codeBlock: false,
        blockquote: false,
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
          "horizontalRule",
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
          composing.current = true;
          setToolbar(null);
          composition.composition(scope, true);
          return false;
        },
        compositionend: () => {
          queueMicrotask(() => {
            sync();
            composing.current = false;
            composition.composition(scope, false);
            if (editor) selected(editor);
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
    const mapping = editorBlocks(editor.state.doc, source);
    const blocks = mapping.map(({ block }) => block);
    const positions = mapping.map(({ position }) => position);
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
      callbacks.current.selection(chosen, range, source, !empty);
    } else
      callbacks.current.selection([], { start: 0, end: 0 }, source, !empty);
    clearTimeout(settle.current);
    setToolbar(null);
    if (!empty && !composing.current)
      settle.current = setTimeout(() => {
        if (
          !editor.isFocused ||
          composing.current ||
          editor.state.selection.empty
        )
          return;
        setToolbar(placement(editor.state.selection.to, 168, 44));
      }, 160);
  }
  function placement(pos: number, width: number, height: number) {
    if (!editor) return { left: 0, top: 0 };
    const coords = editor.view.coordsAtPos(pos);
    const main = shell.current
      ?.closest(".manuscript-main")
      ?.getBoundingClientRect();
    const right = Math.min(
      window.innerWidth - 8,
      main?.right ?? window.innerWidth - 8,
    );
    const left = Math.max(8, main?.left ?? 8);
    const bottom = Math.min(
      window.innerHeight - 8,
      main?.bottom ?? window.innerHeight - 8,
    );
    const top = Math.max(8, main?.top ?? 8);
    return {
      left: Math.max(left, Math.min(coords.left, right - width)),
      top: Math.max(top, Math.min(coords.bottom + 6, bottom - height)),
    };
  }
  function openNote(existing?: MarkdownComment) {
    if (!editor || composing.current) return;
    const source = serialize(editor.state.doc);
    const { from, to } = editor.state.selection;
    let range: MarkdownRange | undefined;
    let passage = { from, to };
    if (existing) {
      const anchor = anchorRange(source, existing.anchor);
      const spans = anchor && commentSpans(editor.state.doc, source, anchor);
      if (!anchor || !spans?.length) return;
      range = {
        start: utf8Offset(source, anchor.start),
        end: utf8Offset(source, anchor.end),
      };
      passage = { from: spans[0]!.from, to: spans.at(-1)!.to };
    } else {
      const selected = editorBlocks(editor.state.doc, source).filter(
        ({ position }) => from < position.end && to > position.start,
      );
      const first = selected[0],
        last = selected.at(-1);
      if (!first || !last || from === to) return;
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
      if (!start || !end) return;
      range = {
        start: utf8Offset(source, start.start),
        end: utf8Offset(source, end.end),
      };
    }
    setNote({
      source,
      range,
      ...passage,
      ...placement(passage.to, 300, 244),
      ...(existing ? { existing } : {}),
    });
    setNoteText(existing?.text ?? "");
    setToolbar(null);
  }
  function closeNote(captured = note, restoreFocus = true) {
    if (!captured || !editor || noteRef.current !== captured) return;
    const { from, to } = captured;
    setNote(null);
    if (restoreFocus && serialize(editor.state.doc) === captured.source) {
      editor.commands.setTextSelection({ from, to });
      editor.view.dom.focus({ preventScroll: true });
    }
  }
  async function saveNote(resolve = false) {
    if (!note || !comment || noteBusy) return;
    const captured = note;
    setNoteBusy(true);
    try {
      await composition.run(`inline-comment:${scope}`, async () => {
        if (editor?.isDestroyed || noteRef.current !== captured) return;
        if (serialize(editor!.state.doc) !== captured.source)
          throw new ApiError("MARKDOWN_CONFLICT");
        const input = noteTextRef.current;
        const saved = await comment(
          captured.source,
          captured.range,
          input,
          captured.existing,
          resolve,
        );
        if (editor?.isDestroyed || noteRef.current !== captured) return;
        if (noteTextRef.current !== input) {
          const { existing: _old, ...retained } = captured;
          setNote({
            ...retained,
            ...(saved?.status === "open" ? { existing: saved } : {}),
          });
          return;
        }
        const focused =
          document.activeElement === document.body ||
          (document.activeElement instanceof HTMLElement &&
            !!document.activeElement.closest(".markdown-inline-comment"));
        closeNote(captured, focused);
      });
    } catch (failure) {
      notice.report(failure);
    } finally {
      setNoteBusy(false);
    }
  }
  useEffect(() => {
    if (note) noteInput.current?.focus();
  }, [note]);

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
    editor.view.dispatch(editor.state.tr.setMeta("annotations", true));
    const measure = () => {
      if (!shell.current) return;
      const source = serialize(editor.state.doc);
      const origin = shell.current.getBoundingClientRect();
      setGutter(
        editorBlocks(editor.state.doc, source).flatMap(
          ({ block, position }, index) => {
            const dom = editor.view.nodeDOM(position.start);
            if (!(dom instanceof HTMLElement)) return [];
            const box = dom.getBoundingClientRect();
            return [
              {
                top: box.top - origin.top,
                height: box.height,
                index,
                locked: dom.classList.contains("markdown-locked-block"),
                quote: source.slice(block.start, block.end),
                source,
                range: {
                  start: block.start,
                  end: block.end,
                },
              },
            ];
          },
        ),
      );
    };
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const dismiss = () => setToolbar(null);
    editor.on("update", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(shell.current);
    shell.current
      .closest(".manuscript-main")
      ?.addEventListener("scroll", dismiss);
    schedule();
    return () => {
      observer.disconnect();
      editor.off("update", schedule);
      shell.current
        ?.closest(".manuscript-main")
        ?.removeEventListener("scroll", dismiss);
      cancelAnimationFrame(frame);
    };
  }, [editor, annotations]);
  useEffect(
    () => () => {
      clearTimeout(settle.current);
      composition.composition(`inline-comment:${scope}:input`, false);
      composition.cancel(`inline-comment:${scope}`);
    },
    [],
  );
  return (
    <div
      className="markdown-editor-shell"
      ref={shell}
      onMouseLeave={() => setHoveredBlock(-1)}
      onMouseMove={(event) => {
        const target = (event.target as HTMLElement).closest(
          "[data-lock-block]",
        );
        setHoveredBlock(
          target ? Number(target.getAttribute("data-lock-block")) : -1,
        );
      }}
    >
      <EditorContent editor={editor} />
      {toolbar && !note && (
        <div
          className="markdown-selection-toolbar"
          role="toolbar"
          aria-label={t.markdownSelectionActions}
          style={toolbar}
          onMouseDown={(event) => event.preventDefault()}
        >
          <button onClick={ask}>{t.markdownAsk}</button>
          <button onClick={() => openNote()}>{t.markdownCommentAction}</button>
        </div>
      )}
      {lock &&
        gutter.map((block) => (
          <div
            key={block.index}
            className={`markdown-block-controls${block.locked ? " is-locked" : ""}${block.index === hoveredBlock ? " is-hovered" : ""}`}
            data-lock-block={block.index}
            style={{ top: block.top, height: block.height }}
          >
            <button
              aria-label={
                block.locked ? t.markdownUnlock : t.markdownLockSelection
              }
              title={`${block.locked ? t.markdownLocked : t.markdownLockSelection}: ${block.quote}`}
              className={block.locked ? "markdown-lock-marker" : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() =>
                lock(
                  [
                    {
                      start: utf8Offset(block.source, block.range.start),
                      end: utf8Offset(block.source, block.range.end),
                    },
                  ],
                  block.source,
                )
              }
            >
              <WorkspaceIcon name={block.locked ? "lock" : "unlock"} />
            </button>
          </div>
        ))}
      {note && (
        <div
          className="markdown-inline-comment"
          role="dialog"
          aria-label={t.markdownComments}
          style={{ left: note.left, top: note.top }}
          onKeyDown={(event) => {
            if (
              event.key === "Escape" &&
              !event.nativeEvent.isComposing &&
              !composing.current
            ) {
              event.preventDefault();
              event.stopPropagation();
              closeNote();
            }
          }}
        >
          <label>
            {t.markdownCommentText}
            <textarea
              ref={noteInput}
              value={noteText}
              maxLength={16384}
              onChange={(event) => setNoteText(event.target.value)}
              onCompositionStart={() => {
                composing.current = true;
                composition.composition(`inline-comment:${scope}:input`, true);
              }}
              onCompositionEnd={() => {
                composing.current = false;
                composition.composition(`inline-comment:${scope}:input`, false);
              }}
              onBlur={() =>
                composition.blur(`inline-comment:${scope}:input`, () => {
                  composing.current = false;
                  composition.composition(
                    `inline-comment:${scope}:input`,
                    false,
                  );
                })
              }
            />
          </label>
          <div className="markdown-inline-comment-actions">
            <button
              disabled={noteBusy || !noteText.trim()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void saveNote()}
            >
              {t.markdownSave}
            </button>
            {note.existing && (
              <button
                disabled={noteBusy}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void saveNote(true)}
              >
                {t.markdownResolveComment}
              </button>
            )}
            <button disabled={noteBusy} onClick={() => closeNote()}>
              {t.close}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
