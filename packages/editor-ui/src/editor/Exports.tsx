import { useTaskNotifications } from "../NotificationPresenter";
import { notifyFailure } from "../notifications";
import { useEffect, useRef, useState } from "react";
import type {
  CopyRequest,
  PreparedCopy,
  ExportJob,
  ExportRequest,
  ExportRetry,
} from "@scenesparrow/contracts";
import { ApiError, type PlatformClient } from "@scenesparrow/platform-client";
import type en from "../locales/en.json";
import type { Autosave } from "./autosave";
export function Exports({
  client,
  save,
  t,
}: {
  client: PlatformClient;
  save: Autosave;
  t: typeof en;
}) {
  const [format, setFormat] = useState<ExportRequest["format"]>("md");
  const [job, setJob] = useState<ExportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<ExportJob[]>([]);
  const touched = useRef(false);
  const pendingControl = useRef<{
    kind: "cancel" | "retry";
    job: ExportJob;
    request: {
      requestId: string;
      attempt: number;
      mode: "retained";
      expectedRevision: number;
    };
  } | null>(null);
  const [message, setMessage] = useState<keyof typeof en | "">("");
  useTaskNotifications(
    job && touched.current
      ? [
          {
            id: `${job.id}:${job.attempt}`,
            status: job.status,
            error: job.error,
          },
        ]
      : [],
  );
  const [prepared, setPrepared] = useState<PreparedCopy | null>(null);
  const pending = useRef<
    | { request: ExportRequest; copy: false }
    | { request: CopyRequest; copy: true }
    | {
        request: ExportRetry;
        copy: false;
        source: { id: string; attempt: number };
      }
    | null
  >(null);
  const active = useRef(true);
  const [currentBodyHash, setCurrentBodyHash] = useState("");
  const currentToken = `canonical-1|${save.state.manuscriptId}|${save.state.schemaVersion}|${save.state.blocks.map((b) => `${b.id}:${b.revision}`).join("|")}`;
  const hashToken = async (token: string) =>
    [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
      ),
    ]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
  useEffect(() => {
    let live = true;
    void hashToken(currentToken).then((hash) => {
      if (live) setCurrentBodyHash(hash);
    });
    return () => {
      live = false;
    };
  }, [currentToken]);
  const delivery = useRef<{ id: string; job: string } | null>(null);
  const localMessage = (code: string) =>
    code === "NO_MANUSCRIPT_CONTENT"
      ? "exportNoContent"
      : code === "DELIVERY_STATUS_UNKNOWN"
        ? "exportUnknown"
        : "exportFailed";
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, [client]);
  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    let disposed = false;
    let reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const next = await client.exportJob(job.id);
        if (!disposed && active.current) setJob(next);
      } catch {
      } finally {
        reading = false;
      }
    };
    const stop = client.subscribeEvents(
      (event) => {
        if (
          event.type === "exportJob.changed" &&
          event.affectedIds.includes(job.id)
        )
          void refresh();
      },
      () => void refresh(),
    );
    // Poll only an active utility job; recovery survives a missed/disconnected event.
    const timer = setInterval(() => void refresh(), 2000);
    void refresh();
    return () => {
      disposed = true;
      stop();
      clearInterval(timer);
    };
  }, [client, job?.id, job?.status]);
  useEffect(() => {
    let live = true;
    void client
      .readExports()
      .then((items) => {
        if (live && active.current) {
          setRecent(items);
          if (!touched.current) setJob(items[0] ?? null);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client]);
  useEffect(() => {
    if (job?.delivery && ["intent", "unknown"].includes(job.delivery.status)) {
      delivery.current = { id: job.delivery.deliveryId, job: job.id };
      setMessage("exportUnknown");
    }
  }, [job?.id, job?.delivery?.status]);
  useEffect(() => {
    if (job)
      setRecent((old) =>
        [job, ...old.filter((item) => item.id !== job.id)].slice(0, 30),
      );
  }, [job]);
  async function control(kind: "cancel" | "retry") {
    if (!job || busy) return;
    if (!pendingControl.current)
      pendingControl.current = {
        kind,
        job,
        request: {
          requestId: crypto.randomUUID(),
          attempt: job.attempt,
          mode: "retained",
          expectedRevision: job.capturedRevision,
        },
      };
    const intent = pendingControl.current;
    setBusy(true);
    try {
      const next =
        intent.kind === "cancel"
          ? await client.cancelExport(intent.job.id, {
              requestId: intent.request.requestId,
              attempt: intent.request.attempt,
            })
          : await client.retryExport(intent.job.id, intent.request);
      if (active.current) {
        pendingControl.current = null;
        setJob(next);
        setMessage("");
      }
    } catch (error) {
      notifyFailure(error);
      if (error instanceof ApiError && error.code !== "STORAGE_UNAVAILABLE")
        pendingControl.current = null;
      try {
        const next = await client.exportJob(intent.job.id);
        if (active.current) setJob(next);
      } catch {}
      if (active.current) setMessage("exportFailed");
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function clipboard(text: string, captured: PreparedCopy) {
    if (!active.current) return;
    try {
      if (client.writePreparedClipboard)
        await client.writePreparedClipboard({
          deliveryId: crypto.randomUUID(),
          preparationId: captured.id,
          bodyHash: captured.bodyHash,
        });
      else await navigator.clipboard.writeText(text);
      if (active.current) setMessage("exportCopied");
    } catch {
      notifyFailure("exportClipboardFallback");
      if (active.current) setMessage("exportClipboardFallback");
    }
  }
  async function start(copy: boolean, recapture?: ExportJob) {
    touched.current = true;
    setBusy(true);
    setMessage("");
    try {
      if (!pending.current) {
        if (
          !(await save.prepareInput()) ||
          !active.current ||
          save.composing ||
          save.status !== "saved" ||
          save.hasUnresolvedBusiness
        )
          throw new Error("SAVE_FAILED");
        const identity = save.exportInputIdentity;
        const token = `canonical-1|${save.state.manuscriptId}|${save.state.schemaVersion}|${save.state.blocks.map((b) => `${b.id}:${b.revision}`).join("|")}`;
        const expectedBodyHash = await hashToken(token);
        const base = {
          requestId: crypto.randomUUID(),
          expectedRevision: save.state.workingRevision,
          expectedBodyHash,
        };
        // No await between the visible-input fence and capture dispatch.
        if (
          identity !== save.exportInputIdentity ||
          save.composing ||
          save.status !== "saved"
        )
          throw new Error("REVISION_CONFLICT");
        pending.current = copy
          ? { request: base, copy: true }
          : recapture
            ? {
                request: {
                  ...base,
                  attempt: recapture.attempt,
                  mode: "recapture",
                },
                copy: false,
                source: { id: recapture.id, attempt: recapture.attempt },
              }
            : { request: { ...base, format }, copy: false };
      }
      const intent = pending.current;
      if (intent.copy !== copy) setMessage("exportResolvedEarlier");
      try {
        if (intent.copy) {
          const result = await client.prepareCopy(intent.request);
          if (active.current) {
            pending.current = null;
            setPrepared(result);
            if (copy) await clipboard(result.text, result);
          }
        } else {
          const next =
            "source" in intent
              ? await client.retryExport(intent.source.id, intent.request)
              : await client.startExport(intent.request);
          if (active.current) {
            pending.current = null;
            setJob(next);
            delivery.current = null;
          }
        }
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.code !== "STORAGE_UNAVAILABLE" &&
          error.code !== "COMMAND_UNRESOLVED"
        )
          pending.current = null;
        throw error;
      }
    } catch (e) {
      notifyFailure(e);
      if (active.current)
        setMessage(
          localMessage(e instanceof Error ? e.message : "EXPORT_FAILED"),
        );
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function deliver() {
    if (!job || job.status !== "ready") return;
    setBusy(true);
    try {
      if (client.saveExport) {
        if (delivery.current?.job !== job.id)
          delivery.current = { id: crypto.randomUUID(), job: job.id };
        const receipt = await client.saveExport({
          deliveryId: delivery.current!.id,
          jobId: job.id,
          artifactHash: job.artifactHash!,
        });
        if (!receipt || receipt.status === "failed") delivery.current = null;
        if (receipt && ["failed", "unknown", "intent"].includes(receipt.status))
          notifyFailure(
            receipt.status === "failed" ? "exportFailed" : "exportUnknown",
          );
        if (active.current && receipt) setJob({ ...job, delivery: receipt });
        if (active.current)
          setMessage(
            !receipt
              ? "exportCancelled"
              : receipt.status === "saved"
                ? "exportSaved"
                : receipt.status === "unknown" || receipt.status === "intent"
                  ? "exportUnknown"
                  : "exportFailed",
          );
      } else {
        const bytes = await client.exportBytes(job.id);
        if (!active.current) return;
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
        try {
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = job.filename;
          anchor.click();
          setMessage("exportDownloadRequested");
        } finally {
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      }
    } catch (e) {
      notifyFailure(e);
      if (e instanceof Error && e.message.startsWith("DESTINATION_"))
        delivery.current = null;
      if (active.current)
        setMessage(
          localMessage(e instanceof Error ? e.message : "EXPORT_FAILED"),
        );
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <section className="export-panel" aria-label={t.exportTitle}>
      <p>{t.exportExcludes}</p>
      <div role="group" aria-label={t.exportTitle}>
        <button
          disabled={busy || save.composing || !!pending.current}
          onClick={() => void start(true)}
        >
          {t.copyManuscript}
        </button>
        <select
          aria-label={t.exportFormat}
          value={format}
          onChange={(e) => setFormat(e.target.value as ExportRequest["format"])}
        >
          <option value="md">Markdown</option>
          <option value="txt">TXT</option>
          <option value="docx">DOCX</option>
        </select>
        <button
          disabled={busy || save.composing}
          onClick={() => void start(false)}
        >
          {pending.current ? t.exportResolve : t.exportTitle}
        </button>
      </div>
      {recent.length > 0 && (
        <label>
          {t.exportRecent}
          <select
            aria-label={t.exportRecent}
            value={job?.id ?? ""}
            onChange={(e) => {
              const next = recent.find((j) => j.id === e.target.value);
              if (next) {
                touched.current = true;
                setJob(next);
              }
            }}
          >
            {recent.map((j) => (
              <option key={j.id} value={j.id}>
                {j.filename} · {t[`export_${j.status}`]}
              </option>
            ))}
          </select>
        </label>
      )}
      {job && (
        <div>
          <p role="status">
            {t[`export_${job.status}`]} · {t.exportCapturedRevision}{" "}
            {job.capturedRevision}
            {currentBodyHash !== job.bodyHash || save.hasLocalBodyChanges
              ? ` · ${t.exportEarlierSnapshot}`
              : ""}
          </p>
          {job.status === "ready" && (
            <button disabled={busy} onClick={() => void deliver()}>
              {client.saveExport ? t.exportSave : t.exportDownload}
            </button>
          )}
          {pendingControl.current && (
            <button
              disabled={busy}
              onClick={() => void control(pendingControl.current!.kind)}
            >
              {t.exportResolve}
            </button>
          )}
          {["queued", "running"].includes(job.status) && (
            <button
              disabled={busy || !!pendingControl.current}
              onClick={() => void control("cancel")}
            >
              {t.cancel}
            </button>
          )}
          {["failed", "interrupted"].includes(job.status) && (
            <>
              {job.inputRetained && (
                <button
                  disabled={busy || !!pendingControl.current}
                  onClick={() => void control("retry")}
                >
                  {t.exportRetryCaptured}
                </button>
              )}
              {job.inputRetained && (
                <button
                  disabled={busy || !!pendingControl.current}
                  onClick={() => void control("cancel")}
                >
                  {t.exportDiscardInput}
                </button>
              )}
              <button
                disabled={busy || !!pending.current || !!pendingControl.current}
                onClick={() => {
                  if (pending.current || pendingControl.current) return;
                  void start(false, job);
                }}
              >
                {t.exportRecapture}
              </button>
            </>
          )}
        </div>
      )}
      {message && <p role="status">{t[message]}</p>}
      {message === "exportUnknown" &&
        job?.status === "ready" &&
        client.saveExport && (
          <button
            disabled={busy}
            onClick={() => {
              delivery.current = null;
              void deliver();
            }}
          >
            {t.exportReselect}
          </button>
        )}
      {prepared && (
        <div>
          <p>
            {t.exportCapturedRevision} {prepared.capturedRevision}
            {(currentBodyHash && currentBodyHash !== prepared.bodyHash) ||
            save.hasLocalBodyChanges
              ? ` · ${t.exportEarlierSnapshot}`
              : ""}
          </p>
          <button onClick={() => void clipboard(prepared.text, prepared)}>
            {t.copyPreparedManuscript}
          </button>
          <label>
            {t.exportManualCopy}
            <textarea
              readOnly
              value={prepared.text}
              onFocus={(e) => e.target.select()}
            />
          </label>
        </div>
      )}
    </section>
  );
}
