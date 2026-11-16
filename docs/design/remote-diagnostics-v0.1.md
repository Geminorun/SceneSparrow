# Remote diagnostics design, v0.1

Status: **RD-1/RD-2 implemented in source; deployment and live-incident
verification remain separate**. See the [implementation evidence](../validation/remote-diagnostics.md).
This document specifies a private Web support capability, not authorization to
access or change a server.
It supplements [Web deployment](../web-deployment.md) and
[ADR 0003](../decisions/0003-private-self-hosted-web.md); it preserves the single
workspace, operator authentication, private loopback core and native API boundary.

## 1. Problem and evidence boundary

The operator reports a browser JSON parsing error after entering HTTP Basic
credentials, with no SceneSparrow sidebar or application UI. Diagnose the initial
document, authentication challenge and proxy chain before assuming an imported
file or a React API call failed. A successful deployment workflow establishes
build/deployment evidence, not the authenticated browser response body.

Unauthenticated public observations returned `401 application/json` with
`{"code":"UNAUTHORIZED"}` and a Basic challenge for `/`, `200` with
`{"code":"READY"}` for `/readyz`, and valid unauthorized JSON for
`/api/v1/project`. There is no captured authenticated homepage response. These
observations do not establish the root cause or exclude Nginx/Cloudflare behavior.

The operator subsequently confirmed that refreshing after entering credentials
opens the application. This narrows the working hypothesis to the initial Basic
challenge/document transition, including browser JSON-viewer behavior; it is not
an authenticated network capture or proof of a specific browser defect. Preserve
this distinction when implementing and verifying HTML authentication responses.

Confirmed source gaps at the reviewed release baseline:

- `scripts/web/start.mjs` discards core stdout/stderr; Docker logs cannot recover
  those discarded bytes.
- `scripts/web/gateway.mjs` has no structured request log/correlation and uses
  generic JSON errors, including unauthenticated HTML document navigation.
- `packages/platform-client/src/index.ts` parses JSON without first distinguishing
  empty, non-JSON and malformed responses. This is a robustness gap, not proof
  that the reported browser message came from that client.

The first investigation must capture browser document status, content type,
redirect/challenge sequence, response length and trace identifiers, then determine
whether the application mounted. Never collect credentials, full response bodies
or an unsanitized HAR as routine diagnostics.

## 2. Ownership and availability

The Node Web gateway owns diagnostics authentication, routes, collection and safe
exports. Rust service/infrastructure adapters emit generic operational events;
domain/application modules remain independent of HTTP, log storage and Web support.
Shared AI adapters report safe lifecycle/result codes through the same event
contract for text, audio and video. Manuscript orchestration stays in its existing
business services; diagnostics neither reads prompts nor changes dispatch policy.

`GET /diagnostics` serves a small operator-authenticated HTML page with inline
gateway-owned assets, independent of the React bundle, project API and application
bootstrap. It shows safe status, grants/revocation and bounded export controls.
Use stable localization keys with `en` and `zh-CN`; no third-party scripts/assets.
The page can work when the main frontend fails, provided the gateway is running.

Do not silently change supervision: today core startup failure prevents gateway
startup and unexpected core exit shuts the runtime down. Gateway/container failure
also removes diagnostics. Preserving a failed core's gateway would require a
separate lifecycle decision. The operator fallback is trusted SSH/host console,
Compose status/log inspection and offline safe-log export. If only the page is
broken, an operator CLI can call the same APIs using Basic credentials supplied
interactively or via a protected input, never a password in URL/history/arguments.

## 3. Routes and access contract

All routes use the configured HTTPS origin, `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`; reject unexpected Host and disallowed Origin.
There is no CORS support. Existing `/readyz` remains minimal and public; it gains
no log, configuration or version details. All routes below are new and protected.

| Method and exact path                       | Credential                           | Result                       |
| ------------------------------------------- | ------------------------------------ | ---------------------------- |
| `GET /diagnostics`                          | Existing operator Basic only         | Minimal HTML operator page   |
| `GET /diagnostics/v1/status`                | Operator Basic or diagnostics Bearer | Safe runtime status          |
| `GET /diagnostics/v1/logs`                  | Operator Basic or diagnostics Bearer | Bounded JSON event page      |
| `GET /diagnostics/v1/bundle`                | Operator Basic or diagnostics Bearer | Bounded JSON download        |
| `POST /diagnostics/v1/access-grants`        | Operator Basic, exact Origin         | Mint/replace one read grant  |
| `POST /diagnostics/v1/access-grants/revoke` | Operator Basic, exact Origin         | Revoke active grant          |
| `POST /diagnostics/v1/client-events`        | Operator Basic, exact Origin         | Submit one safe client event |

No other method/path is authorized by a diagnostics grant, including business
APIs, native endpoints, the HTML page, grant management or client event submission.
Resolve diagnostics auth before the business proxy and never forward this token
to Rust, workers or an upstream provider. Operator Basic keeps its existing scope;
there is no new mandatory permanent secret or remembered password. Desktop
credential behavior is unchanged. Do not accept cookies or query-string tokens.

Mint accepts only `{"ttlSeconds":900}` (optional field, default 900; range 60–3600).
Generate 32 cryptographically random bytes, encoded base64url; return the token
once in `201` JSON with `grantId`, `expiresAt` and fixed scope
`diagnostics:read`. The page reveals/copies it only on an explicit operator action
and holds it in memory, never browser storage. The operator supplies it to a
support tool that can set `Authorization: Bearer <token>`; no shareable token URL.
Keep only its SHA-256 hash, opaque grant ID and expiry in gateway RAM, compare
hashes in constant time, allow one active grant, and invalidate on replacement,
revocation, expiry or process restart. Revoke returns `200 {"revoked":true}` even
if none is active. A grant is read-only but exposes operational metadata; the page
states its expiry/scope and offers immediate revocation. Do not log the token.

Browser Basic navigation retains `WWW-Authenticate: Basic realm="SceneSparrow"`
on `401`, so a fresh browser profile receives the native username/password prompt.
Unauthenticated document navigation returns small HTML with a localized auth/error
message and trace ID; successful `/` returns HTML, never a JSON error as a document.
API failures return JSON. This content negotiation must preserve the challenge
and be verified in a real browser, including top-level navigation from another site.
Bearer failures return `401` JSON with a Bearer challenge; insufficient scope
returns `403`. Never fall back from invalid Bearer to cached operator credentials.
Header-based CLI reads may omit Origin/Fetch Metadata; supplied values still must
pass validation. Browser reads retain same-origin checks, with the existing
top-level document exception extended narrowly to `/diagnostics`.

## 4. Safe event contract and correlation

Version the event schema in `packages/contracts`; derive consumers as for other
protocols. Logs are operational records, not a second project history/database.
Each record has `schemaVersion`, UTC `timestamp`, gateway `bootId`, monotonic
`sequence`, `component`, `level`, static `eventCode` and optional validated fields:

- `stage`, `routeId`, HTTP `method`/`status`, bounded `durationMs`, `responseBytes`,
  allowlisted `responseKind`/MIME class, `completion` (`complete`, `aborted`,
  `truncated`), generated `traceId`, and validated `cfRay`.
- Bounded `droppedEvents` producer summaries, folded into collector drop counts.
- Safe enum/code fields for OS/SQLite failures and worker/provider outcomes;
  `category` (`text`, `audio`, `video`) and lifecycle stage where relevant.

Use registered event/route/stage/code enums, not free-form interpolated messages.
Unknown routes become `unknown`, with no raw path/query. Do not log headers,
cookies, authorization, IP addresses, filenames, arbitrary filesystem paths,
project/content IDs, request/response bodies, prompts, manuscripts, provider
responses, provider URLs, credentials or raw SDK/external exception strings.
Discard unknown fields, bound strings/numbers, and replace unrecognized errors
with a static code. Redaction is an allowlist at creation and ingestion, not a
regular-expression pass over arbitrary messages.

For each HTTP request the gateway generates a random 128-bit
`traceId`, ignores external trace overrides, returns `X-SceneSparrow-Trace-Id`,
and passes its value to the authenticated loopback service using that header.
Rust validates it at the service boundary; workers receive only a safe operational
context when needed. A background task can have a separate execution trace linked
by a safe parent trace, without persisting content identifiers in exported logs.
Existing business `requestId`, idempotency identities and shared AI `traceId`
semantics remain intact; the gateway identifier is a transport correlation field,
not a replacement business identity. Keep those namespaces explicit in code/types.

Accept `CF-Ray` only as bounded ASCII matching Cloudflare's ray/colo format; reject
other values, never echo arbitrary headers. It is correlation metadata, not proof
of authenticity unless the origin is restricted to the trusted proxy. Log one
request completion or abort, auth/origin failures and upstream failures. For SSE,
record opening/closing and aggregate bytes/duration, never individual event data.
Limit repeated security events with counters so unauthenticated traffic cannot
exhaust storage. Early browser failures have no client event until JS executes;
document/asset gateway events and browser network evidence cover that gap.
Previously discarded output cannot be reconstructed retroactively; collection
starts only after the instrumentation is implemented and deployed.

## 5. Collection, retention and bounded reads

Replace ignored child output with piped streams that are drained immediately.
Rust service uses structured JSON tracing on stderr; worker stdout remains its
versioned RPC channel and is never reused for logs. Worker adapters emit only
safe structured events or redacted supervisor summaries (exit/signal/static code).
Unknown/non-JSON child lines are discarded with a bounded dropped-line counter,
not copied verbatim to disk or Docker stdout. No raw debug/SQL/provider dump mode.

The collector has a 1024-event/1 MiB queue, a 4 KiB event ceiling and a 64 KiB
partial-line ceiling per stream. Drain oversized lines through their terminator;
never pause a child behind a full log queue. On overflow, drop diagnostic events
and increment bounded counters. Slow/full/read-only disks degrade diagnostics,
not business requests, workers or shutdown; expose `DIAGNOSTICS_DEGRADED` safely.
Read/write work is asynchronous and yields in bounded chunks; shutdown gives
pending diagnostics a short deadline rather than delaying core quiesce.

Write allowlisted JSONL under `/data/app/diagnostics` in the existing app-data
volume, independent of project DB/history and without a migration. Use mode 0700
for the directory and 0600 for files. Rotate at 2 MiB; retain at most 20 MiB total
and at most three days, deleting whichever bound is reached first, including
startup cleanup. Count the active file in the byte cap. Logs survive restarts;
access grants do not. Existing full app-data backups can include these safe logs;
their separately managed backup retention is not the active-log retention policy.

`logs` accepts only `since` (UTC RFC3339), `level`, `component`, `traceId`, `cursor`
and `limit` (default 200, maximum 500). Default window is the last 15 minutes;
maximum requested window is 24 hours and never exceeds retained data. The initial
read freezes `until` at server time; the opaque cursor binds filters, that bound
and sequence/file position. A cursor cannot encode a path and is MAC-protected
with a boot-local key. Restart-invalid cursors return `409 CURSOR_EXPIRED`;
rotation gaps return a successful page with `gap:true` and the retained boundary.
New initial reads can still read pre-restart events using `(bootId, sequence)`.

Responses are at most 1 MiB and contain `schemaVersion`, `events`, `window`,
`nextCursor`, `gap`, `truncated` and `droppedEvents`. Empty logs return valid
`200` JSON with `events:[]`; no `204`. Ignore an incomplete trailing JSONL record;
skip malformed records and set the gap/corruption indicator. Never return raw
partial bytes. Limit scan work to 20 MiB/2 seconds per read, reporting truncation
with a resumable cursor; serve at most two concurrent reads and one bundle build.
Reads are bounded to 30/minute per credential and 60/minute globally; bundles to
2/minute; mint/revoke to 6/minute; client events to 30/minute, with global caps.

`status` returns app version/build SHA, gateway/core availability, boot time,
collector state, retained time range and aggregate drop/error counts, at most
16 KiB. Mark unknown build metadata explicitly; never dump environment, settings,
operator identity, provider configuration, secrets or process arguments.
`bundle` uses the same filters/window and produces at most 1 MiB of JSON with safe
status, schema/retention manifest and one bounded event page plus truncation/gap
markers. It contains no project database, attachments, config files, arbitrary
filesystem contents or raw host logs. It cannot select a directory or run commands.

## 6. Response classification and client reports

Diagnostics API errors always have JSON `{code,traceId}` and explicit content type:
`400 INVALID_DIAGNOSTICS_QUERY/INVALID_DIAGNOSTICS_EVENT`, `401 UNAUTHORIZED` or
`DIAGNOSTICS_GRANT_EXPIRED`, `403 DIAGNOSTICS_SCOPE_DENIED/ORIGIN_DENIED`,
`404 NOT_FOUND`, `405 METHOD_NOT_ALLOWED`, `409 CURSOR_EXPIRED`,
`413 INPUT_TOO_LARGE`, `429 DIAGNOSTICS_RATE_LIMITED` (with `Retry-After`), or
`503 DIAGNOSTICS_UNAVAILABLE`. Cap POST bodies at 4 KiB and finish reads within
5 seconds. Core unavailability is status data, not failure of gateway-owned reads.
Do not attempt a second JSON error after streamed headers; record an aborted trace.

Platform-client decoding classifies HTTP/auth failures, timeouts/network errors,
wrong content type, empty body and malformed/truncated JSON separately, using
stable localized codes such as `AUTH_REQUIRED`, `HTTP_ERROR`, `NETWORK_TIMEOUT`,
`RESPONSE_NOT_JSON`, `RESPONSE_EMPTY` and `RESPONSE_INVALID_JSON`. Show status and a
validated gateway trace ID when present, never raw HTML or response fragments.
Accept empty responses only for contractually empty `204`/`HEAD` operations; empty
`200` is not valid data. Preserve SSE, binary download and upload-specific parsers.

A client event accepts only a registered failure code, route/stage enum, status,
validated trace ID and app build, never a stack, URL or user message. Return
`202 {"accepted":true}` after bounded enqueue; reporting is best-effort and never
recursively reports itself. Early bootstrap reporting must not require React.
Parser/transport failures on writes can mean delivery is unknown: retain the
original request/idempotency identity and query its original receipt before any
retry decision. Add no automatic write/provider retry or new request ID; preserve
shared AI's one-dispatch and unknown-origin recovery guards.

## 7. Proxy boundary and operator workflow

The assistant can read safe application diagnostics only after the operator grants
temporary access. A support session starts with status and a narrow recent log
window, follows trace IDs, exports only if needed, then revokes the grant. These
APIs do not grant SSH or access to all server logs. Never make logs public.

Nginx, Cloudflare, TLS/DNS and host/container runtime failures lie outside the
application collector. An edge failure can leave no application trace. Compare
browser/network status, timestamp, request stage and CF-Ray with the operator's
proxy evidence; absence of a gateway record is not proof of a gateway fault.
An optional later collector may read only a dedicated per-vhost sanitized Nginx
JSON access log through a read-only directory mount. Allowlist status/upstream
status/timing/ray metadata; exclude auth, bodies, IPs and raw URLs. No Docker
socket, shell endpoint, arbitrary paths or mount of all `/var/log`; no automatic
Cloudflare account access. Configure cache bypass for diagnostics at this hostname.

An optional manually dispatched diagnostics workflow can reuse the existing
deployment SSH secrets as a host fallback. It runs a fixed read-only collector
and uploads a bounded, already allowlisted artifact that the support tool reads
through GitHub's API, without application passwords or new permanent credentials.
It performs no build, tests, deployment or arbitrary operator-provided command.
Raw Compose/Nginx logs must not be streamed into Actions logs or artifacts. Its
`workflow_dispatch` definition must be registered on the default branch; a file
only on release is not sufficient. Any required default-branch workflow setup
needs a separate reviewed operational change, not an unaccepted product merge.

## 8. Ordered work and acceptance

The user subsequently authorized RD-1/RD-2 implementation. The source now includes
the versioned protocol, safe collector, gateway APIs/page/grants, client decoding
and early reports. RD-3 remains deferred. Evidence and limits are recorded in the
[validation report](../validation/remote-diagnostics.md); source delivery alone does
not enable the capability on a running deployment or establish the incident cause.

| Phase          | Concrete work and exit evidence                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RD-1           | Capture fresh-browser authenticated document/challenge behavior; add gateway trace/events, safe child collection and response classification. Establish which layer fails before claiming a cause. |
| RD-2           | Add independent operator page, protected status/log/bundle APIs, scoped grants/revocation, retention and early safe client reports. Document CLI/host fallback and operator flow.                  |
| RD-3, optional | Add a dedicated sanitized Nginx reader or manual fixed host collector if application evidence is insufficient; preserve the host trust boundary and default-branch registration requirement.       |

- **RD-A01:** Real browser, fresh profile: wrong/right Basic credentials, native
  challenge, initial HTML document, redirects/external top-level navigation,
  static assets and successful application mount. A fetch-only test is insufficient.
- **RD-A02:** Break the main bundle/early bootstrap; diagnostics page still grants,
  reads and exports while the gateway lives. Core/container death follows existing
  supervision and the documented host fallback, with no false availability claim.
- **RD-A03:** Reject unauthenticated, expired/revoked/replaced grants, query tokens,
  cross-origin writes, out-of-scope methods/business/native calls and token minting.
  Confirm restart invalidates grants/cursors while safe retained logs remain.
- **RD-A04:** Canary credentials, Unicode manuscripts/filenames, provider URLs,
  SDK exceptions and malformed child output never appear in logs, errors or bundles.
- **RD-A05:** Overflow, disk full, partial write, corrupt tail, rotation/retention,
  reader concurrency and rate limits remain bounded without blocking business work.
- **RD-A06:** Proxy HTML, empty/truncated JSON, 401/403/502 and timeout errors produce
  the correct localized class/trace; initial document failures remain distinguishable
  from mounted-app errors. Unknown writes keep their original receipt identity.
- **RD-A07:** Preserve SSE streaming/cancellation, upload/export limits, private
  loopback core/native exclusions, desktop credentials and shared AI dispatch guards.

These acceptance cases define the intended behavior. Consult the validation report
for executed checks, fault simulations and remaining platform/live-incident gaps.
A local browser fixture does not establish the authenticated response or proxy
behavior of the reported production incident.
