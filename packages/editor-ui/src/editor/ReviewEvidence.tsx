import { useEffect, useRef, useState } from "react";
import type {
  PlanningEvidenceChoice,
  SourceSummary,
  PlanningVisual,
} from "@scenesparrow/contracts";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type en from "../locales/en.json";
export function ReviewEvidence({
  client,
  value,
  onChange,
  t,
}: {
  client: PlatformClient;
  value: PlanningEvidenceChoice[];
  onChange: (v: PlanningEvidenceChoice[]) => void;
  t: typeof en;
}) {
  const [sources, setSources] = useState<SourceSummary[]>([]),
    [next, setNext] = useState<string | null>(null),
    [error, setError] = useState(""),
    [visuals, setVisuals] = useState<Record<string, PlanningVisual>>({}),
    [indexes, setIndexes] = useState<Record<string, number>>({}),
    [preview, setPreview] = useState("");
  const live = useRef(true),
    requests = useRef(0);
  useEffect(() => {
    live.current = true;
    const n = ++requests.current;
    void client.readSources().then((p) => {
      if (live.current && n === requests.current) {
        setSources(p.items);
        setNext(p.next);
      }
    });
    return () => {
      live.current = false;
      requests.current++;
    };
  }, [client]);
  useEffect(() => {
    if (
      !Object.values(visuals).some((v) =>
        ["queued", "running"].includes(v.status),
      )
    )
      return;
    const timer = setTimeout(() => {
      for (const [id, v] of Object.entries(visuals)) {
        if (["queued", "running"].includes(v.status))
          void client.planningVisual(v.id).then((p) => {
            if (live.current) setVisuals((old) => ({ ...old, [id]: p }));
          });
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [client, visuals]);
  const update = (id: string, choice: PlanningEvidenceChoice | null) =>
    onChange([
      ...value.filter((e) => e.sourceId !== id),
      ...(choice ? [choice] : []),
    ]);
  return (
    <details>
      <summary>{t.planningEvidence}</summary>
      <p>{t.planningSearchUnavailable}</p>
      <p>{t.reviewContextChoice}</p>
      {sources.map(({ source, jobId, status, hasImages }) => {
        const choice = value.find((v) => v.sourceId === source.id),
          visual = visuals[source.id];
        return (
          <article key={source.id}>
            <label>
              <input
                type="checkbox"
                checked={!!choice}
                onChange={(e) =>
                  update(
                    source.id,
                    e.target.checked
                      ? {
                          sourceId: source.id,
                          mode:
                            source.kind === "link" ? "link_only" : "text_only",
                          start: 0,
                          end: 0,
                          visualId: "",
                          allowUnknownImages: false,
                        }
                      : null,
                  )
                }
              />
              {source.title} ·{" "}
              {source.kind === "link" ? t.planningLinkOnly : status}
            </label>
            {source.kind === "file" && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    void client
                      .documentAction({
                        type: "extractSource",
                        jobId: crypto.randomUUID(),
                        sourceId: source.id,
                      })
                      .then(
                        () => setError(t.reviewRefreshEvidence),
                        (e) => setError(e.message),
                      );
                  }}
                >
                  {t.retryExtraction}
                </button>
                <button
                  type="button"
                  disabled={!jobId}
                  onClick={() => {
                    if (jobId)
                      void client.extractionPage(jobId).then(
                        (p) => setPreview(p.text),
                        (e) => setError(e.message),
                      );
                  }}
                >
                  {t.planningEvidencePreview}
                </button>
                <label>
                  {t.planningVisualIndex}
                  <input
                    type="number"
                    min={1}
                    value={indexes[source.id] ?? 1}
                    onChange={(e) =>
                      setIndexes((v) => ({
                        ...v,
                        [source.id]: Number(e.target.value),
                      }))
                    }
                  />
                </label>
                <button
                  type="button"
                  onClick={() =>
                    void client
                      .preparePlanningVisual({
                        id: crypto.randomUUID(),
                        sourceId: source.id,
                        index: indexes[source.id] ?? 1,
                      })
                      .then(
                        (v) =>
                          setVisuals((old) => ({ ...old, [source.id]: v })),
                        (e) => setError(e.message),
                      )
                  }
                >
                  {t.planningPrepareVisual}
                </button>
                {visual && (
                  <p>
                    {visual.status} · {visual.width}×{visual.height}
                  </p>
                )}
                {choice && (
                  <>
                    <label>
                      {t.planningEvidence}
                      <select
                        value={choice.mode}
                        onChange={(e) =>
                          update(source.id, {
                            ...choice,
                            mode: e.target
                              .value as PlanningEvidenceChoice["mode"],
                            visualId: visual?.id ?? choice.visualId,
                          })
                        }
                      >
                        <option value="extracted_text">
                          {t.planningExtracted}
                        </option>
                        <option value="text_only">{t.planningTextOnly}</option>
                        <option value="visual_input">{t.planningVisual}</option>
                      </select>
                    </label>
                    {choice.mode === "visual_input" ? (
                      <>
                        <label>
                          <input
                            type="checkbox"
                            checked={choice.allowUnknownImages}
                            onChange={(e) =>
                              update(source.id, {
                                ...choice,
                                allowUnknownImages: e.target.checked,
                                visualId: visual?.id ?? choice.visualId,
                              })
                            }
                          />
                          {t.planningAllowUnknown}
                        </label>
                        <button
                          type="button"
                          disabled={visual?.status !== "ready"}
                          onClick={() =>
                            update(source.id, {
                              ...choice,
                              visualId: visual!.id,
                            })
                          }
                        >
                          {t.planningIncluded}
                        </button>
                      </>
                    ) : (
                      <>
                        {(["start", "end"] as const).map((field) => (
                          <label key={field}>
                            {field === "start"
                              ? t.planningStartByte
                              : t.planningEndByte}
                            <input
                              type="number"
                              min={0}
                              value={choice[field]}
                              onChange={(e) =>
                                update(source.id, {
                                  ...choice,
                                  [field]: Number(e.target.value),
                                })
                              }
                            />
                          </label>
                        ))}
                        {hasImages && <p>{t.planningTextOnly}</p>}
                      </>
                    )}
                  </>
                )}
              </>
            )}
          </article>
        );
      })}
      <button
        type="button"
        onClick={() => {
          const n = ++requests.current;
          void client.readSources().then((p) => {
            if (live.current && n === requests.current) {
              setSources(p.items);
              setNext(p.next);
            }
          });
        }}
      >
        {t.retry}
      </button>
      {next && (
        <button
          type="button"
          onClick={() => {
            const n = ++requests.current;
            void client.readSources(next).then((p) => {
              if (live.current && n === requests.current) {
                setSources((old) => [...old, ...p.items]);
                setNext(p.next);
              }
            });
          }}
        >
          {t.reviewMore}
        </button>
      )}
      {preview && <pre className="review-evidence-preview">{preview}</pre>}
      {error && <p role="status">{error}</p>}
    </details>
  );
}
