# Unified Agent writing validation

[Implementation specification](../specs/agent-writing-review.md) ·
[PR #32](https://github.com/Geminorun/SceneSparrow/pull/32)

## Phase 1 — Shared Markdown editor

The phase starts from `1a33832` and covers AWR-T01, AWR-AC01–02, and the
editor portion of AWR-AC12. An outline with a thematic break, bilingual
headings, and nested emphasis stays in the shared visual editor, and
editing one passage preserves the original Markdown around it. Locks use
the same right-hand gutter in both documents. Users can add, reopen, edit,
and resolve a comment at its anchor. Ask attaches an explicit selection and
focuses the composer.

Ponytail Review followed the projection, gutter, comment persistence,
composer attachment, and affected browser callers. Review corrections
reused the existing source mapping, fenced stale comment actions, kept the
selection toolbar reachable before gutter controls, and preserved focus
through Chinese input composition. The browser fixtures verify that a
late acknowledgment preserves a newer comment draft.

Verification used the generated contract check, editor typecheck, Rust
annotation tests (5), source projection tests (6), affected EWA and MOR
browser regressions (8), and four AWR browser cases. The AWR
cases cover both requested widths and simulated composition and delayed
network acknowledgments. Native desktop and an OS input method were
outside this Web validation.

- [Outline and open comment at 1280 × 720](assets/awr-outline-comment-1280.png)
- [Outline and open comment at 960 × 720](assets/awr-outline-comment-960.png)

## Phase 2 — Agent pane and conversation history

The phase starts from `e682b56` and covers AWR-T02, AWR-AC03–05, and the
conversation and provider settings portions of AWR-AC12. The project Agent
pane shows searchable history, generated outlines and drafts in conversation
order, and the active document context. Reopening uses the saved conversation
to restore the transcript and send context to a new runner session. The
settings view groups connection, model, and credential controls for the
selected provider.

Ponytail Review followed the file reads, accepted sends, cancel and switch
boundaries, source comments, and generation callers. Review corrections
bounded history listings, used direct reads of selected conversations,
reconciled generation results with the originating project, and fenced late
Create and Stop acknowledgments. History files retain interrupted
instructions and settled Apply and Discard outcomes. Recovery for an
interruption between the Markdown write and its outcome belongs to AWR-AC07.

The generated contract check, TypeScript checks, scoped Clippy, and
format checks passed. The service suite (7), application tests (4), and
infrastructure restart test passed. Fourteen browser tests passed in the
independent AWR and Web smoke run. They exercised project
switching, refresh, search and rename, generation order, the writing
fallback, and the provider detail. Hosted inference and native desktop
operation remain separate from this Web validation.

- [Agent history at 1280 × 720](assets/awr-agent-history-1280.png)
- [Agent history at 960 × 720](assets/awr-agent-history-960.png)
- [Provider settings at 1280 × 720](assets/awr-provider-settings-1280.png)

## Phase 3 — One revision from pending comments

The phase starts from `4203871` and covers AWR-T03, AWR-AC06–07, and the
batch preview portion of AWR-AC12. Ordinary document sends capture the saved
Markdown, open comment records and resolved ranges, and live locks. The core
groups overlapping anchors into stable scopes before sending the full document
to the writing runner. Questions produce answers; edit instructions can produce
one grouped proposal. Locked, detached, and omitted unclear scopes remain
unresolved. The existing explicit selection API, direct writing fallback,
generated outline flow, and collaboration ZIP allowlist remain in place.

The conversation shows captured document/comment context, one applicable and
unresolved summary, a primary Apply action, secondary Discard, and expandable
Original/Proposed comparisons linked to their notes and source passages. The
proposal keeps its original project/document identity across navigation. Apply
rechecks original bytes, saved revision, affected comment snapshots and current
locks under the existing writer mutex, performs one Markdown save, and resolves
only the comments attached to saved changes.

A proposal-specific receipt records the exact target before that save. A retry
or restart can complete pending comment resolution without another Markdown
write and restore an applied disposition after a lost conversation
acknowledgement. A completed proposal is persisted before entering the writer.
Transient storage failures allow an explicit retry with the same proposal;
conflicts retain the preview and require a fresh turn. Receipt files stay in
application-managed project storage and are excluded from collaboration ZIPs.

Ponytail Full and Ponytail Review followed the generated contracts, both native
adapters, conversation persistence, annotation snapshots, writer, and browser
callers. Corrections fenced undurable proposals, restored landed outcomes before
Discard, cleared a recovered Apply error, and retained the existing question
path while an unrelated selection Apply acknowledgement is pending and no open
notes or unsaved edits require a new saved capture. Scope stays within the
existing single-operator Web workspace and its bounded runner context/output.

Focused verification passed.

- Generated contract consistency, editor TypeScript checks, touched-file
  Prettier checks, Rust formatting, and scoped Clippy with warnings denied.
- Application Agent tests, infrastructure conversation/batch tests, both native
  socket fixture suites, and the Agent HTTP suite. Cases cover two edits plus
  one locked note in each document, overlapping and detached anchors, unclear
  scopes/questions, unknown scope rejection, stale text/locks/comment records,
  transient write retry, duplicate Apply, Discard, and restart between the
  Markdown commit and its acknowledgements.
- Nine external-Agent JavaScript unit tests, including exact UTF-8 grouped
  patches with BOM and CRLF preservation.
- All 24 conversation and external-Agent browser cases passed on the final UI.
  The focused rerun covered batch preview and the pending-Apply question regression.

The bilingual captures show the locked passage, the unresolved note, and the
visible composer. The browser fixture supplies deterministic proposals. The Rust
HTTP tests exercise the actual writer. Hosted inference and native desktop
operation remain separate from this Web validation.

- [Batch summary at 1280 × 720](assets/awr-batch-summary-1280.png)
- [Expanded comparison at 960 × 720](assets/awr-batch-preview-960.png)

## Phase 4 — Read-only selected-text research

The phase starts from `bc21655` and covers AWR-T04 and AWR-AC08–09. Ask
attaches the captured quote and waits for a question. Product sends carry an
explicit research marker; older explicit selection consumers retain the
protected proposal API. Research uses the existing session, turn, event,
cancellation and durable conversation boundaries. It supplies only the captured
quote and retrieved evidence as the current writing input, disables proposals
at both the application and Markdown writer boundaries, and leaves document and
review sidecars unchanged.

The file-backed project reads small documented `references/*.md` / `*.txt`
inputs first, with bounded lexical matching for English and Chinese. When those
sources are insufficient, the application supervises a dependency-free Node
fetch adapter against one operator-configured HTTPS search endpoint (loopback
HTTP for local adapters/tests). It supports SearXNG JSON and the documented
`sources` response. The public query contains only bounded portions of the
explicit selection and question. Redirects, unsafe URLs, oversized responses,
and unbounded waits are rejected. See [research sources](../research-sources.md)
for exact limits, source-file placement, endpoint configuration and supported
response shapes. The Web supervisor and Compose service forward the setting
without giving the writing runner a network or file tool.

Source titles, validated links or project reference IDs, excerpts, retrieval
outcome, original question, and quote are saved on the originating turn before
answer generation. The conversation displays these actual source records beside
the answer and restores them from history. Missing, partial, empty, cancelled,
and unavailable outcomes remain visible. Failed answers retain retrieved
sources. Explicit retries keep the original quote while its document revision
remains valid. A failed source readback preserves the settled answer and points
to reopening the saved conversation.

Ponytail Full and implementation Ponytail Review followed the generated
contracts, both native text-only adapters, bounded retrieval, writer denials,
conversation restoration, source links and affected fixtures. Corrections bounded
large-selection matching, preserved excerpt offsets when Unicode lowercasing
expands characters, kept valid SearXNG neighbors beside malformed rows, and used
the contract generator's existing indirect-snapshot rule to keep protocol unions
small. The root review also traced the project scope and the distinction
between research and the existing write-capable paths.

Focused verification passed.

- Six application Agent tests, including rejection of research without a quote
  and of all edit-shaped outputs.
- Six infrastructure retrieval tests used real local HTTP and supervised Node
  fetch. They cover Chinese project references first, a question grounded by
  its selected claim, actual source metadata, durable reopen,
  unavailable/lost/empty/partial responses, answer failure, and cancellation.
  Bounded matching and case-expanding Unicode have a focused regression.
- Both native socket research fixtures verify supplied evidence, plain-text
  answers, and the existing writing-only policy. The eight existing Agent HTTP
  tests preserve the explicit selection, batch, cancellation and restart paths.
- Seven search-adapter HTTP tests exercise both response formats, invalid
  endpoints, unsafe links, Unicode limits, malformed rows, redirects, response
  limits, lost/unavailable responses and request abort. Existing JavaScript Agent
  and Web-supervisor checks pass, including forwarding the configured endpoint.
- All 26 Agent/conversation browser cases passed. The two research cases passed
  again with sources initially pending and loaded from the settled conversation.
  They verify question-before-send, citations after refresh/history navigation,
  unchanged Markdown/open comments, and cancelled/unavailable retry context.
- Generated contract consistency, editor TypeScript, scoped Clippy with warnings
  denied, touched-file formatting and Rust formatting.

These checks use deterministic Agent and search fixtures. Hosted inference,
live public search, and native desktop operation remain separate from this Web
validation. The capability provides evidence excerpts from the configured sources.

## Phase 5 — Exportable Remotion project and native skill capability

Implementation starts from `1ff5cc5` and covers AWR-T05 / AWR-AC10–11. The Web
workspace opens a project-scoped Video project dialog with the installed official
skill name/version, ordinary Agent requests, a four-field composition comparison,
Apply/Discard, ZIP export, and an accepted playable render. English and Simplified
Chinese strings use the shared catalog. [Runtime and reproduction guide](../video-projects.md)

The official Remotion skill `4.0.547` is prepared from pinned upstream revision
`a3f4098a2afd0e13f6a6f8c8760e275f75457ea9` with verified archive SHA-256.
All 133 package files are installed in the created project and
exported under `.agents/skills/remotion-best-practices/`. Official DeepSeek
`dsh-skill-filesystem` and `dsh-tool-skill` `0.2.2-rc.5` perform staged native
loading with only that project's explicit skill root and a contained bundled
reference. The capability supplies that context through the existing text Agent
transport. Writing-runner tools and policy remain unchanged.

The bounded fixture changes `composition.json` data rather than generated code.
The core owns request identities, pending proposals, stale checks and atomic
adoption of complete immutable project snapshots. Reopen retains settled results;
interrupted in-flight requests are visibly failed without another inference call.
Native snapshot/render work releases the Markdown writer lock. Supervision limits
wall time, heap, worker RSS, protocol/output and artifact sizes and cleans the
process group. The trusted shipped TypeScript composition consumes only accepted
validated props. Collaboration writing ZIPs keep their existing safe allowlist.

Focused verification passed.

- Generated contract consistency, complete TypeScript checks, repository Prettier
  check and service/all-target Clippy with warnings denied. The root ran the
  workspace-wide `pnpm check` and verified the final supervisor correction
  against its focused test.
- All 313 Node unit tests pass, including the unchanged DeepSeek writing policy.
  The eight existing Agent HTTP tests and six native DeepSeek adapter tests also
  pass. Two Node video tests verify the bounded data capability, exact preservation of
  every official file, official native skill-tool loading and bundled reference,
  and refusal of symlinked resources.
- Three infrastructure tests cover durable request/review/adoption, repeated
  dispatch/Apply receipts, unchanged Markdown, stale preview retention, interrupted
  request recovery and parent symlink denial. The actual exported ZIP is extracted
  and loaded by the official native capability from its new location.
- The explicit native adopted-project render fixture passed with installed
  Chromium. `ffprobe` measured H264, 640 × 360, 60 frames and two seconds; `ffmpeg`
  decoded the entire video without errors. A local Chromium playback of that
  adopted MP4 advanced to 0.421 seconds with duration 2 seconds and no media error;
  frames 0 and 45 show the requested leftward motion and bilingual title. The
  fixture is ordinarily ignored so
  environments without a rendering browser do not claim native render evidence.
- Two Web browser tests passed. They cover actual project creation, export,
  and supervised MP4 playback (time advances beyond 0.2 seconds at width 640), plus a deterministic
  normal-request composition diff/adoption fixture preserving newer composer
  input. The root smoke run independently passed both cases among its 14 tests.
- The phase 4 research worker was moved under the existing document package to
  repair the release-version check without adding a package or lock importer.
  The ten release/research unit checks passed after the move.

Ponytail Review traced archive integrity, filesystem containment, the Markdown
writer boundary, and renderer configuration. The Web supervisor now passes the
explicit Chromium path through its core environment allowlist, covered by the
supervisor test. `docker buildx build --call=check --progress=plain .` passed
without warnings. The Web Docker image build and launch, hosted inference, and
Windows/macOS packaging remain unverified. The video capability uses the official
native skill components with the existing text transport.

- [Web playback and installed Remotion skill](assets/awr-video-playback.png)
