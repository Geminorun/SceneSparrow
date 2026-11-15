import { useEffect, useRef, useState } from "react";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type {
  ExtractionPage,
  OutlineNode,
  PlanningContent,
  PlanningEvidenceChoice,
  PlanningPreparation,
  PlanningPreparationRequest,
  PlanningState,
  PlanningVisual,
  SourceSummary,
} from "@scenesparrow/contracts";
import type en from "../locales/en.json";
import { Autosave } from "./autosave";
import { PlanningAutosave } from "./planning-autosave";
export function Planning({
  client,
  save,
  projectId,
  t,
}: {
  client: PlatformClient;
  save: Autosave;
  projectId: string;
  t: typeof en;
}) {
  const [initial, setInitial] = useState<PlanningState | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void client.readPlanning().then(
      (p) => {
        if (active) setInitial(p);
      },
      (e) => {
        if (active) setError(e.message);
      },
    );
    return () => {
      active = false;
    };
  }, [client]);
  if (error)
    return (
      <p role="alert">
        {t.error}
        <button
          onClick={() => {
            setError("");
            void client
              .readPlanning()
              .then(setInitial, (e) => setError(e.message));
          }}
        >
          {t.retry}
        </button>
      </p>
    );
  if (!initial) return <p role="status">{t.connecting}</p>;
  return (
    <PlanningEditor
      initial={initial}
      client={client}
      save={save}
      projectId={projectId}
      t={t}
    />
  );
}
export function subtreeEnd(nodes: OutlineNode[], i: number) {
  let end = i + 1;
  while (end < nodes.length && nodes[end]!.depth > nodes[i]!.depth) end++;
  return end;
}
export function changeStructure(
  nodes: OutlineNode[],
  i: number,
  action: "up" | "down" | "indent" | "outdent" | "delete",
) {
  const result = structuredClone(nodes),
    end = subtreeEnd(nodes, i);
  const moved = result.splice(i, end - i);
  if (action === "delete") return result;
  if (action === "up") {
    let previous = i - 1;
    while (previous >= 0 && nodes[previous]!.depth > nodes[i]!.depth)
      previous--;
    if (previous >= 0 && nodes[previous]!.depth === nodes[i]!.depth)
      result.splice(previous, 0, ...moved);
    else return nodes;
  }
  if (action === "down") {
    if (end >= nodes.length || nodes[end]!.depth !== nodes[i]!.depth)
      return nodes;
    const nextEnd = subtreeEnd(nodes, end);
    result.splice(nextEnd - moved.length, 0, ...moved);
  }
  if (action === "indent") {
    let previous = i - 1;
    while (previous >= 0 && nodes[previous]!.depth > nodes[i]!.depth)
      previous--;
    if (
      previous < 0 ||
      nodes[previous]!.depth !== nodes[i]!.depth ||
      moved.some((n) => n.depth >= 3)
    )
      return nodes;
    moved.forEach((n) => n.depth++);
    result.splice(i, 0, ...moved);
  }
  if (action === "outdent") {
    if (nodes[i]!.depth === 0) return nodes;
    let at = i;
    while (at < result.length && result[at]!.depth >= nodes[i]!.depth) at++;
    moved.forEach((n) => n.depth--);
    result.splice(at, 0, ...moved);
  }
  return result;
}
function PlanningEditor({
  initial,
  client,
  save,
  projectId,
  t,
}: {
  initial: PlanningState;
  client: PlatformClient;
  save: Autosave;
  projectId: string;
  t: typeof en;
}) {
  const [, render] = useState(0);
  const [planning] = useState(
    () =>
      new PlanningAutosave(initial, save, client, projectId, () =>
        render((n) => n + 1),
      ),
  );
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [prepared, setPrepared] = useState<PlanningPreparation | null>(null);
  const [operation, setOperation] = useState<
    PlanningPreparationRequest["operation"]
  >(
    initial.content.nodes.length
      ? "generate_initial_draft"
      : "generate_outline",
  );
  const [error, setError] = useState("");
  const [acting, setActing] = useState(false);
  const [extracted, setExtracted] = useState<ExtractionPage | null>(null);
  const [visuals, setVisuals] = useState<Record<string, PlanningVisual>>({});
  const [indexes, setIndexes] = useState<Record<string, number>>({});
  const active = useRef(true);
  async function refreshSources() {
    const items: SourceSummary[] = [];
    let after: string | undefined;
    do {
      const page = await client.readSources(after);
      items.push(...page.items);
      after = page.next ?? undefined;
    } while (after);
    if (active.current) setSources(items);
  }
  useEffect(() => {
    active.current = true;
    void refreshSources().catch(() => {});
    const refresh = () => {
      void planning
        .refresh()
        .then(() => save.resync())
        .catch(() => {});
      void refreshSources().catch(() => {});
    };
    const unsubscribe = client.subscribeEvents((e) => {
      if (
        [
          "planning.changed",
          "planningTask.changed",
          "draft.created",
          "history.changed",
          "sources.changed",
          "aiRun.changed",
        ].includes(e.type)
      )
        refresh();
    }, refresh);
    const timer = setInterval(refresh, 1000);
    return () => {
      active.current = false;
      clearInterval(timer);
      unsubscribe();
      planning.dispose();
    };
  }, [client, planning]);
  const p = planning.local;
  const reserved = planning.state.reserved;
  const activeTask = planning.state.tasks.find(
    (task) =>
      task.application === "pending" &&
      ["queued", "running", "succeeded"].includes(task.run.status),
  );
  const message = (code: string) => t[code as keyof typeof t] ?? t.error;
  const update = (
    content: PlanningContent,
    scope: string,
    discrete = false,
  ) => {
    setPrepared(null);
    planning.edit(content, scope, discrete);
  };
  const patchBrief = (field: keyof PlanningContent["brief"], value: string) =>
    update({ ...p, brief: { ...p.brief, [field]: value } }, `brief:${field}`);
  const updateEvidence = (
    sourceId: string,
    choice: PlanningEvidenceChoice | null,
  ) => {
    const evidence = p.evidence.filter((e) => e.sourceId !== sourceId);
    if (choice) evidence.push(choice);
    update({ ...p, evidence }, "evidence", true);
  };
  async function prepare(op = operation) {
    setError("");
    setActing(true);
    const intent = planning.identity();
    try {
      if (!(await planning.flush()) || intent !== planning.identity())
        return null;
      const value = await client.preparePlanning({ operation: op });
      if (intent !== planning.identity()) {
        setError("PREFLIGHT_STALE");
        return null;
      }
      setOperation(op);
      setPrepared(value);
      return value;
    } catch (e) {
      setError(e instanceof Error ? e.message : "error");
      return null;
    } finally {
      setActing(false);
    }
  }
  async function start(
    op: PlanningPreparationRequest["operation"],
    retryOfTaskId: string | null = null,
  ) {
    const intent = planning.identity();
    const value = prepared && operation === op ? prepared : await prepare(op);
    if (!value || planning.identity() !== intent) return;
    setActing(true);
    setError("");
    try {
      await planning.control((revision) => ({
        type: "StartPlanningTask",
        requestId: crypto.randomUUID(),
        projectId,
        expectedWorkingRevision: revision,
        payload: { preparationId: value.id, retryOfTaskId },
      }));
      setPrepared(null);
    } finally {
      setActing(false);
    }
  }
  async function prepareVisual(sourceId: string) {
    if (!(await planning.flush())) return;
    setError("");
    try {
      const visual = await client.preparePlanningVisual({
        id: crypto.randomUUID(),
        sourceId,
        index: indexes[sourceId] ?? 1,
      });
      setVisuals((v) => ({ ...v, [sourceId]: visual }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "error");
    }
  }
  useEffect(() => {
    const pending = Object.values(visuals).filter((v) =>
      ["queued", "running"].includes(v.status),
    );
    if (!pending.length) return;
    const timer = setInterval(() => {
      for (const v of pending)
        void client.planningVisual(v.id).then((current) => {
          if (active.current)
            setVisuals((old) => ({ ...old, [current.sourceId]: current }));
        });
    }, 400);
    return () => clearInterval(timer);
  }, [client, visuals]);
  const inputLocked = reserved || acting || save.stageTransitionPending;
  const locked = inputLocked || planning.composing;
  return (
    <section className="planning-workspace" aria-label={t.planningTitle}>
      <div className="planning-heading">
        <div>
          <h2>{t.planningTitle}</h2>
          <p>{t.planningDescription}</p>
        </div>
        <p role="status">
          {t.planningStatus}: {message(planning.status)}
        </p>
      </div>
      {reserved && (
        <p role="status" className="planning-notice">
          {t.planningReserved}
        </p>
      )}
      {(error || planning.error) && (
        <div role="alert" className="error">
          <p>{message(error || planning.error)}</p>
          <p>{t.planningSaveError}</p>
          <button onClick={() => void planning.flush(true, true)}>
            {t.planningSaveRetry}
          </button>
          <button onClick={() => void planning.refresh(true)}>
            {t.planningReload}
          </button>
          <textarea
            readOnly
            aria-label={t.planningSavedPlan}
            value={JSON.stringify(p, null, 2)}
          />
        </div>
      )}
      <fieldset
        className="planning-brief"
        disabled={inputLocked}
        onCompositionStart={() => planning.composition(true)}
        onCompositionEnd={() => planning.composition(false)}
      >
        {(
          [
            ["topic", t.planningTopic],
            ["language", t.planningLanguage],
            ["audience", t.planningAudience],
            ["style", t.planningStyle],
            ["lengthHint", t.planningLength],
          ] as const
        ).map(([field, label]) => (
          <label key={field}>
            {label}
            <input
              value={p.brief[field]}
              onChange={(e) => patchBrief(field, e.target.value)}
              onBlur={() => void planning.flush(false)}
            />
          </label>
        ))}
      </fieldset>
      <div className="planning-outline">
        <h3>{t.planningOutline}</h3>
        {p.nodes.map((node, i) => (
          <div
            className="outline-node"
            key={node.id}
            style={{ marginInlineStart: `${node.depth * 1.2}rem` }}
            onCompositionStart={() => planning.composition(true)}
            onCompositionEnd={() => planning.composition(false)}
          >
            <label>
              {t.planningOutline} {i + 1}
              <input
                disabled={inputLocked}
                aria-label={`${t.planningOutline} ${i + 1}`}
                value={node.title}
                onChange={(e) =>
                  update(
                    {
                      ...p,
                      nodes: p.nodes.map((n) =>
                        n.id === node.id ? { ...n, title: e.target.value } : n,
                      ),
                    },
                    `${node.id}:title`,
                  )
                }
                onBlur={() => void planning.flush(false)}
              />
            </label>
            <label>
              {t.planningKeyPoints}
              <textarea
                disabled={inputLocked}
                value={node.keyPoints.join("\n")}
                onChange={(e) =>
                  update(
                    {
                      ...p,
                      nodes: p.nodes.map((n) =>
                        n.id === node.id
                          ? {
                              ...n,
                              keyPoints: e.target.value
                                ? e.target.value.split("\n")
                                : [],
                            }
                          : n,
                      ),
                    },
                    `${node.id}:points`,
                  )
                }
                onBlur={() => void planning.flush(false)}
              />
            </label>
            <div className="outline-actions">
              {(
                [
                  ["up", t.planningUp],
                  ["down", t.planningDown],
                  ["indent", t.planningIndent],
                  ["outdent", t.planningOutdent],
                  ["delete", t.planningDelete],
                ] as const
              ).map(([action, label]) => (
                <button
                  key={action}
                  disabled={locked}
                  onClick={() =>
                    update(
                      { ...p, nodes: changeStructure(p.nodes, i, action) },
                      "structure",
                      true,
                    )
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ))}
        <button
          disabled={locked}
          onClick={() =>
            update(
              {
                ...p,
                nodes: [
                  ...p.nodes,
                  {
                    id: crypto.randomUUID(),
                    revision: 0,
                    title: t.planningNewNode,
                    depth: 0,
                    keyPoints: [],
                  },
                ],
              },
              "structure",
              true,
            )
          }
        >
          {t.planningAddNode}
        </button>
      </div>
      <label>
        {t.planningInstruction}
        <textarea
          disabled={inputLocked}
          value={p.instruction}
          onCompositionStart={() => planning.composition(true)}
          onCompositionEnd={() => planning.composition(false)}
          onChange={(e) =>
            update({ ...p, instruction: e.target.value }, "instruction")
          }
          onBlur={() => void planning.flush(false)}
        />
      </label>
      <details className="planning-evidence">
        <summary>{t.planningEvidence}</summary>
        <p>{t.planningSearchUnavailable}</p>
        {!p.evidence.length && <p>{t.planningNoEvidence}</p>}
        {sources.map(({ source, ...summary }) => {
          const choice = p.evidence.find((e) => e.sourceId === source.id);
          const visual = visuals[source.id];
          return (
            <article key={source.id}>
              <label>
                <input
                  type="checkbox"
                  disabled={locked}
                  checked={!!choice}
                  onChange={(e) =>
                    updateEvidence(
                      source.id,
                      e.target.checked
                        ? {
                            sourceId: source.id,
                            mode:
                              source.kind === "link"
                                ? "link_only"
                                : "extracted_text",
                            start: 0,
                            end: 0,
                            visualId: "",
                            allowUnknownImages: false,
                          }
                        : null,
                    )
                  }
                />
                {source.title} —{" "}
                {source.kind === "link"
                  ? t.planningLinkOnly
                  : message(summary.status)}
              </label>
              {source.kind === "file" && (
                <>
                  <button
                    onClick={() => {
                      if (summary.jobId)
                        void client.extractionPage(summary.jobId).then(
                          (page) => setExtracted(page),
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
                    disabled={locked}
                    onClick={() => void prepareVisual(source.id)}
                  >
                    {t.planningPrepareVisual}
                  </button>
                  {visual && (
                    <p role="status">
                      {message(visual.status)} · {visual.width}×{visual.height}{" "}
                      · {visual.size} {visual.transformation}
                      {["queued", "running"].includes(visual.status) && (
                        <button
                          onClick={() =>
                            void client
                              .cancelPlanningVisual(visual.id)
                              .then((v) =>
                                setVisuals((old) => ({
                                  ...old,
                                  [source.id]: v,
                                })),
                              )
                          }
                        >
                          {t.cancel}
                        </button>
                      )}
                      {visual.error && message(visual.error)}
                    </p>
                  )}
                </>
              )}
              {choice && source.kind === "file" && (
                <>
                  <select
                    disabled={locked}
                    aria-label={t.planningEvidence}
                    value={choice.mode}
                    onChange={(e) =>
                      updateEvidence(source.id, {
                        ...choice,
                        mode: e.target.value as PlanningEvidenceChoice["mode"],
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
                  {choice.mode === "visual_input" ? (
                    <>
                      <label>
                        <input
                          type="checkbox"
                          disabled={locked}
                          checked={choice.allowUnknownImages}
                          onChange={(e) =>
                            updateEvidence(source.id, {
                              ...choice,
                              allowUnknownImages: e.target.checked,
                              visualId: visual?.id ?? choice.visualId,
                            })
                          }
                        />
                        {t.planningAllowUnknown}
                      </label>
                      <button
                        disabled={locked || visual?.status !== "ready"}
                        onClick={() =>
                          updateEvidence(source.id, {
                            ...choice,
                            visualId: visual?.id ?? "",
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
                            disabled={locked}
                            value={choice[field]}
                            onChange={(e) =>
                              updateEvidence(source.id, {
                                ...choice,
                                [field]: Number(e.target.value),
                              })
                            }
                          />
                        </label>
                      ))}
                    </>
                  )}
                </>
              )}
            </article>
          );
        })}
        {extracted && (
          <div>
            <p>
              {t.planningExcerptPage
                .replace("{start}", String(extracted.offset))
                .replace(
                  "{end}",
                  String(
                    extracted.offset +
                      new TextEncoder().encode(extracted.text).length,
                  ),
                )}
            </p>
            <pre className="evidence-text">{extracted.text}</pre>
            {extracted.next !== null && (
              <button
                onClick={() =>
                  void client
                    .extractionPage(extracted.jobId, extracted.next!)
                    .then(setExtracted, (e) => setError(e.message))
                }
              >
                {t.planningNextPage}
              </button>
            )}
          </div>
        )}
      </details>
      <div className="planning-primary">
        <button
          disabled={locked || !!activeTask || !!p.nodes.length}
          onClick={() => void start("generate_outline")}
        >
          {t.planningGenerateOutline}
        </button>
        <button
          disabled={
            locked || !!activeTask || !p.nodes.length || !p.instruction.trim()
          }
          onClick={() => void start("adjust_outline")}
        >
          {t.planningAdjust}
        </button>
        <button
          disabled={locked || !!activeTask || !p.nodes.length}
          onClick={() => void start("generate_initial_draft")}
        >
          {t.planningDraft}
        </button>
        <button
          disabled={locked}
          onClick={() =>
            void prepare(
              p.nodes.length ? "generate_initial_draft" : "generate_outline",
            )
          }
        >
          {t.planningPrepare}
        </button>
        <button
          disabled={locked}
          onClick={() =>
            void planning.control((revision) => ({
              type: "StartManualDraft",
              requestId: crypto.randomUUID(),
              projectId,
              expectedWorkingRevision: revision,
              payload: {},
            }))
          }
        >
          {t.planningManual}
        </button>
      </div>
      {prepared && (
        <details open>
          <summary>{t.planningPrepared}</summary>
          <p>
            {t.planningConfig}: {prepared.configuration.provider.label} /{" "}
            {prepared.configuration.model.id}
          </p>
          <p>
            {t.planningTokens}: {prepared.estimatedInputTokens} /{" "}
            {prepared.outputTokens}
          </p>
          {prepared.warnings.map((w) => (
            <p key={w}>{message(w)}</p>
          ))}
          {prepared.evidence.map((e) => (
            <p key={e.id}>
              {e.sourceId} · {message(e.level)} · {e.location} · {e.contentHash}
            </p>
          ))}
        </details>
      )}
      <section className="planning-tasks">
        <h3>{t.planningTasks}</h3>
        {planning.state.tasks.map((task) => (
          <article key={task.id}>
            <p>
              {message(task.operation)} · {message(task.run.status)} ·{" "}
              {message(task.application)}
            </p>
            {task.error && <p role="alert">{message(task.error)}</p>}
            <p>
              {t.planningConfig}: {task.run.configuration.provider.label} /{" "}
              {task.run.configuration.model.id}
            </p>
            {["pending", "not_applied"].includes(task.application) && (
              <button
                disabled={acting || planning.composing}
                onClick={() =>
                  void planning.control((revision) => ({
                    type: "CancelPlanningTask",
                    requestId: crypto.randomUUID(),
                    projectId,
                    expectedWorkingRevision: revision,
                    payload: { taskId: task.id },
                  }))
                }
              >
                {t.planningTaskCancel}
              </button>
            )}
            {!activeTask &&
              !["pending", "applied"].includes(task.application) && (
                <button
                  disabled={acting || planning.composing}
                  onClick={() =>
                    void start(
                      task.operation as PlanningPreparationRequest["operation"],
                      task.id,
                    )
                  }
                >
                  {t.planningTaskRetry}
                </button>
              )}
            {task.application === "not_applied" && (
              <button
                disabled={acting || reserved}
                onClick={() =>
                  void planning.control((revision) => ({
                    type: "UsePlanningResult",
                    requestId: crypto.randomUUID(),
                    projectId,
                    expectedWorkingRevision: revision,
                    payload: {
                      taskId: task.id,
                      expectedHistoryRevision: save.history.historyRevision,
                      explicit: true,
                    },
                  }))
                }
              >
                {t.planningUseResult}
              </button>
            )}
            <details>
              <summary>{t.planningTaskDetails}</summary>
              <pre>{task.preview}</pre>
            </details>
          </article>
        ))}
      </section>
    </section>
  );
}
export function GeneratedDraftEvidence({
  client,
  blockIds,
  t,
}: {
  client: PlatformClient;
  blockIds: string[];
  t: typeof en;
}) {
  const [state, setState] = useState<PlanningState | null>(null);
  const [error, setError] = useState(false),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(() => client.readPlanning())
      .then((value) => {
        if (active) {
          setState(value);
          setError(false);
        }
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [client, retry]);
  if (error)
    return (
      <details className="draft-evidence">
        <summary>{t.planningTaskDetails}</summary>
        <p role="alert">{t.error}</p>
        <button onClick={() => setRetry((n) => n + 1)}>{t.retry}</button>
      </details>
    );
  const task = state?.tasks.find((task) =>
    task.metadata?.sectionMapping.some((section) =>
      section.blockIds.some((id) => blockIds.includes(id)),
    ),
  );
  if (!task?.metadata) return null;
  return (
    <details className="draft-evidence">
      <summary>{t.planningTaskDetails}</summary>
      <p>
        {t.planningConfig}: {task.run.configuration.provider.label} /{" "}
        {task.run.configuration.model.id}
      </p>
      {task.metadata.verificationHints.map((hint, i) => (
        <p key={`hint-${i}`}>{hint}</p>
      ))}
      {task.metadata.planningNotes.map((note, i) => (
        <p key={`note-${i}`}>{note}</p>
      ))}
      {!task.metadata.evidence.length && <p>{t.planningNoEvidence}</p>}
      {task.metadata.evidence.map((e) => (
        <p key={e.id}>
          {e.id} · {t[e.level as keyof typeof t] ?? t.planningEvidence} ·{" "}
          {e.location} · {e.contentHash}
        </p>
      ))}
    </details>
  );
}
