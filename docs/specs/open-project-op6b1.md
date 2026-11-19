# OP6-B1 preparation: core startup, accepted recovery and session identity

Status: root preparation, not dispatched. Freeze after accepted OP6 native
primitives and OP5-C. This checkpoint implements core/service lifecycle only;
OP6-B2 owns host locator/activation epochs and visible guarded switching. Root owns
specification, review, validation and Git. Read the OP6 parent and accepted native
checkpoint handoffs before implementation. Applied SQL001–015 are immutable;
append versions and update all versioned backup/inspection readers if needed.

## Startup ordering and accepted recovery

Current open_storage_mode applies some startup task updates before constructing
the repository, then recover_source_intents/verify_source_state can return a fatal
storage error. Move the ordinary project reconciliation behind an explicit startup
state. A proved accepted project with unknown live/staged creative versions opens
in RecoveryOnly; corrupt or missing accepted closure still refuses. Do not reset,
adopt live unknown bytes, initialize blank state or start project jobs/collection
merely because HTTP can start. Global AI configuration remains independent.

Verify accepted management project identity, immutable source/file graph, retained
history/locks/approvals and referenced objects before offering accepted read views.
When live project.json is the conflict, use its accepted graph object. A source-only
preregistration root needs a conservative proved view; never invent/drop unknown
manifest extensions or media. Preserve original receipts and unknown intent bytes.

Keep existing actual source/graph recovery and durable recovery index/cursor owner.
Expose a small generated lifecycle read model with safe state/reason/capability
facts, accepted source/manuscript/history, and exact recovery actions. The existing
recovery UI can operate while all unrelated project mutations, intakes, preparation,
paid dispatch, mutable status reconciliation and collection are fenced. Audit real
routes/ports, not only a URL prefix. No blanket /v1/ai exemption: runs and results
are project-owned, while settings/credentials/discovery/connection tests are global.
Read paths that currently mutate records must obey the same startup boundary.

After a proved recovery settles, run deferred normal startup reconciliation once
under lifecycle/writer ownership before publishing Active. Do not recursively lock
the repository mutex or leave a mutation gap between intent settlement and deferred
reconciliation. Failure remains visible and fenced. Known committed/uncommitted
intents still reconcile automatically; duplicate recovery cannot redispatch an
ambiguous paid request or apply a later intent using older proof.

## Verify imported management schema before executing it

The accepted metadata closure includes schema behavior, not only row/object hashes.
Current portable inspection checks user_version and quick_check, then queries known
business names; those checks alone do not reject a forged view/trigger. SQL015 owns
the legitimate package_intake_decision_retention trigger. An imported additional or
altered trigger must never become code that can change locks/history during later
acceptance or copied-work sanitization.

Validate the version-appropriate core schema (tables/columns/constraints and known
trigger/view definitions) before business queries, upgrade/sanitization or project
startup. Preserve legitimate delivered schemas/WAL snapshots; do not mutate an
unrecognized source to repair it. Reuse the same verifier in portable package/
backup/legacy inspection and mutable opening. Unknown executable schema is an
integrity refusal, not unlocked verified restore. Creative-only inspection/adoption
remains an explicit separate choice. Keep extension loading disabled and bound
untrusted SQLite verification/cancellation; no unbounded user-defined view/trigger
work on the startup thread. A schema-only expected baseline can be derived from
immutable migrations without dispatching normal startup work.

Add a forged extra trigger and a same-name altered SQL015 trigger that would unlock
content on candidate decision, and a project-name view in place of its table. Prove
refusal before executing those definitions, unchanged original bytes and no lock/
history mutation. Also prove an ordinary genuine versioned schema remains valid.
Do not broaden this into unrelated provider/tenant functionality.

## Persistent physical ownership

A repository session retains and validates creative root, management root and live
DB identity/handles. Parent-per-operation checks alone miss rename-and-clone between
operations while SQLite still owns the old DB. Validate before every creative,
object, SQL or asynchronous project mutation; fence rather than split writes across
two roots. Verify ordinary reads needed for accepted recovery deliberately. Native
handles may prevent rename; otherwise detect changed identity. Reject hardlinked
management DB before mutable open. Keep per-operation no-follow/alias proofs.

Do not promise protection from unrestricted filesystem owners; test the concrete
root replacement/alias and copied-origin boundaries. A copied root with the same
project UUID is not the original execution origin. Fence copied nonterminal work
before initialization can classify it as original; original same-root restart keeps
its known-undispatched continuation policy and ambiguous-call fence.

## Default native creation

Truly new app-owned absent roots use format-v1 without a project naming gate.
Support precreated empty app-owned locations only through explicit verified empty
location creation; Docker volumes cannot accidentally choose legacy by mkdir.
Existing legacy projects keep their loader until explicit conversion. Unknown
nonempty roots require inspect/adopt; registered managed roots missing management
state require recovery rather than unlocked fresh adoption.

Construct the initial accepted manifest/empty Markdown and graph as part of new
creation, so ordinary optional rename/export can run without a graph-registration
gate. Registration must not autoaccept unrelated files added later. Preserve
partial-creation request identity and original outcome. Retain compatible explicit
legacy fixture creation for old suites; keep legacy/Tiptap evidence separate from
new-default/native CodeMirror evidence. Do not make every old fixture silently
native and count unrelated failures as platform regressions.

## Evidence and handoff

Add deterministic native repository and actual process restart HTTP evidence for
unknown preserved intents -> usable accepted RecoveryOnly -> explicit settlement
-> exactly-once deferred startup. Verify mock SDK call counts, five-step history,
locks, original receipts, global settings, fresh-client index discovery and closed
mutation/job/collection routes. Test management/creative root rename-and-clone and
DB hardlink, copied origin, absent/empty/partial/legacy/unknown nonempty startup and
initial graph/export/rename. All fixtures sanitized, no providers or real projects.

Stop all writes/checks/processes; provide exact intended files, SHA-256/log manifest
and unresolved target evidence. Root independently reviews/tests, documents and
commits/pushes. No Git/worktree/delegation by writer, no merge/tag/deploy/cloud
publication, no host switch UI in this checkpoint. Preserve root docs and .agents.
