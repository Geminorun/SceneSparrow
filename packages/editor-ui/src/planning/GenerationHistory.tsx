import type {
  PlanningTask,
  PlanningPreparationRequest,
} from "@scenesparrow/contracts";
import type en from "../locales/en.json";
import type { PlanningSession } from "./use-planning-session";
import type { ProjectSession } from "../project-session/project-session";
import { errorMessage } from "../feedback/notifications";
const operations = [
  "generate_outline",
  "adjust_outline",
  "generate_initial_draft",
];
const activeTask = (task: PlanningTask) =>
  task.application === "pending" &&
  ["queued", "running", "cancelling", "succeeded"].includes(task.run.status);
export function planningProgress(task: PlanningTask, t: typeof en) {
  const operation =
    task.operation === "generate_initial_draft"
      ? t.writingProgressDraft
      : task.operation === "adjust_outline"
        ? t.writingProgressAdjust
        : t.writingProgressOutline;
  return task.run.status === "queued"
    ? t.writingProgressQueued
    : task.run.status === "cancelling"
      ? t.writingProgressCancelling
      : task.run.status === "succeeded"
        ? t.writingProgressApplying
        : operation;
}
export function GenerationHistoryButton({
  session,
  t,
}: {
  session: PlanningSession;
  t: typeof en;
}) {
  return (
    <button
      className="quiet-button history-icon"
      data-generation-history
      aria-label={t.writingGenerationHistory}
      title={t.writingGenerationHistory}
      onClick={() => session.navigateHistory(true)}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <path d="M3 10a9 9 0 1 1 1 7M3 4v6h6M12 7v5l3 2" />
      </svg>
    </button>
  );
}
export function GenerationHistory({
  session,
  save,
  t,
}: {
  session: PlanningSession;
  save: ProjectSession;
  t: typeof en;
}) {
  const { planning, acting, start, control } = session;
  const tasks = planning?.state.tasks ?? [];
  const busy =
    acting ||
    !!planning?.state.reserved ||
    save.stageTransitionPending ||
    tasks.some(activeTask);
  const initialEligible =
    save.state.workspaceStage === "outline" &&
    !save.local.length &&
    !save.recoveryText;
  const ready =
    !!planning?.local.brief.topic.trim() &&
    !planning.recoveryText &&
    planning.local.nodes.every((node) => !!node.title.trim());
  return (
    <section
      className="generation-history"
      aria-label={t.writingGenerationHistory}
    >
      <div className="generation-history-heading">
        <button
          className="quiet-button generation-history-back"
          onClick={() => session.navigateHistory(false)}
        >
          ← {t.writingBackAssistant}
        </button>
        <h2>{t.writingGenerationHistory}</h2>
      </div>
      <p className="muted">{t.writingHistoryHelp}</p>
      {session.pendingStart && (
        <div>
          <p className="muted">{t.writingStartUnconfirmed}</p>
          <button disabled={acting} onClick={() => void session.recoverStart()}>
            {t.writingCheckTask}
          </button>
        </div>
      )}
      {!planning && <button onClick={session.retryLoad}>{t.retry}</button>}
      {planning && !tasks.length && (
        <p className="muted">{t.writingNoResults}</p>
      )}
      {tasks
        .slice()
        .reverse()
        .map((task) => {
          const active = activeTask(task);
          const failure = task.error ?? task.run.error;
          const draft = task.operation === "generate_initial_draft";
          const usable =
            task.application === "not_applied" &&
            !!task.preview &&
            !!task.run.result &&
            (!draft || initialEligible);
          const applied = task.application === "applied";
          const outcome = active
            ? planningProgress(task, t)
            : applied
              ? t.writingHistoryCompleted
              : usable
                ? t.writingHistoryReady
                : task.application === "cancelled" ||
                    task.run.status === "cancelled"
                  ? t.cancelled
                  : task.application === "pruned"
                    ? t.writingHistoryUnavailable
                    : task.error === "NO_CHANGE"
                      ? t.writingHistoryNoChange
                      : task.run.status === "failed" ||
                          task.run.status === "interrupted" ||
                          task.application === "invalid"
                        ? t.writingHistoryFailed
                        : t.writingHistoryChanged;
          return (
            <article className="writing-result" key={task.id}>
              <h3>
                {task.operation === "generate_outline"
                  ? t.generate_outline
                  : task.operation === "adjust_outline"
                    ? t.adjust_outline
                    : t.generate_initial_draft}
              </h3>
              <p role={active ? "status" : undefined}>{outcome}</p>
              {!active &&
                failure &&
                !["NO_CHANGE", "CANCELLED", "HISTORY_DIVERGED"].includes(
                  failure,
                ) && <p className="muted">{errorMessage(failure, t)}</p>}
              {active && (
                <button
                  disabled={acting || task.run.status === "cancelling"}
                  onClick={() => void control("CancelPlanningTask", task.id)}
                >
                  {t.cancel}
                </button>
              )}
              {applied &&
                (draft
                  ? save.local.length > 0
                  : !!planning?.local.nodes.length) && (
                  <button
                    onClick={() =>
                      session.viewCurrent(draft ? "manuscript" : "outline")
                    }
                  >
                    {draft
                      ? t.writingViewCurrentBody
                      : t.writingViewCurrentOutline}
                  </button>
                )}
              {usable && (
                <button
                  disabled={busy}
                  onClick={() => void control("UsePlanningResult", task.id)}
                >
                  {t.planningUseResult}
                </button>
              )}
              {!active &&
                operations.includes(task.operation) &&
                (!draft || initialEligible) && (
                  <button
                    disabled={
                      busy ||
                      !ready ||
                      (task.operation !== "generate_outline" &&
                        !planning?.local.nodes.length)
                    }
                    onClick={() =>
                      void start(
                        task.operation as PlanningPreparationRequest["operation"],
                        task.id,
                      )
                    }
                  >
                    {t.writingGenerateAgain}
                  </button>
                )}
              <details className="generation-diagnostics">
                <summary>{t.writingDiagnostics}</summary>
                <p>
                  {task.run.configuration.provider.label} ·{" "}
                  {task.run.configuration.model.id}
                </p>
                <pre>
                  {JSON.stringify(
                    {
                      taskId: task.id,
                      outcome: task.application,
                      run: task.run,
                      metadata: task.metadata,
                    },
                    null,
                    2,
                  )}
                </pre>
                {task.preview && <pre>{task.preview}</pre>}
              </details>
            </article>
          );
        })}
    </section>
  );
}
