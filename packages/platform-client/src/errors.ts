import type {
  HistoryErrorDetails,
  DiagnosticClientEvent,
} from "@scenesparrow/contracts";

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly details?: HistoryErrorDetails,
    public readonly status?: number,
    public readonly traceId?: string,
  ) {
    super(code);
  }
}

export type TransportCode = DiagnosticClientEvent["code"];
export function safeTraceId(value: string | null | undefined) {
  return value && /^[a-f0-9]{32}$/.test(value) ? value : undefined;
}
/** Transport failures cannot prove that a submitted command was rejected. */
export class TransportError extends Error {
  readonly status: number | undefined;
  readonly traceId: string | undefined;
  constructor(
    public readonly code: TransportCode,
    status?: number,
    traceId?: string | null,
  ) {
    // Provider AUTH_REQUIRED has a different, established UI meaning.
    super(`TRANSPORT_${code}`);
    this.status =
      Number.isInteger(status) && status! >= 100 && status! <= 599
        ? status
        : undefined;
    this.traceId = safeTraceId(traceId);
  }
}
