import {
  readTransferHints,
  writeTransferHint,
  discardTransferHint,
} from "./transfer-hints";
import { useEffect, useRef, useState } from "react";
import type {
  LegacyMigrationInspection,
  MigrationOperationView,
  PackageOperationView,
  LegacyMigrationRequest,
  ProjectPackageExportRequest,
  PackageInspectionRequest,
  PackageRestoreRequest,
  PackageReturnRequest,
  WorkItemView,
} from "@scenesparrow/contracts";
import {
  ApiError,
  PackageFileUpload,
  safePackageFilename,
  type PlatformClient,
} from "@scenesparrow/platform-client";
import type { ProjectSession } from "../project-session/project-session";
import type en from "../locales/en.json";
import { WritingDialog } from "../ui/WritingDialog";
import { useNoticeOwner } from "../feedback/NotificationPresenter";
const knownNativeRejection = (error: unknown) =>
  error instanceof ApiError &&
  [
    "SOURCE_PATH_UNSAFE",
    "PACKAGE_EXPIRED",
    "PACKAGE_NOT_FOUND",
    "PACKAGE_BUSY",
    "PACKAGE_SAVE_NOT_STARTED",
    "PACKAGE_REQUEST_CONFLICT",
    "PACKAGE_ARCHIVE_INVALID",
    "SOURCE_PLATFORM_UNSUPPORTED",
    "INVALID_REQUEST",
  ].includes(error.code);
export type TransferKind = "convert" | "export" | "import";
export type TransferIntent = {
  serial: number;
  kind: TransferKind;
  returnFocus: HTMLElement | null;
};
type Operation = PackageOperationView | MigrationOperationView;
type TransferControl = {
  action: "cancel" | "retry";
  settled: boolean;
  run: () => Promise<Operation>;
};
const terminal = (operation: Operation) =>
  !["capturing", "queued", "running"].includes(operation.state);
export function PackageStatus({
  operation,
  t,
}: {
  operation: Operation;
  t: typeof en;
}) {
  return (
    <div className="transfer-status" role="status">
      <p>
        {t.transferPhase}: {t[`transferPhase_${operation.phase}`]}
      </p>
      <p>
        {t.transferState}: {t[`transferState_${operation.state}`]}
      </p>
      {!(
        "archive" in operation &&
        operation.archive &&
        operation.state === "succeeded"
      ) && (
        <p>
          {t.transferEntries}:{" "}
          {"completedEntries" in operation
            ? operation.completedEntries
            : operation.completedObjects}{" "}
          · {t.transferBytes}: {operation.completedBytes.toLocaleString()}
        </p>
      )}
      {"archive" in operation && operation.archive && (
        <p>
          {operation.archive.filename} · {operation.archive.entryCount}{" "}
          {t.transferEntries.toLowerCase()}
        </p>
      )}
      {operation.failureCode && (
        <p>
          {(t as Record<string, string>)[operation.failureCode] ??
            t.transferFailed}
        </p>
      )}
    </div>
  );
}
export function ProjectTransfers({
  client,
  save,
  intent,
  t,
  onReturned,
}: {
  client: PlatformClient;
  save: ProjectSession;
  intent: TransferIntent | null;
  t: typeof en;
  onReturned: (target?: { workItemId: string; candidateId: string }) => void;
}) {
  const [open, setOpen] = useState<TransferKind | null>(null);
  const focus = useRef<HTMLElement | null>(null);
  const [inspection, setInspection] =
    useState<LegacyMigrationInspection | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [progress, setProgress] = useState<{
    phase: "hash" | "upload";
    done: number;
    total: number;
  } | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [nativeOutcome, setNativeOutcome] = useState("");
  const nativeSave = useRef<{ requestId: string; archiveId: string } | null>(
    null,
  );
  const notice = useNoticeOwner();
  const mounted = useRef(true),
    epoch = useRef(0);
  const upload = useRef<PackageFileUpload | null>(null);
  const nativeIntake = useRef<string | null>(null);
  const original = useRef<{
    kind: TransferKind;
    id: string;
    request?:
      | LegacyMigrationRequest
      | ProjectPackageExportRequest
      | PackageInspectionRequest
      | PackageRestoreRequest
      | PackageReturnRequest;
    resume?: () => Promise<Operation | null>;
    lookupOnly?: boolean;
    createdAt?: number;
    control?: TransferControl;
  } | null>(null);
  const [filename, setFilename] = useState("");
  const [returnWhole, setReturnWhole] = useState(false),
    [returnProse, setReturnProse] = useState(false);
  const [returnPaths, setReturnPaths] = useState("");
  const busyTask = useRef<object | null>(null);
  const cancelTask = useRef<{
    owner: string | PackageFileUpload;
    ticket: number;
    promise: Promise<void>;
  } | null>(null);
  const reportedTerminal = useRef(new Set<string>());
  const [initialHints] = useState(() => readTransferHints(save.projectId));
  const retained = useRef(
    new Map<
      string,
      {
        owner: NonNullable<typeof original.current>;
        operation: Operation | null;
      }
    >(
      initialHints.map((hint) => [
        hint.id,
        {
          owner: {
            kind: hint.kind,
            id: hint.id,
            createdAt: hint.createdAt,
            lookupOnly: true,
            ...(hint.request
              ? {
                  request: hint.request as NonNullable<
                    NonNullable<typeof original.current>["request"]
                  >,
                }
              : {}),
          },
          operation: null,
        },
      ]),
    ),
  );
  const retainOwner = (owner: NonNullable<typeof original.current>) => {
    if (!retained.current.has(owner.id) && retained.current.size >= 20) {
      for (const [id, row] of retained.current) {
        if (retained.current.size < 20) break;
        if (
          row.operation &&
          terminal(row.operation) &&
          (!row.owner.control || row.owner.control.settled)
        )
          retained.current.delete(id);
      }
      if (retained.current.size >= 20) throw new ApiError("TRANSFER_BUSY");
    }
    owner.createdAt ??= Date.now();
    original.current = owner;
    writeTransferHint({
      version: 1,
      id: owner.id,
      projectId: save.projectId,
      kind: owner.kind,
      createdAt: owner.createdAt,
      ...(owner.request
        ? { request: owner.request as unknown as Record<string, unknown> }
        : {}),
    });
    retained.current.set(owner.id, {
      owner,
      operation: retained.current.get(owner.id)?.operation ?? null,
    });
  };
  const reportTerminal = (next: Operation, explicit = false) => {
    if (busyTask.current && !explicit) return;
    const key = `${next.requestId}:${next.operationRevision}:${next.failureCode ?? ""}`;
    if (next.failureCode && !reportedTerminal.current.has(key)) {
      reportedTerminal.current.add(key);
      notice.resolve("project-transfer");
      notice.report(next.failureCode, { identity: "project-transfer" });
    }
  };
  const recentRows = () =>
    [...retained.current.values()].sort(
      (a, b) => (b.owner.createdAt ?? 0) - (a.owner.createdAt ?? 0),
    );
  const selectRow = (
    previous:
      | {
          owner: NonNullable<typeof original.current>;
          operation: Operation | null;
        }
      | undefined,
    kind: TransferKind,
  ) => {
    original.current = previous?.owner ?? null;
    setOperation(previous?.operation ?? null);
    setBusy(false);
    busyTask.current = null;
    setProgress(null);
    setError("");
    setDownloaded(false);
    const hint = readTransferHints(save.projectId).find(
      (hint) => hint.id === previous?.owner.id,
    );
    setNativeOutcome(hint?.delivery?.outcome ?? "");
    nativeSave.current =
      hint?.delivery?.outcome === "unknown"
        ? {
            requestId: hint.delivery.requestId,
            archiveId: hint.delivery.archiveId,
          }
        : null;
    setOpen(kind);
  };
  const selectKind = (kind: TransferKind) =>
    selectRow(
      recentRows().find((row) => row.owner.kind === kind),
      kind,
    );
  const persistDelivery = (
    owner: NonNullable<typeof original.current> | null,
    request: { requestId: string; archiveId: string },
    outcome: string,
  ) => {
    if (owner)
      writeTransferHint({
        version: 1,
        id: owner.id,
        projectId: save.projectId,
        kind: owner.kind,
        createdAt: owner.createdAt ?? Date.now(),
        ...(owner.request
          ? { request: owner.request as unknown as Record<string, unknown> }
          : {}),
        delivery: { ...request, outcome },
      });
  };
  const clearDeliveryHint = (
    owner: NonNullable<typeof original.current> | null,
  ) => {
    if (owner)
      writeTransferHint({
        version: 1,
        id: owner.id,
        projectId: save.projectId,
        kind: owner.kind,
        createdAt: owner.createdAt ?? Date.now(),
        ...(owner.request
          ? { request: owner.request as unknown as Record<string, unknown> }
          : {}),
      });
  };
  const announceNativeOutcome = (outcome: string) => {
    if (outcome === "unknown" || outcome === "exists")
      notice.report(
        outcome === "unknown" ? "exportUnknown" : "PACKAGE_TARGET_EXISTS",
        { identity: "project-transfer" },
      );
  };
  const failure = (e: unknown) => {
    setError(e instanceof Error ? e.message : "STORAGE_UNAVAILABLE");
    notice.resolve("project-transfer");
    notice.report(e, { identity: "project-transfer" });
  };
  const cancelSelected = (native: boolean) => {
    const selected = native ? nativeIntake.current : upload.current;
    if (!selected) return Promise.resolve();
    const ticket = epoch.current,
      capturedClient = client;
    if (
      cancelTask.current?.owner === selected &&
      cancelTask.current.ticket === ticket
    )
      return cancelTask.current.promise;
    const promise = Promise.resolve()
      .then(() =>
        typeof selected === "string"
          ? capturedClient.cancelNativePackageIntake!({
              requestId: selected,
            }).then(() => {})
          : selected.cancel(),
      )
      .catch((error) => {
        if (
          mounted.current &&
          epoch.current === ticket &&
          (typeof selected === "string"
            ? nativeIntake.current === selected
            : upload.current === selected)
        )
          failure(error);
      })
      .finally(() => {
        if (cancelTask.current?.promise === promise) cancelTask.current = null;
      });
    cancelTask.current = { owner: selected, ticket, promise };
    return promise;
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
      busyTask.current = null;
      upload.current?.controller.abort();
    };
  }, [client, save]);
  useEffect(() => {
    if (!intent) return;
    focus.current = intent.returnFocus;
    selectKind(intent.kind);
    const ticket = ++epoch.current;
    if (intent.kind === "convert") {
      setInspection(null);
      void client
        .inspectLegacyMigration?.()
        .then((value) => {
          if (mounted.current && ticket === epoch.current) setInspection(value);
        })
        .catch((e) => {
          if (mounted.current && ticket === epoch.current) failure(e);
        });
    }
  }, [intent]);
  const close = () => {
    setOpen(null);
  };
  async function perform(action: () => Promise<Operation | null | undefined>) {
    if (busyTask.current) return;
    setBusy(true);
    setError("");
    notice.resolve("project-transfer");
    reportedTerminal.current.clear();
    const task = {};
    busyTask.current = task;
    const ticket = epoch.current;
    try {
      const next = await action();
      if (next) {
        const record = retained.current.get(next.requestId);
        const effective =
          record?.operation &&
          record.operation.operationRevision > next.operationRevision
            ? record.operation
            : next;
        if (record) record.operation = effective;
        if (
          mounted.current &&
          ticket === epoch.current &&
          original.current?.id === next.requestId
        ) {
          setOperation(effective);
          reportTerminal(effective, true);
        }
      }
    } catch (e) {
      if (mounted.current && ticket === epoch.current) failure(e);
    } finally {
      if (
        mounted.current &&
        ticket === epoch.current &&
        busyTask.current === task
      ) {
        setBusy(false);
        busyTask.current = null;
      }
    }
  }
  const readOriginal = async () => {
    const owner = original.current;
    if (!owner) return null;
    return owner.kind === "convert"
      ? client.readMigrationOperation!(owner.id)
      : client.readPackageOperation!(owner.id);
  };
  useEffect(() => {
    if (!operation || terminal(operation)) return;
    let active = true,
      reading = false;
    const owner = original.current;
    const timer = setInterval(() => {
      if (reading || !owner) return;
      reading = true;
      void (
        owner.kind === "convert"
          ? client.readMigrationOperation!(owner.id)
          : client.readPackageOperation!(owner.id)
      )
        .then((next) => {
          const row = retained.current.get(next.requestId);
          if (
            row &&
            (!row.operation ||
              next.operationRevision >= row.operation.operationRevision)
          )
            row.operation = next;
          if (active && owner === original.current) {
            reportTerminal(next);
            setOperation((current) =>
              !current || next.operationRevision >= current.operationRevision
                ? next
                : current,
            );
          }
        })
        .catch(() => {})
        .finally(() => {
          reading = false;
        });
    }, 600);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, operation?.requestId, operation?.state]);
  async function convert() {
    if (
      !inspection ||
      !client.startLegacyMigration ||
      !client.issueMigrationTarget
    )
      throw new ApiError("SOURCE_CAPABILITY_UNSUPPORTED");
    if (original.current?.kind === "convert") return readOriginal();
    const source = inspection;
    const owner = { kind: "convert" as const, id: crypto.randomUUID() };
    const targetRequest = {
      requestId: crypto.randomUUID(),
      projectId: source.projectId,
      destination: "managed" as const,
    };
    const prepare = async () => {
      const ticket = epoch.current;
      const target = await client.issueMigrationTarget!(targetRequest);
      if (
        !mounted.current ||
        ticket !== epoch.current ||
        original.current?.id !== owner.id
      )
        return null;
      const request = {
        requestId: owner.id,
        projectId: source.projectId,
        contentBase: source.contentBase,
        targetId: target.targetId,
      };
      retainOwner({ ...owner, request });
      return (await client.startLegacyMigration!(request)).operation;
    };
    retainOwner({ ...owner, resume: prepare });
    return prepare();
  }
  async function reconcileOriginal() {
    const owner = original.current;
    if (!owner) return null;
    if (owner.lookupOnly) throw new ApiError("TRANSFER_LOOKUP_ONLY");
    if (owner.resume) return owner.resume();
    const request = owner.request;
    if (!request) return readOriginal();
    const result =
      owner.kind === "convert"
        ? await client.startLegacyMigration!(request as LegacyMigrationRequest)
        : "base" in request
          ? await client.startProjectPackageExport!(request)
          : "targetId" in request
            ? await client.restorePackage!(request as PackageRestoreRequest)
            : "intakeId" in request
              ? await client.inspectPackage!(
                  request as PackageInspectionRequest,
                )
              : await client.returnPackage!(request as PackageReturnRequest);
    return result.operation;
  }
  async function exportProject() {
    if (original.current?.kind === "export") return readOriginal();
    const owner = { kind: "export" as const, id: crypto.randomUUID() };
    retainOwner(owner);
    const ticket = epoch.current;
    // DTO is installed before sending, including an unknown capture ACK.
    try {
      const result = await save.capturedAction("package-export", async () => {
        const intended = {
          revision: save.state.workingRevision,
          history: save.history.historyRevision,
          hash: save.source?.acceptedHash,
          generation: save.source?.generation,
        };
        if (
          !mounted.current ||
          ticket !== epoch.current ||
          original.current !== owner
        )
          return null;
        const base = await client.readPackageBase!();
        if (
          !mounted.current ||
          ticket !== epoch.current ||
          original.current !== owner
        )
          return null;
        if (
          base.projectId !== save.projectId ||
          base.workingRevision !== intended.revision ||
          base.historyRevision !== intended.history ||
          base.sourceHash !== intended.hash ||
          base.sourceGeneration !== intended.generation
        )
          throw new ApiError("REVISION_CONFLICT");
        const request = { requestId: owner.id, base };
        retainOwner({ ...owner, request });
        return (await client.startProjectPackageExport!(request)).operation;
      });
      if (!result && original.current?.id === owner.id)
        throw new ApiError(save.error || "REVISION_CONFLICT");
      return result;
    } catch (error) {
      if (!retained.current.get(owner.id)?.owner.request) {
        retained.current.delete(owner.id);
        if (original.current?.id === owner.id) original.current = null;
      }
      throw error;
    }
  }
  async function inspectFile() {
    const selected = upload.current;
    if (!selected) return null;
    const ticket = epoch.current;
    const intake = await selected.run((phase, done, total) => {
      if (
        mounted.current &&
        ticket === epoch.current &&
        selected === upload.current
      )
        setProgress({ phase, done, total });
    });
    if (
      !mounted.current ||
      ticket !== epoch.current ||
      selected !== upload.current
    )
      return null;
    const request: PackageInspectionRequest = {
      requestId: crypto.randomUUID(),
      ownerProjectId: save.projectId,
      intakeId: intake.intakeId,
    };
    retainOwner({ kind: "import", id: request.requestId, request });
    return (await client.inspectPackage!(request)).operation;
  }
  async function control(action: "cancel" | "retry") {
    const owner = original.current;
    if (!operation || !owner || owner.id !== operation.requestId) return null;
    let captured = operation;
    let pending = owner.control;
    const ticket = epoch.current;
    if (pending?.settled) {
      const current = await readOriginal();
      if (
        !mounted.current ||
        ticket !== epoch.current ||
        original.current !== owner ||
        !current
      )
        return null;
      captured = current;
    }
    if (pending && !pending.settled) return pending.run();
    {
      const requestId = crypto.randomUUID();
      const request =
        "contentBase" in captured
          ? {
              requestId,
              projectId: captured.projectId,
              operationId: captured.requestId,
              expectedOperationRevision: captured.operationRevision,
              action,
            }
          : {
              requestId,
              ownerProjectId: captured.ownerProjectId,
              operationId: captured.requestId,
              expectedOperationRevision: captured.operationRevision,
              action,
            };
      const owned = {
        action,
        settled: false,
        run: async (): Promise<Operation> => {
          try {
            const result =
              "projectId" in request
                ? await client.controlMigration!(
                    request as import("@scenesparrow/contracts").MigrationControlRequest,
                  )
                : await client.controlPackageOperation!(
                    request as import("@scenesparrow/contracts").PackageControlRequest,
                  );
            owned.settled = true;
            return result;
          } catch (error) {
            if (
              error instanceof ApiError &&
              ![
                "STORAGE_UNAVAILABLE",
                "COMMAND_UNRESOLVED",
                "CORE_UNAVAILABLE",
                "SOURCE_RECOVERY_REQUIRED",
              ].includes(error.code)
            )
              owned.settled = true;
            throw error;
          }
        },
      };
      owner.control = owned;
      pending = owned;
    }
    return pending.run();
  }
  async function restore() {
    const inspected =
      operation && "inspection" in operation ? operation.inspection : undefined;
    if (!inspected?.verifiedRestore) return null;
    const targetRequest = {
      requestId: crypto.randomUUID(),
      ownerProjectId: save.projectId,
      inspectionId: inspected.inspectionId,
      destination: "managed" as const,
    };
    const owner = { kind: "import" as const, id: crypto.randomUUID() };
    const prepare = async () => {
      const ticket = epoch.current;
      const target = await client.issuePackageRestoreTarget!(targetRequest);
      if (
        !mounted.current ||
        ticket !== epoch.current ||
        original.current?.id !== owner.id
      )
        return null;
      const request: PackageRestoreRequest = {
        requestId: owner.id,
        ownerProjectId: save.projectId,
        inspectionId: inspected.inspectionId,
        targetId: target.targetId,
      };
      retainOwner({ ...owner, request });
      return (await client.restorePackage!(request)).operation;
    };
    retainOwner({ ...owner, resume: prepare });
    return prepare();
  }
  async function returned() {
    const inspected =
      operation && "inspection" in operation ? operation.inspection : undefined;
    if (!inspected?.trustedReturn) return null;
    const request: PackageReturnRequest = {
      requestId: crypto.randomUUID(),
      ownerProjectId: save.projectId,
      inspectionId: inspected.inspectionId,
      ...(inspected.kind === "work-copy"
        ? { workItemId: inspected.workItemId! }
        : {
            grant: {
              wholeTree: returnWhole,
              files: returnWhole
                ? []
                : returnPaths
                    .split(/\r?\n/)
                    .map((path) => path.trim())
                    .filter((path) => path && !path.endsWith("/")),
              directories: returnWhole
                ? []
                : returnPaths
                    .split(/\r?\n/)
                    .map((path) => path.trim())
                    .filter((path) => path.endsWith("/"))
                    .map((path) => path.slice(0, -1)),
              manuscriptScope: {
                kind: returnProse ? ("all" as const) : ("none" as const),
                blockIds: [],
              },
            },
          }),
    };
    retainOwner({ kind: "import", id: request.requestId, request });
    return (await client.returnPackage!(request)).operation;
  }
  const inspected =
    operation && "inspection" in operation ? operation.inspection : undefined;
  const archive =
    operation && "archive" in operation ? operation.archive : undefined;
  return (
    <>
      {!open && retained.current.size > 0 && (
        <div
          className="transfer-compact transfer-recovery"
          data-testid="transfer-recovery"
        >
          <button
            className="quiet-button"
            onClick={(event) => {
              focus.current = event.currentTarget;
              epoch.current++;
              const latest = recentRows()[0];
              if (latest) selectRow(latest, latest.owner.kind);
            }}
          >
            {t.transferRecent.replace("{count}", String(retained.current.size))}
          </button>
        </div>
      )}
      {open && (
        <WritingDialog
          title={
            t[
              open === "convert"
                ? "transferConvert"
                : open === "export"
                  ? "transferExport"
                  : "transferImport"
            ]
          }
          close={close}
          closeLabel={t.close}
          returnFocus={focus.current}
        >
          {retained.current.size > 0 && (
            <label className="transfer-file">
              {t.transferRecentOperations}
              <select
                aria-label={t.transferRecentOperations}
                value={original.current?.id ?? ""}
                onChange={(event) => {
                  const selected = retained.current.get(event.target.value);
                  epoch.current++;
                  selectRow(selected, selected?.owner.kind ?? open);
                  setFilename("");
                }}
              >
                <option value="">{t.transferNew}</option>
                {recentRows().map((row, index) => (
                  <option key={row.owner.id} value={row.owner.id}>
                    {
                      t[
                        row.owner.kind === "convert"
                          ? "transferConvert"
                          : row.owner.kind === "export"
                            ? "transferExport"
                            : "transferImport"
                      ]
                    }{" "}
                    ·{" "}
                    {row.operation
                      ? t[`transferState_${row.operation.state}`]
                      : t.transferAwaitingStatus}{" "}
                    ({index + 1})
                  </option>
                ))}
              </select>
            </label>
          )}
          {original.current?.lookupOnly && <p>{t.TRANSFER_LOOKUP_ONLY}</p>}
          <p>
            {open === "convert"
              ? t.transferConversionHelp
              : open === "export"
                ? t.transferExportHelp
                : t.transferImportHelp}
          </p>
          {open === "convert" && inspection && (
            <p>
              {t.revision} {inspection.workingRevision} ·{" "}
              {inspection.blockCount} {t.transferBlocks} ·{" "}
              {inspection.retainedObjectCount} {t.transferEntries}
            </p>
          )}
          {open === "export" && (
            <p>
              {t.transferGeneration}:{" "}
              {original.current?.request && "base" in original.current.request
                ? original.current.request.base.sourceGeneration
                : (save.source?.generation ?? "—")}
            </p>
          )}
          {open === "import" && client.choosePackageIntake && (
            <button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const requestId = crypto.randomUUID();
                  nativeIntake.current = requestId;
                  const ticket = epoch.current;
                  const result = await client.choosePackageIntake!({
                    requestId,
                    ownerProjectId: save.projectId,
                  });
                  if (
                    !mounted.current ||
                    epoch.current !== ticket ||
                    nativeIntake.current !== requestId
                  )
                    return null;
                  if (result.outcome === "cancelled" || !result.intake)
                    return null;
                  setFilename(result.intake.filename);
                  const request = {
                    requestId: crypto.randomUUID(),
                    ownerProjectId: save.projectId,
                    intakeId: result.intake.intakeId,
                  };
                  retainOwner({
                    kind: "import",
                    id: request.requestId,
                    request,
                  });
                  return (await client.inspectPackage!(request)).operation;
                })
              }
            >
              {t.transferChooseFile}
            </button>
          )}
          {open === "import" && !client.choosePackageIntake && (
            <label className="transfer-file">
              {t.transferChooseFile}
              <input
                type="file"
                accept=".zip,application/zip"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (!file) return;
                  epoch.current++;
                  busyTask.current = null;
                  setBusy(false);
                  upload.current?.controller.abort();
                  const selected: PackageFileUpload = new PackageFileUpload(
                    client,
                    save.projectId,
                    file,
                    () => mounted.current && upload.current === selected,
                  );
                  upload.current = selected;
                  original.current = null;
                  setOperation(null);
                  setProgress(null);
                  setError("");
                  setFilename(safePackageFilename(file.name));
                }}
              />
            </label>
          )}
          {filename && open === "import" && (
            <p className="transfer-filename">{filename}</p>
          )}
          {progress && open === "import" && (
            <p role="status">
              {
                t[
                  progress.phase === "hash"
                    ? "transferHashing"
                    : "transferUploading"
                ]
              }{" "}
              {Math.floor((progress.done / progress.total) * 100)}%
              <progress value={progress.done} max={progress.total} />
            </p>
          )}
          {operation && <PackageStatus operation={operation} t={t} />}
          {error && (
            <p role="status">
              {(t as Record<string, string>)[error] ?? t.transferFailed}
            </p>
          )}
          {inspected?.trustedReturn && inspected.kind === "project" && (
            <fieldset>
              <legend>{t.externalScope}</legend>
              <label>
                <input
                  type="checkbox"
                  checked={returnWhole}
                  onChange={(e) => setReturnWhole(e.target.checked)}
                />
                {t.externalWholeTree}
              </label>
              {!returnWhole && (
                <label>
                  {t.externalScope}
                  <textarea
                    value={returnPaths}
                    onChange={(e) => setReturnPaths(e.target.value)}
                  />
                </label>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={returnProse}
                  onChange={(e) => setReturnProse(e.target.checked)}
                />
                {t.externalAllProse}
              </label>
            </fieldset>
          )}
          {inspected && (
            <p>
              {t[`transferKind_${inspected.kind}`]} · {inspected.entryCount}{" "}
              {t.transferEntries} ·{" "}
              {inspected.verifiedRestore
                ? t.transferVerified
                : t.transferUnmanaged}
            </p>
          )}
          {operation?.state === "succeeded" &&
            ("contentBase" in operation || operation.kind === "restore") && (
              <p>{t.transferPrepared}</p>
            )}
          {downloaded && <p role="status">{t.transferDownloadStarted}</p>}
          {nativeOutcome && (
            <p role="status">
              {(t as Record<string, string>)[`transferNative_${nativeOutcome}`]}
            </p>
          )}
          <div className="dialog-actions">
            {original.current?.lookupOnly && (
              <button
                disabled={busy}
                onClick={() => {
                  const owner = original.current;
                  if (!owner) return;
                  discardTransferHint(owner.id);
                  retained.current.delete(owner.id);
                  original.current = null;
                  setOperation(null);
                }}
              >
                {t.transferDiscardHint}
              </button>
            )}
            {operation &&
              terminal(operation) &&
              !original.current?.lookupOnly && (
                <button
                  disabled={busy}
                  onClick={() => {
                    original.current = null;
                    setOperation(null);
                    setDownloaded(false);
                    setNativeOutcome("");
                    upload.current = null;
                    setFilename("");
                  }}
                >
                  {t.transferNew}
                </button>
              )}
            {open === "convert" && !original.current && (
              <button
                disabled={busy || !inspection?.supported}
                onClick={() => void perform(convert)}
              >
                {t.transferConvertAction}
              </button>
            )}
            {open === "export" && !original.current && (
              <button
                disabled={busy || !save.source || !client.readPackageBase}
                onClick={() => void perform(exportProject)}
              >
                {t.transferExportAction}
              </button>
            )}
            {open === "export" && !save.source && (
              <p>{t.transferConvertRequired}</p>
            )}
            {open === "import" && !original.current && (
              <button
                disabled={busy || !upload.current}
                onClick={() => void perform(inspectFile)}
              >
                {t.transferInspect}
              </button>
            )}
            {open === "import" && busy && nativeIntake.current && (
              <button onClick={() => void cancelSelected(true)}>
                {t.cancel}
              </button>
            )}
            {open === "import" && busy && upload.current && (
              <button onClick={() => void cancelSelected(false)}>
                {t.cancel}
              </button>
            )}
            {original.current &&
              !(
                operation?.state === "succeeded" &&
                "archive" in operation &&
                operation.archive
              ) && (
                <button
                  disabled={busy}
                  onClick={() => void perform(readOriginal)}
                >
                  {t.transferCheckStatus}
                </button>
              )}
            {original.current && !original.current.lookupOnly && !operation && (
              <button
                disabled={busy}
                onClick={() => void perform(reconcileOriginal)}
              >
                {t.transferReconcile}
              </button>
            )}
            {error === "GRAPH_REGISTRATION_REQUIRED" && (
              <button
                onClick={() => {
                  close();
                  onReturned();
                }}
              >
                {t.transferReviewChanges}
              </button>
            )}
            {operation &&
              !original.current?.lookupOnly &&
              !terminal(operation) && (
                <button
                  disabled={busy}
                  onClick={() => void perform(() => control("cancel"))}
                >
                  {t.cancel}
                </button>
              )}
            {operation &&
              !original.current?.lookupOnly &&
              ["failed", "interrupted"].includes(operation.state) && (
                <button
                  disabled={busy}
                  onClick={() => void perform(() => control("retry"))}
                >
                  {t.retry}
                </button>
              )}
            {nativeOutcome === "unknown" &&
              client.readNativePackageSave &&
              nativeSave.current && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      const request = nativeSave.current!,
                        ticket = epoch.current,
                        owner = original.current;
                      // Lookup errors never prove that a previously dispatched
                      // unknown write cannot still publish. Keep original custody.
                      const result =
                        await client.readNativePackageSave!(request);
                      persistDelivery(owner, request, result.outcome);
                      if (
                        mounted.current &&
                        ticket === epoch.current &&
                        nativeSave.current === request
                      ) {
                        setNativeOutcome(result.outcome);
                        if (result.outcome !== "unknown")
                          nativeSave.current = null;
                      }
                      return null;
                    })
                  }
                >
                  {t.transferCheckDelivery}
                </button>
              )}
            {archive && client.savePackageArchive && (
              <button
                disabled={busy || nativeOutcome === "unknown"}
                onClick={() =>
                  void perform(async () => {
                    const request =
                      nativeSave.current?.archiveId === archive.archiveId
                        ? nativeSave.current
                        : (nativeSave.current = {
                            requestId: crypto.randomUUID(),
                            archiveId: archive.archiveId,
                          });
                    const ticket = epoch.current,
                      owner = original.current;
                    persistDelivery(owner, request, "unknown");
                    setNativeOutcome("");
                    let result;
                    try {
                      result = await client.savePackageArchive!(request);
                    } catch (error) {
                      if (
                        mounted.current &&
                        ticket === epoch.current &&
                        nativeSave.current === request &&
                        knownNativeRejection(error)
                      ) {
                        nativeSave.current = null;
                        clearDeliveryHint(owner);
                      } else if (
                        mounted.current &&
                        ticket === epoch.current &&
                        nativeSave.current === request
                      ) {
                        setNativeOutcome("unknown");
                      }
                      throw error;
                    }
                    persistDelivery(owner, request, result.outcome);
                    if (
                      mounted.current &&
                      ticket === epoch.current &&
                      nativeSave.current === request
                    ) {
                      setNativeOutcome(result.outcome);
                      announceNativeOutcome(result.outcome);
                      if (result.outcome !== "unknown")
                        nativeSave.current = null;
                    }
                    return null;
                  })
                }
              >
                {t.transferSaveNew}
              </button>
            )}
            {archive && !client.savePackageArchive && (
              <button
                disabled={busy || !client.downloadPackageArchive}
                onClick={() =>
                  void perform(async () => {
                    const ticket = epoch.current;
                    await client.downloadPackageArchive!(archive);
                    if (mounted.current && ticket === epoch.current)
                      setDownloaded(true);
                    return null;
                  })
                }
              >
                {t.transferDownload}
              </button>
            )}
            {inspected?.verifiedRestore && !original.current?.lookupOnly && (
              <button disabled={busy} onClick={() => void perform(restore)}>
                {t.transferRestore}
              </button>
            )}
            {inspected?.trustedReturn && !original.current?.lookupOnly && (
              <button
                disabled={
                  busy ||
                  (inspected.kind === "project" &&
                    !returnWhole &&
                    !returnProse &&
                    !returnPaths.trim())
                }
                onClick={() => void perform(returned)}
              >
                {t.transferReturn}
              </button>
            )}
            {operation && "candidate" in operation && operation.candidate && (
              <button
                onClick={() => {
                  const candidate = operation.candidate!;
                  close();
                  onReturned({
                    workItemId: candidate.workItemId,
                    candidateId: candidate.candidateId,
                  });
                }}
              >
                {t.transferReviewChanges}
              </button>
            )}
          </div>
        </WritingDialog>
      )}
    </>
  );
}
export function WorkPackageExport({
  client,
  save,
  item,
  t,
}: {
  client: PlatformClient;
  save: ProjectSession;
  item: WorkItemView;
  t: typeof en;
}) {
  const [operation, setOperation] = useState<PackageOperationView | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [deliveryOutcome, setDeliveryOutcome] = useState("");
  const pending = useRef<{
    request: Parameters<
      NonNullable<PlatformClient["startWorkCopyPackageExport"]>
    >[0];
    sent: boolean;
  } | null>(null);
  const delivery = useRef<{ requestId: string; archiveId: string } | null>(
    null,
  );
  const notice = useNoticeOwner(),
    mounted = useRef(true),
    task = useRef<object | null>(null);
  const latestOperation = useRef<PackageOperationView | null>(null),
    reported = useRef(new Set<string>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      task.current = null;
    };
  }, [client, save]);
  const adopt = (next: PackageOperationView, explicit = false) => {
    if (
      !mounted.current ||
      next.requestId !== pending.current?.request.requestId ||
      (latestOperation.current?.requestId === next.requestId &&
        latestOperation.current.operationRevision > next.operationRevision)
    )
      return;
    latestOperation.current = next;
    setOperation(next);
    const key = `${next.requestId}:${next.operationRevision}:${next.failureCode ?? ""}`;
    if (
      (!task.current || explicit) &&
      next.failureCode &&
      !reported.current.has(key)
    ) {
      reported.current.add(key);
      notice.report(next.failureCode);
    }
  };
  const fail = (error: unknown) => {
    if (!mounted.current) return;
    setError(error instanceof Error ? error.message : "STORAGE_UNAVAILABLE");
    notice.resolve();
    notice.report(error);
  };
  async function perform(action: () => Promise<void>) {
    if (task.current) return;
    const owned = {};
    task.current = owned;
    setBusy(true);
    setError("");
    reported.current.clear();
    notice.resolve();
    try {
      await action();
    } catch (error) {
      fail(error);
    } finally {
      if (mounted.current && task.current === owned) {
        task.current = null;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    if (!operation || terminal(operation)) return;
    let active = true,
      reading = false;
    const requestId = operation.requestId;
    const timer = setInterval(() => {
      if (reading) return;
      reading = true;
      void client.readPackageOperation!(requestId)
        .then((next) => {
          if (active) adopt(next);
        })
        .catch(() => {})
        .finally(() => {
          reading = false;
        });
    }, 600);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [operation?.requestId, operation?.state, client]);
  const lookup = async () => {
    const owned = pending.current;
    if (owned)
      adopt(await client.readPackageOperation!(owned.request.requestId), true);
  };
  async function start() {
    if (pending.current?.sent) return lookup();
    const owned = (pending.current ??= {
      request: {
        requestId: crypto.randomUUID(),
        ownerProjectId: item.projectId,
        workItemId: item.workItemId,
        expectedWorkItemRevision: item.itemRevision,
      },
      sent: false,
    });
    const result = await save.capturedAction(
      `work-package:${owned.request.workItemId}:${owned.request.requestId}`,
      async () => {
        if (!mounted.current || pending.current !== owned) return null;
        owned.sent = true;
        writeTransferHint({
          version: 1,
          id: owned.request.requestId,
          projectId: item.projectId,
          kind: "export",
          createdAt: Date.now(),
        });
        return (await client.startWorkCopyPackageExport!(owned.request))
          .operation;
      },
    );
    if (result) adopt(result, true);
    else if (mounted.current)
      throw new ApiError(save.error || "REVISION_CONFLICT");
  }
  async function deliver() {
    const archive = operation?.archive;
    if (!archive) return;
    if (client.savePackageArchive) {
      const request = (delivery.current ??= {
        requestId: crypto.randomUUID(),
        archiveId: archive.archiveId,
      });
      writeTransferHint({
        version: 1,
        id: pending.current!.request.requestId,
        projectId: item.projectId,
        kind: "export",
        createdAt: Date.now(),
        delivery: { ...request, outcome: "unknown" },
      });
      setDeliveryOutcome("");
      let result;
      try {
        result = await client.savePackageArchive(request);
      } catch (error) {
        if (
          mounted.current &&
          delivery.current === request &&
          knownNativeRejection(error)
        ) {
          delivery.current = null;
          writeTransferHint({
            version: 1,
            id: pending.current!.request.requestId,
            projectId: item.projectId,
            kind: "export",
            createdAt: Date.now(),
          });
        } else if (mounted.current && delivery.current === request) {
          setDeliveryOutcome("transferNative_unknown");
        }
        throw error;
      }
      writeTransferHint({
        version: 1,
        id: pending.current!.request.requestId,
        projectId: item.projectId,
        kind: "export",
        createdAt: Date.now(),
        delivery: { ...request, outcome: result.outcome },
      });
      if (mounted.current && delivery.current === request) {
        setDeliveryOutcome(`transferNative_${result.outcome}`);
        if (result.outcome === "unknown" || result.outcome === "exists")
          notice.report(
            result.outcome === "unknown"
              ? "exportUnknown"
              : "PACKAGE_TARGET_EXISTS",
          );
        if (result.outcome !== "unknown") delivery.current = null;
      }
    } else {
      await client.downloadPackageArchive!(archive);
      if (mounted.current) setDeliveryOutcome("transferDownloadStarted");
    }
  }
  return (
    <section className="transfer-compact">
      {!(operation?.state === "succeeded" && operation.archive) && (
        <button disabled={busy} onClick={() => void perform(start)}>
          {pending.current?.sent ? t.transferCheckStatus : t.transferWorkExport}
        </button>
      )}
      {operation?.state === "succeeded" && operation.archive && (
        <button
          disabled={busy}
          onClick={() => {
            pending.current = null;
            latestOperation.current = null;
            setOperation(null);
            delivery.current = null;
            setDeliveryOutcome("");
          }}
        >
          {t.transferNewPackage}
        </button>
      )}
      {pending.current?.sent && !operation && (
        <button
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const request = pending.current!.request;
              adopt(
                (await client.startWorkCopyPackageExport!(request)).operation,
              );
            })
          }
        >
          {t.transferReconcile}
        </button>
      )}
      {error && (
        <p role="status">
          {(t as Record<string, string>)[error] ?? t.transferFailed}
        </p>
      )}
      {operation && (
        <>
          <PackageStatus operation={operation} t={t} />
          {operation.archive && (
            <button
              disabled={busy || deliveryOutcome === "transferNative_unknown"}
              onClick={() => void perform(deliver)}
            >
              {client.savePackageArchive
                ? t.transferSaveNew
                : t.transferDownload}
            </button>
          )}
        </>
      )}
      {deliveryOutcome === "transferNative_unknown" &&
        client.readNativePackageSave &&
        delivery.current && (
          <button
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const request = delivery.current!;
                const result = await client.readNativePackageSave!(request);
                if (mounted.current && delivery.current === request) {
                  writeTransferHint({
                    version: 1,
                    id: pending.current!.request.requestId,
                    projectId: item.projectId,
                    kind: "export",
                    createdAt: Date.now(),
                    delivery: { ...request, outcome: result.outcome },
                  });
                  setDeliveryOutcome(`transferNative_${result.outcome}`);
                  if (result.outcome !== "unknown") delivery.current = null;
                }
              })
            }
          >
            {t.transferCheckDelivery}
          </button>
        )}
      {deliveryOutcome && (
        <p role="status">{(t as Record<string, string>)[deliveryOutcome]}</p>
      )}
    </section>
  );
}
