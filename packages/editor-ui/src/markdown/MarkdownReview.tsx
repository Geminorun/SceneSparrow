import { useRef, useState } from "react";
import type {
  MarkdownAnnotations,
  MarkdownAnnotationAction,
  MarkdownComment,
  MarkdownDocument,
  MarkdownDocumentKind,
  MarkdownRange,
  MarkdownScopedResult,
  MarkdownScopedAction,
} from "@scenesparrow/contracts";
import {
  ApiError,
  TransportError,
  type PlatformClient,
} from "@scenesparrow/platform-client";
import type en from "../locales/en.json";
import type { CompositionActions } from "../project-session/composition-actions";
import { useNoticeOwner } from "../feedback/NotificationPresenter";
import { MarkdownPreview } from "./MarkdownPreview";

export type ReviewCapture = {
  projectId: string;
  revision: string;
  text: string;
  epoch: number;
  session: object;
  kind: MarkdownDocumentKind;
};
export function MarkdownReview({
  client,
  t,
  kind,
  annotations,
  selection,
  composition,
  prepare,
  validate,
  annotated,
  applied,
  locate,
}: {
  client: PlatformClient;
  t: typeof en;
  kind: MarkdownDocumentKind;
  annotations: MarkdownAnnotations;
  selection: {
    ranges: MarkdownRange[];
    range: MarkdownRange;
    source: string;
  } | null;
  composition: CompositionActions;
  prepare: (
    kind: MarkdownDocumentKind,
    save?: boolean,
  ) => Promise<ReviewCapture>;
  validate: (capture: ReviewCapture) => void;
  annotated: (capture: ReviewCapture, data: MarkdownAnnotations) => void;
  applied: (capture: ReviewCapture, saved: MarkdownDocument) => void;
  locate: (comment: MarkdownComment) => void;
}) {
  const [drafts, setDrafts] = useState({ outline: "", manuscript: "" });
  const text = drafts[kind];
  function setText(value: string | ((current: string) => string)) {
    setDrafts((current) => ({
      ...current,
      [kind]: typeof value === "function" ? value(current[kind]) : value,
    }));
  }
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const notice = useNoticeOwner();
  const pendingAction = useRef<{
    capture: ReviewCapture;
    action: MarkdownScopedAction;
  } | null>(null);
  const [proposal, setProposal] = useState<{
    capture: ReviewCapture;
    commentId: string;
    result: MarkdownScopedResult;
  } | null>(null);
  async function run(operation: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await composition.run("markdown-review", operation);
    } catch (failure) {
      notice.report(failure);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function change(
    action: MarkdownAnnotationAction,
    captured: ReviewCapture,
  ) {
    validate(captured);
    const data = await client.markdownProjects!.annotate(
      captured.projectId,
      captured.kind,
      action,
    );
    annotated(captured, data);
  }
  function add(comment: boolean) {
    const selected = selection;
    const input = text;
    if (!selected || (comment && selected.range.end <= selected.range.start))
      return;
    void run(async () => {
      const captured = await prepare(kind);
      if (captured.text !== selected.source)
        throw new ApiError("MARKDOWN_CONFLICT");
      await change(
        comment
          ? {
              action: "comment",
              revision: captured.revision,
              range: selected.range,
              text: input,
            }
          : {
              action: "lock",
              revision: captured.revision,
              ranges: selected.ranges,
            },
        captured,
      );
      if (comment) setText((current) => (current === input ? "" : current));
    });
  }
  function existing(action: MarkdownAnnotationAction) {
    void run(async () => {
      const captured = await prepare(kind, false);
      await change(action, captured);
    });
  }
  function generate(comment: MarkdownComment) {
    void run(async () => {
      const captured = await prepare(kind);
      let pending = pendingAction.current;
      if (
        !pending ||
        pending.capture.session !== captured.session ||
        pending.capture.revision !== captured.revision ||
        pending.capture.epoch !== captured.epoch ||
        pending.action.commentId !== comment.id
      ) {
        const [settings, ready] = await Promise.all([
          client.readAiSettings(),
          client.resolveAiConfiguration(),
        ]);
        validate(captured);
        pending = {
          capture: captured,
          action: {
            actionId: crypto.randomUUID(),
            sessionId: settings.sessionId,
            fingerprint: ready.configuration.fingerprint,
            revision: captured.revision,
            commentId: comment.id,
          },
        };
        pendingAction.current = pending;
      }
      let result: MarkdownScopedResult;
      try {
        result = await client.markdownProjects!.scoped(
          captured.projectId,
          captured.kind,
          pending.action,
        );
        pendingAction.current = null;
      } catch (failure) {
        if (
          !(failure instanceof TransportError) &&
          !(
            failure instanceof ApiError &&
            ["ACTION_IN_PROGRESS", "WORKER_INTERRUPTED"].includes(failure.code)
          )
        )
          pendingAction.current = null;
        throw failure;
      }
      setProposal({ capture: captured, commentId: comment.id, result });
    });
  }
  let stale = false;
  if (proposal) {
    try {
      validate(proposal.capture);
    } catch {
      stale = true;
    }
  }
  return (
    <section className="markdown-review" aria-label={t.markdownComments}>
      <h3>{t.markdownComments}</h3>
      <div className="markdown-block-actions">
        <button
          disabled={busy || !selection}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => add(false)}
        >
          {t.markdownLockSelection}
        </button>
        <button
          disabled={
            busy ||
            !selection ||
            selection.range.end <= selection.range.start ||
            !text.trim()
          }
          onClick={() => add(true)}
        >
          {t.markdownAddComment}
        </button>
      </div>
      <label>
        {t.markdownCommentText}
        <textarea
          id="markdown-comment-composer"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onCompositionStart={() =>
            composition.composition("review-comment", true)
          }
          onCompositionEnd={() =>
            composition.composition("review-comment", false)
          }
          onBlur={() =>
            composition.blur("review-comment", () =>
              composition.composition("review-comment", false),
            )
          }
        />
      </label>
      {annotations.locks.map((lock) => (
        <div key={lock.id} className="markdown-lock-record">
          <span>
            {lock.anchors.some((a) => a.resolvedStart === null)
              ? t.MARKDOWN_LOCK_CONFLICT
              : t.markdownLocked}
          </span>
          <blockquote>{lock.anchors.map((a) => a.quote).join("\n")}</blockquote>
          <button
            disabled={busy}
            onClick={() => existing({ action: "unlock", id: lock.id })}
          >
            {t.markdownUnlock}
          </button>
        </div>
      ))}
      {annotations.comments.map((comment) => (
        <article
          key={comment.id}
          className="markdown-comment"
          data-comment-status={comment.status}
        >
          <p>{comment.text}</p>
          <blockquote>{comment.anchor.quote}</blockquote>
          <p role="status">
            {comment.status === "resolved"
              ? t.markdownCommentResolved
              : comment.anchor.resolvedStart === null
                ? t.MARKDOWN_ANCHOR_DETACHED
                : t.markdownCommentOpen}
          </p>
          <button
            disabled={comment.anchor.resolvedStart === null}
            onClick={() => locate(comment)}
          >
            {t.markdownGoToComment}
          </button>
          {comment.status === "open" && (
            <>
              <button
                disabled={busy}
                onClick={() => existing({ action: "resolve", id: comment.id })}
              >
                {t.markdownResolveComment}
              </button>
              <button
                disabled={
                  busy ||
                  !selection ||
                  selection.range.end <= selection.range.start
                }
                onClick={() => {
                  if (selection)
                    void run(async () => {
                      const captured = await prepare(kind);
                      if (captured.text !== selection.source)
                        throw new ApiError("MARKDOWN_CONFLICT");
                      await change(
                        {
                          action: "reposition",
                          id: comment.id,
                          revision: captured.revision,
                          range: selection.range,
                        },
                        captured,
                      );
                    });
                }}
              >
                {t.markdownRepositionComment}
              </button>
              <button
                disabled={busy || comment.anchor.resolvedStart === null}
                onClick={() => generate(comment)}
              >
                {t.markdownReviseComment}
              </button>
            </>
          )}
        </article>
      ))}
      {proposal && proposal.capture.kind === kind && (
        <section aria-label={t.markdownScopedPreview}>
          <h4>{t.markdownScopedPreview}</h4>
          {stale && (
            <p className="markdown-conflict">{t.MARKDOWN_DRAFT_CONFLICT}</p>
          )}
          <p>{t.markdownScopedHelp}</p>
          <MarkdownPreview text={proposal.result.text} />
          <button
            disabled={busy || stale}
            onClick={() =>
              void run(async () => {
                validate(proposal.capture);
                const saved = await client.markdownProjects!.applyScoped(
                  proposal.capture.projectId,
                  proposal.capture.kind,
                  {
                    revision: proposal.capture.revision,
                    commentId: proposal.commentId,
                    text: proposal.result.text,
                    range: proposal.result.range,
                    fingerprint: proposal.result.fingerprint,
                  },
                );
                applied(proposal.capture, saved);
                setProposal(null);
              })
            }
          >
            {t.markdownApplyChanges}
          </button>
          <button disabled={busy} onClick={() => setProposal(null)}>
            {t.close}
          </button>
        </section>
      )}
      {busy && <p role="status">{t.markdownWritingProgress}</p>}
    </section>
  );
}
