import { useEffect, useRef, useState } from "react";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type { DocumentJob, Intake } from "@scenesparrow/contracts";
import type en from "../locales/en.json";
import { useErrorNotification } from "../feedback/NotificationPresenter";
import { notifyFailure } from "../feedback/notifications";
import type { ProjectSession } from "../project-session/project-session";
import { warningMessage } from "../library/document-warnings";

export function ImportDialog({
  client,
  save,
  projectId,
  t,
  close,
}: {
  client: PlatformClient;
  save: ProjectSession;
  projectId: string;
  t: typeof en;
  close: () => void;
}) {
  const [paste, setPaste] = useState(""),
    [job, setJob] = useState<DocumentJob | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useErrorNotification(error);
  const [committing, setCommitting] = useState(false);
  const current = useRef<string | null>(null),
    abort = useRef<AbortController | null>(null),
    live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
      abort.current?.abort();
      if (current.current)
        void client
          .documentAction({ type: "cancel", jobId: current.current })
          .catch(() => {});
    },
    [client],
  );
  async function prepare(file?: File, pick = false) {
    setError("");
    setBusy(true);
    let intake: Intake | null = null;
    try {
      if (!(await save.prepareInput())) {
        setError("REVISION_CONFLICT");
        return;
      }
      if (!live.current) return;
      if (current.current)
        await client.documentAction({ type: "cancel", jobId: current.current });
      abort.current = new AbortController();
      if (pick) intake = await client.pickFileIntake!(abort.current.signal);
      else if (file)
        intake = await client.uploadFile(file, abort.current.signal);
      if ((pick || file) && !intake) return;
      if (!live.current || abort.current.signal.aborted) {
        if (intake) await client.cancelIntake(intake.id);
        return;
      }
      const id = crypto.randomUUID();
      current.current = id;
      let result = await client.documentAction(
        intake
          ? {
              type: "prepareFile",
              jobId: id,
              intakeId: intake.id,
              expectedWorkingRevision: save.state.workingRevision,
            }
          : {
              type: "preparePaste",
              jobId: id,
              text: paste,
              expectedWorkingRevision: save.state.workingRevision,
            },
      );
      if (!live.current) {
        await client.documentAction({ type: "cancel", jobId: id });
        return;
      }
      if (live.current) setJob(result);
      while (
        live.current &&
        current.current === id &&
        ["queued", "running"].includes(result.status)
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
        if (!live.current || current.current !== id) break;
        result = await client.documentJob(id);
        if (live.current) setJob(result);
      }
      if (result.error && live.current) setError(result.error);
    } catch (e) {
      if (intake) await client.cancelIntake(intake.id).catch(() => {});
      if (live.current && !abort.current?.signal.aborted)
        setError(e instanceof Error ? e.message : "WORKER_UNAVAILABLE");
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function commit(mode: "start" | "append" | "replace") {
    if (!job?.candidateHash) return;
    setBusy(true);
    abort.current = new AbortController();
    try {
      const ok = await save.business(
        (revision) => ({
          type: "CommitManuscriptImport",
          requestId: crypto.randomUUID(),
          projectId,
          expectedWorkingRevision: revision,
          payload: {
            preparedId: job.id,
            candidateHash: job.candidateHash!,
            mode,
          },
        }),
        { signal: abort.current.signal, dispatched: () => setCommitting(true) },
      );
      if (!live.current) return;
      setBusy(false);
      setCommitting(false);
      if (ok) {
        current.current = null;
        close();
      } else setError(save.error || "IMPORT_STALE");
    } catch (failure) {
      if (live.current && !abort.current?.signal.aborted) {
        notifyFailure(failure);
        setError(failure instanceof Error ? failure.message : "IMPORT_STALE");
      }
    } finally {
      if (live.current) {
        setBusy(false);
        setCommitting(false);
      }
    }
  }
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t.importManuscript}
      className="import-dialog"
    >
      <h3>{t.importManuscript}</h3>
      <p>{t.importHelp}</p>
      <label>
        {t.pasteManuscript}
        <textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          disabled={busy}
        />
      </label>
      <button disabled={busy || !paste.trim()} onClick={() => void prepare()}>
        {t.preparePreview}
      </button>
      {client.pickFileIntake ? (
        <button disabled={busy} onClick={() => void prepare(undefined, true)}>
          {t.importFile}
        </button>
      ) : (
        <label>
          {t.importFile}
          <input
            aria-label={t.importFile}
            type="file"
            accept=".txt,.md,.markdown,.docx,.pdf"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void prepare(f);
            }}
          />
        </label>
      )}
      {busy && <p role="status">{t.preparing}</p>}
      {job?.result && (
        <>
          <h4>{t.importPreview}</h4>
          <pre data-testid="import-preview">{job.result.text}</pre>
          {job.result.warnings.map((w) => (
            <p key={w}>{warningMessage(w, t)}</p>
          ))}
          {job.result.hasImages && <p>{t.imagesUnprocessed}</p>}
          <p>
            {t.parserProvenance}: {job.result.parser}
          </p>
        </>
      )}
      {job?.status === "ready" && job.candidateHash && (
        <div>
          {save.state.workspaceStage === "outline" ? (
            <button disabled={busy} onClick={() => void commit("start")}>
              {t.startFromImport}
            </button>
          ) : (
            <>
              <button disabled={busy} onClick={() => void commit("append")}>
                {t.appendImport}
              </button>
              <button disabled={busy} onClick={() => void commit("replace")}>
                {t.replaceImport}
              </button>
            </>
          )}
        </div>
      )}
      <button
        disabled={committing || save.hasUnresolvedBusiness}
        onClick={() => {
          abort.current?.abort();
          close();
        }}
      >
        {t.cancel}
      </button>
    </div>
  );
}
