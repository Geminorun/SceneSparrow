import { safePackageFilename } from "@scenesparrow/platform-client/package-name";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type {
  NativePackageIntakeRequest,
  NativePackageIntakeResult,
  NativePackageSaveRequest,
  NativePackageSaveResult,
  PackageIntakeView,
  PackageIntakeControlRequest,
  PackageOperationView,
} from "@scenesparrow/contracts";
export interface NativePackageSession {
  core: unknown;
  request(
    path: string,
    body?: unknown,
    bytes?: Uint8Array,
    headers?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
interface Host {
  checkSender(event: IpcMainInvokeEvent, existing?: boolean): void;
  session(): NativePackageSession;
  current(session: NativePackageSession): boolean;
  chooseIntake(): Promise<string | null>;
  chooseSave(filename: string): Promise<string | null>;
  platform?: string;
}
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    v,
  );
function closed(value: unknown, keys: string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join() !== [...keys].sort().join() ||
    !keys.every((key) => uuid((value as Record<string, unknown>)[key]))
  )
    throw Error("INVALID_REQUEST");
}
const safeName = safePackageFilename;
function saveResult(
  value: unknown,
  requestId: string,
): NativePackageSaveResult {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join() !== "filename,outcome,requestId"
  )
    throw Error("CORE_UNAVAILABLE");
  const result = value as NativePackageSaveResult;
  if (
    result.requestId !== requestId ||
    !["saved", "cancelled", "exists", "unknown"].includes(result.outcome) ||
    typeof result.filename !== "string"
  )
    throw Error("CORE_UNAVAILABLE");
  return {
    requestId,
    outcome: result.outcome,
    filename: safeName(result.filename),
  };
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(Error("PACKAGE_CANCELLED"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
/** Main retains original capabilities through chooser, hashing, upload and unknown delivery. */
export function registerNativePackageIpc(
  ipc: Pick<IpcMain, "handle">,
  host: Host,
  checks?: { intakeByteLimit?: number; beforeIntakeOpen?: () => Promise<void> },
) {
  type Owner = {
    digest: string;
    session: NativePackageSession;
    abort: AbortController;
    promise: Promise<unknown>;
    terminal: boolean;
    kind: "intake" | "save";
    archiveId: string | null;
    done: boolean;
    dispatched: boolean;
    cancelBackend?: () => Promise<void>;
    cancelError: unknown;
    cancelPromise: Promise<unknown> | undefined;
  };
  const owners = new Map<string, Owner>();
  const errorResult = (error: unknown) => ({
    ok: false,
    code:
      error instanceof Error &&
      [
        "INVALID_REQUEST",
        "ORIGIN_DENIED",
        "PROJECT_CLOSING",
        "CAPABILITY_EXPIRED",
        "PACKAGE_SIZE_LIMIT",
        "PACKAGE_ARCHIVE_INVALID",
        "PACKAGE_CANCELLED",
        "PACKAGE_FILE_CHANGED",
        "SOURCE_PLATFORM_UNSUPPORTED",
        "PACKAGE_EXPIRED",
        "PACKAGE_REQUEST_CONFLICT",
        "PACKAGE_NOT_FOUND",
        "PACKAGE_REVISION_CONFLICT",
        "PACKAGE_INTAKE_CLOSED",
        "PACKAGE_BUSY",
        "PACKAGE_SAVE_NOT_STARTED",
        "SOURCE_PATH_UNSAFE",
      ].includes(error.message)
        ? error.message
        : "CORE_UNAVAILABLE",
  });
  function guard(session: NativePackageSession, signal?: AbortSignal) {
    if (!host.current(session)) throw Error("CAPABILITY_EXPIRED");
    if (signal?.aborted) throw Error("PACKAGE_CANCELLED");
  }
  async function intake(
    request: NativePackageIntakeRequest,
    session: NativePackageSession,
    abort: AbortController,
    owner: Owner,
  ): Promise<NativePackageIntakeResult> {
    const signal = abort.signal;
    guard(session, signal);
    const path = await abortable(host.chooseIntake(), signal);
    guard(session, signal);
    if (!path) return { requestId: request.requestId, outcome: "cancelled" };
    const resolved = await realpath(path);
    guard(session, signal);
    if (resolved !== path) throw Error("PACKAGE_FILE_CHANGED");
    const before = await lstat(path);
    guard(session, signal);
    const limit = Math.min(
      checks?.intakeByteLimit ?? 8 * 1024 ** 3,
      8 * 1024 ** 3,
    );
    if (!before.isFile() || before.size <= 0 || before.size > limit)
      throw Error("PACKAGE_SIZE_LIMIT");
    await checks?.beforeIntakeOpen?.();
    guard(session, signal);
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let current: PackageIntakeView | undefined;
    let creating = false;
    let cancelRequest: PackageIntakeControlRequest | undefined;
    let cancelPending: Promise<void> | undefined;
    const cancelBackend = (): Promise<void> => {
      if (cancelPending) return cancelPending;
      if (!current && !creating) return Promise.resolve();
      const pending = (async () => {
        guard(session);
        if (!cancelRequest) {
          const status = (await session.request(
            `/project/package-intakes/${current?.intakeId ?? request.requestId}`,
          )) as PackageIntakeView;
          guard(session);
          cancelRequest = {
            requestId: randomUUID(),
            ownerProjectId: request.ownerProjectId,
            intakeId: status.intakeId,
            expectedRevision: status.revision,
            action: "cancel",
          };
        }
        await session.request(
          `/project/package-intakes/${cancelRequest.intakeId}/control`,
          cancelRequest,
        );
        guard(session);
        owner.cancelError = undefined;
      })();
      cancelPending = pending
        .catch((error) => {
          if (
            error instanceof Error &&
            error.message === "PACKAGE_REVISION_CONFLICT"
          )
            cancelRequest = undefined;
          throw error;
        })
        .finally(() => {
          cancelPending = undefined;
        });
      return cancelPending;
    };
    owner.cancelBackend = cancelBackend;
    try {
      const stamp = await file.stat();
      guard(session, signal);
      if (!stamp.isFile() || stamp.size <= 0 || stamp.size > limit)
        throw Error("PACKAGE_SIZE_LIMIT");
      if (
        stamp.dev !== before.dev ||
        stamp.ino !== before.ino ||
        stamp.size !== before.size ||
        stamp.mtimeMs !== before.mtimeMs ||
        stamp.ctimeMs !== before.ctimeMs
      )
        throw Error("PACKAGE_FILE_CHANGED");
      const verify = async () => {
        const held = await file.stat();
        guard(session, signal);
        const named = await lstat(path);
        guard(session, signal);
        if (
          !named.isFile() ||
          !held.isFile() ||
          named.dev !== stamp.dev ||
          named.ino !== stamp.ino ||
          held.dev !== before.dev ||
          held.ino !== before.ino ||
          held.size !== stamp.size ||
          held.mtimeMs !== stamp.mtimeMs ||
          held.ctimeMs !== stamp.ctimeMs
        )
          throw Error("PACKAGE_FILE_CHANGED");
      };
      await verify();
      const buffer = Buffer.alloc(64 * 1024);
      const hash = createHash("sha256");
      for (let offset = 0; offset < stamp.size;) {
        const read = await file.read(
          buffer,
          0,
          Math.min(buffer.length, stamp.size - offset),
          offset,
        );
        guard(session, signal);
        if (!read.bytesRead) throw Error("PACKAGE_FILE_CHANGED");
        hash.update(buffer.subarray(0, read.bytesRead));
        offset += read.bytesRead;
      }
      await verify();
      creating = true;
      owner.dispatched = true;
      current = (await session.request(
        "/project/package-intakes",
        {
          requestId: request.requestId,
          ownerProjectId: request.ownerProjectId,
          filename: safeName(path),
          length: stamp.size,
          hash: hash.digest("hex"),
        },
        undefined,
        undefined,
        signal,
      )) as PackageIntakeView;
      guard(session, signal);
      for (let offset = current.receivedBytes; offset < stamp.size;) {
        const read = await file.read(
          buffer,
          0,
          Math.min(buffer.length, stamp.size - offset),
          offset,
        );
        guard(session, signal);
        if (!read.bytesRead) throw Error("PACKAGE_FILE_CHANGED");
        const bytes = buffer.subarray(0, read.bytesRead),
          digest = createHash("sha256").update(bytes).digest("hex");
        const ack = (await session.request(
          `/project/package-intakes/${current.intakeId}/chunks`,
          undefined,
          bytes,
          {
            "x-scenesparrow-owner-project-id": request.ownerProjectId,
            "x-scenesparrow-chunk-offset": String(offset),
            "x-scenesparrow-chunk-length": String(read.bytesRead),
            "x-scenesparrow-chunk-sha256": digest,
          },
          signal,
        )) as {
          intakeId: string;
          offset: number;
          length: number;
          hash: string;
          acknowledgedEnd: number;
        };
        guard(session, signal);
        if (
          ack.intakeId !== current.intakeId ||
          ack.offset !== offset ||
          ack.length !== bytes.length ||
          ack.hash !== digest ||
          ack.acknowledgedEnd !== offset + bytes.length
        )
          throw Error("PACKAGE_ARCHIVE_INVALID");
        offset = ack.acknowledgedEnd;
      }
      await verify();
      current = (await session.request(
        `/project/package-intakes/${current.intakeId}`,
      )) as PackageIntakeView;
      guard(session, signal);
      return {
        requestId: request.requestId,
        outcome: "selected",
        intake: current,
      };
    } catch (error) {
      if ((current || creating) && host.current(session)) {
        try {
          await cancelBackend();
        } catch (cancelError) {
          owner.cancelError = cancelError;
        }
      }
      throw error;
    } finally {
      await file.close();
    }
  }
  async function save(
    request: NativePackageSaveRequest,
    session: NativePackageSession,
    abort: AbortController,
    owner: Owner,
  ): Promise<NativePackageSaveResult> {
    const signal = abort.signal;
    guard(session, signal);
    try {
      const original = await session.request(
        `/native/project/packages/${request.archiveId}/saves/${request.requestId}`,
        undefined,
        undefined,
        undefined,
        signal,
      );
      guard(session, signal);
      return saveResult(original, request.requestId);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "PACKAGE_NOT_FOUND")
        throw error;
    }
    guard(session, signal);
    const operation = (await session.request(
      `/project/packages/operations/${request.archiveId}`,
    )) as PackageOperationView;
    guard(session, signal);
    if (
      !operation.archive ||
      operation.state !== "succeeded" ||
      operation.archive.archiveId !== request.archiveId
    )
      throw Error("PACKAGE_ARCHIVE_INVALID");
    if (operation.archive.expiresAt <= Date.now())
      throw Error("PACKAGE_EXPIRED");
    await session.request(
      `/native/project/packages/${request.archiveId}/availability`,
    );
    guard(session, signal);
    const filename = safeName(operation.archive.filename);
    const destinationPath = await abortable(host.chooseSave(filename), signal);
    guard(session, signal);
    if (!destinationPath)
      return { requestId: request.requestId, filename, outcome: "cancelled" };
    try {
      owner.dispatched = true;
      const result = (await session.request(
        `/native/project/packages/${request.archiveId}/save-new`,
        { requestId: request.requestId, destinationPath },
        undefined,
        undefined,
        signal,
      )) as NativePackageSaveResult;
      guard(session, signal);
      return saveResult(result, request.requestId);
    } catch (error) {
      if (signal.aborted)
        return {
          requestId: request.requestId,
          filename: safeName(destinationPath),
          outcome: "unknown",
        };
      if (
        error instanceof Error &&
        /^(?:PACKAGE_|SOURCE_|INVALID_REQUEST|ORIGIN_DENIED|PROJECT_CLOSING)/.test(
          error.message,
        ) &&
        !["SOURCE_READ_UNAVAILABLE"].includes(error.message)
      )
        throw error;
      // Publication may have happened. The retained promise never opens a second chooser.
      return { requestId: request.requestId, filename, outcome: "unknown" };
    }
  }
  for (const kind of ["intake", "save"] as const)
    ipc.handle(`native-package:${kind}`, async (event, value: unknown) => {
      try {
        host.checkSender(event);
        closed(
          value,
          kind === "intake"
            ? ["requestId", "ownerProjectId"]
            : ["requestId", "archiveId"],
        );
        if ((host.platform ?? process.platform) !== "linux")
          throw Error("SOURCE_PLATFORM_UNSUPPORTED");
        const request = value as NativePackageIntakeRequest &
          NativePackageSaveRequest;
        const digest = JSON.stringify([kind, value]);
        const previous = owners.get(request.requestId);
        if (previous) {
          if (previous.digest !== digest) throw Error("INVALID_REQUEST");
          return await previous.promise;
        }
        // Completed receipts have bounded cache custody; unknown delivery owners are
        // never evicted or replayed through another chooser.
        if ([...owners.values()].filter((owner) => !owner.terminal).length >= 8)
          throw Error("PACKAGE_BUSY");
        const completed = [...owners.entries()].filter(
          ([, owner]) => owner.terminal,
        );
        for (const [id] of completed.slice(
          0,
          Math.max(0, completed.length - 63),
        ))
          owners.delete(id);
        // Capture this actual session before ANY chooser/prerequisite await.
        const session = host.session(),
          abort = new AbortController();
        guard(session);
        const owner: Owner = {
          digest,
          session,
          abort,
          promise: Promise.resolve<unknown>(null),
          terminal: false,
          kind,
          archiveId: kind === "save" ? request.archiveId : null,
          done: false,
          dispatched: false,
          cancelError: undefined,
          cancelPromise: undefined,
        };
        owners.set(request.requestId, owner);
        owner.promise = (
          kind === "intake"
            ? intake(request, session, abort, owner)
            : save(request, session, abort, owner)
        )
          .then((data) => {
            owner.terminal = !("outcome" in data && data.outcome === "unknown");
            return { ok: true, data };
          })
          .catch((error) => {
            const result = errorResult(error);
            if (
              kind === "save" &&
              !owner.dispatched &&
              result.code === "CORE_UNAVAILABLE"
            )
              result.code = "PACKAGE_SAVE_NOT_STARTED";
            owner.terminal =
              !owner.dispatched || result.code !== "CORE_UNAVAILABLE";
            return result;
          })
          .finally(() => {
            owner.done = true;
          });
        return await owner.promise;
      } catch (e) {
        return errorResult(e);
      }
    });
  ipc.handle("native-package:save-status", async (event, value: unknown) => {
    try {
      host.checkSender(event, true);
      closed(value, ["requestId", "archiveId"]);
      const request = value as NativePackageSaveRequest;
      const captured = host.session();
      guard(captured);
      const retained = owners.get(request.requestId);
      if (
        retained?.kind === "save" &&
        retained.terminal &&
        retained.session.core === captured.core &&
        retained.archiveId === request.archiveId
      ) {
        const original = await retained.promise;
        guard(captured);
        return original;
      }
      const data = (await captured.request(
        `/native/project/packages/${request.archiveId}/saves/${request.requestId}`,
      )) as NativePackageSaveResult;
      guard(captured);
      const checked = saveResult(data, request.requestId);
      const original = owners.get(request.requestId);
      if (
        original?.kind === "save" &&
        original.session.core === captured.core &&
        original.archiveId === request.archiveId &&
        checked.requestId === request.requestId &&
        ["saved", "exists", "cancelled"].includes(checked.outcome)
      ) {
        original.terminal = true;
        original.promise = Promise.resolve({ ok: true, data: checked });
      }
      return { ok: true, data: checked };
    } catch (error) {
      return errorResult(error);
    }
  });
  ipc.handle("native-package:cancel-intake", async (event, value: unknown) => {
    try {
      host.checkSender(event, true);
      closed(value, ["requestId"]);
      const owner = owners.get((value as { requestId: string }).requestId);
      if (!owner) return { ok: true, data: false };
      if (owner.kind !== "intake") throw Error("INVALID_REQUEST");
      if (owner.cancelPromise) return await owner.cancelPromise;
      const wasDone = owner.done;
      const cancelling = (async () => {
        owner.abort.abort();
        await owner.promise;
        if (wasDone) await owner.cancelBackend?.();
        else if (owner.cancelError) throw owner.cancelError;
        return { ok: true, data: true };
      })();
      owner.cancelPromise = cancelling.catch((error) => {
        owner.cancelPromise = undefined;
        return errorResult(error);
      });
      return await owner.cancelPromise;
    } catch (e) {
      return errorResult(e);
    }
  });
  return {
    async settle() {
      for (const owner of owners.values()) owner.abort.abort();
      await Promise.allSettled(
        [...owners.values()].map((owner) => owner.promise),
      );
    },
    clear() {
      owners.clear();
    },
  };
}
