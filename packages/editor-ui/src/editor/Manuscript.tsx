import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type UseEditorOptions } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Code from "@tiptap/extension-code";
import { CanonicalIdentity } from "./identity";
import type { Editor } from "@tiptap/core";
import { TextSelection, type SelectionBookmark } from "@tiptap/pm/state";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type { HistoryState, ManuscriptState } from "@scenesparrow/contracts";
import type en from "../locales/en.json";
import { Review } from "./Review";
import { WorkspacePane, useAuxiliaryPane } from "./WorkspacePane";
import { SaveStatus } from "./SaveStatus";
import { DocumentToolbar } from "./DocumentToolbar";
import { Locks } from "./Locks";
import { ContentProtection, contentProtectionKey } from "./content-protection";
import { ReviewDecorations } from "./review-decorations";
import {
  Planning,
  GeneratedDraftEvidence,
  type PlanningFeedback,
} from "./Planning";
import { Exports } from "./Exports";
import { Sources } from "./Sources";
import { Autosave } from "./autosave";
import { canonicalTransaction } from "./canonical-transaction";
import { fromEditorNode, toEditor } from "./canonical";
export function Manuscript({
  client,
  projectId,
  t,
  onRevision,
  onBeforeClose,
  approvedBaseline,
}: {
  client: PlatformClient;
  projectId: string;
  t: typeof en;
  onRevision: (revision: number) => void;
  onBeforeClose: () => void;
  approvedBaseline: number | null;
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
      key={projectId}
      initial={initial.document}
      history={initial.history}
      client={client}
      projectId={projectId}
      t={t}
      onRevision={onRevision}
      onBeforeClose={onBeforeClose}
      approvedBaseline={approvedBaseline}
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
  onBeforeClose,
  approvedBaseline,
}: {
  initial: ManuscriptState;
  history: HistoryState;
  client: PlatformClient;
  projectId: string;
  t: typeof en;
  onRevision: (revision: number) => void;
  onBeforeClose: () => void;
  approvedBaseline: number | null;
}) {
  const beforeClose = useRef(onBeforeClose);
  beforeClose.current = onBeforeClose;
  const [, render] = useState(0);
  const [recovery, setRecovery] = useState(false);
  const [protectionReady, setProtectionReady] = useState(
    initial.workspaceStage === "outline",
  );
  const pane = useAuxiliaryPane();
  const [planningFeedback, setPlanningFeedback] =
    useState<PlanningFeedback | null>(null);
  const protectionReadyRef = useRef(false);
  protectionReadyRef.current = protectionReady;
  const [lockHeader, setLockHeader] = useState<HTMLDivElement | null>(null);
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
  const deferredToolbar = useRef<
    Array<{ action: () => unknown; bookmark: SelectionBookmark }>
  >([]);
  const resumeToolbar = useRef(() => {});
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
                resumeToolbar.current();
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
      [save, t.manuscript, protectionReady],
    ),
  );
  liveEditor.current = editor;
  useEffect(() => {
    if (!save.composing) resumeToolbar.current();
  }, [save, save.composing]);
  useEffect(() => {
    if (!editor) return;
    const map = ({
      transaction,
    }: {
      transaction: import("@tiptap/pm/state").Transaction;
    }) => {
      for (const intent of deferredToolbar.current)
        intent.bookmark = intent.bookmark.map(transaction.mapping);
    };
    editor.on("transaction", map);
    return () => {
      editor.off("transaction", map);
      deferredToolbar.current = [];
    };
  }, [editor]);
  useEffect(() => {
    if (editor && save.state.workspaceStage === "outline") {
      // Empty Outline projects have no locks; Draft still loads its lock projection.
      editor.view.dispatch(
        editor.state.tr.setMeta(contentProtectionKey, new Set<string>()),
      );
      editor.setEditable(true, false);
      setProtectionReady(true);
    }
  }, [editor, save.state.workspaceStage]);
  const applyCanonical = () => {
    const editor = liveEditor.current;
    if (!editor || editor.isDestroyed || !save.canPresentCanonical) return;
    const transaction = canonicalTransaction(
      editor.state,
      editor.schema.nodeFromJSON(toEditor(save.state.blocks)),
    );
    if (transaction) editor.view.dispatch(transaction);
  };
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
        target?.closest("dialog,[role=dialog],[aria-modal=true]") ||
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
  const [frozen, setFrozen] = useState(false);
  const freezeContainer = useRef<HTMLFieldSetElement | null>(null);
  const freeze = (value: boolean) => {
    if (freezeContainer.current) {
      freezeContainer.current.disabled = value;
      freezeContainer.current.inert = value;
    }
    liveEditor.current?.setEditable(!value && protectionReadyRef.current);
    setFrozen(value);
  };
  useEffect(
    () =>
      client.onCloseAborted?.(() => {
        freeze(false);
        setClosing(false);
      }),
    [client, editor, protectionReady],
  );
  useEffect(() => {
    onRevision(save.state.workingRevision);
  }, [save.state.workingRevision, onRevision]);
  useEffect(() => {
    const warning = (event: BeforeUnloadEvent) => {
      if (
        save.status !== "saved" ||
        save.planningAdapter?.dirty() ||
        save.reviewDirty?.()
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warning);
    const remove = client.onCloseRequested?.(async () => {
      beforeClose.current();
      freeze(true);
      const ok = await save.controlledClose();
      if (ok) return true;
      freeze(false);
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
    const closeAfter = closing;
    freeze(true);
    if (!window.confirm(t.workspaceDiscardConfirm)) {
      freeze(false);
      return;
    }
    if (await save.reload()) {
      applyCanonical();
      setRecovery(false);
      setClosing(false);
      if (closeAfter) {
        closeDecision.current?.(true);
        closeDecision.current = null;
      } else freeze(false);
    } else freeze(false);
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
    if (save.composing && editor) {
      deferredToolbar.current.push({
        action,
        bookmark: editor.state.selection.getBookmark(),
      });
      return;
    }
    void save.discrete(() => {
      const active = document.activeElement;
      const mayFocus =
        active === document.body ||
        active === editor?.view.dom ||
        !!active?.closest(".editor-toolbar,.history-toolbar");
      action();
      // A later queued command must never take focus from another input.
      if (mayFocus && document.activeElement === active) editor?.view.focus();
    });
  };
  resumeToolbar.current = () => {
    if (!editor || editor.isDestroyed || save.composing) return;
    while (deferredToolbar.current.length) {
      const intent = deferredToolbar.current.shift()!;
      void save.discrete(() => {
        // Apply to the mapped original range without taking focus from a new input.
        let restore = editor.state.selection.getBookmark();
        const map = ({
          transaction,
        }: {
          transaction: import("@tiptap/pm/state").Transaction;
        }) => {
          restore = restore.map(transaction.mapping);
        };
        editor.view.dispatch(
          editor.state.tr.setSelection(
            intent.bookmark.resolve(editor.state.doc),
          ),
        );
        editor.on("transaction", map);
        try {
          intent.action();
        } finally {
          editor.off("transaction", map);
          editor.view.dispatch(
            editor.state.tr.setSelection(restore.resolve(editor.state.doc)),
          );
        }
      });
    }
  };
  return (
    <section className="manuscript-workspace">
      {frozen && <p role="status">{t.closingProject}</p>}
      <fieldset
        ref={freezeContainer}
        disabled={frozen}
        inert={frozen}
        className="manuscript-freeze"
      >
        <div className="manuscript-header">
          <h3>{t.manuscript}</h3>
          <SaveStatus
            save={save}
            planning={planningFeedback}
            openPlanning={() => pane.open("planning")}
            t={t}
            recover={() => setRecovery(true)}
          />
          {save.state.workspaceStage === "draft" && (
            <span className="approval-status" data-testid="approval-status">
              {approvedBaseline !== null ? t.finalized : t.notApproved}
            </span>
          )}
          <div ref={setLockHeader} className="lock-header-target" />
        </div>
        {save.state.workspaceStage === "draft" && (
          <details className="export-menu">
            <summary>{t.exportTitle}</summary>
            <Exports client={client} save={save} t={t} />
          </details>
        )}
        <div
          className="history-toolbar"
          role="toolbar"
          aria-label={t.history}
          inert={pane.narrow && !pane.collapsed}
        >
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
        <WorkspacePane
          pane={pane}
          t={t}
          panels={{
            structure: (
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
            ),
            planning: (
              <>
                <Planning
                  onStatus={setPlanningFeedback}
                  client={client}
                  save={save}
                  projectId={projectId}
                  t={t}
                />
                {save.state.workspaceStage === "draft" && (
                  <GeneratedDraftEvidence
                    client={client}
                    blockIds={save.state.blocks.map((b) => b.id)}
                    t={t}
                  />
                )}
              </>
            ),
            review:
              save.state.workspaceStage === "draft" ? (
                <Review
                  client={client}
                  save={save}
                  editor={editor}
                  projectId={projectId}
                  t={t}
                  onOpen={() => pane.open("review")}
                  visible={!pane.collapsed && pane.tab === "review"}
                />
              ) : (
                <p className="muted">{t.workspaceReviewEmpty}</p>
              ),
            sources: (
              <Sources
                client={client}
                save={save}
                projectId={projectId}
                t={t}
              />
            ),
          }}
        >
          <DocumentToolbar editor={editor} t={t} toolbar={toolbar} />
          <div className="document-layout">
            <EditorContent editor={editor} />
            {save.state.workspaceStage === "draft" && (
              <Locks
                client={client}
                save={save}
                editor={editor}
                projectId={projectId}
                t={t}
                headerTarget={lockHeader}
                onReady={setProtectionReady}
              />
            )}
          </div>
        </WorkspacePane>
        {save.operationError && (
          <p role="status">
            {save.operationError.code === "UNSENT_REVIEW"
              ? t.reviewUnsent
              : t.historyBlocked}{" "}
            <code>
              {save.operationError.details?.reason ?? save.operationError.code}
            </code>
          </p>
        )}
      </fieldset>
      {recovery && (
        <div className="recovery" role="dialog" aria-label={t.recover}>
          <p>{t.recoveryHelp}</p>
          {save.error === "COMMAND_UNRESOLVED" && (
            <p role="status">{t.workspaceDiscardBlocked}</p>
          )}
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
          <button disabled={frozen} onClick={() => void reload()}>
            {t.discardAndReload}
          </button>
          <button
            disabled={frozen}
            onClick={() => {
              freeze(false);
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
                disabled={frozen}
                onClick={() =>
                  void (async () => {
                    freeze(true);
                    const ok = await save.controlledClose(true);
                    if (ok) {
                      setClosing(false);
                      closeDecision.current?.(true);
                      closeDecision.current = null;
                    } else freeze(false);
                  })()
                }
              >
                {t.retryClose}
              </button>
              <button
                disabled={frozen}
                onClick={() => {
                  freeze(true);
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
