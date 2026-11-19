# Open project format and file-authoring specification

Status: implementation in progress, 2026-11-19. OP1 contracts/codec and the Linux
OP2 source store and OP3-A reconciliation/delivery backend are locally reviewed.
OP3-B source UI is locally reviewed. Packaging and full platform support remain
later gates.
Baseline: `release/1.0.0` at `bf56982`.
Decision: [ADR 0005](../decisions/0005-open-project-workspace.md). Delivery gates
and OP1–OP6 assignments: [execution plan](../open-project-execution.md).

This is the shared project-format contract. The existing S1–S4 and shared AI
specifications remain the behavioral baseline for editing, review, locks, history,
credentials and at-most-one dispatch. Root supplies a bounded stage brief before
each coding assignment; a future media-production spec extends this contract.

## 1. Goal and scope

An authored project is a portable directory of ordinary files. Codex, Claude and
other tools can read and modify its creative sources. SceneSparrow presents,
validates and accepts those changes while protecting confirmed versions.

Desktop is the primary product workflow. Web exercises the same UI, protocol,
core and format in a cloud development workspace or private deployment. A cloud
development checkout and a separately deployed server are different filesystems;
application deployment must not overwrite or implicitly synchronize user projects.

This delivery includes the format, file-backed manuscript authoring, external
change reconciliation, approved-state protection, legacy migration, project
packaging and shared platform integration. Audio/video declarations and a small
standalone Remotion compatibility fixture are included. Production TTS/ASR,
audio-editing UI, a complete video editor, embedded Agent sessions, cloud project
synchronization and automatic incremental rendering are separate deliveries.

## 2. Directory and ownership

```text
project/
  project.json
  manuscript.md
  README.md
  AGENTS.md
  CLAUDE.md
  package.json                    # Added when executable media tooling is used
  pnpm-lock.yaml
  src/index.ts                    # Standard Remotion entry
  src/Root.tsx
  src/scenes/
  src/components/
  audio/plan.json
  captions/
  public/audio/
  public/images/
  public/video/
  public/fonts/
  references/
  tools/
  .scenesparrow/project.sqlite
  .scenesparrow/snapshots/
  .scenesparrow/cache/
  output/
```

Only `project.json` and its manuscript are required creative files for a new
text-only project; core-owned management files are initialized by the app. Opening
or writing text does not require Node, Remotion, AI configuration or a project-name
form. Optional stages add their files progressively. The directory is independent
of the SceneSparrow application source checkout. Git is optional for user projects.

First adoption of an unmanaged directory explicitly initializes management state
and reports unavailable historical review data. A known managed directory with
missing/corrupt metadata requires recovery; do not infer that its content has no
locks or silently create an empty replacement database. Standalone rendering does
not require SceneSparrow management records.

| Data                                                          | Authoritative representation                         | External editing                                               |
| ------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| Manuscript text and Markdown syntax                           | Declared `.md` file                                  | Candidate creative changes                                     |
| Audio editing intent                                          | Declared audio plan                                  | Candidate creative changes                                     |
| Video implementation                                          | Declared Remotion source and dependencies            | Candidate creative changes                                     |
| Subtitles and media                                           | Actual referenced files                              | Candidate additions/replacements                               |
| Identity, review, user locks, decisions, history and receipts | Core-owned management records and verified snapshots | Read as context; never accept direct replacement from an Agent |
| Search/projection indexes, thumbnails and render cache        | Rebuildable derived data                             | Not a source of approval or authored text                      |

SQLite remains necessary persistent application state, not a disposable cache.
It must not become a second editable copy of the new format's manuscript.
Projections and immutable historical snapshots may contain text but never compete
with the current file as the authoring source. Existing legacy projects keep
their current storage semantics until explicit migration.

## 3. Manifest, paths and versions

The initial manifest contract has `format: "scenesparrow"`, integer
`formatVersion: 1`, a stable UUID `projectId`, a project-relative `manuscript`
path, optional display `name`, optional `audio: { plan }`, optional
`video: { entry, compositionId }`, and an optional namespaced `extensions` object.
Absent audio/video fields mean those stages are unavailable, not corrupt.

The executable JSON Schema and generated TypeScript/Rust types are introduced in
OP1 through the existing contracts pipeline. File-format version, project identity
and accepted content revision are separate concepts. Renaming or relocating a
project preserves identity; an explicit independent Save as creates a new identity.

The manifest stores entry locations, not duplicate prose, component source or
manually maintained media durations. Selected Remotion Composition metadata owns
video fps, dimensions and duration; actual audio files own measured sample rate
and sample count. Any derived index records its input fingerprints. Validation
must reject inconsistent or unavailable metadata rather than invent it.

Core manifest fields are strict; extensions have explicit names and preserve
unrecognized payloads. Unsupported major format versions are inspectable read-only
with a localized explanation, never silently rewritten or initialized as blank.

Schema-declared file integers follow mathematical JSON integer semantics within
the JavaScript safe-integer range: integral spellings such as `1`, `1.0` and `1e0`
agree across the Node/native validators. Validation may normalize its typed clone;
it does not rewrite raw files or opaque extension values. Fractions and unsafe
core integers reject. Live transport DTO decoding remains independently strict.

Paths in manifests/plans are UTF-8 project-root-relative paths with `/`
separators. Logical names and user text allow Unicode. Validate Windows reserved
names, case-insensitive collisions and path normalization before accepting a
portable project. Reject absolute/drive/UNC paths, traversal, archive symlinks,
special files and filesystem links escaping the registered project root.
Revalidate paths at file access/promotion; string-prefix checks are insufficient.

Remotion source keeps native `public/` and `staticFile()` conventions. There is
one physical media file; no independently edited mirror is maintained for Web.
Reference links remain link-only unless the user explicitly imports their content.
References and management records are not exposed as public preview assets.

## 4. Markdown fidelity and identity

Store UTF-8 Markdown; generate new files with LF. Preserve existing source bytes
outside intentional edits, including unsupported syntax. Opening/saving an
unchanged file is a no-op. Do not parse into the current normalized canonical
model and serialize the whole file as an implementation shortcut.

The editor may use a semantic projection, but the source buffer is authoritative.
Unrepresentable syntax stays readable and recoverable. If the current editor
cannot preserve it, source-capable editing is required; an engine choice is not
permission to lose syntax. Retain the Obsidian-style writing experience and stable
editor identity, IME behavior and 5/10/30-second save policy.

Stable block identity travels with source using reserved Markdown HTML comments,
with the proposed simple-block form `<!-- scenesparrow:block=<stable-id> -->`.
Markers are metadata, not spoken prose or subtitles. Existing paragraph/list
identities, review anchors and locks must survive migration; line numbers alone
are not identities. Duplicate IDs, missing locked IDs or ambiguous mappings cannot
silently create replacement approved objects. Surface unresolved binding and keep
the prior confirmed state.

The tested encoding is frozen in [OP1](open-project-op1.md), with shared insertion
and read/failure corpora. It adds the explicit `scenesparrow:empty` variant for
zero-content leaves, uses suffix markers for container paragraphs/headings, and
never assigns both a list/quote parent and its content leaves the same identity.
Root reviewed the CommonMark meaning proof before downstream storage/UI work.
This is a codec proof; runtime persistence and speech/export integration have
their own later acceptance gates.

## 5. Files, revisions and external changes

A file edit and user acceptance are separate facts. A working directory may hold
external edits while a previously confirmed snapshot remains immutable. Core owns
registration, history and approval transitions; an external file write cannot
unlock content, resolve a comment or mark a task accepted.

All app writes capture base content fingerprints and use the existing serialized
project writer and receipt identities. Stage complete files beside their target,
flush and atomically promote. Multi-file changes require a durable commit/recovery
record coordinated with metadata, so a crash cannot report a mixed generation as
saved. Keep the last valid snapshot available on disk/DB promotion failure.

Filesystem events trigger debounced inspection, not automatic acceptance. Verify
actual bytes after transient/partial writes settle; event loss is repaired by
rescan/reopen. A failed or empty read cannot erase valid content. Recognize app
writes without replaying them as new user edits or history entries.

If the local editor is dirty, preserve its buffer and compare both changes against
their captured base. Offer a resolvable conflict; do not clobber either side.
Disjoint merging is allowed only with verified identity/range mapping. Unsupported
or ambiguous merges remain explicit. Later acknowledgments cannot clear newer
input or change an existing operation's request identity.

An external work item carries project identity, base snapshot/fingerprints,
request identity and requested scope. Inspect actual changes, including deletion,
rename, assets and shared dependencies. Present differences and candidate preview
when execution is supported; user acceptance promotes once through the ordinary
mutation policy. Stale or repeated submissions do not apply twice. One accepted
change set is one grouped project operation; retained Undo/Redo remains five
transitions and cannot restore live jobs or bypass locks.

External management-file changes are rejected as updates to the source project's
state. Candidate workspaces receive only the required inputs and reference
context. A working copy, lock instruction or separate process is not OS isolation.

## 6. Media interoperability boundary

Audio plans use stable segment IDs, source block/version references, project-relative
media references and explicitly named units for trims, placement and gain. Capture
the narration text/version used to generate a take as provenance, without making
it another active manuscript. Actual takes are ordinary WAV/FLAC files; captions
are SRT/WebVTT with retained alignment provenance where available.

Video positions use integer frames and audio positions use integer samples with
half-open intervals. Do not accumulate per-segment rounding. Upstream changes
mark related takes, captions and scenes stale or needing review; they do not
automatically regenerate, overwrite manual work or issue paid calls.

Remotion projects contain normal source, explicit scripts, public dependencies,
a matching dependency lockfile, local media/fonts and reproducibility inputs.
They must not import private SceneSparrow workspace packages or contact private
application APIs to render. The application is not required to understand every
arbitrary TSX element; unknown dependency impact conservatively expands review
scope and cannot cross a lock on an assumption of no effect.

Text and production-file locks have separate impact sets. Locked manuscript text
can be used to create audio/video while its actual bytes/identities remain intact.
Unknown shared code/dependency effects expand production scope and honor explicit
production locks/reservations; text finalization does not automatically lock every
future media file. Source-reference divergence/staleness is visible provenance,
not permission to rewrite approved text or a claim of verified synthesis.

OP1 defines versioned declaration envelopes; production narration generation,
mixing, alignment and video orchestration receive their own later specs. Do not
claim the declaration alone implements those capabilities. OpenTimelineIO/DAW
interchange and pixel-identical cross-platform rendering are not v1 promises.

Imported code/dependency scripts are not run during package inspection. Product
execution of arbitrary external code stays gated until platform isolation has
actual escape/credential-boundary evidence. A separate worker is not enough.
Reviewed fixture rendering through the normal developer CLI is valid compatibility
evidence, not evidence of safe arbitrary-code execution in the product.

## 7. Packaging, recovery and compatibility

Export one ordinary ZIP rooted at one manifest and a fixed saved revision. Settle
pending input or retain it explicitly; edits during export cannot enter that
snapshot. Include referenced creative files, local media/fonts, required source
dependencies, management records and retained snapshot/object closure. Use the
existing consistent SQLite backup mechanism, not a live WAL main-file copy.

Exclude credentials, authentication/session state, node_modules, caches,
unreferenced temporary outputs and active process handles. A package is resumable
with existing comments/locks/decisions; an ordinary media renderer can ignore the
management directory. Dependency installation may require public package sources.

Archive inspection is bounded and streaming. Validate expanded paths, duplicate
entries, collisions, link/special-file types, counts and expanded-size/ratio
budgets before promotion. OP5's root-owned stage brief fixes operational limits
and fixtures; exceeding them must preserve the package and existing project with
an explicit error. Archive resource policy is not a hidden creative-content limit.

Opening a returned edit for the same project compares its creative changes against
the recorded base; it never replaces current locks/history with the package's DB.
An independent explicit restore uses verified management state and object closure,
preserves provenance and fences copied nonterminal jobs under ADR 0002. It cannot
resume another machine's running task or reuse an ambiguous dispatch.

Legacy migration is explicit and recoverable: inspect, take a verified consistent
backup, produce and validate a new directory, then switch only after success.
Preserve IDs, accepted/locked baselines, sources, pending review, history and
receipt identities. Never invent unavailable prose syntax from an old normalized
projection; retain the legacy bytes/objects as provenance. Applied migrations
001–010 remain unchanged; append any needed schema steps to the shared ledger.

## 8. Commands, platform and errors

Use named, versioned project operations over the existing PlatformClient and
generated HTTP/preload contract. Required operation semantics are inspect/open,
create, read/save source with a base hash, inspect external changes, accept/discard
candidate, migrate, package/inspect/import and capability status. Each stage fixes its operation DTO
names in the executable contract; this is not an arbitrary file/shell endpoint.

The same core owns both platforms. Web selects a configured development/private
project root and retains authentication/exact-origin rules. Desktop uses named
folder capabilities and controlled lifecycle guards. CI/deployment updates code,
not the mutable project volume. Native file dialogs, path/locking behavior and
execution isolation require actual target-platform evidence.

Errors retain safe codes and bilingual presentation. Preserve three-second notices
and compact recovery after expiry. Failed save/migration/import, unsupported
format, stale base, binding loss and unavailable execution capability must not
produce a blank replacement workspace or silent data loss.

## 9. Acceptance contract

| ID       | Required observable result                                                                                                           | Owner         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| OPF-AC01 | Text-only project creates/opens without media runtime, AI settings or mandatory naming                                               | OP1, OP2      |
| OPF-AC02 | TS/Rust manifest contracts agree; strict core fields, preserved extensions and read-only future version                              | OP1           |
| OPF-AC03 | Traversal, escaping links, portable-path collisions and malformed identity reject without writes                                     | OP1, OP2      |
| OPF-AC04 | Unchanged Markdown is byte-stable; edited and unsupported regions round-trip without unrelated normalization                         | OP1, OP3      |
| OPF-AC05 | Marker/container proof preserves identity; duplicate/lost/ambiguous protected IDs cannot bypass locks                                | OP1, OP3      |
| OPF-AC06 | Promotion/crash failures expose a complete prior/new revision, never falsely saved mixed files                                       | OP2           |
| OPF-AC07 | Locks/comments/decisions/history survive reopen and loss of rebuildable caches                                                       | OP2           |
| OPF-AC08 | External edit, partial write, missed event and app-write echo reconcile without loss or duplicate history                            | OP3           |
| OPF-AC09 | Dirty local input plus external edit retains both sides; IME, caret and original receipt ownership remain stable                     | OP3           |
| OPF-AC10 | Scoped external changes have real diff, stale-base rejection, explicit acceptance and idempotent replay                              | OP4           |
| OPF-AC11 | Locked direct/shared dependency changes reject; management-file edits never update approval state                                    | OP4           |
| OPF-AC12 | Accepted batch is one operation; five-step history and existing S2/S3 decisions remain valid                                         | OP3, OP4      |
| OPF-AC13 | Legacy migration preserves IDs/metadata/objects, verifies backup and rolls back failure without rewriting old migrations             | OP5           |
| OPF-AC14 | Fixed-snapshot ZIP has referenced closure and no keys/cache/process state; corrupt/unsafe/over-budget ZIP cannot overwrite a project | OP5           |
| OPF-AC15 | Backup restore preserves review state; returned edit cannot replace it; copied jobs never redispatch                                 | OP5           |
| OPF-AC16 | Same open project works through Web and preload contracts; deployment preserves project data                                         | OP6           |
| OPF-AC17 | Small licensed Remotion fixture renders from a fresh exported directory using its own public dependencies                            | OP1, OP5, OP6 |
| OPF-AC18 | Unsupported/unisolated code execution is honestly unavailable; approved execution has actual boundary evidence                       | OP6           |
| OPF-AC19 | Safe localized errors/recovery retain input; no automatic inference, continuation or paid retry on open/import                       | OP2–OP6       |
| OPF-AC20 | Final full gates, migration/export/reopen scenario and actual platform/media evidence are recorded separately from unrun checks      | OP6, root     |

The document is a contract and plan, not acceptance evidence. An unresolved marker
codec, storage recovery mechanism or archive budget must be closed in the owning
stage before dependent implementation proceeds. Root reviews those decisions;
subagents do not silently redefine the format or product scope.
