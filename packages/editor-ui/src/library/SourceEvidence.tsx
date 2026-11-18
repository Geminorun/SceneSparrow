import {
  useErrorNotification,
  useTaskNotifications,
} from "../feedback/NotificationPresenter";
import { useEffect, useRef, useState } from "react";
import type {
  PlanningEvidenceChoice,
  PlanningVisual,
  SourceSummary,
} from "@scenesparrow/contracts";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type en from "../locales/en.json";
import { evidenceChoice, readEvidenceText, textRange } from "./evidence";

export function SourceEvidence({
  item,
  client,
  choice,
  update,
  locked = false,
  purpose = "creation",
  compact = false,
  t,
}: {
  item: SourceSummary;
  client: PlatformClient;
  choice?: PlanningEvidenceChoice | undefined;
  update: (choice: PlanningEvidenceChoice | null) => void;
  locked?: boolean;
  purpose?: "creation" | "review";
  compact?: boolean;
  t: typeof en;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useErrorNotification(error);
  const [preview, setPreview] = useState<{
    text: string;
    truncated: boolean;
  } | null>(null);
  const [visual, setVisual] = useState<PlanningVisual | null>(null),
    [index, setIndex] = useState(1);
  useTaskNotifications(
    visual
      ? [{ id: visual.id, status: visual.status, error: visual.error }]
      : [],
  );
  const textarea = useRef<HTMLTextAreaElement>(null),
    active = useRef(true),
    epoch = useRef(0);
  useEffect(() => {
    active.current = true;
    epoch.current++;
    setPreview(null);
    setVisual(null);
    setBusy(false);
    setError("");
    return () => {
      active.current = false;
      epoch.current++;
    };
  }, [item.source.revision, item.jobId, item.source.objectHash]);
  async function currentSource(ticket: number) {
    let after: string | undefined;
    do {
      const page = await client.readSources(after);
      if (!active.current || ticket !== epoch.current) return false;
      const current = page.items.find(
        (value) => value.source.id === item.source.id,
      );
      if (current)
        return (
          current.source.revision === item.source.revision &&
          current.source.objectHash === item.source.objectHash &&
          current.jobId === item.jobId
        );
      after = page.next ?? undefined;
    } while (after);
    return false;
  }
  useEffect(() => {
    if (!visual || !["queued", "running"].includes(visual.status)) return;
    const ticket = epoch.current;
    const timer = setTimeout(
      () =>
        void client.planningVisual(visual.id).then(
          (value) => {
            if (active.current && ticket === epoch.current) setVisual(value);
          },
          () => {
            if (active.current && ticket === epoch.current)
              setError("WORKER_UNAVAILABLE");
          },
        ),
      400,
    );
    return () => clearTimeout(timer);
  }, [client, visual]);
  async function load(select = false) {
    const ticket = epoch.current;
    setBusy(true);
    setError("");
    try {
      if (item.source.kind === "link") {
        if (select) update(evidenceChoice(item));
        return;
      }
      if (!item.jobId) throw new Error("EVIDENCE_NOT_READY");
      const value = preview ?? (await readEvidenceText(client, item.jobId));
      if (!active.current || ticket !== epoch.current) return;
      if (!(await currentSource(ticket))) return;
      setPreview(value);
      if (select) {
        if (!value.text.length) throw new Error("SOURCE_TEXT_UNAVAILABLE");
        update(evidenceChoice(item, value.text));
      }
    } catch (e) {
      if (active.current && ticket === epoch.current)
        setError(e instanceof Error ? e.message : "SOURCE_TEXT_UNAVAILABLE");
    } finally {
      if (active.current && ticket === epoch.current) setBusy(false);
    }
  }
  return (
    <div
      className={
        compact ? "source-evidence source-evidence-compact" : "source-evidence"
      }
    >
      <label className="reference-select">
        <input
          type="checkbox"
          checked={!!choice}
          disabled={
            locked ||
            busy ||
            (item.source.kind === "file" && item.status !== "ready")
          }
          onChange={(event) =>
            event.target.checked ? void load(true) : update(null)
          }
        />
        <span className={compact ? "visually-hidden" : undefined}>
          {purpose === "review" ? t.reviewUseReference : t.libraryUseReference}
        </span>
      </label>
      {choice && !compact && (
        <p className="muted">
          {choice.mode === "link_only"
            ? t.linkOnly
            : choice.mode === "visual_input"
              ? t.planningVisual
              : !preview && choice.start === 0
                ? t.libraryTextSelected
                : preview?.truncated ||
                    choice.start > 0 ||
                    (preview && choice.end < textRange(preview.text).end)
                  ? t.libraryExcerptUsed
                  : t.libraryFullTextUsed}
          {item.hasImages && choice.mode !== "visual_input"
            ? ` ${t.imagesUnprocessed}`
            : ""}
        </p>
      )}
      {choice && preview?.truncated && (
        <p className="muted">{t.libraryTextBound}</p>
      )}
      {item.source.kind === "file" && (
        <details>
          <summary>{t.libraryReferenceDetails}</summary>
          <button disabled={busy || !item.jobId} onClick={() => void load()}>
            {t.planningEvidencePreview}
          </button>
          {preview && (
            <>
              <p>
                {preview.truncated
                  ? t.libraryTextBound
                  : t.librarySelectExcerptHelp}
              </p>
              <textarea
                aria-label={t.extractedText}
                className="evidence-text"
                ref={textarea}
                readOnly
                value={preview.text}
              />
              <button
                disabled={locked || busy}
                onClick={() => {
                  const input = textarea.current!;
                  const range = textRange(
                    preview.text,
                    input.selectionStart,
                    input.selectionEnd,
                  );
                  if (range.end <= range.start) {
                    setError("EVIDENCE_CHOICE_REQUIRED");
                    return;
                  }
                  update({ ...evidenceChoice(item), ...range });
                }}
              >
                {t.libraryUseExcerpt}
              </button>
              <button
                disabled={locked || busy || !preview.text}
                onClick={() => update(evidenceChoice(item, preview.text))}
              >
                {preview.truncated
                  ? t.libraryUseLeadingExcerpt
                  : t.libraryUseFullText}
              </button>
            </>
          )}
          <p className="muted">{t.libraryVisualHelp}</p>
          <label>
            {t.planningVisualIndex}
            <input
              type="number"
              min={1}
              value={index}
              onChange={(event) => setIndex(Number(event.target.value))}
            />
          </label>
          <button
            disabled={locked || busy}
            onClick={async () => {
              const ticket = epoch.current;
              setBusy(true);
              try {
                const value = await client.preparePlanningVisual({
                  id: crypto.randomUUID(),
                  sourceId: item.source.id,
                  index,
                });
                if (active.current && ticket === epoch.current)
                  setVisual(value);
              } catch (e) {
                if (active.current)
                  setError(
                    e instanceof Error ? e.message : "WORKER_UNAVAILABLE",
                  );
              } finally {
                if (active.current && ticket === epoch.current) setBusy(false);
              }
            }}
          >
            {t.planningPrepareVisual}
          </button>
          {visual && (
            <>
              <p role="status">
                {t[visual.status as keyof typeof t] ?? visual.status}{" "}
                {visual.width}×{visual.height}
              </p>
              {["queued", "running"].includes(visual.status) && (
                <button
                  onClick={() =>
                    void client.cancelPlanningVisual(visual.id).then(
                      (value) => {
                        if (
                          active.current &&
                          visual.sourceRevision === item.source.revision
                        )
                          setVisual(value);
                      },
                      () => {
                        if (active.current) setError("WORKER_UNAVAILABLE");
                      },
                    )
                  }
                >
                  {t.cancel}
                </button>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={choice?.allowUnknownImages ?? false}
                  disabled={locked}
                  onChange={(event) =>
                    update({
                      ...(choice ?? evidenceChoice(item)),
                      mode: "visual_input",
                      visualId: visual.id,
                      allowUnknownImages: event.target.checked,
                    })
                  }
                />
                {t.planningAllowUnknown}
              </label>
              <button
                disabled={locked || visual.status !== "ready"}
                onClick={() =>
                  update({
                    ...(choice ?? evidenceChoice(item)),
                    mode: "visual_input",
                    visualId: visual.id,
                  })
                }
              >
                {t.libraryUseVisual}
              </button>
            </>
          )}
        </details>
      )}
      {busy && <p role="status">{t.preparing}</p>}
    </div>
  );
}
