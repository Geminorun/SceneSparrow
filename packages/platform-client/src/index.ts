import type {
  CreateProject,
  ManuscriptState,
  ManuscriptCommand,
  CommandReceipt,
  Health,
  ProjectResponse,
} from "@scenesparrow/contracts";

export interface PlatformClient {
  readManuscript(): Promise<ManuscriptState>;
  executeManuscript(command: ManuscriptCommand): Promise<CommandReceipt>;
  commandReceipt(requestId: string): Promise<CommandReceipt>;
  onCloseRequested?(handler: () => Promise<boolean>): () => void;
  health(): Promise<Health>;
  readProject(): Promise<ProjectResponse>;
  createProject(command: CreateProject): Promise<ProjectResponse>;
}

export class ApiError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export function createHttpClient(baseUrl = "/api"): PlatformClient {
  async function request<T>(
    path: string,
    body?: CreateProject | ManuscriptCommand,
  ): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const error = (await response.json()) as { code?: string };
      throw new ApiError(error.code ?? "SERVICE_UNAVAILABLE");
    }
    return (await response.json()) as T;
  }
  return {
    readManuscript: () => request("/v1/manuscript"),
    executeManuscript: (command) => request("/v1/manuscript/commands", command),
    commandReceipt: (id) => request(`/v1/commands/${encodeURIComponent(id)}`),
    health: () => request("/v1/health"),
    readProject: () => request("/v1/project"),
    createProject: (command) => request("/v1/project", command),
  };
}

export type BridgeResult<T> =
  { ok: true; data: T } | { ok: false; code: string };
export interface DesktopBridge {
  health(): Promise<BridgeResult<Health>>;
  readProject(): Promise<BridgeResult<ProjectResponse>>;
  createProject(command: CreateProject): Promise<BridgeResult<ProjectResponse>>;
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
    if (!result.ok) throw new ApiError(result.code);
    return result.data;
  }
  return {
    health: () => unwrap(bridge.health()),
    readProject: () => unwrap(bridge.readProject()),
    createProject: (c) => unwrap(bridge.createProject(c)),
    readManuscript: () => unwrap(bridge.readManuscript()),
    executeManuscript: (c) => unwrap(bridge.executeManuscript(c)),
    commandReceipt: (id) => unwrap(bridge.commandReceipt(id)),
    onCloseRequested: (handler) => bridge.onCloseRequested(handler),
  };
}
