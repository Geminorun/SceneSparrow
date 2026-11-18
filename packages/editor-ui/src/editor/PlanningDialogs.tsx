import { useEffect, useRef, type ReactNode } from "react";
import type en from "../locales/en.json";
import type { PlanningPreparationRequest } from "@scenesparrow/contracts";
import type { PlanningSession } from "./use-planning-session";
import { outlineSource } from "./outline-codec";
import { useNoticeOwner } from "../NotificationPresenter";
import { trapDialogFocus } from "../dialog-focus";
function Dialog({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      className="writing-dialog"
      ref={dialog}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(event) => {
        if (dialog.current) trapDialogFocus(event, dialog.current);
      }}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button aria-label={title} onClick={close}>
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function PlanningDialogs({
  session,
  t,
}: {
  session: PlanningSession;
  t: typeof en;
}) {
  const { report } = useNoticeOwner();
  const {
    planning,
    recovery,
    setRecovery,
    diagnostics,
    setDiagnostics,
    acting,
    start,
    control,
  } = session;
  if (!planning) return null;
  return (
    <>
      {recovery && (
        <Dialog title={t.noticeRecovery} close={() => setRecovery(false)}>
          <p>{t.writingOutlineRecovery}</p>
          <textarea
            aria-label={t.localCopy}
            readOnly
            value={
              planning.recoveryText ??
              [
                t.planningTopic + ": " + planning.local.brief.topic,
                t.planningLanguage + ": " + planning.local.brief.language,
                t.planningAudience + ": " + planning.local.brief.audience,
                t.planningStyle + ": " + planning.local.brief.style,
                t.planningLength + ": " + planning.local.brief.lengthHint,
                "",
                outlineSource(planning.local.nodes),
                "",
                planning.local.instruction,
              ].join("\n")
            }
          />
          <button onClick={() => void planning.flush(true, true)}>
            {t.retry}
          </button>
          <button
            onClick={async () => {
              try {
                if (
                  window.confirm(t.workspaceDiscardConfirm) &&
                  (await planning.discard())
                )
                  setRecovery(false);
              } catch (error) {
                report(error);
              }
            }}
          >
            {t.discardAndReload}
          </button>
          <button onClick={() => setRecovery(false)}>{t.keepEditing}</button>
        </Dialog>
      )}
      {diagnostics && (
        <Dialog title={t.writingResults} close={() => setDiagnostics(false)}>
          {!planning.state.tasks.length && (
            <p className="muted">{t.writingNoResults}</p>
          )}
          {planning.state.tasks
            .slice()
            .reverse()
            .map((task) => (
              <article className="writing-result" key={task.id}>
                <h3>
                  {t[task.operation as keyof typeof t] ?? t.writingResults}
                </h3>
                <p>
                  {t[task.application as keyof typeof t] ?? t.writingResults}
                </p>
                <p>
                  {task.run.configuration.provider.label} ·{" "}
                  {task.run.configuration.model.id}
                </p>
                {task.metadata?.verificationHints.map((hint, index) => (
                  <p key={`hint-${index}`}>{hint}</p>
                ))}
                {task.metadata?.planningNotes.map((note, index) => (
                  <p key={`note-${index}`}>{note}</p>
                ))}
                {task.metadata?.evidence.map((item) => (
                  <p key={item.id}>
                    {item.location} ·{" "}
                    {t[item.level as keyof typeof t] ?? t.planningEvidence}
                  </p>
                ))}
                {task.preview && (
                  <details>
                    <summary>{t.planningTaskDetails}</summary>
                    <pre>{task.preview}</pre>
                  </details>
                )}
                {task.application === "not_applied" && (
                  <button
                    disabled={acting || planning.state.reserved}
                    onClick={() => void control("UsePlanningResult", task.id)}
                  >
                    {t.planningUseResult}
                  </button>
                )}
                {!["applied", "pending"].includes(task.application) && (
                  <button
                    disabled={acting}
                    onClick={() =>
                      void start(
                        task.operation as PlanningPreparationRequest["operation"],
                        task.id,
                      )
                    }
                  >
                    {t.retry}
                  </button>
                )}
              </article>
            ))}
        </Dialog>
      )}
    </>
  );
}
