# OP6-B2 preparation: guarded host activation and immutable client context

Status: root preparation, not dispatched. Freeze after accepted OP6-B1 APIs and
native checkpoints. Root owns architecture, design, review and Git. This implements
the existing OP6 host lifecycle scope; it does not add multi-user tenancy or media
execution. Preserve global settings/credential ownership and both Web data volumes.

## Actual hosts and authoritative locator

Implement real root switching in apps/web/server/start.mjs and desktop main.
Resolve only privileged core-verified opaque Ready targets, plus native main-owned
folder choices/recent roots; never accept renderer filesystem paths. Supply a
trusted library/CLI/private route for target resolution so JavaScript does not
reimplement transfer journal/Ready proof. It must also work when the original core
is unhealthy. Native private capabilities retain bearer+native-token authorization.

Keep a stable root registry entry identity separate from activation epoch. Preserve
legacy registry readers; extend existing native registry rather than build another.
Authoritative locator contains selected root, expected managed identity and current
epoch in trusted appdata. Web has one configured starting root and can subsequently
activate a verified managed target. Both /data/project and /data/app remain backed
up together offline; deploy never syncs creative data. Operator auth, exact-origin
writes, loopback/private tokens and external credential master key are unchanged.

Actual A -> B switch: pass shared dirty/composition/uncertain-close guard; seal that
approved input while candidate boot can take time; cancel/quiesce tracked old work;
start/verify candidate; persist authoritative locator+NEW epoch; publish host route
and reload initiating client. Failed boot/persistence rolls back old root+epoch and
keeps old buffers/recovery. Disposable recent-title write failure is distinct from
authoritative locator failure. Same-root core restart retains epoch and does not
reload/drop dirty input. B -> A is a new activation, never reuse first A epoch.
Handle signal shutdown, rollback and missing remembered roots explicitly.

Do not preflight-reject a valid RecoveryOnly project before its recovery UI starts.
A registered root missing its management directory requires recovery. An explicit
standalone creative-only adoption is a different user choice. Ready target opening
must validate actual root identity/proof, not merely a cached success label.

Verify the original Ready closure before candidate startup under a held target
identity. Normal authorized startup may migrate schema, fence copied runtime rows
or reconcile operational records; do not compare its post-start SQL bytes with an
immutable pre-start backup hash and reject legitimate initialization. Require the
candidate core to bind/prove the expected physical root before any mutation, then
verify its current accepted state and persist the final registry/locator identity.
After successful activation, reopening that registered root uses current managed
identity rather than treating the edited project as a corrupt old Ready snapshot.
Keep the original transfer outcome historical and preserve the Ready provenance.
Test activating an older-schema target and reopening it after a legitimate edit.

Conversion prepares a saved snapshot while its source remains active. The user may
edit that source before later activation. After the close guard, compare the
current saved source base with the conversion's captured base. A newer source
must not silently appear to have migrated into the older target. Offer an explicit
new conversion or clearly labeled opening of the prepared snapshot, retaining the
original project and Ready result. Independent archive restoration is inherently
snapshot opening and must keep that provenance clear. Test later source edits
between conversion Ready and Open prepared project.

## Immutable transport ownership

Create each HTTP/preload client with one immutable context obtained at construction,
never a mutable global getter upgraded after switch. Context is transport metadata
outside business DTOs/digests. A fresh explicit open-current action can construct a
new client; old callbacks retain old context. Include context before/after awaits
and on all project reads, mutations, bytes, SSE, download anchors and native IPC.
Same-origin attachment anchors cannot set custom headers: use an exact query or
purpose-bound delivery capability checked by the same host/core boundary.

Central route classification must reflect actual service ownership. Project routes
include /v1/history, /commands, /sources, /intakes, /document-jobs,
/source-extractions, /reviews, /manuscript, /project and children, and /v1/ai/runs
including result/cancel. Global settings/credentials/configuration/model discovery/
connection tests remain independent. Do not exempt all /v1/ai or fence only /project.
Health/context bootstrap and private host lifecycle routes have explicit policies.

Native preload can use an internal fixed-context envelope while preserving public
named generated business arguments. Main captures the actual core/session and
credentials before chooser/prerequisite awaits. Late chooser/upload/readback must
never resolve host.session again to retarget. Preserve C unknown-save ownership.
Native file intake/save must use accepted platform primitives rather than Node
check-then-rename or Linux-only inode assumptions on Windows.

Other browser tabs keep unsaved original buffers on context mismatch. Do not
silently fetch a new context/remount. Provide a small localized durable stale-session
entry with existing copy/download plus explicit Open current project. Global
settings stay usable. Test old A -> B -> A closures, not only different projectUUID.

## Visible activation and completion evidence

Wire C prepared conversion/restore results to actual Open prepared project through
the existing application menu/dialog, shared close guard and host capabilities.
Keep off-white editor, compact bilingual controls, three-second notices and durable
recovery status. Default boot stays editor-first; no workspace/project-name form or
raw JSON/error navigation. Native normal create/open folder uses the same lifecycle.
Update RememberedProject preflight for both legacy and format-v1 roots. Startup
budgets must accommodate validated large closures truthfully, with bounded cancel
and shell status rather than premature Ready or an unbounded hidden wait.

Add real-process Web switch/rollback/restart/locator tests, native host boundary
mocks plus actual platform cases, and browser held boot + later input, old-tab
buffer, A -> B -> A late requests, same-root restart, settings isolation, missing
root, original chooser ownership and unavailable archive cases. Keep original DTO
receipt recovery possible via a newly authorized client. Full current-head checks,
legacy/native browser suites and final standalone package render are root's final
acceptance, not implied by a constructor mock or compile.

Stop all writer processes/checks and provide exact files/hashes/logs. Root reviews,
tests, documents and commits/pushes. Preserve root docs/.agents; no writer Git or
delegation, no merge/tag/deploy/cloud publication, no providers/real projects or
arbitrary imported-code execution.
