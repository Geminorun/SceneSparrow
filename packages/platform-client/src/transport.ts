import type {
  DiagnosticClientEvent,
  HistoryErrorDetails,
} from "@scenesparrow/contracts";
import { ApiError, TransportError } from "./errors";

const listeners = new Set<(error: TransportError) => void>();
export function onTransportFailure(listener: (error: TransportError) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function routeId(path: string): DiagnosticClientEvent["routeId"] {
  if (path.startsWith("/v1/ai/")) return "ai";
  if (path === "/v1/project/events") return "events";
  if (path.startsWith("/v1/project")) return "project";
  if (/^\/v1\/(manuscript|commands|planning|reviews|history)(\/|$)/.test(path))
    return "manuscript";
  return "unknown";
}
export function reportTransport(error: unknown, path: string) {
  if (!(error instanceof TransportError)) return;
  for (const listener of listeners) {
    try {
      listener(error);
    } catch {}
  }
  // The independent bootstrap script owns the bounded, Web-only reporter.
  try {
    const reporter = (
      globalThis as typeof globalThis & {
        sceneSparrowDiagnostics?: {
          report(event: DiagnosticClientEvent): void;
        };
      }
    ).sceneSparrowDiagnostics;
    reporter?.report({
      schemaVersion: 1,
      component: "client",
      level: "warn",
      eventCode: "CLIENT_FAILURE",
      stage: error.code.startsWith("RESPONSE_") ? "decode" : "request",
      routeId: routeId(path),
      code: error.code,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.traceId ? { traceId: error.traceId } : {}),
    });
  } catch {}
}
export function networkError(error: unknown, signal?: AbortSignal) {
  return new TransportError(
    signal?.reason?.name === "TimeoutError" ||
      (error instanceof Error && error.name === "TimeoutError")
      ? "NETWORK_TIMEOUT"
      : "NETWORK_FAILED",
  );
}
export async function fetchResponse(url: string, init: RequestInit) {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw networkError(error, init.signal ?? undefined);
  }
}
const jsonMime = (value: string | null) =>
  /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json\s*(?:;|$)/i.test(value ?? "");

export function decodeJsonText(
  status: number,
  mime: string | null,
  text: string,
  traceId: string | null,
): unknown {
  if (status === 401 || status === 403)
    throw new TransportError("AUTH_REQUIRED", status, traceId);
  if (status < 200 || status >= 300) {
    // Only a complete contractual client rejection proves non-delivery. Proxy,
    // rate-limit and server failures remain ambiguous even if they contain JSON.
    if (
      status >= 400 &&
      status < 500 &&
      ![408, 429].includes(status) &&
      jsonMime(mime)
    ) {
      try {
        const value = JSON.parse(text) as {
          code?: unknown;
          details?: HistoryErrorDetails;
        };
        if (
          value &&
          typeof value.code === "string" &&
          /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code) &&
          ![
            "SERVICE_UNAVAILABLE",
            "STORAGE_UNAVAILABLE",
            "COMMAND_UNRESOLVED",
          ].includes(value.code)
        )
          throw new ApiError(
            value.code,
            value.details,
            status,
            new TransportError("HTTP_ERROR", status, traceId).traceId,
          );
      } catch (error) {
        if (error instanceof ApiError) throw error;
      }
    }
    throw new TransportError("HTTP_ERROR", status, traceId);
  }
  if (!jsonMime(mime))
    throw new TransportError("RESPONSE_NOT_JSON", status, traceId);
  if (!text.trim()) throw new TransportError("RESPONSE_EMPTY", status, traceId);
  try {
    return JSON.parse(text);
  } catch {
    throw new TransportError("RESPONSE_INVALID_JSON", status, traceId);
  }
}
export async function decodeJson<T>(
  response: Response,
  method = "GET",
  allowEmpty = false,
  signal?: AbortSignal,
): Promise<T> {
  if (
    response.ok &&
    allowEmpty &&
    (response.status === 204 || method === "HEAD")
  )
    return undefined as T;
  const trace = response.headers.get("X-SceneSparrow-Trace-Id");
  // Classify HTTP failures even if an intermediary closes its error body.
  if (response.status === 401 || response.status === 403)
    throw new TransportError("AUTH_REQUIRED", response.status, trace);
  if (!response.ok && response.status >= 500)
    throw new TransportError("HTTP_ERROR", response.status, trace);
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (
      signal?.reason?.name === "TimeoutError" ||
      (error instanceof Error && error.name === "TimeoutError")
    )
      throw new TransportError("NETWORK_TIMEOUT", response.status, trace);
    throw new TransportError(
      response.ok ? "RESPONSE_INVALID_JSON" : "HTTP_ERROR",
      response.status,
      trace,
    );
  }
  return decodeJsonText(
    response.status,
    response.headers.get("content-type"),
    text,
    trace,
  ) as T;
}
