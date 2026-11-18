import type en from "../locales/en.json";
import type { PlanningSession } from "./use-planning-session";
import { outlineSource } from "./outline-codec";
import { useNoticeOwner } from "../feedback/NotificationPresenter";
import { WritingDialog } from "../ui/WritingDialog";
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
