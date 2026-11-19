import type * as Work from "@scenesparrow/contracts";
import { workPath, pageQuery } from "./external-work";
import type {
  AuthoredSourceSaveRequest,
  AuthoredSourceResolveRequest,
  AuthoredSourceRecoverRequest,
  CopyRequest,
  ExportRequest,
  ExportControl,
  ExportRetry,
  PlanningPreparationRequest,
  PlanningVisualAction,
  CreateProject,
  EnsureProject,
  RenameProject,
  ManuscriptCommand,
  DocumentAction,
  AiSettingsUpdate,
  AiCredentialUpdate,
  AiTestAction,
  AiTestTarget,
  ProjectEvent,
  Intake,
} from "@scenesparrow/contracts";
import type { PlatformClient } from "./types";
import { ApiError, TransportError } from "./errors";
import {
  decodeJson,
  decodeJsonText,
  fetchResponse,
  networkError,
  reportTransport,
} from "./transport";
import { subscribeProjectEvents } from "./events";
import { validateExternalLink } from "./links";

export function createHttpClient(baseUrl = "/api"): PlatformClient {
  async function request<T>(
    path: string,
    body?:
      | Work.GraphRegisterRequest
      | Work.WorkItemCreateRequest
      | Work.WorkItemInspectRequest
      | Work.WorkCandidateAcceptRequest
      | Work.WorkItemDiscardRequest
      | Work.WorkItemControlRequest
      | Work.ProductionFileLockRequest
      | AuthoredSourceSaveRequest
      | AuthoredSourceResolveRequest
      | AuthoredSourceRecoverRequest
      | CopyRequest
      | ExportRequest
      | ExportControl
      | ExportRetry
      | PlanningPreparationRequest
      | PlanningVisualAction
      | CreateProject
      | EnsureProject
      | RenameProject
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
  const downloadMember = async (path: string) => {
    const link = document.createElement("a");
    link.href = `${baseUrl}${path}`;
    link.download = "creative-member.bin";
    link.rel = "noopener";
    link.click();
    return true;
  };
  return {
    readFileGraph: () => request("/v1/project/file-graph"),
    readGraphFiles: (cursor) =>
      request(`/v1/project/file-graph/files${pageQuery(cursor)}`),
    registerFileGraph: (body) =>
      request("/v1/project/file-graph/register", body),
    createWorkItem: (body) => request("/v1/project/work-items", body),
    readWorkItems: (cursor) =>
      request(`/v1/project/work-items${pageQuery(cursor)}`),
    readWorkItem: (item) => request(workPath(item)),
    inspectWorkItem: (body) =>
      request(`${workPath(body.workItemId)}/inspect`, body),
    acceptWorkCandidate: (body) =>
      request(`${workPath(body.workItemId)}/accept`, body),
    discardWorkItem: (body) =>
      request(`${workPath(body.workItemId)}/discard`, body),
    controlWorkItem: (body) =>
      request(`${workPath(body.workItemId)}/control`, body),
    readWorkOperation: (id) =>
      request(`/v1/project/work-operations/${encodeURIComponent(id)}`),
    readWorkCandidate: (item, candidate) =>
      request(`${workPath(item)}/candidates/${encodeURIComponent(candidate)}`),
    readWorkChanges: (item, candidate, cursor) =>
      request(
        `${workPath(item)}/candidates/${encodeURIComponent(candidate)}/changes${pageQuery(cursor)}`,
      ),
    readProductionFileLocks: (cursor) =>
      request(`/v1/project/file-locks${pageQuery(cursor)}`),
    setProductionFileLocks: (body) => request("/v1/project/file-locks", body),
    inspectGraphRecovery: (intent) =>
      request(`/v1/project/file-recoveries/${encodeURIComponent(intent)}`),
    readGraphRecoveries: (cursor) =>
      request(`/v1/project/file-recoveries${pageQuery(cursor)}`),
    readGraphRecoveryMembers: (intent, cursor) =>
      request(
        `/v1/project/file-recoveries/${encodeURIComponent(intent)}/members${pageQuery(cursor)}`,
      ),
    downloadWorkCandidateMember: (item, candidate, member, role) =>
      downloadMember(
        `${workPath(item)}/candidates/${encodeURIComponent(candidate)}/members/${encodeURIComponent(member)}/${role}/bytes`,
      ),
    downloadGraphRecoveryMember: (intent, member) =>
      downloadMember(
        `/v1/project/file-recoveries/${encodeURIComponent(intent)}/members/${encodeURIComponent(member)}/bytes`,
      ),
    inspectProjectFormat: () => request("/v1/project/format"),
    readAuthoredSource: () => request("/v1/manuscript/source"),
    readAuthoredSourceRecoveryEvidence: (intent) =>
      request(
        `/v1/manuscript/source/recoveries/${encodeURIComponent(intent)}/evidence`,
      ),
    readAuthoredSourceRecoveryVersion: (intent, source) =>
      request(
        `/v1/manuscript/source/recoveries/${encodeURIComponent(intent)}/evidence/${encodeURIComponent(source)}`,
      ),
    readAuthoredSourceStatus: () => request("/v1/manuscript/source/status"),
    rescanAuthoredSource: () =>
      request("/v1/manuscript/source/rescan", undefined, "POST"),
    readAuthoredSourceCandidate: (id) =>
      request(`/v1/manuscript/source/candidates/${encodeURIComponent(id)}`),
    resolveAuthoredSource: (body) =>
      request("/v1/manuscript/source/resolve", body),
    recoverAuthoredSource: (body) =>
      request("/v1/manuscript/source/recover", body),
    saveAuthoredSource: (body) => request("/v1/manuscript/source", body),
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
    ensureProject: (command) => request("/v1/project/ensure", command),
    renameProject: (command) => request("/v1/project/rename", command),
  };
}
