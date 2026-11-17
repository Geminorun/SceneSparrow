import { useEffect, useRef, useState } from "react";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type {
  OutlineNode,
  PlanningContent,
  PlanningEvidenceChoice,
  PlanningPreparation,
  PlanningPreparationRequest,
  PlanningState,
  SourceSummary,
} from "@scenesparrow/contracts";
import type en from "../locales/en.json";
import { Autosave, type SaveStatus } from "./autosave";
export type PlanningFeedback = {
  status: SaveStatus;
  error: string;
  retry: () => void;
};
import type { PlanningEvidenceBridge } from "./evidence";
import { PlanningAutosave } from "./planning-autosave";
export function Planning({
  client,
  save,
  projectId,
  t,
  onStatus,
  onEvidence,
  openLibrary,
  openReview,
}: {
  client: PlatformClient;
  save: Autosave;
  projectId: string;
  t: typeof en;
  onStatus: (feedback: PlanningFeedback) => void;
  onEvidence: (bridge: PlanningEvidenceBridge) => void;
  openLibrary: () => void;
  openReview: () => void;
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
  useEffect(() => {
    if (!initial)
      onStatus({
        status: error ? "error" : "saving",
        error,
        retry: () => {
          setError("");
          void client
            .readPlanning()
            .then(setInitial, (failure) => setError(failure.message));
        },
      });
  }, [error, initial, onStatus, client]);
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
  if (!initial) return <p role="status">{t.planningLoading}</p>;
  return (
    <PlanningEditor
      initial={initial}
      onEvidence={onEvidence}
      openLibrary={openLibrary}
      openReview={openReview}
      onStatus={onStatus}
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
  onStatus,
  onEvidence,
  openLibrary,
  openReview,
}: {
  initial: PlanningState;
  client: PlatformClient;
  save: Autosave;
  projectId: string;
  t: typeof en;
  onStatus: (feedback: PlanningFeedback) => void;
  onEvidence: (bridge: PlanningEvidenceBridge) => void;
  openLibrary: () => void;
  openReview: () => void;
}) {
  const [, render] = useState(0);
  const [planning] = useState(
    () =>
      new PlanningAutosave(initial, save, client, projectId, () =>
        render((n) => n + 1),
      ),
  );
  useEffect(() => {
    onStatus({
      status: planning.status,
      error: planning.error,
      retry: () => {
        void planning.flush(true, true);
      },
    });
  }, [planning.status, planning.error, onStatus]);
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [prepared, setPrepared] = useState<PlanningPreparation | null>(null);
  const [operation, setOperation] = useState<
    PlanningPreparationRequest["operation"]
  >(
    initial.content.nodes.length &&
      save.state.workspaceStage === "outline" &&
      !save.local.length
      ? "generate_initial_draft"
      : "generate_outline",
  );
  const [error, setError] = useState("");
  const [acting, setActing] = useState(false);
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
    let refreshing = false,
      again = false,
      wantSources = false,
      sourceEpoch = 0,
      failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (sources = false) => {
      if (sources) {
        wantSources = true;
        sourceEpoch++;
      }
      again = true;
      if (refreshing || !active.current) return;
      clearTimeout(retry);
      refreshing = true;
      try {
        while (again && active.current) {
          again = false;
          const readSources = wantSources,
            epoch = sourceEpoch;
          await planning.refresh();
          if (!active.current) return;
          await save.resync();
          if (readSources) {
            await refreshSources();
            if (epoch === sourceEpoch) wantSources = false;
          }
          failures = 0;
        }
      } catch {
        again = true;
        failures++;
        if (active.current)
          retry = setTimeout(
            () => void refresh(),
            Math.min(30000, 1000 * 2 ** Math.min(failures, 5)),
          );
      } finally {
        refreshing = false;
      }
    };
    const unsubscribe = client.subscribeEvents(
      (e) => {
        if (
          [
            "planning.changed",
            "planningTask.changed",
            "draft.created",
            "history.changed",
            "sources.changed",
          ].includes(e.type) ||
          (e.type === "aiRun.changed" &&
            planning.state.tasks.some((task) =>
              e.affectedIds.includes(task.run.runId),
            ))
        )
          void refresh(e.type === "sources.changed");
      },
      () => void refresh(true),
    );
    const timer = setInterval(() => {
      if (
        planning.state.tasks.some((task) =>
          ["queued", "running", "cancelling"].includes(task.run.status),
        )
      )
        void refresh();
    }, 3000);
    return () => {
      active.current = false;
      clearInterval(timer);
      clearTimeout(retry);
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
    if (planning.state.reserved || save.stageTransitionPending) return;
    const current = planning.local;
    const evidence = current.evidence.filter((e) => e.sourceId !== sourceId);
    if (choice) evidence.push(choice);
    update({ ...current, evidence }, "evidence", true);
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
  const inputLocked = reserved || save.stageTransitionPending;
  const locked = inputLocked || acting;
  const initialEligible =
    save.state.workspaceStage === "outline" &&
    !save.local.length &&
    !save.recoveryText;
  const [assistanceOpen, setAssistanceOpen] = useState(initialEligible);
  const ready =
    !!p.brief.topic.trim() && p.nodes.every((node) => !!node.title.trim());
  const briefInvalid = (field: keyof PlanningContent["brief"]) =>
    [...p.brief[field]].length > (field === "topic" ? 500 : 2000);
  const validationError = ["BRIEF_INVALID", "OUTLINE_INVALID"].includes(
    planning.error,
  );
  useEffect(() => {
    onEvidence({
      choices: p.evidence,
      locked: inputLocked,
      update: (sourceId, choice) => {
        if (planning.composing)
          planning.afterComposition(() => updateEvidence(sourceId, choice));
        else updateEvidence(sourceId, choice);
      },
    });
  }, [p, inputLocked, onEvidence]);
  const [discardBlocked, setDiscardBlocked] = useState(false);
  async function discard() {
    if (!window.confirm(t.workspaceDiscardConfirm)) return;
    setDiscardBlocked(!(await planning.discard()));
  }
  return (
    <section
      className="planning-workspace"
      aria-label={t.planningTitle}
      onClickCapture={(event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>(
          "button",
        );
        if (planning.composing && button) {
          event.preventDefault();
          event.stopPropagation();
          planning.afterComposition(() => {
            if (button.isConnected && !button.disabled) button.click();
          });
        }
      }}
    >
      <div className="planning-heading">
        <div>
          <h2>{t.workspaceTab_planning}</h2>
          <p className="creation-steps">
            {initialEligible
              ? p.nodes.length
                ? t.createOutlineStep
                : t.createIdeaStep
              : t.createDraftStep}
          </p>
          <p>
            {initialEligible
              ? t.planningDescription
              : t.workspacePlanPreservesBody}
          </p>
        </div>
        <p
          role="status"
          className="planning-save-status"
          title={t[`save_${planning.status}`]}
        >
          {t.planningStatus}: {t[`save_${planning.status}`]}
        </p>
      </div>
      {reserved && (
        <p role="status" className="planning-notice">
          {t.planningReserved}
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {message(error)}
        </p>
      )}
      {planning.error && !validationError && (
        <p className="field-error" role="status">
          {planning.error === "COMMAND_UNRESOLVED"
            ? t.workspaceDiscardBlocked
            : message(planning.error)}
        </p>
      )}
      <details className="planning-recovery-actions">
        <summary>{t.workspaceRecoveryDetails}</summary>
        {["error", "conflict"].includes(planning.status) && (
          <button
            className="quiet-button"
            onClick={() => void planning.flush(true, true)}
          >
            {t.planningSaveRetry}
          </button>
        )}
        <div className="planning-recovery-details">
          <button className="quiet-button" onClick={() => void discard()}>
            {t.planningReload}
          </button>
          {discardBlocked && <p role="status">{t.workspaceDiscardBlocked}</p>}
          <label htmlFor="planning-recovery-copy">{t.planningSavedPlan}</label>
          <textarea
            id="planning-recovery-copy"
            readOnly
            value={JSON.stringify(p, null, 2)}
          />
        </div>
      </details>
      {!initialEligible && (
        <div className="creation-complete">
          <p>{t.createDraftComplete}</p>
          <button onClick={openReview}>{t.createOpenReview}</button>
        </div>
      )}
      <details
        className="creation-assistance"
        open={assistanceOpen}
        onToggle={(event) => setAssistanceOpen(event.currentTarget.open)}
      >
        <summary>{t.createPlanningAssistance}</summary>
        <fieldset
          className="planning-brief"
          disabled={inputLocked}
          onCompositionStart={() => planning.composition(true)}
          onCompositionEnd={() => planning.composition(false)}
        >
          {([["topic", t.planningTopic]] as const).map(([field, label]) => (
            <div className="planning-field" key={field}>
              <label htmlFor={`planning-brief-${field}`}>{label}</label>
              <input
                id={`planning-brief-${field}`}
                aria-invalid={briefInvalid(field)}
                aria-describedby={
                  briefInvalid(field) ? `planning-error-${field}` : undefined
                }
                value={p.brief[field]}
                onChange={(e) => patchBrief(field, e.target.value)}
                onBlur={() => planning.boundary()}
              />
              {briefInvalid(field) && (
                <p id={`planning-error-${field}`} className="field-error">
                  {t.workspaceValidationLength}
                </p>
              )}
            </div>
          ))}
          <details className="planning-preferences">
            <summary>{t.createPreferences}</summary>
            {(
              [
                ["audience", t.planningAudience],
                ["style", t.planningStyle],
                ["lengthHint", t.planningLength],
              ] as const
            ).map(([field, label]) => (
              <div className="planning-field" key={field}>
                <label htmlFor={`planning-brief-${field}`}>{label}</label>
                <input
                  id={`planning-brief-${field}`}
                  value={p.brief[field]}
                  aria-invalid={briefInvalid(field)}
                  onChange={(event) => patchBrief(field, event.target.value)}
                  onBlur={() => planning.boundary()}
                />
                {briefInvalid(field) && (
                  <p className="field-error">{t.workspaceValidationLength}</p>
                )}
              </div>
            ))}
          </details>
          <div className="planning-field">
            <label htmlFor="planning-language">{t.planningLanguage}</label>
            <select
              id="planning-language"
              value={p.brief.language}
              onChange={(event) => patchBrief("language", event.target.value)}
            >
              {!["zh-CN", "en"].includes(p.brief.language) && (
                <option value={p.brief.language}>
                  {t.workspaceUnsupportedLanguage.replace(
                    "{language}",
                    p.brief.language,
                  )}
                </option>
              )}
              <option value="zh-CN">中文</option>
              <option value="en">English</option>
            </select>
          </div>
        </fieldset>
        <details className="planning-outline" open={!!p.nodes.length}>
          <summary>{t.planningOutline}</summary>
          <h3>{t.planningOutline}</h3>
          {p.nodes.map((node, i) => (
            <div
              className="outline-node"
              key={node.id}
              style={{ marginInlineStart: `${node.depth * 1.2}rem` }}
              onCompositionStart={() => planning.composition(true)}
              onCompositionEnd={() => planning.composition(false)}
            >
              <div>
                <label htmlFor={`outline-title-${node.id}`}>
                  {t.planningOutline} {i + 1}
                </label>
                <input
                  id={`outline-title-${node.id}`}
                  aria-invalid={[...node.title].length > 300}
                  aria-describedby={
                    [...node.title].length > 300
                      ? `outline-title-error-${node.id}`
                      : undefined
                  }
                  disabled={inputLocked}
                  aria-label={`${t.planningOutline} ${i + 1}`}
                  value={node.title}
                  onChange={(e) =>
                    update(
                      {
                        ...p,
                        nodes: p.nodes.map((n) =>
                          n.id === node.id
                            ? { ...n, title: e.target.value }
                            : n,
                        ),
                      },
                      `${node.id}:title`,
                    )
                  }
                  onBlur={() => planning.boundary()}
                />
                {[...node.title].length > 300 && (
                  <p
                    id={`outline-title-error-${node.id}`}
                    className="field-error"
                  >
                    {t.workspaceValidationLength}
                  </p>
                )}
              </div>
              <div>
                <label htmlFor={`outline-points-${node.id}`}>
                  {t.planningKeyPoints}
                </label>
                <textarea
                  id={`outline-points-${node.id}`}
                  aria-invalid={
                    node.keyPoints.length > 20 ||
                    node.keyPoints.some((point) => [...point].length > 1000)
                  }
                  aria-describedby={
                    node.keyPoints.length > 20 ||
                    node.keyPoints.some((point) => [...point].length > 1000)
                      ? `outline-points-error-${node.id}`
                      : undefined
                  }
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
                  onBlur={() => planning.boundary()}
                />
                {(node.keyPoints.length > 20 ||
                  node.keyPoints.some((point) => [...point].length > 1000)) && (
                  <p
                    id={`outline-points-error-${node.id}`}
                    className="field-error"
                  >
                    {t.workspaceValidationLength}
                  </p>
                )}
              </div>
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
        </details>
        <div hidden={!p.nodes.length}>
          <label htmlFor="planning-instruction">{t.planningInstruction}</label>
          <textarea
            id="planning-instruction"
            aria-invalid={new TextEncoder().encode(p.instruction).length > 8192}
            aria-describedby={
              new TextEncoder().encode(p.instruction).length > 8192
                ? "planning-instruction-error"
                : undefined
            }
            disabled={inputLocked}
            value={p.instruction}
            onCompositionStart={() => planning.composition(true)}
            onCompositionEnd={() => planning.composition(false)}
            onChange={(e) =>
              update({ ...p, instruction: e.target.value }, "instruction")
            }
            onBlur={() => planning.boundary()}
          />
          {new TextEncoder().encode(p.instruction).length > 8192 && (
            <p id="planning-instruction-error" className="field-error">
              {t.workspaceValidationLength}
            </p>
          )}
        </div>
        <section
          className="planning-reference-summary"
          aria-label={t.planningEvidence}
        >
          <h3>
            {t.librarySelectedCount.replace(
              "{count}",
              String(p.evidence.length),
            )}
          </h3>
          {!p.evidence.length && (
            <p className="muted">{t.planningNoEvidence}</p>
          )}
          <ul>
            {p.evidence.map((choice) => (
              <li key={choice.sourceId}>
                <span>
                  {sources.find((item) => item.source.id === choice.sourceId)
                    ?.source.title ?? t.sources}
                </span>
                <button
                  className="quiet-button"
                  disabled={locked}
                  aria-label={`${t.removeReference}: ${sources.find((item) => item.source.id === choice.sourceId)?.source.title ?? t.sources}`}
                  onClick={() => updateEvidence(choice.sourceId, null)}
                >
                  {t.removeReference}
                </button>
              </li>
            ))}
          </ul>
          <button className="quiet-button" onClick={openLibrary}>
            {t.libraryOpen}
          </button>
        </section>
        <div className="planning-primary">
          {!p.nodes.length && (
            <button
              className="primary-action"
              disabled={locked || !!activeTask || !ready}
              onClick={() => void start("generate_outline")}
            >
              {t.planningGenerateOutline}
            </button>
          )}
          {!!p.nodes.length && (
            <button
              className="quiet-button"
              disabled={
                locked || !!activeTask || !p.instruction.trim() || !ready
              }
              onClick={() => void start("adjust_outline")}
            >
              {t.planningAdjust}
            </button>
          )}
          {initialEligible && !!p.nodes.length && (
            <button
              className="primary-action"
              disabled={locked || !!activeTask || !p.nodes.length || !ready}
              onClick={() => void start("generate_initial_draft")}
            >
              {t.planningDraft}
            </button>
          )}
        </div>
        <details className="planning-technical">
          <summary>{t.planningPrepared}</summary>
          <button
            disabled={locked}
            onClick={() =>
              void prepare(
                p.nodes.length
                  ? initialEligible
                    ? "generate_initial_draft"
                    : "adjust_outline"
                  : "generate_outline",
              )
            }
          >
            {t.planningPrepare}
          </button>

          {prepared && (
            <div>
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
                  {e.sourceId} · {message(e.level)} · {e.location} ·{" "}
                  {e.contentHash}
                </p>
              ))}
            </div>
          )}
        </details>
      </details>
      {!!planning.state.tasks.length && (
        <section className="planning-tasks">
          <h3>{t.planningTasks}</h3>
          {planning.state.tasks.map((task) => (
            <article key={task.id}>
              <p>
                {message(task.operation)} · {message(task.run.status)} ·{" "}
                {message(task.application)}
              </p>
              {task.error && <p role="alert">{message(task.error)}</p>}

              {["pending", "not_applied"].includes(task.application) && (
                <button
                  disabled={acting}
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
                    disabled={acting}
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
                <p>
                  {t.planningConfig}: {task.run.configuration.provider.label} /{" "}
                  {task.run.configuration.model.id}
                </p>
                <pre>{task.preview}</pre>
              </details>
            </article>
          ))}
        </section>
      )}
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
