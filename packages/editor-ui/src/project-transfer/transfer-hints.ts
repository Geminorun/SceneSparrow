/** Recovery hints grant lookup only. Backend source-scoped status is authoritative;
 * a project UUID cannot prove that a later mounted root is the original context. */
export type TransferHint = {
  version: 1;
  id: string;
  projectId: string;
  kind: "convert" | "export" | "import";
  createdAt: number;
  request?: Record<string, unknown>;
  delivery?: { requestId: string; archiveId: string; outcome: string };
};
const key = "scenesparrow.transfer-hints",
  ttl = 7 * 24 * 60 * 60 * 1000;
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
const ids = new Set([
  "requestId",
  "projectId",
  "ownerProjectId",
  "targetId",
  "inspectionId",
  "intakeId",
  "workItemId",
]);
const hashes = new Set(["contentBase", "sourceHash", "graphHash"]);
const tokens = new Set([
  "workingRevision",
  "historyRevision",
  "sourceGeneration",
  "graphGeneration",
  "expectedWorkItemRevision",
]);
function safeRequest(value: unknown): value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length > 12
  )
    return false;
  return Object.entries(value).every(([field, data]) =>
    ids.has(field)
      ? uuid(data)
      : hashes.has(field)
        ? typeof data === "string" && /^[0-9a-f]{64}$/.test(data)
        : tokens.has(field)
          ? Number.isSafeInteger(data) && Number(data) >= 0
          : field === "base"
            ? safeRequest(data)
            : field === "destination" && data === "managed",
  );
}
function parse(storage: Storage | null, now: number): TransferHint[] {
  try {
    const raw = storage?.getItem(key);
    if (!raw || new TextEncoder().encode(raw).length > 256 * 1024) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > 20) return [];
    return parsed.filter(
      (row): row is TransferHint =>
        !!row &&
        typeof row === "object" &&
        Object.keys(row).every((field) =>
          [
            "version",
            "id",
            "projectId",
            "kind",
            "createdAt",
            "request",
            "delivery",
          ].includes(field),
        ) &&
        row.version === 1 &&
        uuid(row.id) &&
        uuid(row.projectId) &&
        ["convert", "export", "import"].includes(row.kind) &&
        Number.isSafeInteger(row.createdAt) &&
        row.createdAt <= now + 60_000 &&
        row.createdAt >= now - ttl &&
        (row.request === undefined ||
          (safeRequest(row.request) &&
            row.request.requestId === row.id &&
            (row.request.projectId ??
              row.request.ownerProjectId ??
              (row.request.base as Record<string, unknown> | undefined)
                ?.projectId) === row.projectId)) &&
        (row.delivery === undefined ||
          (Object.keys(row.delivery).sort().join() ===
            "archiveId,outcome,requestId" &&
            uuid(row.delivery.requestId) &&
            uuid(row.delivery.archiveId) &&
            ["saved", "cancelled", "exists", "unknown"].includes(
              row.delivery.outcome,
            ))),
    );
  } catch {
    return [];
  }
}
function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
export function readTransferHints(
  projectId: string,
  storage = browserStorage(),
  now = Date.now(),
) {
  return parse(storage, now).filter((row) => row.projectId === projectId);
}
export function writeTransferHint(
  row: TransferHint,
  storage = browserStorage(),
  now = Date.now(),
) {
  try {
    const rows = parse(storage, now).filter((old) => old.id !== row.id);
    const request =
      row.request &&
      Object.fromEntries(
        Object.entries(row.request).filter(([field]) => field !== "grant"),
      );
    const safe = { ...row, ...(request ? { request } : {}) };
    if (request && !safeRequest(request)) return;
    rows.push(safe);
    rows.sort((a, b) => b.createdAt - a.createdAt);
    const bounded = rows.slice(0, 20);
    while (
      bounded.length &&
      new TextEncoder().encode(JSON.stringify(bounded)).length > 256 * 1024
    )
      bounded.pop();
    storage?.setItem(key, JSON.stringify(bounded));
  } catch {
    /* Recovery storage cannot cancel an authoritative operation. */
  }
}
export function discardTransferHint(
  id: string,
  storage = browserStorage(),
  now = Date.now(),
) {
  try {
    storage?.setItem(
      key,
      JSON.stringify(parse(storage, now).filter((row) => row.id !== id)),
    );
  } catch {
    /* Local-only hint. */
  }
}
