import { LegacyEditor } from "../manuscript/LegacyEditor";
import { SourceEditor } from "../manuscript/SourceEditor";
import { SourceChanges } from "../manuscript/SourceChanges";
import { legacySurface, type ManuscriptSurface } from "../manuscript/surface";
import type { Editor } from "@tiptap/core";
import { ApiError } from "@scenesparrow/platform-client";
import type { AuthoredSourceSnapshot } from "@scenesparrow/contracts";
import { useEffect, useRef, useState, useMemo } from "react";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type { HistoryState, ManuscriptState } from "@scenesparrow/contracts";
import type en from "../locales/en.json";
import { useNoticeOwner } from "../feedback/NotificationPresenter";
import { Review } from "../review/Review";
import { OutlineEditor } from "../planning/OutlineEditor";
import { usePlanningSession } from "../planning/use-planning-session";
import type { WritingView } from "./types";
import {
  GenerationHistory,
  GenerationHistoryButton,
} from "../planning/GenerationHistory";
import { PlanningDialogs } from "../planning/PlanningDialogs";
import { WritingDialog } from "../ui/WritingDialog";
import { outlineSource } from "../planning/outline-codec";
import { WorkspacePane, useAuxiliaryPane } from "./WorkspacePane";
import { SaveStatus } from "./SaveStatus";
import { WorkspaceSkeleton } from "./WorkspaceSkeleton";
import { serializeMarkdown } from "../manuscript/markdown";
import { WorkspaceIcon } from "../ui/WorkspaceIcon";
import { Locks } from "../review/Locks";
import { contentProtectionKey } from "../manuscript/content-protection";
import { Planning } from "../planning/Planning";
import type { SaveFeedback } from "../project-session/types";
import { Exports } from "../delivery/Exports";
import { Sources } from "../library/Sources";
import { ImportDialog } from "../manuscript/ImportDialog";
import type { PlanningEvidenceBridge } from "../library/evidence";
import { ProjectSession } from "../project-session/project-session";
import { canonicalTransaction } from "../manuscript/canonical-transaction";
import { fromEditorNode, toEditor } from "../manuscript/canonical";
export function Workbench({
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
    source: AuthoredSourceSnapshot | null;
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
      let source: AuthoredSourceSnapshot | null = null;
      if (client.readAuthoredSource) {
        try {
          source = await client.readAuthoredSource();
        } catch (error) {
          if (!(
            error instanceof ApiError &&
            error.code === "SOURCE_CAPABILITY_UNSUPPORTED"
          ))
            throw error;
        }
      }
      return { document, history, source };
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
    <WorkbenchContent
      key={projectId}
      initial={initial.document}
      history={initial.history}
      initialSource={initial.source}
      client={client}
      projectId={projectId}
      t={t}
      onRevision={onRevision}
      onBeforeClose={onBeforeClose}
      approvedBaseline={approvedBaseline}
    />
  );
}
function WorkbenchContent({
  initial,
  initialSource,
  history,
  client,
  projectId,
  t,
  onRevision,
  onBeforeClose,
  approvedBaseline,
}: {
  initial: ManuscriptState;
  initialSource: AuthoredSourceSnapshot | null;
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
  const [planningFeedback, setPlanningFeedback] = useState<SaveFeedback | null>(
    null,
  );
  const protectionReadyRef = useRef(false);
  protectionReadyRef.current = protectionReady;
  const [lockHeader, setLockHeader] = useState<HTMLDivElement | null>(null);
  const [save] = useState(() => {
    const session = new ProjectSession(
      initial,
      projectId,
      client,
      () => render((n) => n + 1),
      history,
    );
    if (initialSource) session.initializeSource(initialSource);
    return session;
  });
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
  const documentMenu = useRef<HTMLDetailsElement>(null);
  const sourceDialog = useRef<HTMLDialogElement>(null);
  const sourceVisible = useRef(false);
  const [source, setSource] = useState("");
  const [sourceRecovery, setSourceRecovery] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const liveEditor = useRef<Editor | null>(null);
  liveEditor.current = editor;
  const [sourceSurface, setSourceSurface] = useState<ManuscriptSurface | null>(
    null,
  );
  const surface = useMemo(
    () => sourceSurface ?? (editor ? legacySurface(editor, save) : null),
    [editor, sourceSurface],
  );

  useEffect(() => {
    if (editor && save.state.workspaceStage === "outline") {
      // Empty Outline projects have no locks; WorkbenchContent still loads its lock projection.
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
        save.reviewDirty?.() ||
        save.sourceProposalDirty?.()
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
    if (save.source) {
      setSource(save.sourceLocal);
      sourceVisible.current = true;
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
    <section
      className={`manuscript-workspace${initialSource ? " source-authoring" : ""}`}
    >
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
              editor={surface}
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
                      onClick={() => surface?.scrollBlock(b.id)}
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
              {save.source && (
                <SourceChanges
                  save={save}
                  client={client}
                  t={t}
                  frozen={frozen}
                />
              )}
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
            {initialSource ? (
              <SourceEditor
                save={save}
                t={t}
                editable={
                  protectionReady &&
                  !frozen &&
                  !session.planning?.state.reserved
                }
                onSurface={setSourceSurface}
              />
            ) : (
              <LegacyEditor
                initial={initial}
                save={save}
                label={t.manuscript}
                protectionReady={protectionReady}
                sourceVisible={sourceVisible}
                onEditor={setEditor}
              />
            )}
            {save.state.workspaceStage === "draft" && (
              <Locks
                client={client}
                save={save}
                editor={surface}
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
              (save.source ? save.sourceLocal : null) ??
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
