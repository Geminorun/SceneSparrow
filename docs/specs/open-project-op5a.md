# OP5-A: explicit legacy-to-file project conversion

Status: root preparation while OP4-B is implemented, 2026-11-19. Not dispatched.
Root must freeze the accepted B commit/schema and exact named operation handoff
before a coding writer starts. Parent [OP5](open-project-op5.md) owns the resource,
preservation and packaging contracts. This checkpoint implements OP5-T01–T03;
complete ZIP exchange and visible package flows remain OP5-B.

## Read-only source and operation ownership

Inspect a legacy source with a read-only SQLite transaction before any mutable
repository open, upgrade, reconciliation, group closure or collection. Include
committed WAL state. Source management must have no authored-source registration;
do not misclassify a managed `.scenesparrow` folder selected at the wrong level as
legacy. Missing/corrupt known management requires recovery. An absent project
identity is not permission to invent an unlocked replacement during migration.

Inspection returns project/schema/working/history identity, cursor, retained counts
and a content-base token. Derive this token from stable project/content/history
identity, not a connection-local SQLite data-version counter. Job progress can
change without a prose revision; the actual conversion captures one consistent
current SQLite snapshot after validating the requested content base. Record its
backup/closure hash as conversion provenance. Original-request replay reads its
stored outcome before comparing a now-newer live source.

Migration cannot write its receipt into the read-only source DB. Use a small
core-owned lifecycle-operation journal under application data, with original full
DTO digest, source/version, opaque target capability, phase and verified result.
Atomic flushed records and exclusive operation ownership prevent duplicate copies.
This journal tracks transfer/new-target lifecycle; it is not a second live project
content/history/approval writer and does not require another database. Do not reuse
the AI execution model or issue provider calls for filesystem conversion.

The target is new and distinct, selected through a native destination capability
or a core-selected persisted Web location. Browser DTOs carry no arbitrary paths.
Native/CLI filesystem ports may use trusted paths behind those capabilities.
Do not select an ephemeral container sibling. Source/target identity and target
parent containment are checked before preparation and no-clobber promotion.

## Consistent backup and staged schema upgrade

Take a SQLite backup from the same read snapshot used to derive retained roots.
Copy/hash its complete required object/export closure using bounded streams.
Missing roots or changed/unreadable files fail the new operation. If source
collection removes a snapshot member before copy, fail rather than substitute a
newer version. No source lock file is created by read-only inspection. The backup
completion marker is flushed last; incomplete backup cannot be restored.

Retain this verified legacy backup independently of the source and failed target.
Make a fresh staging copy and apply the delivered append-only schema ledger only
there. Separate schema-only upgrade/verification from ordinary startup jobs: no
copied task can dispatch while conversion is still constructing source evidence.
Preserve IDs, high-water tokens, history cursor/entry IDs, locks, candidate/review
records and all original request outcomes. Do not run current normal startup over
an inconsistent half-converted target to fill missing state.

## Marker-aware canonical conversion

Use a trusted application serializer entry around the existing pinned legacy
CommonMark AST builder/writer. Keep the legacy export entry's output/import behavior
unchanged. Explicit identity-aware output can live in a separate pure package
subpath/document worker, without eager new imports in the old worker entry.
Migration may require that trusted Node worker; ordinary native text creation/open/
save must remain Node-independent. Missing worker capability is a clear refusal.

Map canonical blocks to the proved OP1 leaves using their existing UUIDs. Root
empty paragraphs and empty/nested list items need explicit `empty` markers;
unmarked Markdown alone can erase these leaves. Preserve ordered/bullet ancestry,
heading level, inline marks, links, Unicode and breaks. For each derived source,
native parsing with original IDs must reproduce exact canonical order/kind/attrs/
runs/marks. Do not allocate replacement IDs or silently trim whitespace/newlines.
Unsupported representation/one-to-many mapping or source expansion beyond its
bound fails before target promotion. Tests include representable multiline content
and explicit refusal of an unproved case, not blanket newline refusal.

Deduplicate deterministic derived sources by canonical input where safe. Produce
raw evidence for current state and retained history endpoints/approval states,
including approvals whose actual block payloads differ from current prose. The
existing native `render_blocks` is deliberately limited and cannot be substituted
as a universal serializer. Record the serializer/version and normalized-origin
provenance; no unavailable original Markdown spelling is claimed.

## Metadata references and preserved execution evidence

Current/history business snapshots need derived source hashes so native Undo/Redo
can traverse the retained five transitions. Preserve stable entry IDs/cursor and
keep original immutable objects pinned as provenance. Old entries may remain
pre-registration graph history: they restore only their derived manuscript and
preserve the newly registered manifest/media, matching A's old-entry semantics.

Augment approval source evidence while retaining baseline IDs/sequences, original
block/revision/hash locks and original objects. Current finalized state must verify
against its derived raw source; Undo/Redo must reuse the corresponding baseline
identities. Original downstream/export captures keep their original immutable
input identity and legacy serialization meaning. Registration provenance must not
be labeled historical media approval.

Planning dependencies and review contexts use canonical IDs/revisions. Keep their
original context/input/artifact hashes, bindings and paid-run identities. Deriving
source is not a new inference or approval. Exercise retained succeeded planning
output and pending review acceptance after conversion; verify applicability through
the actual owners and count mock SDK calls. Do not blindly stale every retained
result or rewrite the independent shared AI layer to accommodate representation.

Before activation, apply recovered-copy origin fencing to every copied nonterminal
AI/document/export/downstream and B work-copy/preparation operation. Preserve
succeeded evidence. No queued status or copied process/session token is proof that
work can resume here. Explicit user retry creates its own new intent/configuration.
Mutable work-copy directories and active reader/preparation leases are not portable
execution state; missing copies remain truthfully unavailable until explicit action.

## Completion, transport and verification

Verify manifest/source/graph, normalized projection, retained closure/history,
approval/review/receipt invariants and copied-origin fences before marking ready.
Flush ready management and conversion result last, then promote only a new target.
Replays never create another directory; failures preserve the original selection
and verified backup. Activation is a separate guarded capability, with a distinct
root/session ownership identity even for the same project UUID. B/OP6 lifecycle
seams must be frozen before adding visible switching; never activate by path string.

Provide named read-only inspection and conversion/status/retry operations over the
existing authenticated generated HTTP/preload boundary. The preparation contracts
below will be frozen with the accepted B checkpoint before dispatch. Keep status
responsive while bulk copying, retain original uncertain IDs and safe failure codes,
and add en/zh-CN presentation when that UI is connected. Do not autoactivate.

## Named lifecycle seam for the final handoff

Keep lifecycle transfer state outside project SQL and independent of shared AI.
Use a `ProjectTransferStore` (or equivalently named infrastructure owner) under the
existing application-data resolver's `project-transfers/`, with bounded exclusive
workers and durable atomic JSON records. Reusing the directory resolver does not
make migration an AI settings action. Never package this global parent. A target
capability is a durable opaque UUID, bound to this application and intended source
identity, with its private filesystem location in that store only. A fresh HTTP
client can inspect the same operation after process restart without knowing paths.

Web target issuance creates only a registered future destination beneath the
persisted application-data `project-roots/` directory. Reserving a capability must
not create a complete-looking destination. No renderer path, title-derived path,
or ephemeral sibling is accepted. Trusted Rust/CLI tests can use an explicit
filesystem target through the native library port. Native destination chooser
issuance will use the existing private-token/main-process boundary when connected;
ordinary browser DTOs never gain that path field. Activation/supervision is a
separate OP6 lifecycle step and cannot be simulated by changing a path in App.

Add a closed `project-transfer.schema.json` and generate both consumers. Required
families and semantics for A:

- `LegacyMigrationInspection`: project ID, legacy schema, working/history revision,
  cursor, stable `contentBase`, bounded retained counts and supported/refusal code.
  Inspection is of the currently owned legacy source, not an arbitrary server path.
- `MigrationTargetRequest`: request/project IDs and destination kind `managed`;
  the native privileged issuer has its own closed input when implemented.
- `MigrationTarget`: target ID and safe display facts, no absolute location.
- `LegacyMigrationRequest`: original request/project IDs, `contentBase`, target ID.
  The entire original DTO binds the lifecycle receipt before lookup/replay.
- `MigrationOperationView`: original request/project/target IDs, operation revision,
  phase, state, bounded progress, safe error, verified backup/result identities and
  normalized-origin notice. The view distinguishes original start outcome from
  current operation state and never returns mutable paths or credential material.
- `MigrationControlRequest`: new explicit control request ID, project ID, original
  operation ID, expected operation revision, action `cancel` or `retry`. Retry links
  the original attempt but keeps its outcome; it cannot quietly choose a newer base.

Expose `GET /v1/project/migration`, `POST /v1/project/migration-targets`,
`POST /v1/project/migrations`, `GET /v1/project/migrations/{requestId}` and
`POST /v1/project/migrations/{requestId}/control`, with matching named
PlatformClient/HTTP/preload operations. Lookup is project/target scoped; changed
payload with the same request ID conflicts even after failure or source progress.
Bound queue/records/control JSON, never return source bytes in an operation view.
Copying/serialization/verification runs outside the original business writer;
status, manual editing and global settings must remain responsive. A consistent
captured source snapshot is converted; later original edits do not enter it.

Incomplete operations become `interrupted` on owner restart and require explicit
retry. Cancellation before promotion preserves the verified backup and original;
completion that already promoted cannot be reported as an undone cancellation.
Final no-clobber target publication and its journal result must be reconciled by
recorded target/ready identities on replay, including interruption between the two.
Do not delete an unknown target to make retry succeed. Keep terminal operation
identity after payload cleanup and keep ready/backup closure until its explicit
retention policy permits collection. A's new routes are testable now; focused
visible chooser/progress/activation controls connect in B/OP6 without a new start
screen or mandatory workspace/name gate.

Required evidence: every supported legacy schema, live WAL producer, stable IDs/
locks/approvals/reviews/pending candidates/receipts and five-step Undo/Redo; missing
closure and unproved source refusal; phase/promotion interruption and existing
target; changed content base/replayed ID/different payload; copied mock dispatch
count zero; retained succeeded artifact reuse without another SDK call; independent
verified reopen/backup after conversion and original source byte/business equality.
Use only sanitized fixtures, no real project conversion or external code execution.

One fresh gpt-6.1-sol/high writer after root dispatch, no children/Git/worktrees/
deploy/tag/environment publication. Preserve `.agents/` and root docs. Every shell
sources scripts/cloud-env.sh; Rust wrappers use both zero-debug profiles and
CARGO_BUILD_JOBS=4, no parallel Cargo. Freeze all writes/owned checks/processes with
`.artifacts/op5a/HANDOFF.md` before root review/commit/push. This preparation document
does not itself dispatch coding.
