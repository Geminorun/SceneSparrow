import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
} from "./review-selection";
import { useReviewLayout } from "./review-layout";
import { ReviewCommands } from "./review-commands";
import { ReviewEvidence } from "./ReviewEvidence";
import { ReviewConversation } from "./ReviewConversation";
import { reviewDecorationKey } from "./review-decorations";
export function Review({
  client,
  save,
  editor,
  projectId,
  t,
}: {
  client: PlatformClient;
  save: Autosave;
  editor: Editor | null;
  projectId: string;
  t: typeof en;
}) {
  const [cards, setCards] = useState<ReviewCard[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [text, setText] = useState(""),
    [kind, setKind] = useState<ReviewThread["kind"]>("question"),
    [capture, setCapture] = useState<ReturnType<
      typeof captureReviewSelection
    > | null>(null),
    [error, setError] = useState(""),
    [conflicts, setConflicts] = useState<
      import("@scenesparrow/contracts").CandidateConflict[]
    >([]),
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
  input.current = text;
  const refresh = useCallback(async () => {
    const n = ++generation.current;
    try {
      const page = await client.readReviews();
      if (!disposed.current && n === generation.current) {
        setCards(page.cards);
        setCursor(page.nextCursor);
      }
    } catch {
      if (!disposed.current && n === generation.current)
        setError("REVIEW_UNAVAILABLE");
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
    let queued = false;
    const transaction = ({
      transaction: tr,
    }: {
      transaction: import("@tiptap/pm/state").Transaction;
    }) => {
      if (!tr.docChanged || queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (active) update();
      });
    };
    update();
    editor.on("transaction", transaction);
    queueMicrotask(() => {
      if (active) update();
    });
    return () => {
      active = false;
      editor.off("transaction", transaction);
    };
  }, [editor, cards, save.canonicalVersion]);
  useEffect(() => {
    if (!editor) return;
    const changed = () => {
      if (save.composing || editor.state.selection.empty) {
        setSelectionToolbar(null);
        return;
      }
      try {
        const start = editor.view.coordsAtPos(editor.state.selection.from),
          end = editor.view.coordsAtPos(editor.state.selection.to);
        setSelectionToolbar({
          top: Math.max(4, Math.min(start.top, end.top) - 40),
          left: Math.max(4, Math.min(window.innerWidth - 240, start.left)),
        });
      } catch {
        setSelectionToolbar(null);
      }
    };
    editor.on("selectionUpdate", changed);
    return () => {
      editor.off("selectionUpdate", changed);
    };
  }, [editor, save]);
  const action = async (
    identity: string,
    build: (revision: number) => ManuscriptCommand,
    options?: { validIntent?: () => boolean; requestedVisible?: string },
  ) => {
    setError("");
    setConflicts([]);
    try {
      const result = await commands.run(identity, build, {
        ...options,
        dispatched: () => setBusy(true),
      });
      if (!result.ok) {
        setError(result.error || "REVIEW_VERSION_CONFLICT");
        setConflicts(result.details?.candidateConflicts ?? []);
      }
      await refresh();
      return result.ok;
    } catch (e) {
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
  const begin = (whole: boolean, preserveThread = false) => {
    if (!editor || save.composing) return;
    try {
      composerIntent.current++;
      setCapture(captureReviewSelection(editor, whole));
      setReanchored(preserveThread);
      if (!preserveThread) {
        setEditing(null);
        setEvidence([]);
      }
      setFill(false);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "ANCHOR_INVALID");
    }
  };
  const captureTyped = (kind: ReviewThread["kind"]) => {
    begin(false);
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
  const submit = () => {
    const intent = composerIntent.current;
    if (submitFlight.current) {
      return submitFlight.current.intent === intent
        ? submitFlight.current.promise
        : submitFlight.current.promise.then(() => false);
    }
    const promise = submitCore().finally(() => {
      if (submitFlight.current?.promise === promise)
        submitFlight.current = null;
    });
    submitFlight.current = { intent, promise };
    return promise;
  };
  const submitCore = async () => {
    if (composing.current) return;
    const intent = composerIntent.current;
    const requestedVisible = JSON.stringify(save.local);
    const captured = capture,
      original = text,
      existing = editing,
      chosen = kind,
      chosenEvidence = structuredClone(evidence),
      chosenFill = fill,
      chosenReanchored = reanchored;
    if (!captured || !original.trim()) return;
    const id = existing?.id ?? crypto.randomUUID();
    let language = existing?.language ?? "en";
    try {
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
    const ok = await action(
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
    );
    if (
      ok &&
      input.current === original &&
      !composing.current &&
      composerIntent.current === intent
    ) {
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
  const layout = useReviewLayout(editor, orderedCards);
  const visible = orderedCards.filter(
    (c) =>
      showAll || (!c.thread.handled && c.thread.anchor.state !== "orphaned"),
  );
  return (
    <aside className="review-panel" aria-label={t.reviewPanel}>
      <h2>{t.reviewPanel}</h2>
      {selectionToolbar && !save.composing && (
        <div
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
        </div>
      )}
      <div
        className="review-selection-tools"
        role="toolbar"
        aria-label={t.reviewSelection}
      >
        <button disabled={busy || save.composing} {...directAction("question")}>
          {t.reviewQuestion}
        </button>
        <button
          disabled={busy || save.composing}
          {...directAction("revision_note")}
        >
          {t.reviewNote}
        </button>
        <button
          disabled={busy || save.composing}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => begin(false)}
        >
          {t.reviewSelection}
        </button>
        <button
          disabled={busy || save.composing}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => begin(true)}
        >
          {t.reviewWholeBlock}
        </button>
        <button
          disabled={busy || save.composing}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
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
              setError(e instanceof Error ? e.message : "ANCHOR_INVALID");
            }
          }}
        >
          {t.reviewFillSection}
        </button>
      </div>
      {capture && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <blockquote>{capture.map((r) => r.quote).join("\n")}</blockquote>
          <label>
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
          <label>
            {t.reviewInstruction}
            <textarea
              value={text}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onChange={(e) => {
                composerIntent.current++;
                setText(e.target.value);
              }}
              maxLength={16384}
            />
          </label>
          <ReviewEvidence
            client={client}
            value={evidence}
            onChange={(v) => {
              composerIntent.current++;
              setEvidence(v);
            }}
            t={t}
          />
          {editing && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => begin(false, true)}
            >
              {t.reviewReanchor}
            </button>
          )}
          <button disabled={busy || !text.trim()}>{t.reviewSave}</button>
          <button
            type="button"
            onClick={() => {
              composerIntent.current++;
              setCapture(null);
              setEditing(null);
            }}
          >
            {t.cancel}
          </button>
        </form>
      )}
      {error && (
        <p role="alert">
          {t.reviewConflict} <code>{error}</code>
          {conflicts.map((c) => (
            <span key={c.id} className="review-conflict-item">
              {c.id} · {c.version} · {c.reason}
            </span>
          ))}
        </p>
      )}
      <button
        disabled={busy}
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
      <label>
        <input
          type="checkbox"
          checked={showAll}
          onChange={(e) => setShowAll(e.target.checked)}
        />
        {t.reviewShowAll}
      </label>
      <details className="review-location-list">
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
          layout.wide ? "review-cards review-cards-aligned" : "review-cards"
        }
        style={layout.wide ? { minHeight: layout.height } : undefined}
      >
        {visible.map((card) => {
          const thread = card.thread,
            task = card.task,
            c = card.candidate,
            active = task?.application === "pending";
          return (
            <article
              className="review-card"
              key={thread.id}
              style={
                layout.wide
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
                {thread.kind === "question" ? t.reviewQuestion : t.reviewNote}
              </h3>
              <blockquote>
                {thread.anchor.ranges.map((r) => r.quote).join("\n")}
              </blockquote>
              <p>{thread.text}</p>
              {(thread.anchor.state !== "mapped" || thread.handled) && (
                <p className="muted">
                  {thread.handled
                    ? t.reviewHandled
                    : thread.anchor.state === "orphaned"
                      ? t.reviewOrphan
                      : t.reviewChanged}
                </p>
              )}
              {card.sourceComparisons.map((pair) => (
                <div className="review-comparison" key={pair.blockId}>
                  <p>{t.reviewChanged}</p>
                  {pair.previewTruncated && (
                    <button
                      onClick={() => {
                        const n = ++generation.current;
                        void client
                          .reviewSourceComparison(pair.blockId)
                          .then((detail) => {
                            if (!disposed.current && n === generation.current)
                              setCards((old) =>
                                old.map((card) => ({
                                  ...card,
                                  sourceComparisons: card.sourceComparisons.map(
                                    (p) =>
                                      p.blockId === detail.blockId ? detail : p,
                                  ),
                                })),
                              );
                          });
                      }}
                    >
                      {t.reviewInspectFull}
                    </button>
                  )}
                  <del>{pair.before.runs.map((r) => r.text).join("")}</del>
                  <ins>
                    {pair.after?.runs.map((r) => r.text).join("") ??
                      t.reviewOrphan}
                  </ins>
                </div>
              ))}
              <ReviewConversation
                client={client}
                id={thread.id}
                t={t}
                selected={selectedMessages[thread.id] ?? []}
                onSelected={(ids) =>
                  setSelectedMessages((old) => ({ ...old, [thread.id]: ids }))
                }
              />
              {task && task.requestVersion !== thread.requestVersion && (
                <p className="muted">
                  {t.reviewOlderRequest.replace(
                    "{version}",
                    String(task.requestVersion),
                  )}
                </p>
              )}
              {card.answer && (
                <div className="review-answer">
                  <p>
                    {t.reviewRequestVersion.replace(
                      "{version}",
                      String(card.answer.requestVersion),
                    )}
                  </p>
                  <p>{card.answer.text}</p>
                </div>
              )}
              {task?.error && (
                <p role="status">
                  {task.error === "NO_CHANGE"
                    ? t.reviewNoChange
                    : t.reviewTaskTip}{" "}
                  <code>{task.error}</code>
                </p>
              )}
              {c && (
                <div className="review-comparison">
                  <p>
                    {c.status === "stale" ? t.reviewStale : t.reviewComparison}
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
                            if (!disposed.current && n === generation.current)
                              setCards((old) =>
                                old.map((card) =>
                                  card.candidate?.id === detail.id
                                    ? { ...card, candidate: detail }
                                    : card,
                                ),
                              );
                          });
                      }}
                    >
                      {t.reviewInspectFull}
                    </button>
                  )}
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
              {!thread.handled && (
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
                                ["failed", "interrupted", "cancelled"].includes(
                                  task.run.status,
                                )
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
            void client.readReviews(cursor).then((p) => {
              if (!disposed.current && n === generation.current) {
                setCards((old) => [...old, ...p.cards]);
                setCursor(p.nextCursor);
              }
            });
          }}
        >
          {t.reviewMore}
        </button>
      )}
    </aside>
  );
}
