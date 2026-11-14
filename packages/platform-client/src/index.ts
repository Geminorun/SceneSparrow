import type {
  CreateProject,
  Health,
  ProjectResponse,
} from "@scenesparrow/contracts";

export interface PlatformClient {
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
  async function request<T>(path: string, body?: CreateProject): Promise<T> {
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
    health: () => request("/v1/health"),
    readProject: () => request("/v1/project"),
    createProject: (command) => request("/v1/project", command),
  };
}
