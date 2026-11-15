import type {
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
  onCloseRequested?(handler: () => Promise<boolean>): () => void;
  health(): Promise<Health>;
  readProject(): Promise<ProjectResponse>;
  createProject(command: CreateProject): Promise<ProjectResponse>;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly details?: HistoryErrorDetails,
  ) {
    super(code);
  }
}

export function createHttpClient(baseUrl = "/api"): PlatformClient {
  async function request<T>(
    path: string,
    body?: CreateProject | ManuscriptCommand | DocumentAction,
    method?: string,
  ): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: method ?? (body ? "POST" : "GET"),
      headers: body ? { "content-type": "application/json" } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const error = (await response.json()) as {
        code?: string;
        details?: HistoryErrorDetails;
      };
      throw new ApiError(error.code ?? "SERVICE_UNAVAILABLE", error.details);
    }
    return (await response.json()) as T;
  }
  return {
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
              const value = JSON.parse(xhr.responseText);
              if (xhr.status >= 200 && xhr.status < 300) resolve(value);
              else reject(new ApiError(value.code ?? "SERVICE_UNAVAILABLE"));
            } catch {
              reject(new Error("SERVICE_UNAVAILABLE"));
            }
          };
          xhr.onerror = xhr.ontimeout = () => {
            cleanup();
            reject(new Error("SERVICE_UNAVAILABLE"));
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
    subscribeEvents: (handler, resync) =>
      subscribeProjectEvents(
        `${baseUrl}/v1/project/events`,
        {},
        handler,
        resync,
      ),
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
  onCloseRequested(handler: () => Promise<boolean>): () => void;
}
export function createDesktopClient(bridge: DesktopBridge): PlatformClient {
  async function unwrap<T>(promise: Promise<BridgeResult<T>>): Promise<T> {
    const result = await promise;
    if (!result.ok) throw new ApiError(result.code, result.details);
    return result.data;
  }
  return {
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
        const response = await fetch(`${url}?after=${after}`, {
          headers,
          signal: abort.signal,
        });
        if (!response.ok || !response.body)
          throw new Error("SERVICE_UNAVAILABLE");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder
            .decode(value, { stream: true })
            .replaceAll("\r\n", "\n");
          if (pending.length > 1024 * 1024) throw new Error("INVALID_REQUEST");
          let boundary;
          while ((boundary = pending.indexOf("\n\n")) >= 0) {
            const frame = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            const data = frame
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("\n");
            if (frame.split("\n").some((l) => l === "event: resync_required")) {
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
      } catch {
        /* Reconnect using the last delivered cursor, without replaying work. */
      }
      if (!abort.signal.aborted)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 500);
          abort.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
    }
  })();
  return () => abort.abort();
}
