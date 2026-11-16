import {
  randomBytes,
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import {
  readFile,
  mkdir,
  chmod,
  open,
  opendir,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

const schema = JSON.parse(
  await readFile(
    new URL(
      "../../packages/contracts/schema/diagnostics.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const properties = schema.definitions.DiagnosticInput.properties;
export const TRACE_PATTERN = /^[a-f0-9]{32}$/;
const SATURATED = Number.MAX_SAFE_INTEGER;
const increment = (n, count = 1) => Math.min(SATURATED, n + count);
const waitTurn = () => new Promise((resolve) => setImmediate(resolve));
export const DIAGNOSTIC_BOUNDS = Object.freeze({
  queueEvents: 1024,
  queueBytes: 1048576,
  eventBytes: 4096,
  partialBytes: 65536,
  rotateBytes: 2097152,
  retainedBytes: 20971520,
  retainedMs: 259200000,
  responseBytes: 1048576,
  scanBytes: 20971520,
  scanMs: 2000,
  readMs: 4900,
  maintenanceMs: 60000,
});
export class DiagnosticError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
function invalid() {
  throw new DiagnosticError(400, "INVALID_DIAGNOSTICS_QUERY");
}
// Creation and disk/child ingestion share one closed, versioned allowlist. Raw values
// never pass through to an exported record, even if they resemble an error message.
export function safeDiagnostic(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    input.schemaVersion !== 1 ||
    !properties.component.enum.includes(input.component) ||
    !properties.level.enum.includes(input.level) ||
    !properties.eventCode.enum.includes(input.eventCode)
  )
    return null;
  const result = {};
  for (const [name, rule] of Object.entries(properties)) {
    const value = input[name];
    if (value === undefined) continue;
    if (rule.enum) {
      if (rule.enum.includes(value)) result[name] = value;
    } else if (rule.type === "integer") {
      if (
        Number.isSafeInteger(value) &&
        value >= rule.minimum &&
        value <= rule.maximum
      )
        result[name] = value;
    } else if (["traceId", "parentTraceId"].includes(name)) {
      if (typeof value === "string" && TRACE_PATTERN.test(value))
        result[name] = value;
    } else if (name === "cfRay") {
      if (
        typeof value === "string" &&
        /^[a-fA-F0-9]{16,20}-[A-Z]{3}$/.test(value)
      )
        result[name] = value;
    } else if (name === "appBuild") {
      if (
        value === "unknown" ||
        (typeof value === "string" && /^[a-f0-9]{7,40}$/.test(value))
      )
        result[name] = value;
    }
  }
  if (input.code !== undefined && !result.code) result.code = "UNKNOWN";
  return result;
}
function safeRecord(value) {
  const event = safeDiagnostic(value);
  if (
    !event ||
    !TRACE_PATTERN.test(value.bootId) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.timestamp) ||
    !Number.isFinite(Date.parse(value.timestamp))
  )
    return null;
  return {
    ...event,
    timestamp: value.timestamp,
    bootId: value.bootId,
    sequence: value.sequence,
  };
}
const hash = (value) => createHash("sha256").update(value).digest();
export function createGrantStore({ now = Date.now } = {}) {
  let active;
  return {
    mint(body) {
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "ttlSeconds") ||
        (body.ttlSeconds !== undefined &&
          (!Number.isInteger(body.ttlSeconds) ||
            body.ttlSeconds < 60 ||
            body.ttlSeconds > 3600))
      )
        throw new DiagnosticError(400, "INVALID_DIAGNOSTICS_QUERY");
      const token = randomBytes(32).toString("base64url");
      active = {
        hash: hash(token),
        grantId: randomBytes(16).toString("hex"),
        expires: now() + (body.ttlSeconds ?? 900) * 1000,
      };
      return {
        token,
        grantId: active.grantId,
        expiresAt: new Date(active.expires).toISOString(),
        scope: "diagnostics:read",
      };
    },
    authorize(token) {
      if (
        !active ||
        !/^[A-Za-z0-9_-]{43}$/.test(token) ||
        !timingSafeEqual(hash(token), active.hash)
      )
        throw new DiagnosticError(401, "UNAUTHORIZED");
      if (now() >= active.expires) {
        active = undefined;
        throw new DiagnosticError(401, "DIAGNOSTICS_GRANT_EXPIRED");
      }
      return active.grantId;
    },
    revoke() {
      active = undefined;
      return { revoked: true };
    },
    status() {
      if (active && now() >= active.expires) active = undefined;
      return active
        ? {
            grantId: active.grantId,
            expiresAt: new Date(active.expires).toISOString(),
            scope: "diagnostics:read",
          }
        : null;
    },
  };
}
// A fixed number of buckets: one Basic credential, one current grant and global
// categories. Replaced grants cannot cause an attacker-controlled map to grow.
export function createDiagnosticLimiter({ now = Date.now } = {}) {
  const buckets = new Map();
  return (kind, credential = "operator") => {
    const minute = Math.floor(now() / 60000);
    const rules =
      kind === "read"
        ? [
            ["read-global", 60],
            [credential === "operator" ? "read-operator" : "read-grant", 30],
          ]
        : kind === "bundle"
          ? [["bundle", 2]]
          : kind === "grant"
            ? [["grant", 6]]
            : [["client", 30]];
    for (const [key, max] of rules) {
      const value = buckets.get(key);
      if (value?.minute === minute && value.count >= max)
        throw new DiagnosticError(429, "DIAGNOSTICS_RATE_LIMITED");
    }
    for (const [key] of rules) {
      const value = buckets.get(key);
      buckets.set(key, {
        minute,
        count: value?.minute === minute ? value.count + 1 : 1,
      });
    }
  };
}
export function collectChild(stream, collector) {
  let partial = Buffer.alloc(0);
  let oversized = false;
  stream.on("data", (chunk) => {
    let start = 0;
    for (let at = 0; at < chunk.length; at++) {
      if (chunk[at] !== 10) continue;
      const piece = chunk.subarray(start, at);
      start = at + 1;
      if (
        !oversized &&
        partial.length + piece.length <= DIAGNOSTIC_BOUNDS.partialBytes
      ) {
        const line = partial.length ? Buffer.concat([partial, piece]) : piece;
        try {
          const event = safeDiagnostic(JSON.parse(line.toString("utf8")));
          if (
            !event ||
            !["core", "worker", "supervisor"].includes(event.component) ||
            line.length > DIAGNOSTIC_BOUNDS.eventBytes
          )
            collector.drop();
          else {
            if (event.droppedEvents) collector.drop(event.droppedEvents);
            collector.emit(event);
          }
        } catch {
          collector.drop();
        }
      } else if (!oversized) collector.drop();
      partial = Buffer.alloc(0);
      oversized = false;
    }
    if (start < chunk.length && !oversized) {
      const piece = chunk.subarray(start);
      if (partial.length + piece.length > DIAGNOSTIC_BOUNDS.partialBytes) {
        partial = Buffer.alloc(0);
        oversized = true;
        collector.drop();
      } else partial = Buffer.concat([partial, piece]);
    }
  });
  stream.on("end", () => {
    if (partial.length && !oversized) collector.drop();
    partial = Buffer.alloc(0);
  });
  stream.on("error", () => collector.drop());
}

export function createDiagnostics({
  directory,
  now = Date.now,
  version = "unknown",
  buildSha = "unknown",
  coreAvailable = () => false,
  bounds = {},
  openFile = open,
} = {}) {
  const limits = { ...DIAGNOSTIC_BOUNDS, ...bounds };
  const bootId = randomBytes(16).toString("hex");
  const cursorKey = randomBytes(32);
  const bootTime = new Date(now()).toISOString();
  let sequence = 0,
    dropped = 0,
    errors = 0,
    queueBytes = 0,
    closing = false,
    stopped = false,
    degraded = !directory,
    reads = 0,
    bundles = 0;
  let active;
  let lastFileStamp = now() - 1;
  const queue = [];
  const files = [];
  let pending, scheduled, work;
  let maintenanceDue = false;
  const drop = (count = 1) => {
    dropped = increment(dropped, count);
  };
  const failure = () => {
    degraded = true;
    errors = increment(errors);
  };
  async function cleanup() {
    let total = files.reduce((sum, file) => sum + file.size, 0);
    while (
      files.length &&
      (total > limits.retainedBytes ||
        files.length > 64 ||
        files[0].mtime < now() - limits.retainedMs)
    ) {
      const oldest = files[0];
      await unlink(join(directory, oldest.name));
      files.shift();
      total -= oldest.size;
      if (active === oldest) active = undefined;
    }
  }
  const initialized = (async () => {
    if (!directory) return;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const dir = await opendir(directory);
      for await (const entry of dir) {
        if (!/^\d{13}-[a-f0-9]{32}\.jsonl$/.test(entry.name) || !entry.isFile())
          continue;
        await chmod(join(directory, entry.name), 0o600);
        const details = await stat(join(directory, entry.name));
        files.push({
          name: entry.name,
          id: entry.name.slice(14, 46),
          size: details.size,
          mtime: Number(entry.name.slice(0, 13)),
          since: null,
          until: null,
        });
        // Retire incrementally, keeping metadata bounded even after many restarts.
        files.sort((a, b) => a.name.localeCompare(b.name));
        await cleanup();
      }
      await cleanup();
      for (const file of files) {
        const handle = await openFile(join(directory, file.name), "r");
        try {
          const span = Math.min(file.size, 8192);
          const first = Buffer.alloc(span),
            last = Buffer.alloc(span);
          await handle.read(first, 0, span, 0);
          await handle.read(last, 0, span, Math.max(0, file.size - span));
          const head = first.toString("utf8").split("\n").slice(0, -1),
            tail = last
              .toString("utf8")
              .split("\n")
              .slice(file.size > span ? 1 : 0, -1);
          for (const line of [...head, ...tail]) {
            try {
              const event = safeRecord(JSON.parse(line));
              if (event) {
                file.since = file.since
                  ? file.since < event.timestamp
                    ? file.since
                    : event.timestamp
                  : event.timestamp;
                file.until = file.until
                  ? file.until > event.timestamp
                    ? file.until
                    : event.timestamp
                  : event.timestamp;
              }
            } catch {
              /* No raw corruption escapes. */
            }
          }
        } finally {
          await handle.close();
        }
      }
      lastFileStamp = Math.max(
        lastFileStamp,
        ...files.map((file) => file.mtime),
      );
      degraded = errors > 0;
    } catch {
      failure();
    }
  })();
  // Only this tracked operation mutates files after initialization. Maintenance is
  // coalesced with the writer, so a stalled disk cannot build a task/timer queue.
  function startWork() {
    if (work || stopped) return work;
    work = runWork().finally(() => {
      work = undefined;
      if (!stopped && (queue.length || maintenanceDue)) schedule();
    });
    return work;
  }
  async function runWork() {
    try {
      await initialized;
      if (stopped) return;
      if (maintenanceDue) {
        maintenanceDue = false;
        try {
          await cleanup();
        } catch {
          failure();
        }
      }
      if (!directory || degraded) {
        drop(queue.length);
        queue.length = 0;
        queueBytes = 0;
        return;
      }
      let count = 0;
      while (queue.length && !stopped && count++ < 32) {
        const line = queue.shift();
        queueBytes -= line.length;
        if (
          Date.parse(JSON.parse(line).timestamp) <
          now() - limits.retainedMs
        ) {
          drop();
          continue;
        }
        try {
          await cleanup();
          if (!active || active.size + line.length > limits.rotateBytes) {
            const id = randomBytes(16).toString("hex");
            lastFileStamp = Math.max(now(), lastFileStamp + 1);
            active = {
              name: `${lastFileStamp}-${id}.jsonl`,
              id,
              size: 0,
              mtime: lastFileStamp,
              since: null,
              until: null,
            };
            files.push(active);
          }
          // Enforce the cap before append, including the current file.
          while (
            files.length > 1 &&
            files.reduce((sum, f) => sum + f.size, 0) + line.length >
              limits.retainedBytes
          ) {
            const old = files[0];
            await unlink(join(directory, old.name));
            files.shift();
          }
          const handle = await openFile(
            join(directory, active.name),
            "a",
            0o600,
          );
          try {
            await handle.chmod(0o600);
            await handle.writeFile(line);
            active.size += line.length;
            const timestamp = JSON.parse(line).timestamp;
            active.since ??= timestamp;
            active.until = timestamp;
          } finally {
            await handle.close();
          }
        } catch {
          drop();
          failure();
          drop(queue.length);
          queue.length = 0;
          queueBytes = 0;
          break;
        }
      }
    } catch {
      failure();
    }
  }
  function schedule() {
    if (!pending && !work && !stopped) {
      pending = new Promise((done) => {
        scheduled = setImmediate(async () => {
          scheduled = undefined;
          pending = undefined;
          try {
            await startWork();
          } finally {
            done();
          }
        });
      });
    }
  }
  const maintenance = directory
    ? setInterval(() => {
        if (stopped || closing) return;
        maintenanceDue = true;
        schedule();
      }, limits.maintenanceMs).unref()
    : undefined;
  function emit(input) {
    const safe = safeDiagnostic(input);
    if (!safe || closing || stopped) {
      drop();
      return false;
    }
    if (sequence >= Number.MAX_SAFE_INTEGER) {
      drop();
      return false;
    }
    const record = {
      ...safe,
      timestamp: new Date(now()).toISOString(),
      bootId,
      sequence: ++sequence,
    };
    const line = Buffer.from(JSON.stringify(record) + "\n");
    if (
      line.length > limits.eventBytes ||
      queue.length >= limits.queueEvents ||
      queueBytes + line.length > limits.queueBytes
    ) {
      drop();
      return false;
    }
    queue.push(line);
    queueBytes += line.length;
    schedule();
    return true;
  }
  function encodeCursor(state) {
    const body = Buffer.from(
      JSON.stringify({ ...state, boot: bootId }),
    ).toString("base64url");
    return `${body}.${createHmac("sha256", cursorKey).update(body).digest("base64url")}`;
  }
  function decodeCursor(cursor) {
    if (cursor.length > 2048) invalid();
    try {
      const [body, signature, extra] = cursor.split(".");
      if (extra || !body || !signature) invalid();
      const value = JSON.parse(Buffer.from(body, "base64url"));
      const expected = createHmac("sha256", cursorKey).update(body).digest();
      const actual = Buffer.from(signature, "base64url");
      if (
        value.boot !== bootId ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw new DiagnosticError(409, "CURSOR_EXPIRED");
      if (
        !TRACE_PATTERN.test(value.fileId) ||
        !Number.isSafeInteger(value.offset) ||
        value.offset < 0
      )
        invalid();
      return value;
    } catch (error) {
      if (error instanceof DiagnosticError) throw error;
      invalid();
    }
  }
  function query(params) {
    const allowed = new Set([
      "since",
      "level",
      "component",
      "traceId",
      "cursor",
      "limit",
    ]);
    for (const key of params.keys())
      if (!allowed.has(key) || params.getAll(key).length !== 1) invalid();
    const limitText = params.get("limit") ?? "200";
    if (!/^[1-9]\d{0,2}$/.test(limitText) || Number(limitText) > 500) invalid();
    const filters = {};
    for (const key of ["level", "component", "traceId"]) {
      if (!params.has(key)) continue;
      const value = params.get(key);
      if (
        key === "traceId"
          ? !TRACE_PATTERN.test(value)
          : !properties[key].enum.includes(value)
      )
        invalid();
      filters[key] = value;
    }
    const since = params.get("since");
    if (
      since &&
      (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(since) ||
        !Number.isFinite(Date.parse(since)))
    )
      invalid();
    let state;
    if (params.has("cursor")) {
      state = decodeCursor(params.get("cursor"));
      if (
        (since && Date.parse(since) !== state.since) ||
        Object.entries(filters).some(
          ([key, value]) => state.filters[key] !== value,
        )
      )
        invalid();
    } else {
      const until = now(),
        from = since ? Date.parse(since) : until - 900000;
      if (from > until || from < until - 86400000) invalid();
      state = {
        since: from,
        until,
        filters,
        fileId: files[0]?.id ?? "0".repeat(32),
        offset: 0,
      };
    }
    return { state, limit: Number(limitText) };
  }
  async function read(params, bundle = false) {
    if (reads >= 2 || (bundle && bundles >= 1))
      throw new DiagnosticError(429, "DIAGNOSTICS_RATE_LIMITED");
    reads++;
    if (bundle) bundles++;
    try {
      await initialized;
      if (degraded || closing || stopped)
        throw new DiagnosticError(503, "DIAGNOSTICS_UNAVAILABLE");
      const { state, limit } = query(params);
      const snapshot = files.map((file) => ({ ...file }));
      let index = snapshot.findIndex((file) => file.id === state.fileId);
      let gap = false,
        truncated = false,
        scanned = 0,
        bytes = 1024;
      const events = [];
      if (index < 0) {
        index = 0;
        gap = state.fileId !== "0".repeat(32);
        state.offset = 0;
      }
      let nextCursor = null;
      const deadline = Date.now() + limits.scanMs;
      const firstIndex = index,
        firstOffset = state.offset;
      outer: for (; index < snapshot.length; index++) {
        const file = snapshot[index];
        let position = index === firstIndex ? firstOffset : 0;
        state.fileId = file.id;
        state.offset = position;
        let handle;
        try {
          handle = await openFile(join(directory, file.name), "r");
        } catch (error) {
          if (error.code === "ENOENT") {
            gap = true;
            continue;
          }
          throw error;
        }
        try {
          let partial = Buffer.alloc(0),
            oversized = false,
            lineStart = position;
          while (position < file.size) {
            if (scanned >= limits.scanBytes || Date.now() >= deadline) {
              truncated = true;
              state.offset = lineStart;
              nextCursor = encodeCursor(state);
              break outer;
            }
            const buffer = Buffer.alloc(
              Math.min(65536, file.size - position, limits.scanBytes - scanned),
            );
            const { bytesRead } = await handle.read(
              buffer,
              0,
              buffer.length,
              position,
            );
            if (!bytesRead) {
              gap = true;
              break;
            }
            scanned += bytesRead;
            let start = 0;
            for (let at = 0; at < bytesRead; at++) {
              if (buffer[at] !== 10) continue;
              const endPosition = position + at + 1;
              const piece = buffer.subarray(start, at);
              start = at + 1;
              if (
                oversized ||
                partial.length + piece.length > limits.eventBytes
              )
                gap = true;
              else {
                let event;
                try {
                  event = safeRecord(
                    JSON.parse(
                      Buffer.concat([partial, piece]).toString("utf8"),
                    ),
                  );
                } catch {
                  /* Corruption is metadata, never raw output. */
                }
                if (!event) gap = true;
                else if (
                  Date.parse(event.timestamp) >= state.since &&
                  Date.parse(event.timestamp) <= state.until &&
                  Object.entries(state.filters).every(
                    ([key, value]) => event[key] === value,
                  )
                ) {
                  const size = Buffer.byteLength(JSON.stringify(event)) + 1;
                  if (
                    events.length >= limit ||
                    bytes + size > limits.responseBytes - 20000
                  ) {
                    truncated = true;
                    state.offset = lineStart;
                    nextCursor = encodeCursor(state);
                    break outer;
                  }
                  events.push(event);
                  bytes += size;
                }
              }
              partial = Buffer.alloc(0);
              oversized = false;
              lineStart = endPosition;
              state.offset = endPosition;
            }
            if (start < bytesRead && !oversized) {
              if (partial.length + bytesRead - start > limits.eventBytes) {
                partial = Buffer.alloc(0);
                oversized = true;
              } else
                partial = Buffer.concat([
                  partial,
                  buffer.subarray(start, bytesRead),
                ]);
            }
            position += bytesRead;
            await waitTurn();
          }
          // Ignore incomplete tails; never expose or try to repair partial bytes.
          if (partial.length || oversized) gap = true;
        } finally {
          await handle.close();
        }
      }
      return {
        schemaVersion: 1,
        events,
        window: {
          since: new Date(state.since).toISOString(),
          until: new Date(state.until).toISOString(),
          retainedSince: files.find((file) => file.since)?.since ?? null,
        },
        nextCursor,
        gap,
        truncated,
        droppedEvents: dropped,
      };
    } catch (error) {
      if (error instanceof DiagnosticError) throw error;
      failure();
      throw new DiagnosticError(503, "DIAGNOSTICS_UNAVAILABLE");
    } finally {
      reads--;
      if (bundle) bundles--;
    }
  }
  function status() {
    return {
      schemaVersion: 1,
      appVersion: /^\d+\.\d+\.\d+$/.test(version) ? version : "unknown",
      buildSha: /^(?:[a-f0-9]{7,40}|unknown)$/.test(buildSha)
        ? buildSha
        : "unknown",
      bootId,
      bootTime,
      gatewayAvailable: !stopped,
      coreAvailable: Boolean(coreAvailable()),
      collector: degraded ? "DIAGNOSTICS_DEGRADED" : "ready",
      retained: {
        since: files.find((file) => file.since)?.since ?? null,
        until: files.findLast((file) => file.until)?.until ?? null,
        bytes: files.reduce((sum, file) => sum + file.size, 0),
      },
      droppedEvents: dropped,
      errors,
      queueEvents: queue.length,
      queueBytes,
    };
  }
  async function boundedRead(params, bundle = false) {
    let timer;
    try {
      return await Promise.race([
        read(params, bundle),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            failure();
            reject(new DiagnosticError(503, "DIAGNOSTICS_UNAVAILABLE"));
          }, limits.readMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    emit,
    drop,
    status,
    read: boundedRead,
    async bundle(params) {
      const page = await boundedRead(params, true);
      return {
        schemaVersion: 1,
        status: status(),
        manifest: {
          schemaVersion: 1,
          retention: {
            bytes: limits.retainedBytes,
            ageSeconds: limits.retainedMs / 1000,
          },
          eventLimit: 500,
        },
        ...page,
      };
    },
    async flush() {
      if (stopped) return;
      await initialized;
      while (!stopped && (pending || work || queue.length || maintenanceDue)) {
        if (work) await work;
        else if (pending) await pending;
        else await startWork();
      }
    },
    async close(deadlineMs = 250) {
      closing = true;
      clearInterval(maintenance);
      const drain = this.flush();
      let timer;
      await Promise.race([
        drain,
        new Promise((done) => {
          timer = setTimeout(done, deadlineMs);
        }),
      ]);
      clearTimeout(timer);
      stopped = true;
      clearImmediate(scheduled);
      maintenanceDue = false;
      drop(queue.length);
      queue.length = 0;
      queueBytes = 0;
    },
  };
}
