import {
  useErrorNotification,
  useTaskNotifications,
  useNoticeOwner,
} from "../NotificationPresenter";
import { notifyFailure } from "../notifications";
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
import { WritingDialog } from "./PlanningDialogs";

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
  useErrorNotification(error);
  const { report: reportAction, resolve: resolveAction } = useNoticeOwner();
  const linkInput = useRef({ url, title });
  linkInput.current = { url, title };
  const [loaded, setLoaded] = useState(false),
    [reading, setReading] = useState(true),
    [readFailed, setReadFailed] = useState(false),
    [readError, setReadError] = useState(""),
    [linkOpen, setLinkOpen] = useState(false),
    [linkError, setLinkError] = useState("");
  useErrorNotification(readError);
  const linkForm = useRef<HTMLDetailsElement>(null);
  const linkField = useRef<HTMLInputElement>(null);
  const linkEpoch = useRef(0);
  const linkAbort = useRef<AbortController | null>(null);
  const linkVisible = useRef(false);
  function closeLink() {
    linkEpoch.current++;
    linkAbort.current?.abort();
    linkVisible.current = false;
    save.actions.cancel("source-link");
    save.composition(false, "sources");
    setLinkOpen(false);
    linkForm.current?.querySelector("summary")?.focus();
  }
  useTaskNotifications(
    items.map((item) => ({
      id: item.jobId ?? item.source.id,
      status: item.status,
      error: item.error,
    })),
    !loaded,
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
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
  useTaskNotifications(
    rows
      .filter((row) => row.status === "error")
      .map((row) => ({ id: row.path, status: "failed", error: row.code })),
  );
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
  async function refresh(explicit = false) {
    const ticket = ++sourceRead.current;
    if (explicit) {
      setReadError("");
      resolveAction("source-read");
    }
    setReading(true);
    try {
      const result = await readAll();
      if (active.current && ticket === sourceRead.current) {
        setItems(result);
        setLoaded(true);
        setReadFailed(false);
        setReadError("");
        resolveAction("source-read");
      }
    } catch {
      if (active.current && ticket === sourceRead.current) {
        setReadFailed(true);
        setReadError("SOURCE_READ_FAILED");
        if (explicit)
          reportAction("SOURCE_READ_FAILED", { identity: "source-read" });
      }
    } finally {
      if (active.current && ticket === sourceRead.current) setReading(false);
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
      linkAbort.current?.abort();
      save.actions.cancel("source-link");
      save.actions.cancelScope("source:");
      save.composition(false, "sources");
      upload.current?.abort();
      unsubscribe();
    };
  }, [client, save]);
  const execute = (
    type:
      | "AddSourceLink"
      | "RenameSourceLink"
      | "AddSourceFile"
      | "RefreshSourceFile"
      | "RemoveSource",
    payload: unknown,
    signal?: AbortSignal,
    failed?: (code: string) => void,
  ) =>
    save.actions.run(
      `source:${type}:${(payload as { sourceId?: string }).sourceId ?? type}`,
      async () => {
        let attempted: ManuscriptCommand | undefined;
        setError("");
        resolveAction("source-action");
        const ok = await save.business(
          (revision) => {
            attempted = {
              type,
              requestId: crypto.randomUUID(),
              projectId,
              expectedWorkingRevision: revision,
              payload,
            } as ManuscriptCommand;
            return attempted;
          },
          signal ? { signal } : {},
        );
        if (!ok) {
          const code = save.error || "SAVE_FAILED";
          const failure =
            attempted &&
            ["AddSourceLink", "RenameSourceLink"].includes(type) &&
            code === "INVALID_URL"
              ? "SOURCE_LINK_URL_INVALID"
              : attempted &&
                  ["AddSourceLink", "RenameSourceLink"].includes(type) &&
                  code === "INVALID_REQUEST"
                ? "SOURCE_LINK_INVALID"
                : code;
          if (
            attempted &&
            save.businessRejection?.requestId === attempted.requestId
          )
            save.acknowledgeBusinessRejection();
          failed?.(failure);
          if (attempted) setError(failure);
          if (!signal?.aborted)
            reportAction(failure, { identity: "source-action" });
        }
        return ok;
      },
      () => active.current && !signal?.aborted,
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
        <span className="source-kind-icon" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          >
            {item.source.kind === "link" ? (
              <>
                <path d="m10 13 4-4" />
                <path
                  d="M8 16 6 18a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"
                  transform="translate(2 0) scale(.83 1)"
                />
              </>
            ) : (
              <path d="M6 3h8l4 4v14H6zM14 3v5h4" />
            )}
          </svg>
        </span>
        <details className="source-title">
          <summary title={item.source.title}>
            <strong>{item.source.title}</strong>
          </summary>
          <p>{item.source.title}</p>
        </details>
        <p
          className="source-status"
          title={
            item.source.kind === "link"
              ? item.source.url
              : item.source.relativePath
          }
        >
          {item.source.kind === "link"
            ? linkDomain(item.source.url!)
            : t[`source_${item.status}`]}
          {item.source.kind === "link" && <> · {t.source_link_only}</>}
        </p>
        {item.warnings.map((warning) => (
          <p key={warning}>{warningMessage(warning, t)}</p>
        ))}
        {evidence && (
          <SourceEvidence
            compact
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
        <button
          className="quiet-button source-actions"
          aria-label={t.libraryFileActions}
          title={t.libraryFileActions}
          aria-expanded={expanded.has(item.source.id)}
          aria-controls={`source-details-${item.source.id}`}
          onClick={() =>
            setExpanded((old) => {
              const next = new Set(old);
              if (next.has(item.source.id)) next.delete(item.source.id);
              else next.add(item.source.id);
              return next;
            })
          }
        >
          ⋯
        </button>
        {expanded.has(item.source.id) && (
          <div
            className="source-action-body"
            id={`source-details-${item.source.id}`}
          >
            {item.source.kind === "link" && (
              <>
                <p
                  className="reference-url"
                  role="region"
                  aria-label={t.libraryFullUrl}
                  tabIndex={0}
                >
                  {item.source.url}
                </p>
                <p className="muted">{t.linkOnly}</p>
                <button
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(item.source.url!)
                      .catch(() => setError("STORAGE_UNAVAILABLE"))
                  }
                >
                  {t.libraryCopyLink}
                </button>
                <button
                  onClick={() =>
                    void client
                      .openExternalLink(item.source.url!)
                      .catch(() => setError("INVALID_URL"))
                  }
                >
                  {t.libraryOpenLink}
                </button>
                <LinkRename
                  item={item}
                  t={t}
                  save={save}
                  rename={async (title, signal) => {
                    let error = "";
                    const ok = await execute(
                      "RenameSourceLink",
                      {
                        sourceId: item.source.id,
                        expectedSourceRevision: item.source.revision,
                        title,
                      },
                      signal,
                      (code) => {
                        error = code;
                      },
                    );
                    if (ok) await refresh();
                    return { ok: !!ok, error };
                  }}
                />
              </>
            )}
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
                        .then(() => refresh())
                    }
                  >
                    {t.cancel}
                  </button>
                )}
              </>
            )}
            <button
              onClick={() =>
                void execute("RemoveSource", {
                  sourceId: item.source.id,
                  expectedSourceRevision: item.source.revision,
                }).then(() => refresh())
              }
            >
              {t.removeReference}
            </button>
          </div>
        )}
      </li>
    );
  }
  return (
    <section className="source-panel" aria-label={t.sources}>
      <div className="library-heading">
        <p className="muted">{t.referenceHelp}</p>
        {!readFailed && (
          <button
            className="quiet-button library-reload-icon"
            title={t.libraryReload}
            aria-label={t.libraryReload}
            disabled={reading}
            onClick={() => void refresh(true)}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <path d="M20 10a8 8 0 1 0 0 5M20 4v6h-6" />
            </svg>
          </button>
        )}
      </div>
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
      <details
        ref={linkForm}
        open={linkOpen}
        className="library-link-form"
        onToggle={(event) => {
          const open = event.currentTarget.open;
          if (open === linkVisible.current) return;
          if (open) {
            linkVisible.current = true;
            setLinkOpen(true);
            linkField.current?.focus();
          } else closeLink();
        }}
      >
        <summary>{t.addReferenceLink}</summary>
        <form
          onCompositionStart={() => save.composition(true, "sources")}
          onCompositionEnd={() => save.composition(false, "sources")}
          onBlurCapture={() => {
            save.actions.blur("sources", () =>
              save.composition(false, "sources"),
            );
          }}
          onSubmit={(event) => {
            event.preventDefault();
            setLinkError("");
            const epoch = linkEpoch.current;
            void save.actions.run(
              "source-link",
              async () => {
                const abort = new AbortController();
                linkAbort.current = abort;
                const { url, title } = linkInput.current;
                let failure = "";
                const ok = await execute(
                  "AddSourceLink",
                  {
                    sourceId: crypto.randomUUID(),
                    url,
                    title: title.trim() || linkDomain(url),
                  },
                  abort.signal,
                  (code) => {
                    failure = code;
                  },
                );
                if (ok && active.current) {
                  void refresh();
                  if (
                    epoch === linkEpoch.current &&
                    linkVisible.current &&
                    linkInput.current.url === url &&
                    linkInput.current.title === title
                  ) {
                    setUrl("");
                    setTitle("");
                    closeLink();
                  }
                } else if (
                  active.current &&
                  linkVisible.current &&
                  epoch === linkEpoch.current
                )
                  setLinkError(failure || "SAVE_FAILED");
              },
              () =>
                active.current &&
                linkVisible.current &&
                epoch === linkEpoch.current,
            );
          }}
        >
          <label>
            {t.referenceUrl}
            <input
              ref={linkField}
              type="url"
              value={url}
              aria-invalid={linkError === "SOURCE_LINK_URL_INVALID"}
              required
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <label>
            {t.referenceTitle}
            <input
              value={title}
              maxLength={1024}
              aria-invalid={linkError === "SOURCE_LINK_INVALID"}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <button type="submit">{t.addReferenceLink}</button>
          <button type="button" onClick={closeLink}>
            {t.cancel}
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
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="library-read-status">
        {reading && !loaded && <p role="status">{t.libraryLoading}</p>}
        {readFailed && <p role="status">{t.libraryReadFailed}</p>}
        {readFailed && (
          <button
            className="quiet-button"
            disabled={reading}
            onClick={() => void refresh(true)}
          >
            {t.libraryReload}
          </button>
        )}
      </div>
      {loaded && !items.length && !readFailed && (
        <p className="muted">{t.libraryEmpty}</p>
      )}
      <LibraryTree items={items} renderItem={renderItem} />
      {text && (
        <WritingDialog
          closeLabel={t.close}
          title={t.extractedText}
          close={() => setText(null)}
        >
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
        </WritingDialog>
      )}
    </section>
  );
}
function linkDomain(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
function LinkRename({
  item,
  t,
  save,
  rename,
}: {
  item: SourceSummary;
  t: typeof en;
  save: Autosave;
  rename: (
    title: string,
    signal: AbortSignal,
  ) => Promise<{ ok: boolean; error: string }>;
}) {
  const [editing, setEditing] = useState(false),
    [title, setTitle] = useState(item.source.title),
    [error, setError] = useState("");
  const input = useRef(title);
  input.current = title;
  const live = useRef(false),
    abort = useRef<AbortController | null>(null),
    epoch = useRef(0);
  const key = `source-rename:${item.source.id}`;
  useEffect(
    () => () => {
      live.current = false;
      abort.current?.abort();
      save.actions.cancel(key);
      save.composition(false, key);
    },
    [save, key],
  );
  function close() {
    live.current = false;
    abort.current?.abort();
    epoch.current++;
    save.actions.cancel(key);
    save.composition(false, key);
    setEditing(false);
  }
  return editing ? (
    <form
      onCompositionStart={() => save.composition(true, key)}
      onCompositionEnd={() => save.composition(false, key)}
      onBlurCapture={() =>
        save.actions.blur(key, () => save.composition(false, key))
      }
      onSubmit={(event) => {
        event.preventDefault();
        setError("");
        void save.actions.run(
          key,
          async () => {
            const submitted = input.current,
              generation = epoch.current;
            abort.current = new AbortController();
            const result = await rename(submitted, abort.current.signal);
            if (result.ok) {
              if (
                live.current &&
                generation === epoch.current &&
                submitted === input.current
              )
                close();
            } else if (live.current && generation === epoch.current)
              setError(result.error || "SAVE_FAILED");
          },
          () => live.current,
        );
      }}
    >
      <label>
        {t.libraryRenameLink}
        <input
          autoFocus
          aria-invalid={error === "SOURCE_LINK_INVALID"}
          required
          maxLength={1024}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <button type="submit">{t.librarySaveTitle}</button>
      <button type="button" onClick={close}>
        {t.cancel}
      </button>
    </form>
  ) : (
    <button
      onClick={() => {
        setTitle(item.source.title);
        setError("");
        live.current = true;
        setEditing(true);
      }}
    >
      {t.libraryRenameLink}
    </button>
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
function warningMessage(code: string, t: typeof en) {
  if (code === "IMAGES_UNPROCESSED") return t.imagesUnprocessed;
  if (code.startsWith("PDF_")) return t.pdfLayoutWarning;
  if (code === "RAW_HTML_IGNORED") return t.rawHtmlIgnored;
  return t.formatNormalized;
}
