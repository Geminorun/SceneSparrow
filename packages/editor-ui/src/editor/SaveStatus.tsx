import { useEffect, useRef, useState } from "react";
import { useNoticeOwner } from "../NotificationPresenter";
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
  const { report, resolve } = useNoticeOwner();
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const retry = async () => {
    if (planOwns) await planning.retry();
    else if (await save.flush(true)) await save.planningAdapter?.flush(true);
    if (mounted.current) setAttempt((value) => value + 1);
  };
  const callbacks = useRef({
    retry,
    recover: planOwns ? openPlanning : recover,
  });
  callbacks.current = { retry, recover: planOwns ? openPlanning : recover };
  const previousError = useRef<string | null>(null);
  useEffect(() => {
    if (!failed) {
      previousError.current = null;
      resolve("save");
      return;
    }
    if (previousError.current !== null && previousError.current !== error)
      resolve("save");
    previousError.current = error;
    report(error ?? "error", {
      identity: "save",
      actions: [
        ...(status === "conflict"
          ? []
          : [{ kind: "retry" as const, run: () => callbacks.current.retry() }]),
        { kind: "recovery", run: () => callbacks.current.recover() },
      ],
    });
  }, [failed, status, error, planOwns, report, resolve, attempt]);
  return (
    <div className="save-feedback">
      <span
        role="status"
        data-testid="save-status"
        data-state={status}
        title={failed ? t.saveUnsaved : t[`save_${status}`]}
        data-owner={planOwns ? "planning" : "manuscript"}
      >
        {failed ? t.saveUnsaved : t[`save_${status}`]}
      </span>
      {failed && (
        <>
          <button
            className="quiet-button"
            onClick={planOwns ? openPlanning : recover}
          >
            {t.noticeRecovery}
          </button>
        </>
      )}
    </div>
  );
}
