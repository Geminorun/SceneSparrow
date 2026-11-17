import en from "./locales/en.json";

const aliases: Record<string, keyof typeof en> = {
  SOURCE_TEXT_UNAVAILABLE: "sourceTextUnavailable",
  SOURCE_ENCRYPTED: "sourceEncrypted",
  TEXT_ENCODING_UNSUPPORTED: "encodingUnsupported",
  DOCUMENT_PARSE_TIMEOUT: "parseTimeout",
  SOURCE_UNSUPPORTED: "sourceUnsupported",
  DOCUMENT_JOB_INTERRUPTED: "source_interrupted",
  DOCUMENT_RESOURCE_LIMIT: "documentTooLarge",
  IMPORT_STALE: "importStale",
};
const localKeys = new Set([
  "error",
  "renameConflict",
  "projectOpenFailed",
  "exportFailed",
  "exportUnknown",
  "exportClipboardFallback",
  "aiKeySaved",
  "aiConfigurationSaved",
]);
export function safeErrorCode(error: unknown): keyof typeof en {
  const value =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "error";
  if (Object.hasOwn(aliases, value)) return aliases[value]!;
  return Object.hasOwn(en, value) &&
    (/^[A-Z][A-Z0-9_]+$/.test(value) || localKeys.has(value))
    ? (value as keyof typeof en)
    : "error";
}
export function errorMessage(error: unknown, t: typeof en) {
  return t[safeErrorCode(error)];
}
export function savedDiscoveryTarget(root: string) {
  try {
    const url = new URL(root);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      root.length > 8192
    )
      return undefined;
    return `GET ${root.replace(/\/+$/, "")}/models`;
  } catch {
    return undefined;
  }
}
export type Notice = {
  id: number;
  key: keyof typeof en;
  tone: "error" | "success";
  expiresAt: number;
  status?: number | undefined;
  traceId?: string | undefined;
  target?: string | undefined;
};
export class NotificationStore {
  private notices: Notice[] = [];
  private listeners = new Set<() => void>();
  private recent = new Map<string, number>();
  private sequence = 0;
  private held = new Set<number>();
  constructor(private now = Date.now) {}
  getSnapshot = () => this.notices;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish() {
    for (const listener of this.listeners) listener();
  }
  dismiss = (id: number) => {
    this.held.delete(id);
    this.notices = this.notices.filter((notice) => notice.id !== id);
    this.publish();
  };
  hold = (id: number, active: boolean) => {
    if (active) this.held.add(id);
    else this.held.delete(id);
  };
  push(
    error: unknown,
    options: {
      tone?: Notice["tone"];
      target?: string | undefined;
      identity?: string;
      passive?: boolean;
    } = {},
  ) {
    const raw =
      typeof error === "string"
        ? error
        : error instanceof Error
          ? error.message
          : "";
    if (["CANCELLED", "NO_CHANGE"].includes(raw)) return;
    const key = safeErrorCode(error);
    const tone = options.tone ?? "error";
    const identity = options.identity ?? `${tone}:${key}`;
    const now = this.now();
    const active = this.notices.find(
      (notice) => notice.key === key && notice.tone === tone,
    );
    if (
      options.passive &&
      (active ||
        (this.recent.has(identity) && now - this.recent.get(identity)! < 15000))
    )
      return;
    this.recent.delete(identity);
    this.recent.set(identity, now);
    while (this.recent.size > 128)
      this.recent.delete(this.recent.keys().next().value!);
    const detail =
      error && typeof error === "object"
        ? (error as { status?: unknown; traceId?: unknown })
        : {};
    const status =
      typeof detail.status === "number" &&
      Number.isInteger(detail.status) &&
      detail.status >= 100 &&
      detail.status <= 599
        ? detail.status
        : undefined;
    const traceId =
      typeof detail.traceId === "string" &&
      /^[a-f0-9]{32}$/.test(detail.traceId)
        ? detail.traceId
        : undefined;
    // Targets must be constructed from a saved, validated root, never exception text.
    const target = options.target?.startsWith("GET ")
      ? savedDiscoveryTarget(options.target.slice(4).replace(/\/models$/, ""))
      : undefined;
    if (active) {
      const replacedContext =
        (target !== undefined && target !== active.target) ||
        (error !== null && typeof error === "object");
      const next = {
        ...active,
        expiresAt: now + 6000,
        status: replacedContext ? status : (status ?? active.status),
        traceId: replacedContext ? traceId : (traceId ?? active.traceId),
        target: replacedContext ? target : (target ?? active.target),
      };
      // Keep the ID/DOM node so a later failure cannot interrupt reading/copying.
      this.notices = this.notices.map((notice) =>
        notice.id === active.id ? next : notice,
      );
      this.publish();
      return;
    }
    let available =
      3 - this.notices.filter((notice) => this.held.has(notice.id)).length;
    this.notices = [
      {
        id: ++this.sequence,
        key,
        tone,
        expiresAt: now + 6000,
        status,
        traceId,
        target,
      },
      ...this.notices,
    ].filter((notice) => this.held.has(notice.id) || available-- > 0);
    this.publish();
  }
}
export const notifications = new NotificationStore();
export const notifyFailure = (
  error: unknown,
  options?: Parameters<NotificationStore["push"]>[1],
) => notifications.push(error, options);
