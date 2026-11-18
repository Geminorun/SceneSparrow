import { createPortal } from "react-dom";
import { useNoticeOwner, useOpenSettings } from "../NotificationPresenter";
import { notifyFailure } from "../notifications";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Editor } from "@tiptap/core";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type {
  ManuscriptCommand,
  ReviewCard,
  ReviewThread,
  PlanningEvidenceChoice,
} from "@scenesparrow/contracts";
import type en from "../locales/en.json";
import type { Autosave } from "./autosave";
import {
  bindReviewSelection,
  canonicalPositions,
  captureReviewSelection,
  captureWholeManuscript,
} from "./review-selection";
import { useReviewLayout } from "./review-layout";
import { ReviewCommands } from "./review-commands";
import { ReviewEvidence } from "./ReviewEvidence";
import { ReviewConversation } from "./ReviewConversation";
import type { PlanningEvidenceBridge } from "./evidence";
import { useSavedAiView } from "../ai-settings/saved-view";
import type { WritingView } from "./use-planning-session";
import { reviewDecorationKey } from "./review-decorations";
export function Review({
  client,
  save,
  editor,
  projectId,
  t,
  onOpen,
  visible: panelVisible,
  centralView,
  bodyInteractive,
  tab,
  assistant,
  historyOpen,
  history,
  historyButton,
  openLibrary,
  evidence: planningEvidence,
}: {
  client: PlatformClient;
  save: Autosave;
  editor: Editor | null;
  projectId: string;
  t: typeof en;
  onOpen: (panel?: "assistant" | "comments") => void;
  visible: boolean;
  centralView: WritingView;
  bodyInteractive: boolean;
  tab: "assistant" | "comments";
  assistant: ReactNode;
  historyOpen: boolean;
  history: ReactNode;
  historyButton: ReactNode;
  openLibrary: () => void;
  evidence: PlanningEvidenceBridge | null;
}) {
  const assistantMode =
    tab === "assistant" && centralView === "manuscript" && !!save.local.length;
  const commentsMode =
    tab === "comments" &&
    centralView === "manuscript" &&
    save.state.workspaceStage === "draft";
  const explicitWhole = useRef(false);
  const autoCaptureIdentity = useRef("");
  const [scope, setScope] = useState<"selection" | "whole">("whole");
  const { report, resolve } = useNoticeOwner();
  const openSettings = useOpenSettings();
  const cachedAi = useSavedAiView();
  const model = cachedAi?.settings.bindings.find(
    (binding) => binding.category === "text",
  );
  const [cards, setCards] = useState<ReviewCard[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [text, setText] = useState(""),
    [kind, setKind] = useState<ReviewThread["kind"]>("question"),
    [capture, setCapture] = useState<ReturnType<
      typeof captureReviewSelection
    > | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [showAll, setShowAll] = useState(false),
    [editing, setEditing] = useState<ReviewThread | null>(null),
    [evidence, setEvidence] = useState<PlanningEvidenceChoice[]>([]),
    [selectedMessages, setSelectedMessages] = useState<
      Record<string, string[]>
    >({}),
    [fill, setFill] = useState(false),
    [reanchored, setReanchored] = useState(false),
    [selectionToolbar, setSelectionToolbar] = useState<{
      top: number;
      left: number;
    } | null>(null);
  const noticeOpen = useRef(onOpen);
  noticeOpen.current = onOpen;
  useEffect(() => {
    if (error)
      report(error, {
        identity: "review-action",
        passive: true,
        actions: [{ kind: "reviewChanges", run: () => noticeOpen.current() }],
      });
    else resolve("review-action");
  }, [error, report, resolve]);
  const [loaded, setLoaded] = useState(false);
  const floating = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!selectionToolbar || !floating.current) return;
    const width = floating.current.getBoundingClientRect().width,
      left = Math.max(
        4,
        Math.min(selectionToolbar.left, window.innerWidth - width - 4),
      );
    if (left !== selectionToolbar.left)
      setSelectionToolbar((prior) => (prior ? { ...prior, left } : prior));
  }, [selectionToolbar, t.reviewQuestion, t.reviewNote]);
  const [commands] = useState(() => new ReviewCommands(save));
  const submitFlight = useRef<{
    intent: number;
    promise: Promise<unknown>;
  } | null>(null);
  const generation = useRef(0),
    input = useRef(text),
    disposed = useRef(false),
    composing = useRef(false),
    composerIntent = useRef(0);
  const latestSubmit = useRef<(sendToAi: boolean) => Promise<unknown>>(() =>
    Promise.resolve(false),
  );
  const retryAction = useRef<() => unknown>(() => refresh());
  useEffect(() => {
    composerIntent.current++;
    save.actions.cancel("review-submit");
    save.actions.cancel("review-retry");
    save.actions.cancel("review-begin");
    save.actions.cancel("review-fill");
  }, [save, centralView, panelVisible, tab, scope, kind, editing?.id, capture]);
  useEffect(
    () => () => {
      save.actions.cancel("review-submit");
      save.actions.cancel("review-retry");
      save.composition(false, "review");
    },
    [save],
  );
  input.current = text;
  const draftPanel = useRef<"assistant" | "comments">("comments");
  const openDraftPanel = useRef(onOpen);
  openDraftPanel.current = onOpen;
  if (text.trim() && (assistantMode || (commentsMode && capture)))
    draftPanel.current = assistantMode ? "assistant" : "comments";
  useEffect(() => {
    const dirty = () => !!input.current.trim() || composing.current;
    const reveal = () => openDraftPanel.current(draftPanel.current);
    save.reviewDirty = dirty;
    save.revealReviewDraft = reveal;
    return () => {
      if (save.reviewDirty === dirty) save.reviewDirty = undefined;
      if (save.revealReviewDraft === reveal) save.revealReviewDraft = undefined;
    };
  }, [save]);
  useEffect(() => {
    save.reviewInputChanged();
  }, [save, text]);
  const refresh = useCallback(async () => {
    const n = ++generation.current;
    try {
      const page = await client.readReviews();
      if (!disposed.current && n === generation.current) {
        setCards(page.cards);
        setLoaded(true);
        setError((error) => (error === "REVIEW_UNAVAILABLE" ? "" : error));
        setCursor(page.nextCursor);
      }
    } catch {
      if (!disposed.current && n === generation.current) {
        retryAction.current = () => refresh();
        setError("REVIEW_UNAVAILABLE");
      }
    }
  }, [client]);
  useEffect(() => {
    disposed.current = false;
    void refresh();
    const stop = client.subscribeEvents(
      (e) => {
        if (
          [
            "review.changed",
            "reviewTask.changed",
            "candidate.changed",
            "manuscript.changed",
            "history.changed",
          ].includes(e.type)
        )
          void refresh();
      },
      () => void refresh(),
    );
    return () => {
      disposed.current = true;
      generation.current++;
      stop();
    };
  }, [client, refresh]);
  useEffect(() => {
    if (!cards.some((card) => card.task?.application === "pending")) return;
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [cards, refresh]);
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      if (save.composing || save.status !== "saved") return;
      try {
        const positions = canonicalPositions(editor),
          ranges = [] as Array<{ from: number; to: number; id: string }>;
        for (const card of cards) {
          if (card.thread.anchor.state === "mapped" && !card.thread.handled) {
            for (const range of card.thread.anchor.ranges) {
              const saved = save.state.blocks.find(
                  (b) => b.id === range.blockId,
                ),
                visible = positions.find((p) => p.block.id === range.blockId);
              if (
                !saved ||
                !visible ||
                saved.revision !== range.revision ||
                saved.runs.map((r) => r.text).join("") !==
                  visible.block.runs.map((r) => r.text).join("")
              )
                return;
            }
          }
        }
        for (const card of cards) {
          if (
            card.thread.handled ||
            card.thread.deleted ||
            card.thread.anchor.state !== "mapped"
          )
            continue;
          for (const r of card.thread.anchor.ranges) {
            const p = positions.find((p) => p.block.id === r.blockId);
            if (p)
              ranges.push({
                from: p.pos + r.start,
                to: p.pos + r.end,
                id: card.thread.id,
              });
          }
        }
        editor.view.dispatch(
          editor.state.tr.setMeta(reviewDecorationKey, ranges),
        );
      } catch {
        /* An unsaved invalid buffer retains its own recovery path. */
      }
    };
    let active = true;
    update();
    queueMicrotask(() => {
      if (active) update();
    });
    return () => {
      active = false;
    };
  }, [editor, cards, save.canonicalVersion]);
  useEffect(() => {
    if (!editor) return;
    const changed = () => {
      if (
        centralView !== "manuscript" ||
        !bodyInteractive ||
        save.composing ||
        editor.state.selection.empty
      ) {
        setSelectionToolbar(null);
        return;
      }
      try {
        if (!explicitWhole.current) {
          const selected = captureReviewSelection(editor),
            identity = JSON.stringify(selected);
          if (autoCaptureIdentity.current !== identity) {
            autoCaptureIdentity.current = identity;
            composerIntent.current++;
            setScope("selection");
            setCapture(selected);
          }
        }
        const start = editor.view.coordsAtPos(editor.state.selection.from),
          end = editor.view.coordsAtPos(editor.state.selection.to);
        if (
          Math.max(start.bottom, end.bottom) < 0 ||
          Math.min(start.top, end.top) > window.innerHeight
        ) {
          setSelectionToolbar(null);
          return;
        }
        setSelectionToolbar({
          top: Math.max(4, Math.min(start.top, end.top) - 40),
          left: Math.max(4, Math.min(window.innerWidth - 240, start.left)),
        });
      } catch {
        setSelectionToolbar(null);
      }
    };
    changed();
    editor.on("selectionUpdate", changed);
    window.addEventListener("resize", changed);
    window.addEventListener("scroll", changed, true);
    return () => {
      editor.off("selectionUpdate", changed);
      window.removeEventListener("resize", changed);
      window.removeEventListener("scroll", changed, true);
    };
  }, [editor, save, centralView, bodyInteractive]);
  const action = async (
    identity: string,
    build: (revision: number) => ManuscriptCommand,
    options?: { validIntent?: () => boolean; requestedVisible?: string },
  ) => {
    setError("");
    retryAction.current = () => action(identity, build, options);
    try {
      const result = await commands.run(identity, build, {
        ...options,
        dispatched: () => setBusy(true),
      });
      if (!result.ok && result.error !== "CANCELLED") {
        setError(result.error || "REVIEW_VERSION_CONFLICT");
      }
      await refresh();
      return result.ok;
    } catch (e) {
      notifyFailure(e);
      setError(e instanceof Error ? e.message : "INVALID_REQUEST");
      return false;
    } finally {
      if (!disposed.current) setBusy(false);
    }
  };
  const command = (type: string, payload: unknown, revision: number) =>
    ({
      type,
      requestId: crypto.randomUUID(),
      projectId,
      expectedWorkingRevision: revision,
      payload,
    }) as ManuscriptCommand;
  const previousTasks = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    if (!loaded) {
      previousTasks.current = null;
      return;
    }
    const old = previousTasks.current;
    previousTasks.current = new Map(
      cards.flatMap((card) =>
        card.task
          ? [
              [
                card.task.run.runId,
                `${card.task.run.status}:${card.task.error ?? card.task.run.error}`,
              ],
            ]
          : [],
      ),
    );
    if (!old) return;
    for (const card of cards) {
      const task = card.task,
        error = task?.error ?? task?.run.error;
      if (
        !task ||
        !error ||
        ["CANCELLED", "NO_CHANGE"].includes(error) ||
        (!task.error &&
          !["failed", "interrupted", "stale"].includes(task.run.status)) ||
        old.get(task.run.runId) === previousTasks.current.get(task.run.runId)
      )
        continue;
      report(error, {
        identity: `review-task:${task.run.runId}`,
        actions: [
          { kind: "reviewChanges", run: onOpen },
          {
            kind: "retry",
            run: () =>
              action(
                `StartReviewTask:${card.thread.id}:${card.thread.requestVersion}`,
                (revision) =>
                  command(
                    "StartReviewTask",
                    {
                      threadId: card.thread.id,
                      requestVersion: card.thread.requestVersion,
                      retryOfRunId: task.run.runId,
                      messageIds: [],
                    },
                    revision,
                  ),
              ),
          },
        ],
      });
    }
  }, [cards, loaded, report, onOpen]);
  const begin = (whole: boolean, preserveThread = false) => {
    if (!editor) return;
    if (save.composing) {
      void save.actions.run(
        "review-begin",
        () => begin(whole, preserveThread),
        () => !disposed.current,
      );
      return;
    }
    try {
      composerIntent.current++;
      setScope("selection");
      setCapture(captureReviewSelection(editor, whole));
      setReanchored(preserveThread);
      if (!preserveThread) {
        setEditing(null);
        setEvidence([]);
      }
      setFill(false);
      setError("");
    } catch (e) {
      notifyFailure(e);
      setError(e instanceof Error ? e.message : "ANCHOR_INVALID");
    }
  };
  const captureTyped = (kind: ReviewThread["kind"]) => {
    begin(false);
    onOpen();
    setKind(kind);
    setSelectionToolbar(null);
  };
  const directAction = (kind: ReviewThread["kind"]) => ({
    onMouseDown: (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      captureTyped(kind);
    },
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      if (event.detail === 0) captureTyped(kind);
    },
  });
  const submission = useRef<{
    intent: number;
    id: string;
    version?: number;
    saved?: boolean;
  } | null>(null);
  const resumeSubmit = (sendToAi: boolean): Promise<unknown> =>
    save.actions.run(
      "review-retry",
      async () => {
        const intent = composerIntent.current;
        const context = save.actions.contextVersion;
        const original = input.current;
        const valid = () =>
          !disposed.current &&
          !composing.current &&
          !save.composing &&
          composerIntent.current === intent &&
          save.actions.contextVersion === context &&
          input.current === original;
        const bodySaved = await save.flush(true);
        if (!valid()) return false;
        if (!bodySaved) {
          report(save.error || "SAVE_FAILED", {
            identity: "review-submit",
            actions: [{ kind: "retry", run: () => resumeSubmit(sendToAi) }],
          });
          return false;
        }
        if (save.planningAdapter) {
          const planningSaved = await save.planningAdapter.flush(true);
          if (!valid()) return false;
          if (!planningSaved) {
            report(save.error || "SAVE_FAILED", {
              identity: "review-submit",
              actions: [{ kind: "retry", run: () => resumeSubmit(sendToAi) }],
            });
            return false;
          }
        }
        if (!valid()) return false;
        return latestSubmit.current(sendToAi);
      },
      () => !disposed.current,
    );
  const submit = (sendToAi = false): Promise<unknown> => {
    if (save.composing || composing.current)
      return save.actions.run(
        "review-submit",
        () => latestSubmit.current(sendToAi),
        () => !disposed.current,
      );
    const intent = composerIntent.current;
    if (submitFlight.current) {
      return submitFlight.current.intent === intent
        ? submitFlight.current.promise
        : submitFlight.current.promise.then(() => false);
    }
    const promise = submitCore(sendToAi)
      .catch((error: unknown) => {
        retryAction.current = () => resumeSubmit(sendToAi);
        setError(error instanceof Error ? error.message : "REVIEW_UNAVAILABLE");
        report(error, {
          identity: "review-submit",
          actions: [{ kind: "retry", run: () => resumeSubmit(sendToAi) }],
        });
        return false;
      })
      .finally(() => {
        if (composerIntent.current === intent)
          retryAction.current = () => resumeSubmit(sendToAi);
        if (submitFlight.current?.promise === promise)
          submitFlight.current = null;
      });
    submitFlight.current = { intent, promise };
    return promise;
  };
  latestSubmit.current = submit;
  const submitCore = async (sendToAi: boolean) => {
    if (composing.current) return;
    const intent = composerIntent.current;
    const requestedVisible = JSON.stringify(save.local);
    let requestedCapture = capture;
    if (sendToAi && !requestedCapture && editor) {
      try {
        requestedCapture =
          scope === "whole" &&
          (explicitWhole.current || editor.state.selection.empty)
            ? captureWholeManuscript(editor)
            : captureReviewSelection(editor);
      } catch (error) {
        report(error);
        return;
      }
    }
    const captured = requestedCapture,
      original = text,
      existing = editing,
      chosen = kind,
      chosenEvidence = structuredClone(
        sendToAi && !editing ? (planningEvidence?.choices ?? []) : evidence,
      ),
      chosenFill = fill,
      chosenReanchored = reanchored;
    if (!captured || !original.trim()) return;
    if (submission.current?.intent !== intent)
      submission.current = { intent, id: existing?.id ?? crypto.randomUUID() };
    const ownedSubmission = submission.current;
    const id = ownedSubmission.id;
    let language = existing?.language ?? "en";
    try {
      if (!(await save.prepareInput())) {
        report(save.error || "SAVE_FAILED");
        return;
      }
      const planning = await client.readPlanning();
      if (
        disposed.current ||
        input.current !== original ||
        composing.current ||
        composerIntent.current !== intent
      )
        return;
      language = existing?.language ?? planning.content.brief.language;
    } catch {
      setError("REVIEW_UNAVAILABLE");
      return;
    }
    const ok =
      ownedSubmission.saved ||
      (await action(
        `save:${intent}`,
        (revision) =>
          command(
            "SaveReview",
            {
              expectedRequestVersion: existing?.requestVersion ?? 0,
              thread: {
                id,
                kind: chosen,
                text: original,
                requestVersion: 0,
                anchor: (() => {
                  if (
                    existing &&
                    !chosenReanchored &&
                    existing.anchor.state !== "mapped"
                  )
                    return structuredClone(existing.anchor);
                  const anchor = bindReviewSelection(captured, save.state);
                  if (chosenFill) {
                    const index = save.state.blocks.findIndex(
                        (b) => b.id === captured[0]?.blockId,
                      ),
                      heading = save.state.blocks[index],
                      next = save.state.blocks[index + 1];
                    if (
                      captured.length !== 1 ||
                      heading?.kind !== "heading" ||
                      (next &&
                        (next.kind !== "heading" ||
                          next.attrs.level! > heading.attrs.level!))
                    )
                      throw Error("ANCHOR_INVALID");
                    anchor.slot = {
                      headingId: heading.id,
                      beforeId: heading.id,
                      afterId: next?.id ?? null,
                    };
                  }
                  return anchor;
                })(),
                handled: false,
                deleted: false,
                language,
                evidence: chosenEvidence,
                decision: existing?.decision ?? null,
                userMessageIds: existing?.userMessageIds ?? [],
              },
            },
            revision,
          ),
        {
          requestedVisible,
          validIntent: () =>
            !disposed.current &&
            !composing.current &&
            composerIntent.current === intent &&
            input.current === original,
        },
      ));
    if (ok) ownedSubmission.saved = true;
    if (ok && sendToAi) {
      if (!ownedSubmission.version) {
        let after: string | undefined;
        do {
          const page = await client.readReviews(after);
          const saved = page.cards.find(
            (card) => card.thread.id === id,
          )?.thread;
          if (saved) {
            ownedSubmission.version = saved.requestVersion;
            break;
          }
          after = page.nextCursor ?? undefined;
        } while (after);
      }
      if (
        !ownedSubmission.version ||
        disposed.current ||
        composing.current ||
        composerIntent.current !== intent ||
        input.current !== original
      )
        return;
      const version = ownedSubmission.version;
      const started = await action(
        `StartReviewTask:${id}:${version}`,
        (revision) =>
          command(
            "StartReviewTask",
            {
              threadId: id,
              requestVersion: version,
              retryOfRunId: null,
              messageIds: existing ? [...(selectedMessages[id] ?? [])] : [],
            },
            revision,
          ),
        {
          requestedVisible,
          validIntent: () =>
            !disposed.current &&
            !composing.current &&
            composerIntent.current === intent &&
            input.current === original,
        },
      );
      if (!started) return;
    }
    if (
      ok &&
      input.current === original &&
      !composing.current &&
      composerIntent.current === intent
    ) {
      resolve("review-submit");
      composerIntent.current++;
      setText("");
      setCapture(null);
      setEditing(null);
    }
  };
  const decide = (
    type: "AcceptReviewCandidates" | "DiscardReviewCandidate",
    card: ReviewCard,
  ) => {
    const c = card.candidate;
    if (!c) return;
    const reference = { id: c.id, version: c.version };
    void action(`${type}:${reference.id}:${reference.version}`, (r) =>
      command(
        type,
        type === "AcceptReviewCandidates"
          ? {
              candidates: [reference],
              expectedHistoryRevision: save.history.historyRevision,
            }
          : { candidate: reference },
        r,
      ),
    );
  };
  const orderedCards = useMemo(() => {
    const order = new Map(save.state.blocks.map((b, i) => [b.id, i]));
    return [...cards].sort(
      (a, b) =>
        (order.get(a.thread.anchor.ranges[0]?.blockId ?? "") ?? Infinity) -
        (order.get(b.thread.anchor.ranges[0]?.blockId ?? "") ?? Infinity),
    );
  }, [cards, save.state.blocks]);
  const layout = useReviewLayout(editor, orderedCards, panelVisible);
  const visible = orderedCards.filter(
    (c) =>
      showAll || (!c.thread.handled && c.thread.anchor.state !== "orphaned"),
  );
  return (
    <>
      {tab === "assistant" && historyOpen && (
        <section
          className="auxiliary-content"
          role="tabpanel"
          id="auxiliary-generation-history"
          aria-labelledby="auxiliary-tab-planning"
        >
          {history}
        </section>
      )}
      <section
        id={assistantMode ? undefined : "auxiliary-planning"}
        role="tabpanel"
        aria-labelledby="auxiliary-tab-planning"
        className="auxiliary-content"
        hidden={tab !== "assistant" || assistantMode || historyOpen}
        inert={tab !== "assistant" || assistantMode || historyOpen}
      >
        {assistant}
      </section>
      {tab === "comments" && !commentsMode && (
        <section
          id="auxiliary-review"
          role="tabpanel"
          aria-labelledby="auxiliary-tab-review"
          className="auxiliary-content"
        >
          <p className="muted">{t.writingCommentsEmpty}</p>
        </section>
      )}
      <section
        className="auxiliary-content"
        id={
          assistantMode
            ? "auxiliary-planning"
            : commentsMode
              ? "auxiliary-review"
              : undefined
        }
        role="tabpanel"
        aria-labelledby={
          assistantMode ? "auxiliary-tab-planning" : "auxiliary-tab-review"
        }
        hidden={
          (!assistantMode && !commentsMode) ||
          (tab === "assistant" && historyOpen)
        }
        inert={
          (!assistantMode && !commentsMode) ||
          (tab === "assistant" && historyOpen)
        }
      >
        <aside
          className="review-panel"
          aria-label={assistantMode ? t.workspaceTab_planning : t.reviewPanel}
        >
          {commentsMode && <h2>{t.reviewPanel}</h2>}
          {error && (
            <button
              className="quiet-button"
              onClick={() => {
                void retryAction.current();
              }}
            >
              {t.retry}
            </button>
          )}
          {assistantMode && (
            <>
              <div className="assistant-context">
                {historyButton}
                <span>{t.manuscript}</span>
                <button className="quiet-button" onClick={openLibrary}>
                  {t.librarySelectedCount.replace(
                    "{count}",
                    String(planningEvidence?.choices.length ?? 0),
                  )}
                </button>
                <button
                  className="quiet-button"
                  onClick={() => openSettings("defaults")}
                >
                  {model
                    ? t.aiCurrentModel.replace("{model}", model.modelId)
                    : t.aiModelSettings}
                </button>
              </div>
              <p className="muted">{t.writingBodyHelp}</p>
              <div
                className="assistant-mode"
                role="group"
                aria-label={t.reviewKind}
              >
                {(["question", "revision_note"] as const).map((value) => (
                  <button
                    key={value}
                    aria-pressed={kind === value}
                    onClick={() => {
                      composerIntent.current++;
                      setKind(value);
                    }}
                  >
                    {value === "question" ? t.writingAsk : t.writingRevise}
                  </button>
                ))}
              </div>
              <label>
                {t.writingScope}
                <select
                  aria-label={t.writingScope}
                  value={scope}
                  onChange={(event) => {
                    composerIntent.current++;
                    explicitWhole.current = event.target.value === "whole";
                    setScope(event.target.value as "selection" | "whole");
                    setCapture(null);
                    setEditing(null);
                  }}
                >
                  <option value="selection">{t.writingSelection}</option>
                  <option value="whole">{t.writingWhole}</option>
                </select>
              </label>
              {scope === "selection" && (
                <button
                  className="quiet-button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => begin(false)}
                >
                  {t.reviewSelection}
                </button>
              )}
            </>
          )}
          {selectionToolbar &&
            centralView === "manuscript" &&
            bodyInteractive &&
            !save.composing &&
            createPortal(
              <div
                ref={floating}
                className="review-floating-selection"
                role="toolbar"
                aria-label={t.reviewSelection}
                style={{
                  position: "fixed",
                  top: selectionToolbar.top,
                  left: selectionToolbar.left,
                }}
              >
                <button disabled={busy} {...directAction("question")}>
                  {t.reviewQuestion}
                </button>
                <button disabled={busy} {...directAction("revision_note")}>
                  {t.reviewNote}
                </button>
              </div>,
              document.body,
            )}
          <div
            className="review-selection-tools"
            hidden={!commentsMode}
            role="toolbar"
            aria-label={t.reviewSelection}
          >
            <button disabled={busy} {...directAction("question")}>
              {t.reviewQuestion}
            </button>
            <button disabled={busy} {...directAction("revision_note")}>
              {t.reviewNote}
            </button>
            <button
              disabled={busy}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => begin(false)}
            >
              {t.reviewSelection}
            </button>
            <button
              disabled={busy}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => begin(true)}
            >
              {t.reviewWholeBlock}
            </button>
            <button
              disabled={busy}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                void save.actions.run(
                  "review-fill",
                  () => {
                    if (!editor) return;
                    try {
                      const selected = captureReviewSelection(editor, true),
                        positions = canonicalPositions(editor),
                        index = positions.findIndex(
                          (p) => p.block.id === selected[0]?.blockId,
                        ),
                        heading = positions[index]?.block,
                        next = positions[index + 1]?.block;
                      if (
                        selected.length !== 1 ||
                        heading?.kind !== "heading" ||
                        (next &&
                          (next.kind !== "heading" ||
                            next.attrs.level! > heading.attrs.level!))
                      )
                        throw Error("ANCHOR_INVALID");
                      composerIntent.current++;
                      setCapture(selected);
                      setFill(true);
                      setKind("revision_note");
                      setEditing(null);
                      setEvidence([]);
                    } catch (e) {
                      setError(
                        e instanceof Error ? e.message : "ANCHOR_INVALID",
                      );
                    }
                  },
                  () => !disposed.current,
                );
              }}
            >
              {t.reviewFillSection}
            </button>
          </div>
          {(capture || assistantMode) && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit(assistantMode);
              }}
            >
              {capture && (
                <blockquote className="review-capture-summary">
                  {assistantMode && scope === "whole"
                    ? t.writingWhole
                    : capture
                        .map((range) => range.quote)
                        .join("\n")
                        .slice(0, 240)}
                </blockquote>
              )}
              <label hidden={assistantMode}>
                {t.reviewKind}
                <select
                  value={kind}
                  disabled={!!editing || busy}
                  onChange={(e) => {
                    composerIntent.current++;
                    setKind(e.target.value as ReviewThread["kind"]);
                  }}
                >
                  <option value="question">{t.reviewQuestion}</option>
                  <option value="revision_note">{t.reviewNote}</option>
                </select>
              </label>
              <div>
                <label htmlFor="review-instruction">
                  {assistantMode ? t.writingRequest : t.reviewInstruction}
                </label>
                <textarea
                  id="review-instruction"
                  value={text}
                  onCompositionStart={() => {
                    composing.current = true;
                    save.composition(true, "review");
                  }}
                  onCompositionEnd={() => {
                    composing.current = false;
                    save.composition(false, "review");
                  }}
                  onChange={(e) => {
                    composerIntent.current++;
                    setText(e.target.value);
                  }}
                  onBlur={() => {
                    save.actions.blur("review", () => {
                      composing.current = false;
                      save.composition(false, "review");
                    });
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.nativeEvent.isComposing ||
                      composing.current ||
                      event.keyCode === 229
                    )
                      event.stopPropagation();
                  }}
                  maxLength={16384}
                />
              </div>
              {!assistantMode && (
                <ReviewEvidence
                  client={client}
                  value={evidence}
                  onChange={(v) => {
                    composerIntent.current++;
                    setEvidence(v);
                  }}
                  t={t}
                />
              )}
              {editing && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => begin(false, true)}
                >
                  {t.reviewReanchor}
                </button>
              )}
              <button
                className="primary-button"
                disabled={busy || (!text.trim() && !composing.current)}
              >
                {assistantMode ? t.writingSend : t.reviewSave}
              </button>
              <button
                hidden={assistantMode}
                type="button"
                onClick={() => {
                  composerIntent.current++;
                  setText("");
                  setCapture(null);
                  setEditing(null);
                }}
              >
                {t.cancel}
              </button>
            </form>
          )}
          <button
            hidden={!commentsMode}
            disabled={
              busy ||
              !cards.some((card) => card.candidate?.status === "pending")
            }
            onClick={() => {
              const candidates = cards
                .filter((c) => c.candidate?.status === "pending")
                .map((c) => ({
                  id: c.candidate!.id,
                  version: c.candidate!.version,
                }));
              void action(
                `batch:${candidates.map((c) => `${c.id}:${c.version}`).join(",")}`,
                (r) =>
                  command(
                    "AcceptReviewCandidates",
                    {
                      candidates,
                      expectedHistoryRevision: save.history.historyRevision,
                    },
                    r,
                  ),
              );
            }}
          >
            {t.reviewAcceptAll}
          </button>
          <label hidden={!commentsMode}>
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
            />
            {t.reviewShowAll}
          </label>
          <details className="review-location-list" hidden={!commentsMode}>
            <summary>{t.reviewOtherComments}</summary>
            {cards
              .filter(
                (c) =>
                  c.thread.handled ||
                  c.thread.anchor.state === "orphaned" ||
                  layout.offscreen.includes(c.thread.id),
              )
              .map((c) => (
                <button
                  type="button"
                  key={c.thread.id}
                  onClick={() => {
                    setShowAll(true);
                    const id = c.thread.anchor.ranges[0]?.blockId;
                    if (id)
                      editor?.view.dom
                        .querySelector(`[data-blockid="${id}"]`)
                        ?.scrollIntoView({ block: "center" });
                  }}
                >
                  {c.thread.text}
                </button>
              ))}
          </details>
          <div
            ref={layout.list}
            className={
              layout.wide && commentsMode
                ? "review-cards review-cards-aligned"
                : "review-cards"
            }
            style={
              layout.wide && commentsMode
                ? { minHeight: layout.height }
                : undefined
            }
          >
            {(assistantMode
              ? visible.filter(
                  (card) =>
                    !card.thread.handled &&
                    (card.answer ||
                      card.candidate ||
                      card.task?.application === "pending"),
                )
              : visible
            ).map((card) => {
              const thread = card.thread,
                task = card.task,
                c = card.candidate,
                active = task?.application === "pending";
              return (
                <article
                  className="review-card"
                  key={thread.id}
                  style={
                    layout.wide && commentsMode
                      ? {
                          position: "absolute",
                          insetInline: 0,
                          top: layout.tops[thread.id] ?? 0,
                        }
                      : undefined
                  }
                  data-review-thread={thread.id}
                  data-review-block={thread.anchor.ranges[0]?.blockId}
                >
                  <h3>
                    {thread.kind === "question"
                      ? t.reviewQuestion
                      : t.reviewNote}
                  </h3>
                  {commentsMode ? (
                    <blockquote>
                      {thread.anchor.ranges
                        .map((range) => range.quote)
                        .join("\n")
                        .slice(0, 240)}
                    </blockquote>
                  ) : (
                    <details className="assistant-context-quote">
                      <summary>{t.writingSelection}</summary>
                      <blockquote>
                        {thread.anchor.ranges
                          .map((range) => range.quote)
                          .join("\n")
                          .slice(0, 240)}
                      </blockquote>
                    </details>
                  )}
                  <p>{thread.text}</p>
                  {commentsMode &&
                    (thread.anchor.state !== "mapped" || thread.handled) && (
                      <p className="muted">
                        {thread.handled
                          ? t.reviewHandled
                          : thread.anchor.state === "orphaned"
                            ? t.reviewOrphan
                            : t.reviewChanged}
                      </p>
                    )}
                  {commentsMode &&
                    card.sourceComparisons.map((pair) => (
                      <div className="review-comparison" key={pair.blockId}>
                        <p>{t.reviewChanged}</p>
                        {pair.previewTruncated && (
                          <button
                            onClick={() => {
                              const n = ++generation.current;
                              void client
                                .reviewSourceComparison(pair.blockId)
                                .then((detail) => {
                                  if (
                                    !disposed.current &&
                                    n === generation.current
                                  )
                                    setCards((old) =>
                                      old.map((card) => ({
                                        ...card,
                                        sourceComparisons:
                                          card.sourceComparisons.map((p) =>
                                            p.blockId === detail.blockId
                                              ? detail
                                              : p,
                                          ),
                                      })),
                                    );
                                })
                                .catch((error: unknown) => {
                                  if (!disposed.current) report(error);
                                });
                            }}
                          >
                            {t.reviewInspectFull}
                          </button>
                        )}
                        <del>
                          {pair.before.runs.map((r) => r.text).join("")}
                        </del>
                        <ins>
                          {pair.after?.runs.map((r) => r.text).join("") ??
                            t.reviewOrphan}
                        </ins>
                      </div>
                    ))}
                  {commentsMode && (
                    <ReviewConversation
                      client={client}
                      id={thread.id}
                      t={t}
                      selected={selectedMessages[thread.id] ?? []}
                      onSelected={(ids) =>
                        setSelectedMessages((old) => ({
                          ...old,
                          [thread.id]: ids,
                        }))
                      }
                    />
                  )}
                  {commentsMode &&
                    task &&
                    task.requestVersion !== thread.requestVersion && (
                      <p className="muted">
                        {t.reviewOlderRequest.replace(
                          "{version}",
                          String(task.requestVersion),
                        )}
                      </p>
                    )}
                  {card.answer && (
                    <div className="review-answer">
                      {commentsMode && (
                        <p>
                          {t.reviewRequestVersion.replace(
                            "{version}",
                            String(card.answer.requestVersion),
                          )}
                        </p>
                      )}
                      <p>{card.answer.text}</p>
                    </div>
                  )}
                  {task?.error === "NO_CHANGE" && (
                    <p className="muted">{t.reviewNoChange}</p>
                  )}
                  {c && (
                    <div className="review-comparison">
                      <p>
                        {c.status === "stale"
                          ? t.reviewStale
                          : t.reviewComparison}
                      </p>
                      <p>{c.explanation}</p>
                      {c.previewTruncated && <p>{t.reviewComparisonPaged}</p>}
                      {c.previewTruncated && (
                        <button
                          type="button"
                          onClick={() => {
                            const n = ++generation.current;
                            void client
                              .reviewCandidate(c.id, c.detailNextCursor ?? 0)
                              .then((detail) => {
                                if (
                                  !disposed.current &&
                                  n === generation.current
                                )
                                  setCards((old) =>
                                    old.map((card) =>
                                      card.candidate?.id === detail.id
                                        ? { ...card, candidate: detail }
                                        : card,
                                    ),
                                  );
                              })
                              .catch((error: unknown) => {
                                if (!disposed.current) report(error);
                              });
                          }}
                        >
                          {t.reviewInspectFull}
                        </button>
                      )}
                      <details
                        className="candidate-preview"
                        open={commentsMode || undefined}
                      >
                        <summary>{t.reviewComparison}</summary>
                        <del>
                          {c.before
                            .map((b) => b.runs.map((r) => r.text).join(""))
                            .join("\n")}
                        </del>
                        <ins>
                          {c.after
                            .map((b) => b.runs.map((r) => r.text).join(""))
                            .join("\n")}
                        </ins>
                      </details>
                      <button
                        disabled={busy || active || c.status !== "pending"}
                        onClick={() => decide("AcceptReviewCandidates", card)}
                      >
                        {t.reviewAccept}
                      </button>
                      <button
                        disabled={busy || active}
                        onClick={() => decide("DiscardReviewCandidate", card)}
                      >
                        {t.reviewDiscard}
                      </button>
                    </div>
                  )}
                  {editing?.id === thread.id && (
                    <p role="status">{t.reviewSaveFirst}</p>
                  )}
                  {!thread.handled && commentsMode && (
                    <>
                      <button
                        disabled={
                          busy ||
                          active ||
                          thread.anchor.state !== "mapped" ||
                          editing?.id === thread.id
                        }
                        onClick={() =>
                          void action(
                            `StartReviewTask:${thread.id}:${thread.requestVersion}`,
                            (r) =>
                              command(
                                "StartReviewTask",
                                {
                                  threadId: thread.id,
                                  requestVersion: thread.requestVersion,
                                  retryOfRunId:
                                    task &&
                                    [
                                      "failed",
                                      "interrupted",
                                      "cancelled",
                                    ].includes(task.run.status)
                                      ? task.run.runId
                                      : null,
                                  messageIds: [
                                    ...(selectedMessages[thread.id] ?? []),
                                  ],
                                },
                                r,
                              ),
                          )
                        }
                      >
                        {task &&
                        ["failed", "interrupted", "cancelled"].includes(
                          task.run.status,
                        )
                          ? t.reviewRetryAI
                          : thread.kind === "question"
                            ? t.reviewAskAI
                            : t.reviewGenerate}
                      </button>
                      <button
                        disabled={busy || active || !!c}
                        onClick={() =>
                          void action(
                            `SetReviewHandled:${thread.id}:${thread.requestVersion}`,
                            (r) =>
                              command(
                                "SetReviewHandled",
                                {
                                  threadId: thread.id,
                                  requestVersion: thread.requestVersion,
                                  handled: true,
                                },
                                r,
                              ),
                          )
                        }
                      >
                        {t.reviewHandle}
                      </button>
                    </>
                  )}
                  {active && <p role="status">{t.writingWorking}</p>}
                  {active && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action(
                          `CancelReviewTask:${thread.id}:${thread.requestVersion}`,
                          (r) =>
                            command(
                              "CancelReviewTask",
                              {
                                threadId: thread.id,
                                requestVersion: thread.requestVersion,
                              },
                              r,
                            ),
                        )
                      }
                    >
                      {t.reviewCancelTask}
                    </button>
                  )}
                  {thread.kind === "question" && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        composerIntent.current++;
                        setScope("selection");
                        setEditing(thread);
                        setReanchored(false);
                        setKind(thread.kind);
                        setText("");
                        setEvidence(thread.evidence);
                        setFill(false);
                        setCapture(
                          thread.anchor.ranges.map((r) => ({
                            ...r,
                            text:
                              save.state.blocks
                                .find((b) => b.id === r.blockId)
                                ?.runs.map((r) => r.text)
                                .join("") ?? "",
                          })),
                        );
                      }}
                    >
                      {t.reviewReply}
                    </button>
                  )}
                  <button
                    hidden={!commentsMode}
                    disabled={busy}
                    onClick={() => {
                      composerIntent.current++;
                      setEditing(thread);
                      setReanchored(false);
                      setKind(thread.kind);
                      setEvidence(thread.evidence);
                      setFill(!!thread.anchor.slot);
                      setText(thread.text);
                      setCapture(
                        thread.anchor.ranges.map((r) => ({
                          ...r,
                          text:
                            save.state.blocks
                              .find((b) => b.id === r.blockId)
                              ?.runs.map((r) => r.text)
                              .join("") ?? "",
                        })),
                      );
                    }}
                  >
                    {t.reviewEdit}
                  </button>
                  <button
                    hidden={!commentsMode}
                    disabled={busy}
                    onClick={() => {
                      if (c && !window.confirm(t.reviewDeleteConfirm)) return;
                      void action(
                        `DeleteReviewThread:${thread.id}:${thread.requestVersion}`,
                        (r) =>
                          command(
                            "DeleteReviewThread",
                            {
                              threadId: thread.id,
                              requestVersion: thread.requestVersion,
                              discardCandidate: !!c,
                            },
                            r,
                          ),
                      );
                    }}
                  >
                    {t.reviewDelete}
                  </button>
                </article>
              );
            })}
          </div>
          {cursor && (
            <button
              onClick={() => {
                const n = ++generation.current;
                void client
                  .readReviews(cursor)
                  .then((p) => {
                    if (!disposed.current && n === generation.current) {
                      setCards((old) => [...old, ...p.cards]);
                      setCursor(p.nextCursor);
                    }
                  })
                  .catch((error: unknown) => {
                    if (!disposed.current) report(error);
                  });
              }}
            >
              {t.reviewMore}
            </button>
          )}
        </aside>
      </section>
    </>
  );
}
