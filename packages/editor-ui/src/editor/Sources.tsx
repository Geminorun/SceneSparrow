import { useEffect, useRef, useState } from "react";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type {
  SourceSummary,
  DocumentJob,
  Intake,
  ManuscriptCommand,
} from "@scenesparrow/contracts";
import type en from "../locales/en.json";
import type { Autosave } from "./autosave";
export function Sources({
  client,
  save,
  projectId,
  t,
}: {
  client: PlatformClient;
  save: Autosave;
  projectId: string;
  t: typeof en;
}) {
  const [items, setItems] = useState<SourceSummary[]>([]),
    [next, setNext] = useState<string | null>(null);
  const [url, setUrl] = useState(""),
    [title, setTitle] = useState(""),
    [error, setError] = useState("");
  const [adding, setAdding] = useState(false),
    [queued, setQueued] = useState(false);
  const [uploading, setUploading] = useState(false),
    [progress, setProgress] = useState(0);
  const [text, setText] = useState<{
    job: string;
    text: string;
    next: number | null;
    parser: string;
    references: string[];
  } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const sourceRead = useRef(0);
  const active = useRef(true),
    upload = useRef<AbortController | null>(null);
  const refresh = async (after?: string) => {
    const ticket = ++sourceRead.current;
    try {
      const p = await client.readSources(after);
      if (active.current && ticket === sourceRead.current) {
        setItems((old) => (after ? [...old, ...p.items] : p.items));
        setNext(p.next);
      }
    } catch {
      if (active.current && ticket === sourceRead.current)
        setError("STORAGE_UNAVAILABLE");
    }
  };
  useEffect(() => {
    active.current = true;
    void refresh();
    const unsubscribe = client.subscribeEvents(
      (e) => {
        if (e.type === "sources.changed" || e.type === "documentJob.changed")
          void refresh();
        if (
          e.type === "manuscript.changed" &&
          e.workingRevision > save.state.workingRevision
        )
          void save.resync();
      },
      () => {
        void refresh();
        void save.resync();
      },
    );
    return () => {
      active.current = false;
      upload.current?.abort();
      unsubscribe();
    };
  }, [client, save]);
  const execute = (
    type: "AddSourceLink" | "AddSourceFile" | "RemoveSource",
    payload: unknown,
    options?: { signal?: AbortSignal; dispatched?: () => void },
  ) =>
    save.business(
      (revision) =>
        ({
          type,
          requestId: crypto.randomUUID(),
          projectId,
          expectedWorkingRevision: revision,
          payload,
        }) as ManuscriptCommand,
      options,
    );
  async function extract(sourceId: string) {
    try {
      await client.documentAction({
        type: "extractSource",
        jobId: crypto.randomUUID(),
        sourceId,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "WORKER_UNAVAILABLE");
    }
  }
  async function addFile(file?: File) {
    setError("");
    setUploading(true);
    setProgress(0);
    const abort = new AbortController();
    upload.current = abort;
    let intake: Intake | null = null;
    try {
      intake = client.pickFileIntake
        ? await client.pickFileIntake(abort.signal, (loaded, total) =>
            setProgress(total ? Math.round((100 * loaded) / total) : 0),
          )
        : file
          ? await client.uploadFile(file, abort.signal, (loaded, total) =>
              setProgress(total ? Math.round((100 * loaded) / total) : 0),
            )
          : null;
      if (!intake) return;
      if (!active.current || abort.signal.aborted) {
        await client.cancelIntake(intake.id);
        return;
      }
      setQueued(true);
      const sourceId = crypto.randomUUID();
      if (
        await execute(
          "AddSourceFile",
          {
            sourceId,
            intakeId: intake.id,
            hash: intake.hash,
          },
          {
            signal: abort.signal,
            dispatched: () => {
              setAdding(true);
              setQueued(false);
            },
          },
        )
      ) {
        await refresh();
        if (active.current) await extract(sourceId);
      } else if (!save.hasUnresolvedBusiness)
        await client.cancelIntake(intake.id);
    } catch (e) {
      if (intake) await client.cancelIntake(intake.id).catch(() => {});
      setError(e instanceof Error ? e.message : "STORAGE_UNAVAILABLE");
    } finally {
      upload.current = null;
      if (active.current) {
        setUploading(false);
        setAdding(false);
        setQueued(false);
      }
    }
  }
  async function view(job: string, append = false) {
    try {
      const p = await client.extractionPage(
        job,
        append ? (text?.next ?? 0) : 0,
      );
      setText((old) => ({
        job,
        text: append ? (old?.text ?? "") + p.text : p.text,
        next: p.next,
        parser: p.parser,
        references: p.references,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "SOURCE_TEXT_UNAVAILABLE");
    }
  }
  return (
    <aside className="source-panel" aria-label={t.sources}>
      <h3>{t.sources}</h3>
      <p className="muted">{t.referenceHelp}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          void execute("AddSourceLink", {
            sourceId: crypto.randomUUID(),
            url,
            title: title || url,
          }).then((ok) => {
            if (ok) {
              setUrl("");
              setTitle("");
              void refresh();
            }
          });
        }}
      >
        <label>
          {t.referenceUrl}
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            type="url"
            required
          />
        </label>
        <label>
          {t.referenceTitle}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={1024}
          />
        </label>
        <button disabled={save.busy || save.composing} type="submit">
          {t.addReferenceLink}
        </button>
      </form>
      {client.pickFileIntake ? (
        <button disabled={uploading} onClick={() => void addFile()}>
          {t.addReferenceFile}
        </button>
      ) : (
        <label className="file-control">
          {t.addReferenceFile}
          <input
            aria-label={t.addReferenceFile}
            type="file"
            accept=".txt,.md,.markdown,.docx,.pdf"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void addFile(f);
            }}
          />
        </label>
      )}
      {uploading && (
        <p role="status">
          {adding
            ? t.addingReference
            : queued
              ? t.waitingForManuscriptSave
              : t.uploading}{" "}
          {progress}%{" "}
          <button disabled={adding} onClick={() => upload.current?.abort()}>
            {t.cancel}
          </button>
        </p>
      )}
      <button
        onClick={() => setImportOpen(true)}
        disabled={save.busy || save.composing}
      >
        {t.importManuscript}
      </button>
      {error && (
        <p role="alert" data-error-code={error}>
          {documentMessage(error, t)}
        </p>
      )}
      <ul>
        {items.map((item) => (
          <li key={item.source.id} data-testid="source-item">
            <strong>{item.source.title}</strong>
            <p>{t[`source_${item.status}`]}</p>
            {item.source.kind === "link" && (
              <>
                <p>{t.linkOnly}</p>
                <button
                  onClick={() =>
                    void client
                      .openExternalLink(item.source.url!)
                      .catch(() => setError("INVALID_URL"))
                  }
                >
                  {t.openReference}
                </button>
              </>
            )}
            {item.error && (
              <p data-error-code={item.error}>
                {documentMessage(item.error, t)}
              </p>
            )}
            {item.warnings.map((w) => (
              <p key={w}>{warningMessage(w, t)}</p>
            ))}
            {item.hasImages && <p>{t.imagesUnprocessed}</p>}
            {item.source.kind === "file" && (
              <>
                {item.jobId && ["ready", "failed"].includes(item.status) && (
                  <button onClick={() => void view(item.jobId!)}>
                    {t.viewExtractedText}
                  </button>
                )}
                {["interrupted", "failed"].includes(item.status) && (
                  <button onClick={() => void extract(item.source.id)}>
                    {t.retryExtraction}
                  </button>
                )}
                {item.jobId && ["queued", "running"].includes(item.status) && (
                  <button
                    onClick={() =>
                      void client
                        .documentAction({ type: "cancel", jobId: item.jobId! })
                        .then(() => refresh())
                    }
                  >
                    {t.cancel}
                  </button>
                )}
              </>
            )}
            <button
              disabled={save.busy || save.composing}
              onClick={() =>
                void execute("RemoveSource", {
                  sourceId: item.source.id,
                  expectedSourceRevision: item.source.revision,
                }).then(() => refresh())
              }
            >
              {t.removeReference}
            </button>
          </li>
        ))}
      </ul>
      {next && <button onClick={() => void refresh(next)}>{t.loadMore}</button>}
      {text && (
        <div role="dialog" aria-label={t.extractedText}>
          <h4>{t.extractedText}</h4>
          <pre>{text.text}</pre>
          <p>
            {t.parserProvenance}: {text.parser}
          </p>
          <p>{text.references.join(", ")}</p>
          {text.next !== null && (
            <button onClick={() => void view(text.job, true)}>
              {t.loadMore}
            </button>
          )}
          <button onClick={() => setText(null)}>{t.close}</button>
        </div>
      )}
      {importOpen && (
        <ImportDialog
          client={client}
          save={save}
          projectId={projectId}
          t={t}
          close={() => setImportOpen(false)}
        />
      )}
    </aside>
  );
}
function ImportDialog({
  client,
  save,
  projectId,
  t,
  close,
}: {
  client: PlatformClient;
  save: Autosave;
  projectId: string;
  t: typeof en;
  close: () => void;
}) {
  const [paste, setPaste] = useState(""),
    [job, setJob] = useState<DocumentJob | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
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
      if (live.current)
        setError(e instanceof Error ? e.message : "WORKER_UNAVAILABLE");
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function commit(mode: "start" | "append" | "replace") {
    if (!job?.candidateHash) return;
    setBusy(true);
    abort.current = new AbortController();
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
      {error && (
        <p role="alert" data-error-code={error}>
          {documentMessage(error, t)}
        </p>
      )}
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
function documentMessage(code: string, t: typeof en) {
  if (code === "IMPORT_STALE" || code === "REVISION_CONFLICT")
    return t.importStale;
  if (code === "SOURCE_ENCRYPTED") return t.sourceEncrypted;
  if (code === "SOURCE_TEXT_UNAVAILABLE") return t.sourceTextUnavailable;
  if (code === "TEXT_ENCODING_UNSUPPORTED") return t.encodingUnsupported;
  if (
    [
      "INPUT_TOO_LARGE",
      "DOCUMENT_TOO_LARGE",
      "DOCUMENT_RESOURCE_LIMIT",
    ].includes(code)
  )
    return t.documentTooLarge;
  if (code === "INVALID_URL") return t.invalidSourceUrl;
  if (code === "DOCUMENT_PARSE_TIMEOUT") return t.parseTimeout;
  if (code === "SOURCE_UNSUPPORTED") return t.sourceUnsupported;
  if (code === "DOCUMENT_JOB_INTERRUPTED") return t.source_interrupted;
  return t.documentParseFailed;
}
function warningMessage(code: string, t: typeof en) {
  if (code === "IMAGES_UNPROCESSED") return t.imagesUnprocessed;
  if (code.startsWith("PDF_")) return t.pdfLayoutWarning;
  if (code === "RAW_HTML_IGNORED") return t.rawHtmlIgnored;
  return t.formatNormalized;
}
