import { useEffect, useRef, type ReactNode } from "react";
import type en from "../locales/en.json";
import type { PlanningSession } from "./use-planning-session";
import { outlineSource } from "./outline-codec";
import { useNoticeOwner } from "../NotificationPresenter";
import { trapDialogFocus } from "../dialog-focus";
export function WritingDialog({
  title,
  close,
  closeLabel,
  closeDisabled = false,
  children,
}: {
  title: string;
  close: () => void;
  closeLabel: string;
  closeDisabled?: boolean;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    node?.showModal();
    return () => {
      node?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      className="writing-dialog"
      ref={dialog}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!closeDisabled) close();
      }}
      onKeyDown={(event) => {
        if (dialog.current) trapDialogFocus(event, dialog.current);
      }}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button
          aria-label={closeLabel}
          disabled={closeDisabled}
          onClick={close}
        >
          ×
        </button>
      </div>
      <div className="writing-dialog-body">{children}</div>
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
  const { planning, recovery, setRecovery } = session;
  if (!planning) return null;
  return (
    <>
      {recovery && (
        <WritingDialog
          closeLabel={t.close}
          title={t.noticeRecovery}
          close={() => setRecovery(false)}
        >
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
        </WritingDialog>
      )}
    </>
  );
}
