import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type {
  SourceSummary,
  DocumentJob,
  Intake,
  ManuscriptCommand,
  ReferenceDirectoryAssociation,
  ReferenceDirectoryBatch,
} from "@scenesparrow/contracts";
import type en from "../locales/en.json";
import type { Autosave } from "./autosave";
import type { PlanningEvidenceBridge } from "./evidence";
import { SourceEvidence } from "./SourceEvidence";

type UploadRow = {
  path: string;
  status: "uploading" | "adding" | "done" | "skipped" | "error" | "cancelled";
  progress?: number;
  code?: string;
};
export function Sources({
  client,
  save,
  projectId,
  t,
  evidence,
}: {
  client: PlatformClient;
  save: Autosave;
  projectId: string;
  t: typeof en;
  evidence: PlanningEvidenceBridge | null;
}) {
  const [items, setItems] = useState<SourceSummary[]>([]),
    [url, setUrl] = useState(""),
    [title, setTitle] = useState(""),
    [error, setError] = useState("");
  const [rows, setRows] = useState<UploadRow[]>([]),
    [uploading, setUploading] = useState(false),
    [association, setAssociation] =
      useState<ReferenceDirectoryAssociation | null>(null);
  const [text, setText] = useState<{
    job: string;
    text: string;
    next: number | null;
    parser: string;
    references: string[];
  } | null>(null);
  const active = useRef(true),
    upload = useRef<AbortController | null>(null),
    sourceRead = useRef(0);
  const directoryInput = useRef<HTMLInputElement>(null);
  const skippedPaths = useRef(new Set<string>());
  const fileUpload = useRef<{
    path: string;
    controller: AbortController;
  } | null>(null);
  async function readAll() {
    const result: SourceSummary[] = [];
    let next: string | undefined;
    do {
      const page = await client.readSources(next);
      result.push(...page.items);
      next = page.next ?? undefined;
    } while (next);
    return result;
  }
  async function refresh() {
    const ticket = ++sourceRead.current;
    try {
      const result = await readAll();
      if (active.current && ticket === sourceRead.current) {
        setItems(result);
      }
    } catch {
      if (active.current && ticket === sourceRead.current)
        setError("STORAGE_UNAVAILABLE");
    }
  }
  useEffect(() => {
    active.current = true;
    void refresh();
    directoryInput.current?.setAttribute("webkitdirectory", "");
    void client.readReferenceDirectory?.().then(
      (value) => {
        if (active.current) setAssociation(value);
      },
      () => {
        if (active.current) setError("STORAGE_UNAVAILABLE");
      },
    );
    const unsubscribe = client.subscribeEvents(
      (event) => {
        if (["sources.changed", "documentJob.changed"].includes(event.type)) {
          void refresh();
        }
        if (
          event.type === "manuscript.changed" &&
          event.workingRevision > save.state.workingRevision
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
    type:
      "AddSourceLink" | "AddSourceFile" | "RefreshSourceFile" | "RemoveSource",
    payload: unknown,
    signal?: AbortSignal,
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
      signal ? { signal } : {},
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
      if (active.current)
        setError(e instanceof Error ? e.message : "WORKER_UNAVAILABLE");
    }
  }
  const patchRow = (path: string, patch: Partial<UploadRow>) => {
    if (active.current)
      setRows((old) =>
        old.map((row) => (row.path === path ? { ...row, ...patch } : row)),
      );
  };
  async function batch(files?: File[], directory?: "pick" | "refresh") {
    if (upload.current) return;
    const abort = new AbortController();
    upload.current = abort;
    setUploading(true);
    setError("");
    setRows([]);
    skippedPaths.current.clear();
    const unused = new Map<string, Intake>();
    try {
      let result: ReferenceDirectoryBatch | null = null;
      if (directory === "pick")
        result = await client.pickReferenceDirectory!(abort.signal);
      if (directory === "refresh" && association)
        result = await client.refreshReferenceDirectory!(
          association.id,
          abort.signal,
        );
      const entries: { path: string; intake?: Intake; file?: File }[] = [];
      if (result) {
        for (const entry of result.entries) {
          unused.set(entry.intake.id, entry.intake);
          entries.push({
            path: `${result.association.name}/${entry.relativePath}`,
            intake: entry.intake,
          });
        }
        if (active.current) setAssociation(result.association);
        if (result.truncated && active.current) setError("INPUT_TOO_LARGE");
      } else if (directory) return;
      else if (files) {
        let total = 0;
        if (files.length > 100) setError("INPUT_TOO_LARGE");
        for (const file of files.slice(0, 100)) {
          const path = file.webkitRelativePath || file.name;
          if (!/\.(txt|md|markdown|docx|pdf)$/i.test(file.name)) {
            setRows((old) => [
              ...old,
              { path, status: "skipped", code: "SOURCE_UNSUPPORTED" },
            ]);
            continue;
          }
          if (
            file.size > 25 * 1024 * 1024 ||
            entries.length >= 100 ||
            total + file.size > 100 * 1024 * 1024
          ) {
            setRows((old) => [
              ...old,
              { path, status: "error", code: "INPUT_TOO_LARGE" },
            ]);
            continue;
          }
          total += file.size;
          entries.push({ path, file });
        }
      } else {
        const intake = await client.pickFileIntake!(abort.signal);
        if (!intake) return;
        unused.set(intake.id, intake);
        entries.push({ path: intake.displayName, intake });
      }
      if (!active.current || abort.signal.aborted) return;
      setRows((old) => [
        ...old,
        ...entries.map((entry) => ({
          path: entry.path,
          status: "uploading" as const,
        })),
        ...(result?.outcomes.map((outcome) => ({
          path: `${result!.association.name}/${outcome.relativePath}`,
          status: outcome.status,
          code: outcome.code,
        })) ?? []),
      ]);
      let replaceApproved = directory === "refresh";
      for (const entry of entries) {
        if (!active.current || abort.signal.aborted) break;
        if (skippedPaths.current.has(entry.path)) continue;
        let intake = entry.intake;
        const fileAbort = new AbortController();
        const cancelFile = () => fileAbort.abort();
        abort.signal.addEventListener("abort", cancelFile, { once: true });
        fileUpload.current = { path: entry.path, controller: fileAbort };
        try {
          if (!intake) {
            intake = await client.uploadFile(
              entry.file!,
              fileAbort.signal,
              (loaded, total) =>
                patchRow(entry.path, {
                  progress: total ? Math.round((loaded / total) * 100) : 0,
                }),
            );
            unused.set(intake.id, intake);
          }
          if (!active.current || abort.signal.aborted) break;
          if (
            fileAbort.signal.aborted ||
            skippedPaths.current.has(entry.path)
          ) {
            patchRow(entry.path, { status: "cancelled" });
            continue;
          }
          const current = await readAll();
          if (
            fileAbort.signal.aborted ||
            skippedPaths.current.has(entry.path)
          ) {
            patchRow(entry.path, { status: "cancelled" });
            continue;
          }
          const existing = current.find(
            (item) =>
              (item.source.relativePath ?? item.source.title) === entry.path &&
              item.source.kind === "file",
          );
          if (existing?.source.objectHash === intake.hash) {
            patchRow(entry.path, { status: "skipped", code: "UNCHANGED" });
            continue;
          }
          if (existing && !replaceApproved) {
            replaceApproved = window.confirm(t.libraryReplaceConfirm);
            if (!replaceApproved) {
              patchRow(entry.path, { status: "skipped", code: "CANCELLED" });
              continue;
            }
          }
          patchRow(entry.path, { status: "adding" });
          const sourceId = existing?.source.id ?? crypto.randomUUID();
          const ok = await execute(
            existing ? "RefreshSourceFile" : "AddSourceFile",
            {
              sourceId,
              intakeId: intake.id,
              hash: intake.hash,
              relativePath: entry.path,
              ...(existing
                ? { expectedSourceRevision: existing.source.revision }
                : {}),
            },
            fileAbort.signal,
          );
          if (ok || save.hasUnresolvedBusiness) unused.delete(intake.id);
          if (!ok) {
            patchRow(entry.path, {
              status:
                fileAbort.signal.aborted && !save.hasUnresolvedBusiness
                  ? "cancelled"
                  : "error",
              code: save.error || "STORAGE_UNAVAILABLE",
            });
            if (save.hasUnresolvedBusiness) break;
            continue;
          }
          patchRow(entry.path, { status: "done" });
          await refresh();
          if (active.current && !abort.signal.aborted) await extract(sourceId);
        } catch (e) {
          patchRow(entry.path, {
            status:
              abort.signal.aborted || fileAbort.signal.aborted
                ? "cancelled"
                : "error",
            code: e instanceof Error ? e.message : "STORAGE_UNAVAILABLE",
          });
        } finally {
          abort.signal.removeEventListener("abort", cancelFile);
          fileUpload.current = null;
        }
      }
    } catch (e) {
      if (active.current && !abort.signal.aborted)
        setError(e instanceof Error ? e.message : "STORAGE_UNAVAILABLE");
    } finally {
      await Promise.allSettled(
        [...unused.keys()].map((id) => client.cancelIntake(id)),
      );
      if (active.current) {
        setUploading(false);
        setRows((old) =>
          old.map((row) =>
            row.status === "uploading" ? { ...row, status: "cancelled" } : row,
          ),
        );
      }
      upload.current = null;
      if (client.readReferenceDirectory && active.current)
        void client.readReferenceDirectory().then(
          (value) => {
            if (active.current) setAssociation(value);
          },
          () => {},
        );
    }
  }
  async function view(job: string, append = false) {
    try {
      const page = await client.extractionPage(
        job,
        append ? (text?.next ?? 0) : 0,
      );
      if (active.current)
        setText((old) => ({
          job,
          text: append ? (old?.text ?? "") + page.text : page.text,
          next: page.next,
          parser: page.parser,
          references: page.references,
        }));
    } catch (e) {
      if (active.current)
        setError(e instanceof Error ? e.message : "SOURCE_TEXT_UNAVAILABLE");
    }
  }
  function renderItem(item: SourceSummary): ReactNode {
    return (
      <li
        key={item.source.id}
        data-testid="source-item"
        className="library-source"
      >
        <strong>{item.source.title}</strong>
        <p className="source-status">{t[`source_${item.status}`]}</p>
        {item.source.kind === "link" && (
          <>
            <p className="muted">{t.linkOnly}</p>
            <button
              className="quiet-button reference-url"
              onClick={() =>
                void client
                  .openExternalLink(item.source.url!)
                  .catch(() => setError("INVALID_URL"))
              }
            >
              {item.source.url}
            </button>
          </>
        )}
        {item.error && (
          <p data-error-code={item.error}>{documentMessage(item.error, t)}</p>
        )}
        {item.warnings.map((warning) => (
          <p key={warning}>{warningMessage(warning, t)}</p>
        ))}
        {evidence && (
          <SourceEvidence
            item={item}
            client={client}
            t={t}
            choice={evidence.choices.find(
              (choice) => choice.sourceId === item.source.id,
            )}
            locked={evidence.locked}
            update={(choice) => evidence.update(item.source.id, choice)}
          />
        )}
        <details>
          <summary>{t.libraryFileActions}</summary>
          {item.source.kind === "file" && (
            <>
              {item.jobId && ["ready", "failed"].includes(item.status) && (
                <button onClick={() => void view(item.jobId!)}>
                  {t.viewExtractedText}
                </button>
              )}
              {["pending", "interrupted", "failed"].includes(item.status) && (
                <button onClick={() => void extract(item.source.id)}>
                  {t.retryExtraction}
                </button>
              )}
              {item.jobId && ["queued", "running"].includes(item.status) && (
                <button
                  onClick={() =>
                    void client
                      .documentAction({ type: "cancel", jobId: item.jobId! })
                      .then(refresh)
                  }
                >
                  {t.cancel}
                </button>
              )}
            </>
          )}
          <button
            disabled={save.composing}
            onClick={() =>
              void execute("RemoveSource", {
                sourceId: item.source.id,
                expectedSourceRevision: item.source.revision,
              }).then(refresh)
            }
          >
            {t.removeReference}
          </button>
        </details>
      </li>
    );
  }
  return (
    <section className="source-panel" aria-label={t.sources}>
      <p className="muted">{t.referenceHelp}</p>
      <div className="library-intake">
        {client.pickFileIntake ? (
          <button disabled={uploading} onClick={() => void batch()}>
            {t.addReferenceFile}
          </button>
        ) : (
          <label className="file-control">
            {t.addReferenceFile}
            <input
              aria-label={t.addReferenceFile}
              type="file"
              multiple
              accept=".txt,.md,.markdown,.docx,.pdf"
              disabled={uploading}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                if (files.length) void batch(files);
              }}
            />
          </label>
        )}
        {client.pickReferenceDirectory ? (
          <button
            disabled={uploading}
            onClick={() => void batch(undefined, "pick")}
          >
            {t.libraryAddFolder}
          </button>
        ) : (
          <label className="file-control">
            {t.libraryAddFolder}
            <input
              ref={directoryInput}
              aria-label={t.libraryAddFolder}
              type="file"
              multiple
              disabled={uploading}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                if (files.length) void batch(files);
              }}
            />
          </label>
        )}
        {association && client.refreshReferenceDirectory && (
          <button
            disabled={uploading}
            onClick={() => void batch(undefined, "refresh")}
          >
            {t.libraryRefreshFolder.replace("{name}", association.name)}
          </button>
        )}
      </div>
      <details>
        <summary>{t.addReferenceLink}</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
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
              type="url"
              value={url}
              required
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <label>
            {t.referenceTitle}
            <input
              value={title}
              maxLength={1024}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <button disabled={save.composing} type="submit">
            {t.addReferenceLink}
          </button>
        </form>
      </details>
      {uploading && (
        <p role="status">
          {t.uploading}
          <button onClick={() => upload.current?.abort()}>{t.cancel}</button>
        </p>
      )}
      {!!rows.length && (
        <details open className="library-upload-status">
          <summary>{t.libraryUploadResults}</summary>
          <ul>
            {rows.map((row, index) => (
              <li key={`${row.path}-${index}`}>
                <span>{row.path}</span>
                <span>
                  {t[`libraryUpload_${row.status}`]}{" "}
                  {row.status === "uploading" ? `${row.progress ?? 0}%` : ""}
                  {uploading && row.status === "uploading" && (
                    <button
                      aria-label={t.libraryCancelFile.replace(
                        "{name}",
                        row.path,
                      )}
                      onClick={() => {
                        skippedPaths.current.add(row.path);
                        if (fileUpload.current?.path === row.path)
                          fileUpload.current.controller.abort();
                        patchRow(row.path, { status: "cancelled" });
                      }}
                    >
                      {t.cancel}
                    </button>
                  )}
                  {row.code && !["UNCHANGED", "CANCELLED"].includes(row.code)
                    ? `: ${documentMessage(row.code, t)}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && (
        <p role="alert" data-error-code={error}>
          {documentMessage(error, t)}
        </p>
      )}
      {!items.length && <p className="muted">{t.libraryEmpty}</p>}
      <LibraryTree items={items} renderItem={renderItem} />
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
    </section>
  );
}
type Tree = { files: SourceSummary[]; folders: Map<string, Tree> };
function LibraryTree({
  items,
  renderItem,
}: {
  items: SourceSummary[];
  renderItem: (item: SourceSummary) => ReactNode;
}) {
  const root: Tree = { files: [], folders: new Map() };
  for (const item of items) {
    const segments = item.source.relativePath?.split("/") ?? [];
    segments.pop();
    let node = root;
    for (const segment of segments) {
      if (!node.folders.has(segment))
        node.folders.set(segment, { files: [], folders: new Map() });
      node = node.folders.get(segment)!;
    }
    node.files.push(item);
  }
  const render = (node: Tree): ReactNode => (
    <ul className="library-tree">
      {[...node.folders]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, child]) => (
          <li key={name} className="library-folder">
            <details open>
              <summary>{name}</summary>
              {render(child)}
            </details>
          </li>
        ))}
      {node.files.map(renderItem)}
    </ul>
  );
  return render(root);
}
export function ImportDialog({
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
