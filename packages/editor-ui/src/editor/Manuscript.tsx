import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type UseEditorOptions } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Code from "@tiptap/extension-code";
import { CanonicalIdentity } from "./identity";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { Slice } from "@tiptap/pm/model";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type { HistoryState, ManuscriptState } from "@scenesparrow/contracts";
import type en from "../locales/en.json";
import { useNoticeOwner } from "../NotificationPresenter";
import { Review } from "./Review";
import { OutlineEditor } from "./OutlineEditor";
import { usePlanningSession, type WritingView } from "./use-planning-session";
import {
  GenerationHistory,
  GenerationHistoryButton,
} from "./GenerationHistory";
import { PlanningDialogs, WritingDialog } from "./PlanningDialogs";
import { outlineSource } from "./outline-codec";
import { WorkspacePane, useAuxiliaryPane } from "./WorkspacePane";
import { SaveStatus } from "./SaveStatus";
import { WorkspaceSkeleton } from "./WorkspaceSkeleton";
import { parseMarkdown, serializeMarkdown } from "./markdown";
import { MarkdownLink } from "./markdown-link";
import { WorkspaceIcon } from "../WorkspaceIcon";
import { Locks } from "./Locks";
import { ContentProtection, contentProtectionKey } from "./content-protection";
import { ReviewDecorations } from "./review-decorations";
import { Planning, type PlanningFeedback } from "./Planning";
import { Exports } from "./Exports";
import { Sources } from "./Sources";
import { ImportDialog } from "./ImportDialog";
import type { PlanningEvidenceBridge } from "./evidence";
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
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const { report, resolve } = useNoticeOwner();
  useEffect(() => {
    let active = true;
    setLoading(true);
    resolve("manuscript-load");
    const load = async () => {
      const document = await client.readManuscript();
      const history = await client.readHistory();
      if (document.workingRevision !== history.workingRevision)
        throw Error("REVISION_CONFLICT");
      return { document, history };
    };
    void load()
      .then(
        (state) => {
          if (active) setInitial(state);
        },
        (failure: unknown) => {
          if (active)
            report(failure, {
              identity: "manuscript-load",
              actions: [
                { kind: "retry", run: () => setAttempt((value) => value + 1) },
              ],
            });
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, projectId, attempt, report, resolve]);
  if (!initial)
    return (
      <WorkspaceSkeleton
        t={t}
        busy={loading}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    );
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
  const [recovery, setRecoveryVisible] = useState(false);
  const recoveryEpoch = useRef(0),
    recoveryMounted = useRef(true);
  const setRecovery = (visible: boolean) => {
    recoveryEpoch.current++;
    setRecoveryVisible(visible);
  };
  const [protectionReady, setProtectionReady] = useState(
    initial.workspaceStage === "outline",
  );
  const pane = useAuxiliaryPane();
  const [evidence, setEvidence] = useState<PlanningEvidenceBridge | null>(null);
  const [importOpen, setImportOpen] = useState(false);
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
  const [view, setView] = useState<WritingView>(() => {
    try {
      return localStorage.getItem(`scenesparrow.writing-view:${projectId}`) ===
        "outline"
        ? "outline"
        : "manuscript";
    } catch {
      return "manuscript";
    }
  });
  const selectView = (next: WritingView) => {
    setView(next);
    try {
      localStorage.setItem(`scenesparrow.writing-view:${projectId}`, next);
    } catch {
      /* Optional UI metadata. */
    }
  };
  const session = usePlanningSession(
    client,
    save,
    projectId,
    selectView,
    () => pane.open("planning"),
    (next) => {
      void switchView(next);
    },
  );
  useEffect(() => {
    save.actions.cancel();
  }, [
    save,
    view,
    pane.left.tab,
    pane.right.tab,
    pane.left.collapsed,
    pane.right.collapsed,
    pane.drawer,
  ]);
  const pendingView = useRef<WritingView | null>(null);
  const switchView = async (next: WritingView) => {
    save.actions.cancel();
    pendingView.current = next;
    if (save.composing || session.planning?.composing) return;
    await save.prepareInput();
    if (pendingView.current !== next || save.composing) return;
    pendingView.current = null;
    selectView(next);
  };
  useEffect(() => {
    if (!save.composing && !session.planning?.composing && pendingView.current)
      void switchView(pendingView.current);
  }, [save.composing, session.planning?.composing]);
  const openReviewForNotice = useRef(() => pane.open("review"));
  openReviewForNotice.current = () => {
    void switchView("manuscript");
    if (save.revealReviewDraft) save.revealReviewDraft();
    else pane.open("review");
  };
  const { report: reportOperation, resolve: resolveOperation } =
    useNoticeOwner();
  useEffect(() => {
    if (save.operationError)
      reportOperation(save.operationError.code, {
        identity: "operation",
        actions:
          save.operationError.code === "UNSENT_REVIEW"
            ? [
                {
                  kind: "reviewChanges",
                  run: () => openReviewForNotice.current(),
                },
              ]
            : [],
      });
    else resolveOperation("operation");
  }, [save.operationError, reportOperation, resolveOperation]);
  const forwardingKey = useRef(false);
  const liveEditor = useRef<Editor | null>(null);
  const documentMenu = useRef<HTMLDetailsElement>(null);
  const sourceDialog = useRef<HTMLDialogElement>(null);
  const sourceVisible = useRef(false);
  const [source, setSource] = useState("");
  const [sourceRecovery, setSourceRecovery] = useState(false);
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
            "aria-label": t.manuscript,
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
      [save, t.manuscript, protectionReady],
    ),
  );
  liveEditor.current = editor;

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
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && !event.altKey && key === "s") {
        event.preventDefault();
        event.stopPropagation();
        if (!document.querySelector("dialog[open],[aria-modal=true]"))
          void save.manualSave();
        return;
      }
      if (event.isComposing || save.composing || event.keyCode === 229) return;
      if (
        target?.closest("dialog,[role=dialog],[aria-modal=true]") ||
        inEditor ||
        target?.closest("input,textarea,select,[contenteditable=true]")
      )
        return;
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
  useEffect(() => {
    editor?.setEditable(
      protectionReady && !frozen && !session.planning?.state.reserved,
      false,
    );
  }, [editor, protectionReady, frozen, session.planning?.state.reserved]);
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
        recoveryEpoch.current++;
        freeze(false);
        setClosing(false);
      }),
    [client, editor, protectionReady],
  );
  useEffect(() => {
    onRevision(save.state.workingRevision);
  }, [save.state.workingRevision, onRevision]);
  useEffect(() => {
    recoveryMounted.current = true;
    const blur = () => {
      void save.windowChanged();
    };
    const visibility = () => {
      if (document.hidden) blur();
    };
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
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
      recoveryEpoch.current++;
      sourceDialog.current?.close();
      sourceVisible.current = false;
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
      recoveryMounted.current = false;
      recoveryEpoch.current++;
      closeDecision.current?.(false);
      closeDecision.current = null;
      save.dispose();
      remove?.();
      window.removeEventListener("beforeunload", warning);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
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
          : label === "renameSource"
            ? t.historyRenameSource
            : label === "refreshSource"
              ? t.historyRefreshSource
              : label === "removeSource"
                ? t.historyRemoveSource
                : label === "import"
                  ? t.historyImport
                  : t.historyEdit;
  const headings = save.local.filter((b) => b.kind === "heading");
  const outlineHeadings = session.planning?.local.nodes ?? [];
  const assistantPlanning = (
    <Planning
      session={session}
      save={save}
      t={t}
      view={view}
      onStatus={setPlanningFeedback}
      onEvidence={setEvidence}
      openLibrary={() => pane.open("sources")}
    />
  );
  const openSource = () => {
    // Read the visible local editor, including pending/IME input. Viewing source
    // does not call a core command, flush, or replace the mounted editor.
    let current: string;
    setSourceRecovery(false);
    if (view === "outline" && session.planning) {
      setSource(
        session.planning.recoveryText ??
          outlineSource(session.planning.local.nodes),
      );
      sourceVisible.current = true;
      if (documentMenu.current) documentMenu.current.open = false;
      sourceDialog.current?.showModal();
      return;
    }
    try {
      current = serializeMarkdown(
        editor
          ? fromEditorNode(
              editor.state.doc,
              new Set(save.local.map((b) => b.id)),
            )
          : save.local,
      );
    } catch {
      setSourceRecovery(true);
      current =
        editor?.getText({ blockSeparator: "\n\n" }) ?? save.recoveryText ?? "";
    }
    setSource(current);
    sourceVisible.current = true;
    if (documentMenu.current) documentMenu.current.open = false;
    sourceDialog.current?.showModal();
  };
  const closeSource = () => {
    sourceVisible.current = false;
    sourceDialog.current?.close();
    requestAnimationFrame(() =>
      documentMenu.current?.querySelector("summary")?.focus(),
    );
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
        <WorkspacePane
          pane={pane}
          t={t}
          rightContent={
            <Review
              client={client}
              save={save}
              editor={editor}
              projectId={projectId}
              t={t}
              onOpen={(panel = "comments") =>
                pane.open(panel === "assistant" ? "planning" : "review")
              }
              visible={
                pane.visible("right") &&
                pane.right.tab === "review" &&
                view === "manuscript"
              }
              centralView={view}
              bodyInteractive={
                view === "manuscript" && (!pane.narrow || pane.drawer === null)
              }
              tab={pane.right.tab === "review" ? "comments" : "assistant"}
              assistant={assistantPlanning}
              historyOpen={session.historyOpen}
              history={
                <GenerationHistory session={session} save={save} t={t} />
              }
              historyButton={
                <GenerationHistoryButton session={session} t={t} />
              }
              openLibrary={() => pane.open("sources")}
              evidence={evidence}
            />
          }
          panels={{
            structure: (
              <nav aria-label={t.headings}>
                {view === "outline" ? (
                  outlineHeadings.length ? (
                    outlineHeadings.map((node) => (
                      <button
                        key={node.id}
                        style={{
                          paddingInlineStart: `${(node.depth + 1) * 8}px`,
                        }}
                        onClick={() =>
                          document
                            .querySelector(
                              `.outline-editor [data-outlineid="${node.id}"]`,
                            )
                            ?.scrollIntoView({
                              block: "center",
                              behavior: "smooth",
                            })
                        }
                      >
                        {node.title || t.heading}
                      </button>
                    ))
                  ) : (
                    <p className="muted">{t.noHeadings}</p>
                  )
                ) : headings.length ? (
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
            planning: null,
            review: null,
            sources: (
              <Sources
                evidence={evidence}
                client={client}
                save={save}
                projectId={projectId}
                t={t}
              />
            ),
          }}
        >
          <div className="manuscript-header">
            <div
              className="writing-view-switch"
              role="group"
              aria-label={t.writingView}
            >
              {(["manuscript", "outline"] as const).map((next) => (
                <button
                  key={next}
                  aria-pressed={view === next}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void switchView(next)}
                >
                  {next === "outline" ? t.writingOutline : t.manuscript}
                </button>
              ))}
            </div>
            <div className="manuscript-context">
              <h3
                data-testid="manuscript-title"
                title={
                  (view === "outline"
                    ? outlineHeadings[0]?.title
                    : headings[0]?.runs.map((run) => run.text).join("")) ||
                  (view === "outline" ? t.writingOutline : t.manuscript)
                }
              >
                {(view === "outline"
                  ? outlineHeadings[0]?.title
                  : headings[0]?.runs.map((run) => run.text).join("")) ||
                  (view === "outline" ? t.writingOutline : t.manuscript)}
              </h3>
              <SaveStatus
                save={save}
                planning={planningFeedback}
                openPlanning={() => session.setRecovery(true)}
                t={t}
                recover={() => setRecovery(true)}
              />
              {view === "manuscript" &&
                save.state.workspaceStage === "draft" && (
                  <span
                    className="approval-status"
                    data-testid="approval-status"
                  >
                    {approvedBaseline !== null ? t.finalized : t.notApproved}
                  </span>
                )}
            </div>
            <div
              ref={setLockHeader}
              className="lock-header-target"
              hidden={view !== "manuscript"}
              inert={view !== "manuscript"}
            />
            <details className="document-menu" ref={documentMenu}>
              <summary
                aria-label={t.documentMenu}
                title={t.documentMenu}
                onMouseDown={(event) => event.preventDefault()}
              >
                <WorkspaceIcon name="menu" />
              </summary>
              <div className="document-menu-content">
                <button
                  onClick={() => {
                    if (documentMenu.current) documentMenu.current.open = false;
                    setImportOpen(true);
                  }}
                >
                  {t.importManuscript}
                </button>
                <button
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={openSource}
                >
                  {t.viewMarkdownSource}
                </button>
                {(["UndoProject", "RedoProject"] as const).map((type) => {
                  const undo = type === "UndoProject";
                  const label = undo ? t.undo : t.redo;
                  const operation = undo
                    ? save.history.undoLabel
                    : save.history.redoLabel;
                  return (
                    <button
                      key={type}
                      aria-label={label}
                      title={
                        operation
                          ? `${label}: ${operationLabel(operation)}`
                          : label
                      }
                      disabled={
                        save.busy ||
                        (undo ? !save.canUndo : !save.canRedo) ||
                        ["error", "conflict"].includes(save.status)
                      }
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        if (documentMenu.current)
                          documentMenu.current.open = false;
                        void historyAction(type);
                      }}
                    >
                      <span>{label}</span>
                      <kbd>{undo ? "Ctrl/⌘ Z" : "Ctrl/⌘ ⇧ Z"}</kbd>
                    </button>
                  );
                })}
                {save.state.workspaceStage === "draft" && (
                  <details className="export-menu">
                    <summary>{t.exportTitle}</summary>
                    <Exports client={client} save={save} t={t} />
                  </details>
                )}
              </div>
            </details>
          </div>
          <div hidden={view !== "outline"} inert={view !== "outline"}>
            {session.planning ? (
              <OutlineEditor
                planning={session.planning}
                t={t}
                history={historyAction}
                frozen={frozen}
              />
            ) : (
              <p role="status">{t.planningLoading}</p>
            )}
          </div>
          <div
            className="document-layout"
            hidden={view !== "manuscript"}
            inert={view !== "manuscript"}
          >
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
        {importOpen && (
          <ImportDialog
            client={client}
            save={save}
            projectId={projectId}
            t={t}
            close={() => setImportOpen(false)}
          />
        )}
      </fieldset>
      <PlanningDialogs session={session} t={t} />
      <dialog
        ref={sourceDialog}
        className="markdown-source-dialog"
        aria-labelledby="markdown-source-title"
        onCancel={(event) => {
          event.preventDefault();
          closeSource();
        }}
      >
        <div className="dialog-heading">
          <h2 id="markdown-source-title">{t.markdownSourceTitle}</h2>
          <button
            className="quiet-button"
            aria-label={t.closeMarkdownSource}
            onClick={closeSource}
          >
            <WorkspaceIcon name="close" />
          </button>
        </div>
        <p className="muted">
          {sourceRecovery ? t.markdownSourceRecovery : t.markdownSourceHelp}
        </p>
        <textarea
          aria-label={t.markdownSourceTitle}
          readOnly
          value={source}
          spellCheck={false}
        />
      </dialog>
      {recovery && (
        <WritingDialog
          title={t.recover}
          closeDisabled={frozen}
          closeLabel={t.close}
          close={() => {
            freeze(false);
            setRecovery(false);
            setClosing(false);
            closeDecision.current?.(false);
            closeDecision.current = null;
          }}
        >
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
          {!closing && (
            <button
              disabled={frozen}
              onClick={async () => {
                const epoch = recoveryEpoch.current,
                  decision = closeDecision.current;
                const current = () =>
                  recoveryMounted.current &&
                  recoveryEpoch.current === epoch &&
                  closeDecision.current === decision;
                const saved = await save.flush(true);
                if (!current() || !saved) return;
                if (save.planningAdapter) {
                  const planningSaved = await save.planningAdapter.flush(true);
                  if (!current() || !planningSaved) return;
                }
                // An older receipt cannot dismiss a newer recovery or native close decision.
                if (current()) setRecovery(false);
              }}
            >
              {t.retry}
            </button>
          )}
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
        </WritingDialog>
      )}
    </section>
  );
}
