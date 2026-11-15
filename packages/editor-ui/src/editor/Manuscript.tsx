import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type UseEditorOptions } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Code from "@tiptap/extension-code";
import { CanonicalIdentity } from "./identity";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type { HistoryState, ManuscriptState } from "@scenesparrow/contracts";
import type en from "../locales/en.json";
import { Planning, GeneratedDraftEvidence } from "./Planning";
import { Sources } from "./Sources";
import { Autosave } from "./autosave";
import { fromEditor, toEditor } from "./canonical";
export function Manuscript({
  client,
  projectId,
  t,
  onRevision,
}: {
  client: PlatformClient;
  projectId: string;
  t: typeof en;
  onRevision: (revision: number) => void;
}) {
  const [initial, setInitial] = useState<{
    document: ManuscriptState;
    history: HistoryState;
  } | null>(null);
  const load = async () => {
    const document = await client.readManuscript();
    const history = await client.readHistory();
    if (document.workingRevision !== history.workingRevision)
      throw Error("REVISION_CONFLICT");
    return { document, history };
  };
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    let active = true;
    void load().then(
      (s) => {
        if (active) setInitial(s);
      },
      () => {
        if (active) setLoadError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [client, projectId]);
  if (loadError)
    return (
      <p role="alert">
        {t.error}
        <button
          onClick={() => {
            setLoadError(false);
            void load().then(setInitial, () => setLoadError(true));
          }}
        >
          {t.retry}
        </button>
      </p>
    );
  if (!initial) return <p role="status">{t.connecting}</p>;
  return (
    <Draft
      initial={initial.document}
      history={initial.history}
      client={client}
      projectId={projectId}
      t={t}
      onRevision={onRevision}
    />
  );
}
function Draft({
  initial,
  history,
  client,
  projectId,
  t,
  onRevision,
}: {
  initial: ManuscriptState;
  history: HistoryState;
  client: PlatformClient;
  projectId: string;
  t: typeof en;
  onRevision: (revision: number) => void;
}) {
  const [, render] = useState(0);
  const [recovery, setRecovery] = useState(false);
  const [link, setLink] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [save] = useState(
    () =>
      new Autosave(
        initial,
        projectId,
        client,
        () => render((n) => n + 1),
        history,
      ),
  );
  const forwardingKey = useRef(false);
  const liveEditor = useRef<Editor | null>(null);
  const editor = useEditor(
    useMemo<UseEditorOptions>(
      () => ({
        extensions: [
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
          CanonicalIdentity.configure({
            attributeName: "blockId",
            types: ["paragraph", "heading"],
          }),
        ],
        content: toEditor(initial.blocks),
        editorProps: {
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
                () =>
                  liveEditor.current?.commands.setContent(
                    toEditor(save.state.blocks),
                    {
                      emitUpdate: false,
                    },
                  ),
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
            role: "textbox",
            "aria-multiline": "true",
            "aria-label": t.manuscript,
          },
          handleDOMEvents: {
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
                      fromEditor(
                        editor.getJSON(),
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
            blur: () => {
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
              fromEditor(
                editor.getJSON(),
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
      [save, t.manuscript],
    ),
  );
  liveEditor.current = editor;
  const applyCanonical = () =>
    editor?.commands.setContent(toEditor(save.state.blocks), {
      emitUpdate: false,
    });
  useEffect(() => {
    if (save.canonicalVersion) applyCanonical();
  }, [editor, save.canonicalVersion]);
  const historyAction = (type: "UndoProject" | "RedoProject") =>
    save.navigate(type, applyCanonical);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const inEditor = !!target?.closest(".tiptap");
      if (
        inEditor ||
        target?.closest("input,textarea,select,[contenteditable=true]")
      )
        return;
      if (event.isComposing || save.composing || event.keyCode === 229) return;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && !event.altKey && (key === "z" || key === "y")) {
        event.preventDefault();
        event.stopPropagation();
        void historyAction(
          key === "y" || event.shiftKey ? "RedoProject" : "UndoProject",
        );
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [editor, save]);
  const closeDecision = useRef<((allowed: boolean) => void) | null>(null);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    onRevision(save.state.workingRevision);
  }, [save.state.workingRevision, onRevision]);
  useEffect(() => {
    const warning = (event: BeforeUnloadEvent) => {
      if (save.status !== "saved" || save.planningAdapter?.dirty()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warning);
    const remove = client.onCloseRequested?.(async () => {
      const ok = await save.controlledClose();
      if (ok) return true;
      setRecovery(true);
      setClosing(true);
      return new Promise<boolean>((resolve) => {
        closeDecision.current = resolve;
      });
    });
    return () => {
      closeDecision.current?.(false);
      closeDecision.current = null;
      save.dispose();
      remove?.();
      window.removeEventListener("beforeunload", warning);
    };
  }, [client, save]);
  async function reload() {
    if (await save.reload()) {
      editor?.commands.setContent(toEditor(save.state.blocks), {
        emitUpdate: false,
      });
      setRecovery(false);
      setClosing(false);
      // The user explicitly chose to discard local input; finish the close handshake.
      closeDecision.current?.(true);
      closeDecision.current = null;
    }
  }
  const operationLabel = (label: string | null) =>
    label === "typing"
      ? t.historyTyping
      : label === "startDraft"
        ? t.historyStartDraft
        : label === "addSource"
          ? t.historyAddSource
          : label === "removeSource"
            ? t.historyRemoveSource
            : label === "import"
              ? t.historyImport
              : t.historyEdit;
  const headings = save.local.filter((b) => b.kind === "heading");
  const toolbar = (action: () => unknown) => {
    void save.discrete(() => {
      editor?.view.focus();
      action();
      editor?.view.focus();
    });
  };
  return (
    <section className="manuscript-workspace">
      <div className="manuscript-header">
        <h3>{t.manuscript}</h3>
        <span role="status" data-testid="save-status" data-state={save.status}>
          {t[`save_${save.status}`]}
        </span>
      </div>
      <div role="toolbar" aria-label={t.history}>
        <button
          disabled={
            save.busy ||
            save.composing ||
            (!save.history.undoCount && save.status === "saved") ||
            ["error", "conflict"].includes(save.status)
          }
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void historyAction("UndoProject")}
          title={
            save.history.undoLabel
              ? `${t.undo}: ${operationLabel(save.history.undoLabel)}`
              : t.undo
          }
        >
          {t.undo}
        </button>
        <button
          disabled={
            save.busy ||
            save.composing ||
            !save.history.redoCount ||
            ["error", "conflict"].includes(save.status)
          }
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void historyAction("RedoProject")}
          title={
            save.history.redoLabel
              ? `${t.redo}: ${operationLabel(save.history.redoLabel)}`
              : t.redo
          }
        >
          {t.redo}
        </button>
      </div>
      {save.state.workspaceStage === "outline" ? (
        <Planning client={client} save={save} projectId={projectId} t={t} />
      ) : (
        <>
          <div
            className="editor-toolbar"
            role="toolbar"
            aria-label={t.formatting}
          >
            <select
              aria-label={t.blockStyle}
              value=""
              onChange={(e) =>
                toolbar(() =>
                  e.target.value === "paragraph"
                    ? editor?.chain().setParagraph().run()
                    : editor
                        ?.chain()
                        .setHeading({
                          level: Number(e.target.value) as
                            1 | 2 | 3 | 4 | 5 | 6,
                        })
                        .run(),
                )
              }
            >
              <option value="" disabled>
                {t.blockStyle}
              </option>
              <option value="paragraph">{t.paragraph}</option>
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {t.heading} {n}
                </option>
              ))}
            </select>
            <button
              aria-label={t.bold}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toolbar(() => editor?.chain().toggleBold().run())}
            >
              <strong>B</strong>
            </button>
            <button
              aria-label={t.italic}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                toolbar(() => editor?.chain().toggleItalic().run())
              }
            >
              <em>I</em>
            </button>
            <button
              aria-label={t.inlineCode}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toolbar(() => editor?.chain().toggleCode().run())}
            >
              {"</>"}
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                toolbar(() => editor?.chain().toggleBulletList().run())
              }
            >
              {t.bulletList}
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                toolbar(() => editor?.chain().toggleOrderedList().run())
              }
            >
              {t.orderedList}
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setLink(String(editor?.getAttributes("link").href ?? ""));
                setLinkOpen(!linkOpen);
              }}
            >
              {t.link}
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toolbar(() => editor?.chain().unsetLink().run())}
            >
              {t.removeLink}
            </button>
          </div>
          {linkOpen && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (/^(https?:\/\/|mailto:)/i.test(link)) {
                  toolbar(() =>
                    editor
                      ?.chain()
                      .extendMarkRange("link")
                      .setLink({ href: link })
                      .run(),
                  );
                  setLinkOpen(false);
                }
              }}
            >
              <label>
                {t.linkUrl}
                <input
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  required
                  pattern="(https?://|mailto:).*"
                />
              </label>
              <button type="submit">{t.applyLink}</button>
            </form>
          )}
          <div className="document-layout">
            <nav aria-label={t.headings}>
              {headings.length ? (
                headings.map((b) => (
                  <button
                    key={b.id}
                    style={{
                      paddingInlineStart: `${(b.attrs.level ?? 1) * 8}px`,
                    }}
                    onClick={() =>
                      editor?.view.dom
                        .querySelector(`[data-blockid="${b.id}"]`)
                        ?.scrollIntoView({
                          block: "center",
                          behavior: "smooth",
                        })
                    }
                  >
                    {b.runs.map((r) => r.text).join("") || t.heading}
                  </button>
                ))
              ) : (
                <p className="muted">{t.noHeadings}</p>
              )}
            </nav>
            <EditorContent editor={editor} />
          </div>
        </>
      )}
      {save.state.workspaceStage === "draft" && (
        <GeneratedDraftEvidence
          client={client}
          blockIds={save.state.blocks.map((b) => b.id)}
          t={t}
        />
      )}
      <Sources client={client} save={save} projectId={projectId} t={t} />
      {(save.status === "error" || save.status === "conflict") && (
        <div role="alert" className="error">
          <p>
            {save.status === "conflict" ? t.conflictHelp : t.saveErrorHelp}{" "}
            <span data-testid="save-error-code" data-error-code={save.error}>
              {save.error === "DOCUMENT_TOO_LARGE"
                ? t.documentTooLarge
                : save.error === "DOCUMENT_INVALID"
                  ? t.documentInvalid
                  : save.error === "HISTORY_BLOCKED"
                    ? t.historyBlocked
                    : save.error === "HISTORY_EMPTY"
                      ? t.historyEmpty
                      : save.error === "HISTORY_CONFLICT"
                        ? t.historyConflict
                        : ""}
            </span>
          </p>
          {save.status !== "conflict" && (
            <button onClick={() => void save.flush(true)}>{t.retry}</button>
          )}
          <button onClick={() => setRecovery(true)}>{t.recover}</button>
        </div>
      )}
      {recovery && (
        <div className="recovery" role="dialog" aria-label={t.recover}>
          <p>{t.recoveryHelp}</p>
          <textarea
            aria-label={t.localCopy}
            readOnly
            value={
              save.recoveryText ??
              save.local
                .map((b) => b.runs.map((r) => r.text).join(""))
                .join("\n")
            }
          />
          <button onClick={() => void reload()}>{t.discardAndReload}</button>
          <button
            onClick={() => {
              setRecovery(false);
              setClosing(false);
              closeDecision.current?.(false);
              closeDecision.current = null;
            }}
          >
            {t.keepEditing}
          </button>
          {closing && (
            <>
              <button
                onClick={() =>
                  void save.controlledClose(true).then((ok) => {
                    if (ok) {
                      setClosing(false);
                      closeDecision.current?.(true);
                      closeDecision.current = null;
                    }
                  })
                }
              >
                {t.retryClose}
              </button>
              <button
                onClick={() => {
                  closeDecision.current?.(true);
                  closeDecision.current = null;
                }}
              >
                {t.closeUnsaved}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
