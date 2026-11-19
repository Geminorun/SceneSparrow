import { WorkPackageExport } from "../project-transfer/ProjectTransfers";
import { useEffect, useRef, useState } from "react";
import type {
  FileGraphView,
  GraphFileView,
  SourceSummary,
  WorkItemView,
  WorkChangeView,
  GraphActionBase,
  WorkItemCreateRequest,
  WorkOperationView,
} from "@scenesparrow/contracts";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type { ProjectSession } from "../project-session/project-session";
import type en from "../locales/en.json";
import { useNoticeOwner } from "../feedback/NotificationPresenter";
import { useScopedRead } from "./use-scoped-read";

export type ReturnedWorkSelection = {
  serial: number;
  workItemId: string;
  candidateId: string;
};

/** Presentation stays inside the existing Changes dialog and project session. */
export function ExternalWork({
  client,
  save,
  t,
  returnedSelection,
  onManualSelection,
}: {
  client: PlatformClient;
  save: ProjectSession;
  t: typeof en;
  returnedSelection?: ReturnedWorkSelection | null;
  onManualSelection?: () => void;
}) {
  const [operation, setOperation] = useState<WorkOperationView | null>(null);
  const operationEpoch = useRef(0);
  const [graph, setGraph] = useState<FileGraphView | null>(null),
    [items, setItems] = useState<WorkItemView[]>([]),
    [selected, setSelected] = useState<string | null>(null);
  const [changes, setChanges] = useState<WorkChangeView[]>([]),
    [changeCursor, setChangeCursor] = useState<string | null>(null),
    [itemCursor, setItemCursor] = useState<string | null>(null),
    [files, setFiles] = useState<GraphFileView[]>([]),
    [fileCursor, setFileCursor] = useState<string | null>(null);
  const [nameMismatch, setNameMismatch] = useState(false);
  const [setup, setSetup] = useState(false),
    [whole, setWhole] = useState(false),
    [paths, setPaths] = useState(""),
    [manuscript, setManuscript] = useState<"all" | "blocks" | "none">("none"),
    [blockIds, setBlockIds] = useState(""),
    [origin, setOrigin] = useState<"copy" | "live">("copy");
  const [references, setReferences] = useState<SourceSummary[]>([]),
    [referenceCursor, setReferenceCursor] = useState<string | null>(null),
    [referenceIds, setReferenceIds] = useState<string[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [selectedPath, setSelectedPath] = useState<string | null>(null);
  const explicitOperations = useRef(new Set<string>());
  const mounted = useRef(true),
    readEpoch = useRef(0),
    changeEpoch = useRef(0);
  const notice = useNoticeOwner();
  const explicitOperationRead = useRef(true);
  const item = items.find((i) => i.workItemId === selected) ?? null;
  const [expectedReturn, setExpectedReturn] =
    useState<ReturnedWorkSelection | null>(null);
  const returnOwner = useRef<ReturnedWorkSelection | null>(null);
  const selectedOwner = useRef(selected);
  selectedOwner.current = selected;
  const staleReturn =
    !!expectedReturn &&
    !!item &&
    item.latestCandidate?.candidateId !== expectedReturn.candidateId;
  const candidate = staleReturn ? null : item?.latestCandidate;
  const listReads = useScopedRead(client, save.projectId);
  const pathOwner = useRef(selectedPath);
  pathOwner.current = selectedPath;
  const reads = useScopedRead(
    client,
    `${selected ?? ""}:${candidate?.candidateId ?? ""}`,
  );
  const message = (code: string) =>
    (t as Record<string, string>)[code] ?? t.externalWorkFailed;
  function refresh(passive = false) {
    return listReads.run(
      "work-refresh",
      async () => {
        const selectedId = selectedOwner.current;
        const graph = await client.readFileGraph!();
        const page = await client.readWorkItems!();
        const retained =
          selectedId &&
          !page.records.some((row) => row.workItemId === selectedId)
            ? await client.readWorkItem!(selectedId)
            : null;
        return { graph, page, retained };
      },
      ({ graph, page, retained }) => {
        setGraph(graph);
        setItems((previous) => {
          const current =
            retained?.workItemId === selectedOwner.current
              ? retained
              : previous.find(
                  (row) => row.workItemId === selectedOwner.current,
                );
          return current &&
            !page.records.some((row) => row.workItemId === current.workItemId)
            ? [current, ...page.records]
            : page.records;
        });
        setItemCursor(page.continuation);
        setSelected(
          (current) => current ?? page.records[0]?.workItemId ?? null,
        );
      },
      passive,
    );
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      readEpoch.current++;
      changeEpoch.current++;
      operationEpoch.current++;
    };
  }, [client]);
  useEffect(() => {
    if (!returnedSelection) return;
    const target = returnedSelection;
    returnOwner.current = target;
    setExpectedReturn(target);
    reads.invalidate();
    readEpoch.current++;
    changeEpoch.current++;
    operationEpoch.current++;
    setSelected(target.workItemId);
    setError("");
    void listReads.run(
      "returned-work-item",
      () => client.readWorkItem!(target.workItemId),
      (value) => {
        setItems((rows) => [
          value,
          ...rows.filter((row) => row.workItemId !== value.workItemId),
        ]);
      },
      false,
      () => returnOwner.current === target,
    );
    return () => {
      if (returnOwner.current === target) returnOwner.current = null;
    };
  }, [client, returnedSelection]);
  useEffect(() => {
    if (!items.some((i) => ["preparing", "inspecting"].includes(i.state)))
      return;
    const timer = setInterval(() => void refresh(true), 500);
    return () => clearInterval(timer);
  }, [items, client]);
  useEffect(() => {
    changeEpoch.current++;
    setChanges([]);
    setChangeCursor(null);
    setSelectedPath(null);
    if (!item || !candidate) return;
    void loadChanges(item.workItemId, candidate.candidateId);
  }, [client, item?.workItemId, candidate?.candidateId]);
  useEffect(() => {
    const epoch = ++operationEpoch.current;
    setOperation(null);
    if (item) {
      const explicit = explicitOperationRead.current;
      explicitOperationRead.current = false;
      void reads.run(
        "work-operation",
        () => client.readWorkOperation!(item.operationRequestId),
        (value) => {
          if (mounted.current && epoch === operationEpoch.current) {
            setOperation(value);
            if (
              explicitOperations.current.has(value.requestId) &&
              ["succeeded", "failed", "cancelled", "interrupted"].includes(
                value.status,
              )
            ) {
              explicitOperations.current.delete(value.requestId);
              if (value.failureCode)
                notice.report(value.failureCode, { identity: value.requestId });
              else if (value.status === "succeeded")
                notice.report("externalWorkComplete", {
                  identity: value.requestId,
                  tone: "success",
                });
            }
          }
        },
        !explicit,
      );
    }
  }, [client, item?.operationRequestId, item?.itemRevision]);
  function control(item: WorkItemView, kind: "cancel" | "retry") {
    return save.projectAction(
      `work-control:${item.workItemId}`,
      async () => {
        const body = {
          requestId: crypto.randomUUID(),
          projectId: item.projectId,
          workItemId: item.workItemId,
          expectedItemRevision: item.itemRevision,
          action: kind,
        };
        return {
          requestId: body.requestId,
          send: () => client.controlWorkItem!(body),
        };
      },
      false,
      false,
    );
  }
  async function perform(action: () => Promise<unknown>, refreshAfter = true) {
    if (busy) return;
    setBusy(true);
    setError("");
    notice.resolve("external-work");
    try {
      const value = await action();
      if (
        mounted.current &&
        value &&
        typeof value === "object" &&
        "project" in value
      )
        setNameMismatch(false);
      if (mounted.current && refreshAfter) await refresh();
    } catch (failure) {
      if (mounted.current) {
        if (
          failure instanceof Error &&
          failure.message === "GRAPH_NAME_MISMATCH"
        )
          setNameMismatch(true);
        setError(
          failure instanceof Error ? failure.message : "STORAGE_UNAVAILABLE",
        );
        notice.report(failure, {
          identity: "external-work",
          actions: [{ kind: "recovery", run: () => void refresh() }],
        });
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function base(revision: number): Promise<GraphActionBase> {
    const graph = await client.readFileGraph!();
    if (!graph.graphHash) throw Error("GRAPH_REGISTRATION_REQUIRED");
    return {
      requestId: crypto.randomUUID(),
      projectId: graph.projectId,
      expectedWorkingRevision: revision,
      expectedGraphHash: graph.graphHash,
      expectedGraphGeneration: graph.generation,
    };
  }
  function action<T>(
    key: string,
    build: (base: GraphActionBase) => T,
    send: (body: T) => Promise<unknown>,
    mutation = false,
  ) {
    return save
      .projectAction(
        key,
        async (revision) => {
          const body = build(await base(revision)) as T & { requestId: string };
          return {
            requestId: body.requestId,
            send: () => send(body),
            ...(mutation
              ? {
                  readback: async (
                    receipt: import("@scenesparrow/contracts").CommandReceipt,
                  ) => ({
                    receipt,
                    snapshot: await client.readAuthoredSource!(),
                  }),
                }
              : {}),
          };
        },
        mutation,
      )
      .then((value) => {
        const operation = (value as { operation?: WorkOperationView } | null)
          ?.operation;
        if (operation) explicitOperations.current.add(operation.requestId);
        return value;
      });
  }
  const choice = changes.find((c) => c.memberId === selectedPath);
  const active = item && ["preparing", "inspecting"].includes(item.state);
  const canAccept =
    !!candidate && item?.state === "ready" && !candidate.blockers.length;
  const stateLabel = (state: WorkItemView["state"]) =>
    ({
      preparing: t.externalPreparing,
      ready: t.externalReady,
      inspecting: t.externalInspecting,
      accepted: t.externalAccepted,
      discarded: t.externalDiscarded,
      failed: t.externalFailed,
      interrupted: t.externalInterrupted,
    })[state];
  function loadChanges(
    itemId: string,
    candidateId: string,
    after: string | null = null,
  ) {
    return reads.run(
      "work-changes",
      () => client.readWorkChanges!(itemId, candidateId, after ?? undefined),
      (page) => {
        setChanges((rows) =>
          after ? [...rows, ...page.records] : page.records,
        );
        setChangeCursor(page.continuation);
        if (!after) setSelectedPath(page.records[0]?.memberId ?? null);
      },
    );
  }
  function loadReferences() {
    const after = referenceCursor;
    return reads.run(
      "work-references",
      () => client.readSources(after ?? undefined),
      (page) => {
        setReferences((rows) =>
          after ? [...rows, ...page.items] : page.items,
        );
        setReferenceCursor(page.next);
      },
    );
  }
  function loadFiles() {
    const after = fileCursor;
    return reads.run(
      "work-files",
      () => client.readGraphFiles!(after ?? undefined),
      (page) => {
        setFiles((rows) => (after ? [...rows, ...page.records] : page.records));
        setFileCursor(page.continuation);
      },
    );
  }
  if (!client.createWorkItem) return null;
  return (
    <section
      className="external-work"
      aria-label={t.externalWork}
      data-testid="external-work"
    >
      <p className="muted">{t.externalWorkHelp}</p>
      {error && <p role="alert">{message(error)}</p>}
      {(reads.recovery ?? listReads.recovery) && (
        <div className="compact-read-recovery" role="status">
          <p>{message((reads.recovery ?? listReads.recovery)!.code)}</p>
          <button onClick={(reads.recovery ?? listReads.recovery)!.retry}>
            {t.retry}
          </button>
        </div>
      )}
      {save.hasExternalRecovery && (
        <div className="compact-recovery" role="status">
          <p>{t.externalRecovery}</p>
          <button
            disabled={busy}
            onClick={() => void perform(() => save.retryProjectAction())}
          >
            {t.retry}
          </button>
        </div>
      )}
      {graph && !graph.registered ? (
        <div>
          <p>{t.externalRegisterHelp}</p>
          <button
            disabled={busy}
            onClick={() =>
              void perform(() =>
                save.projectAction(
                  "graph-register",
                  async (revision) => {
                    const source = save.source!;
                    const body = {
                      requestId: crypto.randomUUID(),
                      projectId: source.projectId,
                      expectedWorkingRevision: revision,
                      expectedSourceHash: source.acceptedHash,
                      expectedSourceGeneration: source.generation,
                    };
                    return {
                      requestId: body.requestId,
                      send: () => client.registerFileGraph!(body),
                    };
                  },
                  true,
                ),
              )
            }
          >
            {t.externalRegister}
          </button>
          {nameMismatch && (
            <button
              disabled={busy}
              onClick={() =>
                void perform(() =>
                  save.projectAction("graph-name", async () => {
                    const project = (await client.readProject()).project;
                    if (!project) throw Error("PROJECT_NOT_FOUND");
                    const name = graph.manifestName ?? t.untitledProject;
                    const body = {
                      requestId: crypto.randomUUID(),
                      projectId: project.id,
                      previousTitle: project.title,
                      title: name,
                    };
                    return {
                      requestId: body.requestId,
                      legacyMetadata: true,
                      send: () => client.renameProject(body),
                    };
                  }),
                )
              }
            >
              {t.externalUseManifestName}
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="source-change-actions">
            <button
              disabled={busy}
              onClick={() => {
                setSetup((value) => !value);
                if (!references.length) void perform(loadReferences);
              }}
            >
              {t.externalCreate}
            </button>
            <button disabled={busy} onClick={() => void refresh()}>
              {t.sourceRescan}
            </button>
          </div>
          {setup && (
            <fieldset className="external-work-setup">
              <legend>{t.externalScope}</legend>
              <label>
                {t.externalOrigin}
                <select
                  value={origin}
                  onChange={(event) =>
                    setOrigin(event.target.value as typeof origin)
                  }
                >
                  <option value="copy">{t.externalCopy}</option>
                  <option value="live">{t.externalLive}</option>
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={whole}
                  onChange={(event) => setWhole(event.target.checked)}
                />
                {t.externalWholeTree}
              </label>
              {!whole && (
                <label>
                  {t.externalPaths}
                  <textarea
                    value={paths}
                    onChange={(event) => setPaths(event.target.value)}
                    rows={3}
                    placeholder={t.externalPathsPlaceholder}
                  />
                </label>
              )}
              <label>
                {t.externalManuscriptScope}
                <select
                  value={manuscript}
                  onChange={(event) =>
                    setManuscript(event.target.value as typeof manuscript)
                  }
                >
                  <option value="none">{t.externalNoProse}</option>
                  <option value="all">{t.externalAllProse}</option>
                  <option value="blocks">{t.externalSelectedBlocks}</option>
                </select>
              </label>
              {manuscript === "blocks" && (
                <label>
                  {t.externalBlockIds}
                  <input
                    value={blockIds}
                    onChange={(event) => setBlockIds(event.target.value)}
                  />
                </label>
              )}
              <fieldset>
                <legend>{t.externalContext}</legend>
                {references.map(({ source }) => (
                  <label key={source.id}>
                    <input
                      type="checkbox"
                      checked={referenceIds.includes(source.id)}
                      onChange={(event) =>
                        setReferenceIds((ids) =>
                          event.target.checked
                            ? [...ids, source.id]
                            : ids.filter((id) => id !== source.id),
                        )
                      }
                    />
                    {source.title}
                  </label>
                ))}
                {referenceCursor && (
                  <button onClick={() => void perform(loadReferences)}>
                    {t.externalMore}
                  </button>
                )}
              </fieldset>
              <button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const grant = {
                      wholeTree: whole,
                      files: whole
                        ? []
                        : paths
                            .split(/\r?\n/)
                            .map((p) => p.trim())
                            .filter((p) => p && !p.endsWith("/")),
                      directories: whole
                        ? []
                        : paths
                            .split(/\r?\n/)
                            .map((p) => p.trim())
                            .filter((p) => p.endsWith("/"))
                            .map((p) => p.slice(0, -1)),
                      manuscriptScope: {
                        kind: manuscript,
                        blockIds:
                          manuscript === "blocks"
                            ? blockIds.split(/[\s,]+/).filter(Boolean)
                            : [],
                      },
                    };
                    const result = await action(
                      "work-create",
                      (b) =>
                        ({
                          ...b,
                          origin,
                          grant,
                          referenceIds,
                        }) satisfies WorkItemCreateRequest,
                      (body) => client.createWorkItem!(body),
                    );
                    if (result && mounted.current) setSetup(false);
                  })
                }
              >
                {t.externalCreate}
              </button>
            </fieldset>
          )}
          <ul className="external-work-items">
            {items.map((row) => (
              <li key={row.workItemId}>
                <button
                  data-work-item-id={row.workItemId}
                  aria-pressed={selected === row.workItemId}
                  onClick={() => {
                    returnOwner.current = null;
                    setExpectedReturn(null);
                    onManualSelection?.();
                    if (selected === row.workItemId) return;
                    reads.invalidate();
                    readEpoch.current++;
                    changeEpoch.current++;
                    operationEpoch.current++;
                    explicitOperationRead.current = true;
                    setSelected(row.workItemId);
                  }}
                >
                  <span>
                    {row.origin === "copy" ? t.externalCopy : t.externalLive}
                  </span>
                  <span>{stateLabel(row.state)}</span>
                  <small>{row.baseGraphHash.slice(0, 10)}</small>
                </button>
              </li>
            ))}
          </ul>
          {itemCursor && (
            <button
              onClick={() =>
                void reads.run(
                  "work-items",
                  () => client.readWorkItems!(itemCursor!),
                  (page) => {
                    setItems((rows) => [...rows, ...page.records]);
                    setItemCursor(page.continuation);
                  },
                )
              }
            >
              {t.externalMore}
            </button>
          )}
          {item && (
            <div className="external-work-detail">
              {item.origin === "copy" &&
                item.state === "ready" &&
                client.startWorkCopyPackageExport && (
                  <WorkPackageExport
                    key={item.workItemId}
                    client={client}
                    save={save}
                    item={item}
                    t={t}
                  />
                )}
              {operation?.failureCode && (
                <p role="status">{message(operation.failureCode)}</p>
              )}
              <p>
                {t.externalScope}:{" "}
                {item.grant.wholeTree
                  ? t.externalWholeTree
                  : [
                      ...item.grant.files,
                      ...item.grant.directories.map((p) => `${p}/`),
                    ].join(", ") || t.externalEmptyScope}
              </p>
              <p className="muted">
                {t.externalBase}: {item.baseGraphHash.slice(0, 12)} ·{" "}
                {t.revision} {item.creationRevision}
              </p>
              <div className="source-change-actions">
                {client.revealWorkItem && item.origin === "copy" && (
                  <button
                    disabled={busy || !!active}
                    onClick={() =>
                      void perform(() =>
                        client.revealWorkItem!(item.workItemId),
                      )
                    }
                  >
                    {t.externalReveal}
                  </button>
                )}
                <button
                  disabled={busy || !!active || item.state === "discarded"}
                  onClick={() =>
                    void perform(() =>
                      action(
                        `work-inspect:${item.workItemId}`,
                        (b) => ({
                          ...b,
                          workItemId: item.workItemId,
                          expectedItemRevision: item.itemRevision,
                        }),
                        (body) => client.inspectWorkItem!(body),
                      ),
                    )
                  }
                >
                  {t.externalInspect}
                </button>
                {active && (
                  <button
                    disabled={busy}
                    onClick={() => void perform(() => control(item, "cancel"))}
                  >
                    {t.cancel}
                  </button>
                )}
                {["failed", "interrupted"].includes(item.state) && (
                  <button
                    disabled={busy}
                    onClick={() => void perform(() => control(item, "retry"))}
                  >
                    {t.retry}
                  </button>
                )}
              </div>
              {staleReturn && <p role="status">{t.transferReturnedStale}</p>}
              {candidate && (
                <>
                  {candidate.blockers.map((code) => (
                    <p role="status" key={code}>
                      {message(code)}
                    </p>
                  ))}
                  <p>
                    {candidate.impact === "production"
                      ? t.externalProductionImpact
                      : t.externalSourceImpact}{" "}
                    · {t.externalIdentityPreparation}: {candidate.assignedIds}
                  </p>
                  {candidate.provenance.map((p, index) => (
                    <p className="muted" key={index}>
                      {t.externalProvenance}: {p.sourceBlockId} · {t.revision}{" "}
                      {p.sourceRevision} ·{" "}
                      {p.status === "available"
                        ? t.externalNarrationAvailable
                        : p.status === "diverged"
                          ? t.externalNarrationDiverged
                          : t.externalNarrationMissing}
                      {p.adapted ? ` · ${t.externalNarrationAdapted}` : ""}
                    </p>
                  ))}
                  <ul className="external-work-files">
                    {changes.map((change) => (
                      <li key={change.memberId}>
                        <button
                          aria-pressed={selectedPath === change.memberId}
                          onClick={() => setSelectedPath(change.memberId)}
                        >
                          <span>
                            {change.kind === "add"
                              ? "+"
                              : change.kind === "delete"
                                ? "−"
                                : "±"}
                          </span>
                          <span>{change.path}</span>
                          <small>
                            {change.afterSize || change.beforeSize} B
                          </small>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {changeCursor && (
                    <button
                      onClick={() =>
                        void loadChanges(
                          item.workItemId,
                          candidate.candidateId,
                          changeCursor,
                        )
                      }
                    >
                      {t.externalMore}
                    </button>
                  )}
                  {choice && (
                    <section className="source-diff" aria-label={choice.path}>
                      <h3>{choice.path}</h3>
                      {choice.renameHint && (
                        <p>
                          {t.externalRenameHint}: {choice.renameHint}
                        </p>
                      )}
                      {choice.text !== null ? (
                        <pre>{choice.text || t.sourceDiffByteChanges}</pre>
                      ) : (
                        <p>{t.externalBinary}</p>
                      )}
                      {choice.truncated && <p>{t.sourceDiffTruncated}</p>}
                      <div className="source-change-actions">
                        {(["before", "after"] as const).map(
                          (role) =>
                            choice[`${role}Hash`] && (
                              <button
                                key={role}
                                onClick={() =>
                                  void reads.run(
                                    `work-download:${choice.memberId}:${role}`,
                                    () =>
                                      client.downloadWorkCandidateMember!(
                                        item.workItemId,
                                        candidate.candidateId,
                                        choice.memberId,
                                        role,
                                      ),
                                    () => {},
                                    false,
                                    () => pathOwner.current === choice.memberId,
                                  )
                                }
                              >
                                {role === "before"
                                  ? t.externalDownloadBefore
                                  : t.externalDownloadAfter}
                              </button>
                            ),
                        )}
                      </div>
                    </section>
                  )}
                  <div className="source-change-actions">
                    <button
                      disabled={busy || !canAccept}
                      onClick={() =>
                        void perform(() =>
                          action(
                            `work-accept:${candidate.candidateId}`,
                            (b) => ({
                              ...b,
                              workItemId: item.workItemId,
                              candidateId: candidate.candidateId,
                              candidateDigest: candidate.candidateDigest,
                              expectedItemRevision: item.itemRevision,
                            }),
                            (body) => client.acceptWorkCandidate!(body),
                            true,
                          ),
                        )
                      }
                    >
                      {t.externalAccept}
                    </button>
                    <button
                      disabled={busy || !!active}
                      onClick={() =>
                        void perform(() =>
                          action(
                            `work-discard:${candidate.candidateId}`,
                            (b) => ({
                              ...b,
                              workItemId: item.workItemId,
                              candidateId: candidate.candidateId,
                              expectedItemRevision: item.itemRevision,
                              disposition:
                                item.origin === "live"
                                  ? ("restoreAcceptedLive" as const)
                                  : ("discardCandidate" as const),
                            }),
                            (body) => client.discardWorkItem!(body),
                            true,
                          ),
                        )
                      }
                    >
                      {item.origin === "live"
                        ? t.externalRestoreLive
                        : t.externalDiscardCandidate}
                    </button>
                  </div>
                </>
              )}
              {item.origin === "copy" && item.state !== "discarded" && (
                <button
                  disabled={busy || !!active}
                  onClick={() =>
                    void perform(() =>
                      action(
                        `work-discard-copy:${item.workItemId}`,
                        (b) => ({
                          ...b,
                          workItemId: item.workItemId,
                          candidateId:
                            item.latestCandidate?.candidateId ?? null,
                          expectedItemRevision: item.itemRevision,
                          disposition: "discardCopy" as const,
                        }),
                        (body) => client.discardWorkItem!(body),
                        true,
                      ),
                    )
                  }
                >
                  {t.externalDiscardCopy}
                </button>
              )}
            </div>
          )}
          <details>
            <summary>{t.externalProductionLocks}</summary>
            <p>{t.externalProductionLocksHelp}</p>
            <button onClick={() => void perform(loadFiles)}>
              {files.length ? t.externalMore : t.externalShowFiles}
            </button>
            <ul className="external-work-files">
              {files
                .filter(
                  (file) =>
                    file.path !== graph?.manuscriptPath &&
                    file.path !== "project.json",
                )
                .map((file) => (
                  <li key={file.path}>
                    <span>{file.path}</span>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          await action(
                            `file-lock:${file.path}`,
                            (b) => ({
                              ...b,
                              locked: !file.locked,
                              targets: [{ path: file.path, hash: file.hash }],
                            }),
                            (body) => client.setProductionFileLocks!(body),
                            true,
                          );
                          setFiles([]);
                          setFileCursor(null);
                        })
                      }
                    >
                      {file.locked ? t.unlock : t.lock}
                    </button>
                  </li>
                ))}
            </ul>
            {fileCursor && (
              <button onClick={() => void perform(loadFiles)}>
                {t.externalMore}
              </button>
            )}
          </details>
        </>
      )}
      <p className="muted">{t.externalExecutionUnavailable}</p>
    </section>
  );
}
