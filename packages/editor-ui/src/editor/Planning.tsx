import { useEffect } from "react";
import type en from "../locales/en.json";
import type { PlanningContent } from "@scenesparrow/contracts";
import type { Autosave, SaveStatus } from "./autosave";
import type { PlanningEvidenceBridge } from "./evidence";
import type { PlanningSession, WritingView } from "./use-planning-session";
import { useOpenSettings } from "../NotificationPresenter";
import { useSavedAiView } from "../ai-settings/saved-view";
export type PlanningFeedback = {
  status: SaveStatus;
  error: string;
  retry: () => Promise<unknown>;
};
export function Planning({
  session,
  save,
  t,
  view,
  onStatus,
  onEvidence,
  openLibrary,
}: {
  session: PlanningSession;
  save: Autosave;
  t: typeof en;
  view: WritingView;
  onStatus: (feedback: PlanningFeedback) => void;
  onEvidence: (bridge: PlanningEvidenceBridge) => void;
  openLibrary: () => void;
}) {
  const { planning, acting, start, control, setRecovery, setDiagnostics } =
    session;
  const openSettings = useOpenSettings(),
    cached = useSavedAiView();
  const model = cached?.settings.bindings.find(
    (binding) => binding.category === "text",
  );
  useEffect(() => {
    if (planning)
      onStatus({
        status: planning.status,
        error: planning.error,
        retry: () => planning.flush(true, true),
      });
  }, [planning, planning?.status, planning?.error, onStatus]);
  const p = planning?.local,
    locked = !!planning?.state.reserved || save.stageTransitionPending;
  useEffect(() => {
    if (!planning || !p) return;
    onEvidence({
      choices: p.evidence,
      locked,
      update: (sourceId, choice) => {
        planning.afterComposition(() => {
          if (planning.state.reserved || save.stageTransitionPending) return;
          const current = planning.local;
          planning.edit(
            {
              ...current,
              evidence: [
                ...current.evidence.filter(
                  (item) => item.sourceId !== sourceId,
                ),
                ...(choice ? [choice] : []),
              ],
            },
            "evidence",
            true,
          );
        }, `planning-evidence:${sourceId}`);
      },
    });
  }, [planning, p, locked, onEvidence, save]);
  if (!planning || !p)
    return session.loadFailed ? (
      <button className="quiet-button" onClick={session.retryLoad}>
        {t.retry}
      </button>
    ) : (
      <p role="status">{t.planningLoading}</p>
    );
  const patch = (field: keyof PlanningContent["brief"], value: string) =>
    planning.edit(
      { ...planning.local, brief: { ...planning.local.brief, [field]: value } },
      `brief:${field}`,
    );
  const hasOutline = !!p.nodes.length;
  const active = planning.state.tasks.find(
    (task) =>
      task.application === "pending" &&
      ["queued", "running", "cancelling", "succeeded"].includes(
        task.run.status,
      ),
  );
  const ready =
    !!p.brief.topic.trim() &&
    !planning.recoveryText &&
    p.nodes.every((node) => !!node.title.trim());
  const initialEligible =
    save.state.workspaceStage === "outline" &&
    !save.local.length &&
    !save.recoveryText;
  const adjust = hasOutline && !!p.instruction.trim();
  const disabled = locked || acting || !!active || !ready;
  return (
    <section
      className="writing-assistant"
      aria-label={t.workspaceTab_planning}
      onCompositionStart={() => planning.composition(true)}
      onCompositionEnd={() => planning.composition(false)}
      onBlurCapture={() => {
        planning.compositionBlur();
      }}
    >
      <div className="assistant-context">
        <span>{view === "outline" ? t.writingOutline : t.manuscript}</span>
        <button className="quiet-button" onClick={openLibrary}>
          {t.librarySelectedCount.replace("{count}", String(p.evidence.length))}
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
      <p className="muted assistant-introduction">
        {hasOutline ? t.writingOutlineAssistant : t.writingIdeaHelp}
      </p>
      {active && (
        <p className="assistant-progress" role="status">
          {t.writingWorking}
          <button onClick={() => void control("CancelPlanningTask", active.id)}>
            {t.cancel}
          </button>
        </p>
      )}
      <fieldset disabled={locked} className="assistant-brief">
        <div className="assistant-language">
          <label htmlFor="planning-language">{t.planningLanguage}</label>
          <select
            id="planning-language"
            value={p.brief.language}
            onChange={(event) => patch("language", event.target.value)}
          >
            {!["zh-CN", "en"].includes(p.brief.language) && (
              <option value={p.brief.language}>{p.brief.language}</option>
            )}
            <option value="zh-CN">中文</option>
            <option value="en">English</option>
          </select>
        </div>
        <details className="assistant-preferences">
          <summary>{t.writingBrief}</summary>
          {(
            [
              ...(hasOutline ? (["topic"] as const) : []),
              "audience",
              "style",
              "lengthHint",
            ] as const
          ).map((field) => (
            <label key={field}>
              {
                {
                  topic: t.planningTopic,
                  audience: t.planningAudience,
                  style: t.planningStyle,
                  lengthHint: t.planningLength,
                }[field]
              }
              <input
                id={`planning-brief-${field}`}
                value={p.brief[field]}
                aria-invalid={
                  [...p.brief[field]].length > (field === "topic" ? 500 : 2000)
                }
                onChange={(event) => patch(field, event.target.value)}
                onBlur={() => planning.boundary()}
              />
            </label>
          ))}
        </details>
        <label htmlFor={hasOutline ? "planning-instruction" : "planning-idea"}>
          {hasOutline ? t.planningInstruction : t.writingIdea}
        </label>
        <textarea
          id={hasOutline ? "planning-instruction" : "planning-idea"}
          value={hasOutline ? p.instruction : p.brief.topic}
          aria-invalid={
            hasOutline
              ? new TextEncoder().encode(p.instruction).length > 8192
              : [...p.brief.topic].length > 500
          }
          placeholder={
            hasOutline ? t.writingAdjustPlaceholder : t.writingIdeaPlaceholder
          }
          onChange={(event) =>
            hasOutline
              ? planning.edit(
                  { ...planning.local, instruction: event.target.value },
                  "instruction",
                )
              : patch("topic", event.target.value)
          }
          onBlur={() => planning.boundary()}
        />
      </fieldset>
      {(!hasOutline || adjust || initialEligible) && (
        <button
          className="primary-action assistant-send"
          disabled={disabled}
          onClick={() =>
            void start(
              !hasOutline
                ? "generate_outline"
                : adjust
                  ? "adjust_outline"
                  : "generate_initial_draft",
            )
          }
        >
          {!hasOutline
            ? t.planningGenerateOutline
            : adjust
              ? t.planningAdjust
              : t.writingConfirmDraft}
        </button>
      )}
      {adjust && initialEligible && (
        <button
          className="quiet-button"
          disabled={disabled}
          onClick={() => void start("generate_initial_draft")}
        >
          {t.writingConfirmDraft}
        </button>
      )}
      {!!hasOutline && !initialEligible && !adjust && (
        <p className="muted">{t.workspacePlanPreservesBody}</p>
      )}
      <div className="assistant-secondary">
        <button className="quiet-button" onClick={() => setDiagnostics(true)}>
          {t.writingResults}
        </button>
        {["error", "conflict"].includes(planning.status) && (
          <button className="quiet-button" onClick={() => setRecovery(true)}>
            {t.noticeRecovery}
          </button>
        )}
      </div>
    </section>
  );
}
