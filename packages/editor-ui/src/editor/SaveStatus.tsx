import type en from "../locales/en.json";
import type { Autosave } from "./autosave";
import type { PlanningFeedback } from "./Planning";
export function SaveStatus({
  save,
  planning,
  openPlanning,
  t,
  recover,
}: {
  save: Autosave;
  planning: PlanningFeedback | null;
  openPlanning: () => void;
  t: typeof en;
  recover: () => void;
}) {
  const priorities = { saved: 0, saving: 1, pending: 2, error: 3, conflict: 4 };
  const bodyFailed =
    ["error", "conflict"].includes(save.status) &&
    save.failureOwner === "manuscript";
  const planOwns =
    !bodyFailed &&
    !!planning &&
    (priorities[planning.status] > priorities[save.status] ||
      (save.failureOwner === "planning" &&
        ["error", "conflict"].includes(planning.status)));
  const status = planOwns ? planning.status : save.status;
  const error = planOwns ? planning.error : save.error;
  const failed = status === "error" || status === "conflict";
  return (
    <div className="save-feedback">
      <span
        role="status"
        data-testid="save-status"
        data-state={status}
        data-owner={planOwns ? "planning" : "manuscript"}
      >
        {t[`save_${status}`]}
      </span>
      {failed && (
        <>
          <span
            className="save-error-code"
            title={t[error as keyof typeof t] ?? t.saveErrorHelp}
            data-testid="save-error-code"
            data-error-code={error}
          >
            {t[error as keyof typeof t] ?? t.saveErrorHelp}
          </span>
          {status !== "conflict" && (
            <button
              className="quiet-button"
              onClick={async () => {
                if (planOwns) planning.retry();
                else if (await save.flush(true))
                  await save.planningAdapter?.flush(true);
              }}
            >
              {t.retry}
            </button>
          )}
          <button
            className="quiet-button"
            onClick={planOwns ? openPlanning : recover}
          >
            {t.workspaceRecoveryDetails}
          </button>
        </>
      )}
    </div>
  );
}
