import en from "./locales/en.json";

const aliases: Record<string, keyof typeof en> = {
  NO_MANUSCRIPT_CONTENT: "exportNoContent",
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
  "aiRemoteDraftConflict",
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
function noticeIdentity(identity: string) {
  if (/^[a-zA-Z0-9:_.-]{1,256}$/.test(identity)) return identity;
  // User-authored model IDs can contain punctuation. Keep their request identity
  // stable for resolution without putting their text in a notification snapshot.
  let hash = 14695981039346656037n;
  for (const character of identity.slice(0, 8192))
    hash = BigInt.asUintN(
      64,
      (hash ^ BigInt(character.codePointAt(0)!)) * 1099511628211n,
    );
  return `context:${identity.length}:${hash.toString(16)}`;
}
export type NoticeActionKind =
  "retry" | "reviewChanges" | "openLibrary" | "recovery";
export type NoticeAction = {
  kind: NoticeActionKind;
  run: () => void | Promise<unknown>;
};
export type NoticeOptions = {
  tone?: Notice["tone"];
  target?: string | undefined;
  identity?: string;
  passive?: boolean;
  owner?: string;
  actions?: NoticeAction[];
};
export type Notice = {
  id: number;
  key: keyof typeof en;
  tone: "error" | "success";
  expiresAt: number | null;
  fading?: boolean;
  owner?: string | undefined;
  identity: string;
  actions: NoticeActionKind[];
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
  private remaining = new Map<number, number>();
  private owners = new Set<string>();
  private callbacks = new Map<
    number,
    Map<NoticeActionKind, NoticeAction["run"]>
  >();
  private ownerSequence = 0;
  constructor(private now = Date.now) {}
  createOwner = () => {
    const owner = `notice-owner-${++this.ownerSequence}`;
    this.owners.add(owner);
    return owner;
  };
  releaseOwner = (owner: string) => {
    this.owners.delete(owner);
    this.resolveOwner(owner);
  };
  resolveOwner = (owner: string, identity?: string) => {
    if (identity !== undefined)
      this.recent.delete(`${owner}:${noticeIdentity(identity)}`);
    else
      for (const key of this.recent.keys())
        if (key.startsWith(`${owner}:`)) this.recent.delete(key);
    const removed = this.notices.filter(
      (notice) =>
        notice.owner === owner &&
        (identity === undefined ||
          notice.identity === noticeIdentity(identity)),
    );
    for (const notice of removed) {
      this.callbacks.delete(notice.id);
      this.held.delete(notice.id);
      this.remaining.delete(notice.id);
    }
    this.notices = this.notices.filter((notice) => !removed.includes(notice));
    if (removed.length) this.publish();
  };
  runAction = (id: number, kind: NoticeActionKind) => {
    const notice = this.notices.find((notice) => notice.id === id);
    if (!notice?.owner || !this.owners.has(notice.owner)) return;
    const callback = this.callbacks.get(id)?.get(kind);
    if (!callback) return;
    // Consume before invoking: repeated clicks cannot dispatch the same callback twice.
    this.dismiss(id);
    void Promise.resolve()
      .then(() => {
        if (this.owners.has(notice.owner!)) return callback();
      })
      .catch((error: unknown) => {
        if (this.owners.has(notice.owner!))
          this.push(error, { owner: notice.owner! });
      });
  };
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
    const dismissed = this.notices.find((notice) => notice.id === id);
    if (dismissed) {
      this.recent.set(
        dismissed.owner
          ? `${dismissed.owner}:${dismissed.identity}`
          : dismissed.identity,
        this.now(),
      );
      this.recent.set(`${dismissed.tone}:${dismissed.key}`, this.now());
    }
    this.held.delete(id);
    this.remaining.delete(id);
    this.callbacks.delete(id);
    this.notices = this.notices.filter((notice) => notice.id !== id);
    this.publish();
  };
  hold = (id: number, active: boolean) => {
    const notice = this.notices.find((notice) => notice.id === id);
    if (!notice || active === this.held.has(id)) return;
    if (active) {
      this.held.add(id);
      this.remaining.set(
        id,
        Math.max(0, (notice.expiresAt ?? this.now()) - this.now()),
      );
    } else this.held.delete(id);
    this.notices = this.notices.map((item) =>
      item.id === id
        ? {
            ...item,
            expiresAt: active
              ? null
              : this.now() + (this.remaining.get(id) ?? 3000),
          }
        : item,
    );
    if (!active) this.remaining.delete(id);
    this.publish();
  };
  fade = (id: number) => {
    const notice = this.notices.find((notice) => notice.id === id);
    if (!notice || notice.fading) return;
    this.held.delete(id);
    this.remaining.delete(id);
    this.notices = this.notices.map((item) =>
      item.id === id
        ? {
            ...item,
            fading: true,
            expiresAt: this.now() + 190,
          }
        : item,
    );
    this.publish();
  };
  tick = (id: number) => {
    const notice = this.notices.find((notice) => notice.id === id);
    if (
      !notice ||
      this.held.has(id) ||
      notice.expiresAt === null ||
      notice.expiresAt > this.now()
    )
      return;
    if (notice.fading) this.dismiss(id);
    else this.fade(id);
  };
  push(error: unknown, options: NoticeOptions = {}) {
    if (options.owner && !this.owners.has(options.owner)) return;
    const raw =
      typeof error === "string"
        ? error
        : error instanceof Error
          ? error.message
          : "";
    if (["CANCELLED", "NO_CHANGE"].includes(raw)) return;
    const actionKinds: NoticeActionKind[] = [
      "retry",
      "reviewChanges",
      "openLibrary",
      "recovery",
    ];
    const actions = options.owner
      ? (options.actions ?? [])
          .filter(
            (action, index, all) =>
              actionKinds.includes(action.kind) &&
              typeof action.run === "function" &&
              all.findIndex((other) => other.kind === action.kind) === index,
          )
          .slice(0, actionKinds.length)
      : [];
    const key = safeErrorCode(error);
    const tone = options.tone ?? "error";
    const identity =
      options.identity === undefined
        ? `${tone}:${key}`
        : noticeIdentity(options.identity);
    const recentIdentity = options.owner
      ? `${options.owner}:${identity}`
      : identity;
    const now = this.now();
    const active = this.notices.find(
      (notice) =>
        notice.key === key &&
        notice.tone === tone &&
        (options.passive ||
          !notice.owner ||
          (notice.owner === options.owner && notice.identity === identity)),
    );
    if (options.passive && (active || this.recent.has(recentIdentity))) return;
    this.recent.delete(recentIdentity);
    this.recent.set(recentIdentity, now);
    this.recent.set(`${tone}:${key}`, now);
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
        options.owner !== undefined ||
        (target !== undefined && target !== active.target) ||
        (error !== null && typeof error === "object");
      const next = {
        ...active,
        expiresAt: this.held.has(active.id) ? null : now + 3000,
        fading: false,
        owner: options.owner,
        identity,
        actions: actions.map((action) => action.kind),
        status: replacedContext ? status : (status ?? active.status),
        traceId: replacedContext ? traceId : (traceId ?? active.traceId),
        target: replacedContext ? target : (target ?? active.target),
      };
      if (this.held.has(active.id)) this.remaining.set(active.id, 3000);
      this.callbacks.delete(active.id);
      if (options.owner && actions.length)
        this.callbacks.set(
          active.id,
          new Map(actions.map((action) => [action.kind, action.run])),
        );
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
        expiresAt: now + 3000,
        owner: options.owner,
        identity,
        actions: actions.map((action) => action.kind),
        status,
        traceId,
        target,
      },
      ...this.notices,
    ].filter((notice) => this.held.has(notice.id) || available-- > 0);
    const currentIds = new Set(this.notices.map((notice) => notice.id));
    for (const id of this.held)
      if (!currentIds.has(id)) {
        this.held.delete(id);
        this.remaining.delete(id);
      }
    for (const id of this.callbacks.keys())
      if (!currentIds.has(id)) this.callbacks.delete(id);
    if (options.owner && actions.length && currentIds.has(this.sequence))
      this.callbacks.set(
        this.sequence,
        new Map(actions.map((action) => [action.kind, action.run])),
      );
    this.publish();
  }
}
export const notifications = new NotificationStore();
export const notifyFailure = (
  error: unknown,
  options?: Parameters<NotificationStore["push"]>[1],
) => notifications.push(error, options);
