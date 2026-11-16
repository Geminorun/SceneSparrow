import type {
  ManuscriptIdentity,
  CopyRequest,
  PreparedCopy,
  ClipboardAction,
  ExportRequest,
  ExportControl,
  ExportRetry,
  ExportJob,
  DeliveryAction,
  DeliveryReceipt,
  FinalizationState,
  ReviewPage,
  ReviewCandidate,
  ReviewComparison,
  ReviewMessagePage,
  PlanningState,
  PlanningPreparation,
  PlanningPreparationRequest,
  PlanningTask,
  PlanningVisual,
  PlanningVisualAction,
  AiSettingsView,
  AiSettingsUpdate,
  AiCredentialUpdate,
  AiReadiness,
  AiDiscovery,
  AiTestAction,
  AiTestTarget,
  AiTestReceipt,
  AiRun,
  HistoryErrorDetails,
  SourcePage,
  Intake,
  DocumentAction,
  DocumentJob,
  ExtractionPage,
  ProjectEvent,
  HistoryState,
  CreateProject,
  ManuscriptState,
  ManuscriptCommand,
  CommandReceipt,
  Health,
  ProjectResponse,
} from "@scenesparrow/contracts";

export interface PlatformClient {
  readManuscriptIdentity?(): Promise<ManuscriptIdentity>;
  prepareCopy(request: CopyRequest): Promise<PreparedCopy>;

  readExports(): Promise<ExportJob[]>;
  startExport(request: ExportRequest): Promise<ExportJob>;
  exportJob(id: string): Promise<ExportJob>;
  cancelExport(id: string, request: ExportControl): Promise<ExportJob>;
  retryExport(id: string, request: ExportRetry): Promise<ExportJob>;
  exportBytes(id: string): Promise<Uint8Array>;
  writePreparedClipboard?(action: ClipboardAction): Promise<void>;
  saveExport?(action: DeliveryAction): Promise<DeliveryReceipt | null>;

  readFinalization(): Promise<FinalizationState>;
  readReviews(after?: string): Promise<ReviewPage>;
  reviewCandidate(id: string, offset?: number): Promise<ReviewCandidate>;
  reviewMessages(id: string, before?: number): Promise<ReviewMessagePage>;
  reviewSourceComparison(id: string): Promise<ReviewComparison>;
  readPlanning(): Promise<PlanningState>;
  preparePlanning(
    request: PlanningPreparationRequest,
  ): Promise<PlanningPreparation>;
  planningTask(id: string): Promise<PlanningTask>;
  preparePlanningVisual(action: PlanningVisualAction): Promise<PlanningVisual>;
  planningVisual(id: string): Promise<PlanningVisual>;
  cancelPlanningVisual(id: string): Promise<PlanningVisual>;
  readAiSettings(): Promise<AiSettingsView>;
  updateAiSettings(update: AiSettingsUpdate): Promise<AiSettingsView>;
  updateAiCredential(update: AiCredentialUpdate): Promise<AiSettingsView>;
  deleteAiCredential(update: AiCredentialUpdate): Promise<AiSettingsView>;
  resolveAiConfiguration(): Promise<AiReadiness>;
  discoverAiModels(providerId: string): Promise<AiDiscovery>;
  prepareAiTest(target: AiTestTarget): Promise<AiReadiness>;
  testAiConnection(action: AiTestAction): Promise<AiTestReceipt>;
  readAiRun(runId: string): Promise<AiRun>;
  readAiResult(runId: string): Promise<Uint8Array>;
  cancelAiRun(runId: string): Promise<AiRun>;

  readSources(after?: string): Promise<SourcePage>;
  uploadFile(
    file: File,
    signal?: AbortSignal,
    progress?: (loaded: number, total: number) => void,
  ): Promise<Intake>;
  pickFileIntake?(
    signal?: AbortSignal,
    progress?: (loaded: number, total: number) => void,
  ): Promise<Intake | null>;
  cancelIntake(id: string): Promise<unknown>;
  documentAction(action: DocumentAction): Promise<DocumentJob>;
  documentJob(id: string): Promise<DocumentJob>;
  extractionPage(id: string, offset?: number): Promise<ExtractionPage>;
  subscribeEvents(
    handler: (event: ProjectEvent) => void,
    resync: () => void,
  ): () => void;
  openExternalLink(url: string): Promise<void>;

  readHistory(): Promise<HistoryState>;
  readManuscript(): Promise<ManuscriptState>;
  executeManuscript(command: ManuscriptCommand): Promise<CommandReceipt>;
  commandReceipt(requestId: string): Promise<CommandReceipt>;
  pickProject?(recover?: boolean): Promise<void>;
  backupProject?(): Promise<{ id: string }>;
  onCloseAborted?(handler: () => void): () => void;
  onCloseRequested?(handler: () => Promise<boolean>): () => void;
  health(): Promise<Health>;
  readProject(): Promise<ProjectResponse>;
  createProject(command: CreateProject): Promise<ProjectResponse>;
}

import { ApiError, TransportError } from "./errors";
import {
  decodeJson,
  decodeJsonText,
  fetchResponse,
  networkError,
  reportTransport,
} from "./transport";
export { ApiError, TransportError } from "./errors";
export { onTransportFailure } from "./transport";

export function createHttpClient(baseUrl = "/api"): PlatformClient {
  async function request<T>(
    path: string,
    body?:
      | CopyRequest
      | ExportRequest
      | ExportControl
      | ExportRetry
      | PlanningPreparationRequest
      | PlanningVisualAction
      | CreateProject
      | ManuscriptCommand
      | DocumentAction
      | AiSettingsUpdate
      | AiCredentialUpdate
      | AiTestAction
      | AiTestTarget
      | { providerId: string },
    method?: string,
  ): Promise<T> {
    try {
      const signal = AbortSignal.timeout(
        path.includes("connection-tests")
          ? 35_000
          : path.includes("models/discover")
            ? 20_000
            : 10_000,
      );
      const response = await fetchResponse(`${baseUrl}${path}`, {
        method: method ?? (body ? "POST" : "GET"),
        headers: body ? { "content-type": "application/json" } : {},
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal,
      });
      return await decodeJson<T>(response, method, false, signal);
    } catch (error) {
      reportTransport(error, path);
      throw error;
    }
  }
  const subscribers = new Set<{
    handler: (event: ProjectEvent) => void;
    resync: () => void;
  }>();
  let stopEvents: (() => void) | undefined;
  const subscribeEvents: PlatformClient["subscribeEvents"] = (
    handler,
    resync,
  ) => {
    const listener = { handler, resync };
    subscribers.add(listener);
    if (!stopEvents)
      stopEvents = subscribeProjectEvents(
        `${baseUrl}/v1/project/events`,
        {},
        (event) => {
          for (const sub of [...subscribers]) {
            try {
              sub.handler(event);
            } catch {}
          }
        },
        () => {
          for (const sub of [...subscribers]) {
            try {
              sub.resync();
            } catch {}
          }
        },
      );
    return () => {
      subscribers.delete(listener);
      if (!subscribers.size) {
        stopEvents?.();
        stopEvents = undefined;
      }
    };
  };
  return {
    readManuscriptIdentity: () => request("/v1/manuscript/identity"),
    prepareCopy: (body) => request("/v1/manuscript/copies", body),
    readExports: () => request("/v1/manuscript/exports"),
    startExport: (requestBody) =>
      request("/v1/manuscript/exports", requestBody),
    exportJob: (id) =>
      request(`/v1/manuscript/exports/${encodeURIComponent(id)}`),
    cancelExport: (id, body) =>
      request(`/v1/manuscript/exports/${encodeURIComponent(id)}/cancel`, body),
    retryExport: (id, body) =>
      request(`/v1/manuscript/exports/${encodeURIComponent(id)}/retry`, body),
    exportBytes: async (id) => {
      const path = `/v1/manuscript/exports/${encodeURIComponent(id)}/artifact`;
      const signal = AbortSignal.timeout(10000);
      let response: Response | undefined;
      try {
        response = await fetchResponse(`${baseUrl}${path}`, { signal });
        if (!response.ok) await decodeJson(response, "GET", false, signal);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 32 * 1024 * 1024)
          throw new ApiError("EXPORT_TOO_LARGE");
        return bytes;
      } catch (error) {
        const failure =
          error instanceof ApiError || error instanceof TransportError
            ? error
            : new TransportError(
                networkError(error, signal).code,
                response?.status,
                response?.headers.get("X-SceneSparrow-Trace-Id"),
              );
        reportTransport(failure, path);
        throw failure;
      }
    },
    reviewCandidate: (id, offset) =>
      request(
        `/v1/reviews/candidates/${encodeURIComponent(id)}${offset ? `?offset=${offset}` : ""}`,
      ),
    reviewSourceComparison: (id) =>
      request(`/v1/reviews/comparisons/${encodeURIComponent(id)}`),
    reviewMessages: (id, before) =>
      request(
        `/v1/reviews/${encodeURIComponent(id)}/messages${before ? `?before=${before}` : ""}`,
      ),
    readFinalization: () => request("/v1/manuscript/finalization"),
    readReviews: (after) =>
      request(
        `/v1/reviews${after ? `?after=${encodeURIComponent(after)}` : ""}`,
      ),
    readPlanning: () => request("/v1/planning"),
    preparePlanning: (body) => request("/v1/planning/preparations", body),
    planningTask: (id) =>
      request(`/v1/planning/tasks/${encodeURIComponent(id)}`),
    preparePlanningVisual: (body) => request("/v1/planning/visuals", body),
    planningVisual: (id) =>
      request(`/v1/planning/visuals/${encodeURIComponent(id)}`),
    cancelPlanningVisual: (id) =>
      request(
        `/v1/planning/visuals/${encodeURIComponent(id)}`,
        undefined,
        "DELETE",
      ),
    readAiSettings: () => request("/v1/ai/settings"),
    updateAiSettings: (update) => request("/v1/ai/settings", update, "PUT"),
    updateAiCredential: (update) => request("/v1/ai/credentials", update),
    deleteAiCredential: (update) =>
      request("/v1/ai/credentials/delete", update),
    resolveAiConfiguration: () => request("/v1/ai/configuration"),
    discoverAiModels: (providerId) =>
      request("/v1/ai/models/discover", { providerId }),
    prepareAiTest: (target) =>
      request("/v1/ai/connection-tests/prepare", target),
    testAiConnection: (action) => request("/v1/ai/connection-tests", action),
    readAiRun: (id) => request(`/v1/ai/runs/${encodeURIComponent(id)}`),
    readAiResult: async (id) => {
      const path = `/v1/ai/runs/${encodeURIComponent(id)}/result`;
      const signal = AbortSignal.timeout(10000);
      let response: Response | undefined;
      try {
        response = await fetchResponse(`${baseUrl}${path}`, { signal });
        if (!response.ok) await decodeJson(response, "GET", false, signal);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > 8388608) throw new ApiError("OUTPUT_TRUNCATED");
        return bytes;
      } catch (error) {
        const failure =
          error instanceof ApiError || error instanceof TransportError
            ? error
            : new TransportError(
                networkError(error, signal).code,
                response?.status,
                response?.headers.get("X-SceneSparrow-Trace-Id"),
              );
        reportTransport(failure, path);
        throw failure;
      }
    },
    cancelAiRun: (id) =>
      request(`/v1/ai/runs/${encodeURIComponent(id)}/cancel`, {} as never),
    readSources: (after) =>
      request(
        `/v1/sources${after ? `?after=${encodeURIComponent(after)}` : ""}`,
      ),
    uploadFile: async (file, signal, progress) => {
      if (file.size > 25 * 1024 * 1024) throw new ApiError("INPUT_TOO_LARGE");
      const id = crypto.randomUUID();
      try {
        return await new Promise<Intake>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          const abort = () => xhr.abort();
          const cleanup = () => signal?.removeEventListener("abort", abort);
          xhr.open("POST", `${baseUrl}/v1/intakes`);
          xhr.timeout = 120000;
          xhr.setRequestHeader("x-intake-id", id);
          xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
          xhr.setRequestHeader(
            "content-type",
            file.type || "application/octet-stream",
          );
          xhr.upload.onprogress = (e) => progress?.(e.loaded, file.size);
          xhr.onload = () => {
            cleanup();
            try {
              const value = decodeJsonText(
                xhr.status,
                xhr.getResponseHeader("content-type"),
                xhr.responseText,
                xhr.getResponseHeader("X-SceneSparrow-Trace-Id"),
              );
              resolve(value as Intake);
            } catch (error) {
              reportTransport(error, "/v1/intakes");
              reject(error);
            }
          };
          xhr.onerror = () => {
            cleanup();
            const error = new TransportError("NETWORK_FAILED");
            reportTransport(error, "/v1/intakes");
            reject(error);
          };
          xhr.ontimeout = () => {
            cleanup();
            const error = new TransportError("NETWORK_TIMEOUT");
            reportTransport(error, "/v1/intakes");
            reject(error);
          };
          xhr.onabort = () => {
            cleanup();
            reject(new ApiError("DOCUMENT_JOB_INTERRUPTED"));
          };
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) {
            cleanup();
            reject(new ApiError("DOCUMENT_JOB_INTERRUPTED"));
            return;
          }
          xhr.send(file);
        });
      } catch (error) {
        if (!signal?.aborted) {
          try {
            return await request<Intake>(`/v1/intakes/${id}`);
          } catch {}
        }
        await request(`/v1/intakes/${id}`, undefined, "DELETE").catch(() => {});
        throw error;
      }
    },
    cancelIntake: (id) =>
      request(`/v1/intakes/${encodeURIComponent(id)}`, undefined, "DELETE"),
    documentAction: (action) => request("/v1/document-jobs", action),
    documentJob: (id) => request(`/v1/document-jobs/${encodeURIComponent(id)}`),
    extractionPage: (id, offset = 0) =>
      request(
        `/v1/source-extractions/${encodeURIComponent(id)}?offset=${offset}`,
      ),
    subscribeEvents,
    openExternalLink: async (url) => {
      validateExternalLink(url);
      window.open(url, "_blank", "noopener,noreferrer");
    },
    readHistory: () => request("/v1/history"),
    readManuscript: () => request("/v1/manuscript"),
    executeManuscript: (command) => request("/v1/manuscript/commands", command),
    commandReceipt: (id) => request(`/v1/commands/${encodeURIComponent(id)}`),
    health: () => request("/v1/health"),
    readProject: () => request("/v1/project"),
    createProject: (command) => request("/v1/project", command),
  };
}

export type BridgeResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; details?: HistoryErrorDetails };
export interface DesktopBridge {
  readManuscriptIdentity?(): Promise<BridgeResult<ManuscriptIdentity>>;
  readExports(): Promise<BridgeResult<ExportJob[]>>;
  prepareCopy(request: CopyRequest): Promise<BridgeResult<PreparedCopy>>;

  startExport(request: ExportRequest): Promise<BridgeResult<ExportJob>>;
  exportJob(id: string): Promise<BridgeResult<ExportJob>>;
  cancelExport(
    id: string,
    request: ExportControl,
  ): Promise<BridgeResult<ExportJob>>;
  retryExport(
    id: string,
    request: ExportRetry,
  ): Promise<BridgeResult<ExportJob>>;
  exportBytes(id: string): Promise<BridgeResult<Uint8Array>>;
  writePreparedClipboard(action: ClipboardAction): Promise<BridgeResult<null>>;
  saveExport(
    action: DeliveryAction,
  ): Promise<BridgeResult<DeliveryReceipt | null>>;

  readFinalization(): Promise<BridgeResult<FinalizationState>>;
  readReviews(after?: string): Promise<BridgeResult<ReviewPage>>;
  reviewCandidate(
    id: string,
    offset?: number,
  ): Promise<BridgeResult<ReviewCandidate>>;
  reviewMessages(
    id: string,
    before?: number,
  ): Promise<BridgeResult<ReviewMessagePage>>;
  reviewSourceComparison(id: string): Promise<BridgeResult<ReviewComparison>>;
  readPlanning(): Promise<BridgeResult<PlanningState>>;
  preparePlanning(
    request: PlanningPreparationRequest,
  ): Promise<BridgeResult<PlanningPreparation>>;
  planningTask(id: string): Promise<BridgeResult<PlanningTask>>;
  preparePlanningVisual(
    action: PlanningVisualAction,
  ): Promise<BridgeResult<PlanningVisual>>;
  planningVisual(id: string): Promise<BridgeResult<PlanningVisual>>;
  cancelPlanningVisual(id: string): Promise<BridgeResult<PlanningVisual>>;
  readAiSettings(): Promise<BridgeResult<AiSettingsView>>;
  updateAiSettings(
    update: AiSettingsUpdate,
  ): Promise<BridgeResult<AiSettingsView>>;
  updateAiCredential(
    update: AiCredentialUpdate,
  ): Promise<BridgeResult<AiSettingsView>>;
  deleteAiCredential(
    update: AiCredentialUpdate,
  ): Promise<BridgeResult<AiSettingsView>>;
  resolveAiConfiguration(): Promise<BridgeResult<AiReadiness>>;
  discoverAiModels(providerId: string): Promise<BridgeResult<AiDiscovery>>;
  prepareAiTest(target: AiTestTarget): Promise<BridgeResult<AiReadiness>>;
  testAiConnection(action: AiTestAction): Promise<BridgeResult<AiTestReceipt>>;
  readAiRun(runId: string): Promise<BridgeResult<AiRun>>;
  readAiResult(runId: string): Promise<BridgeResult<Uint8Array>>;
  cancelAiRun(runId: string): Promise<BridgeResult<AiRun>>;

  readSources(after?: string): Promise<BridgeResult<SourcePage>>;
  pickFileIntake(id: string): Promise<BridgeResult<Intake | null>>;
  cancelFileSelection(id: string): Promise<BridgeResult<null>>;
  onFileIntakeProgress(
    id: string,
    handler: (loaded: number, total: number) => void,
  ): () => void;
  cancelIntake(id: string): Promise<BridgeResult<unknown>>;
  documentAction(action: DocumentAction): Promise<BridgeResult<DocumentJob>>;
  documentJob(id: string): Promise<BridgeResult<DocumentJob>>;
  extractionPage(
    id: string,
    offset: number,
  ): Promise<BridgeResult<ExtractionPage>>;
  subscribeEvents(
    handler: (event: ProjectEvent) => void,
    resync: () => void,
  ): () => void;
  openExternalLink(url: string): Promise<BridgeResult<null>>;

  health(): Promise<BridgeResult<Health>>;
  readProject(): Promise<BridgeResult<ProjectResponse>>;
  createProject(command: CreateProject): Promise<BridgeResult<ProjectResponse>>;
  readHistory(): Promise<BridgeResult<HistoryState>>;
  readManuscript(): Promise<BridgeResult<ManuscriptState>>;
  executeManuscript(
    command: ManuscriptCommand,
  ): Promise<BridgeResult<CommandReceipt>>;
  commandReceipt(requestId: string): Promise<BridgeResult<CommandReceipt>>;
  pickProject(recover?: boolean): Promise<BridgeResult<null>>;
  backupProject(): Promise<BridgeResult<{ id: string }>>;
  onCloseAborted(handler: () => void): () => void;
  onCloseRequested(handler: () => Promise<boolean>): () => void;
}
export function createDesktopClient(bridge: DesktopBridge): PlatformClient {
  async function unwrap<T>(promise: Promise<BridgeResult<T>>): Promise<T> {
    const result = await promise;
    if (!result.ok) throw new ApiError(result.code, result.details);
    return result.data;
  }
  return {
    ...(bridge.readManuscriptIdentity
      ? {
          readManuscriptIdentity: () =>
            unwrap(bridge.readManuscriptIdentity!()),
        }
      : {}),
    prepareCopy: (body) => unwrap(bridge.prepareCopy(body)),
    readExports: () => unwrap(bridge.readExports()),
    startExport: (body) => unwrap(bridge.startExport(body)),
    exportJob: (id) => unwrap(bridge.exportJob(id)),
    cancelExport: (id, body) => unwrap(bridge.cancelExport(id, body)),
    retryExport: (id, body) => unwrap(bridge.retryExport(id, body)),
    exportBytes: (id) => unwrap(bridge.exportBytes(id)),
    writePreparedClipboard: async (body) => {
      await unwrap(bridge.writePreparedClipboard(body));
    },
    saveExport: (body) => unwrap(bridge.saveExport(body)),
    readFinalization: () => unwrap(bridge.readFinalization()),
    readReviews: (after) => unwrap(bridge.readReviews(after)),
    reviewCandidate: (id, offset) => unwrap(bridge.reviewCandidate(id, offset)),
    reviewSourceComparison: (id) => unwrap(bridge.reviewSourceComparison(id)),
    reviewMessages: (id, before) => unwrap(bridge.reviewMessages(id, before)),
    readPlanning: () => unwrap(bridge.readPlanning()),
    preparePlanning: (body) => unwrap(bridge.preparePlanning(body)),
    planningTask: (id) => unwrap(bridge.planningTask(id)),
    preparePlanningVisual: (body) => unwrap(bridge.preparePlanningVisual(body)),
    planningVisual: (id) => unwrap(bridge.planningVisual(id)),
    cancelPlanningVisual: (id) => unwrap(bridge.cancelPlanningVisual(id)),
    readAiSettings: () => unwrap(bridge.readAiSettings()),
    updateAiSettings: (update) => unwrap(bridge.updateAiSettings(update)),
    updateAiCredential: (update) => unwrap(bridge.updateAiCredential(update)),
    deleteAiCredential: (update) => unwrap(bridge.deleteAiCredential(update)),
    resolveAiConfiguration: () => unwrap(bridge.resolveAiConfiguration()),
    discoverAiModels: (providerId) =>
      unwrap(bridge.discoverAiModels(providerId)),
    prepareAiTest: (target) => unwrap(bridge.prepareAiTest(target)),
    testAiConnection: (action) => unwrap(bridge.testAiConnection(action)),
    readAiRun: (id) => unwrap(bridge.readAiRun(id)),
    readAiResult: (id) => unwrap(bridge.readAiResult(id)),
    cancelAiRun: (id) => unwrap(bridge.cancelAiRun(id)),
    readSources: (after) => unwrap(bridge.readSources(after)),
    uploadFile: async () => {
      throw new ApiError("INVALID_REQUEST");
    },
    pickFileIntake: async (signal, progress) => {
      const id = crypto.randomUUID();
      const remove = bridge.onFileIntakeProgress(id, (loaded, total) =>
        progress?.(loaded, total),
      );
      const cancel = () => {
        void bridge.cancelFileSelection(id);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        if (signal?.aborted) return null;
        return await unwrap(bridge.pickFileIntake(id));
      } finally {
        signal?.removeEventListener("abort", cancel);
        remove();
      }
    },
    cancelIntake: (id) => unwrap(bridge.cancelIntake(id)),
    documentAction: (action) => unwrap(bridge.documentAction(action)),
    documentJob: (id) => unwrap(bridge.documentJob(id)),
    extractionPage: (id, offset = 0) =>
      unwrap(bridge.extractionPage(id, offset)),
    subscribeEvents: (handler, resync) =>
      bridge.subscribeEvents(handler, resync),
    openExternalLink: async (url) => {
      validateExternalLink(url);
      await unwrap(bridge.openExternalLink(url));
    },
    health: () => unwrap(bridge.health()),
    readProject: () => unwrap(bridge.readProject()),
    createProject: (c) => unwrap(bridge.createProject(c)),
    readHistory: () => unwrap(bridge.readHistory()),
    readManuscript: () => unwrap(bridge.readManuscript()),
    executeManuscript: (c) => unwrap(bridge.executeManuscript(c)),
    commandReceipt: (id) => unwrap(bridge.commandReceipt(id)),
    pickProject: async (recover) => {
      await unwrap(bridge.pickProject(recover));
    },
    backupProject: () => unwrap(bridge.backupProject()),
    onCloseAborted: (handler) => bridge.onCloseAborted(handler),
    onCloseRequested: (handler) => bridge.onCloseRequested(handler),
  };
}

export function validateExternalLink(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new ApiError("INVALID_URL");
}
/** Fetch-based SSE carries authentication headers only; cursor replay never invokes commands. */
export function subscribeProjectEvents(
  url: string,
  headers: Record<string, string>,
  handler: (event: ProjectEvent) => void,
  resync: () => void,
) {
  const abort = new AbortController();
  let after = 0;
  void (async () => {
    while (!abort.signal.aborted) {
      try {
        const response = await fetchResponse(`${url}?after=${after}`, {
          headers,
          signal: abort.signal,
        });
        if (!response.ok) await decodeJson(response);
        if (!response.body)
          throw new TransportError(
            "NETWORK_FAILED",
            response.status,
            response.headers.get("X-SceneSparrow-Trace-Id"),
          );
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            pending += decoder
              .decode(value, { stream: true })
              .replaceAll("\r\n", "\n");
            if (pending.length > 1024 * 1024)
              throw new Error("INVALID_REQUEST");
            let boundary;
            while ((boundary = pending.indexOf("\n\n")) >= 0) {
              const frame = pending.slice(0, boundary);
              pending = pending.slice(boundary + 2);
              const data = frame
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trimStart())
                .join("\n");
              if (
                frame.split("\n").some((l) => l === "event: resync_required")
              ) {
                after = Number(data) || 0;
                resync();
              } else if (data) {
                const event = JSON.parse(data) as ProjectEvent;
                if (
                  Number.isSafeInteger(event.sequence) &&
                  event.sequence > after
                ) {
                  after = event.sequence;
                  handler(event);
                }
              }
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } catch (error) {
        if (!abort.signal.aborted) reportTransport(error, "/v1/project/events");
        /* Reconnect using the last delivered cursor, without replaying work. */
      }
      if (!abort.signal.aborted)
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            abort.signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, 500);
          abort.signal.addEventListener("abort", finish, { once: true });
          if (abort.signal.aborted) finish();
        });
    }
  })();
  return () => abort.abort();
}
