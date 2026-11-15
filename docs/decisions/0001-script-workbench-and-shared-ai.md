# ADR 0001: Prioritize the script workbench and share AI execution

Status: accepted product direction; detailed engineering design proposed for
implementation. This record documents the user's interview decisions and the
authorized documentation phase. It does not claim deployed functionality.

## Context

The [original v0.1 references](../reference/README.md) describe the complete
manuscript-to-video application. The repository's bootstrap validates process,
protocol and storage boundaries, but is not a production workflow implementation.
The user has chosen a smaller first outcome: a usable manuscript workbench, with
audio/video work deferred and reusable AI access designed from the start.

The interview also replaced several provisional assumptions: paragraph locks
determine finalization, users see one current manuscript and latest comparison,
undo/redo is bounded to five project steps, and providers use user-supplied keys.
The user authorized a feature branch from the latest remote `main` and detailed
technical documentation before business implementation.

## Decisions

1. Deliver outline planning, complete initial drafting, direct editing, two review
   actions, comparison/acceptance, paragraph locking, persistent bounded history,
   and manuscript export before media production.
2. Keep outline and draft interactions distinct. No paragraph comments, comparison
   controls or locks appear in planning. After generation, headings in the current
   manuscript own its structure; there is no independently edited outline to sync.
3. Derive finalization from all content blocks being locked. Acceptance applies an
   AI modification but does not lock it. Pending modifications must be handled
   before locking their targets; ordinary comments may remain unresolved.
4. Keep stable IDs, monotonic revisions and exact task/artifact provenance without
   a visible version browser. Retain one current review comparison and a linear
   five-transition undo history; retain additional immutable inputs only while
   current state, history, review/tasks or downstream artifacts reference them.
5. Reuse one global AI configuration with text, audio and video categories. Text
   includes planning, prose and review. Audio and video are distinct future bindings;
   video script generation is separate from rendering.
6. Make generic AI execution independent of script models and UI. Business use
   cases own prompts, context, patch scope, validation and acceptance. Adapters
   normalize provider transport, not business approval rules.
7. Implement an OpenAI-compatible first adapter, informed by the BiliNote reference.
   Do not require Python, a Codex-specific provider or vendor-native protocols for
   the first text workflow. Credentials use platform storage, not project files.
8. Freeze configuration and inputs at task start. Failure waits for user action;
   no automatic provider/model switching, paid retries, or silent parameter-repair
   requests. Restart recovery does not resubmit ambiguous in-flight calls.
9. Retain the local Rust modular core, SQLite, shared React/Electron clients and
   separate Node workers. Add no multitenant system or independently deployed AI
   service. User source links do not imply a generic web crawler.

## Consequences and alternatives

The original video-centered M0–M3 sequence remains historical reference, not the
current work order. Use the four manuscript slices in the
[implementation plan](../design/implementation-and-acceptance-v0.1.md).

A single provider implementation inside the script editor would be quick to wire,
but would duplicate settings/secrets/task behavior for later media workflows. The
shared runtime adds an explicit contract now while keeping media schemas deferred.
An all-purpose agent framework is unnecessary for the initial scoped text tasks.

Full unbounded revisions or user-managed branches would add storage and interface
complexity contrary to the selected product behavior. Bounded business snapshots
are simpler to recover and test. References held by media/task provenance are a
different retention requirement and cannot be deleted merely because undo is full.

Automatic retries/fallbacks can improve availability but would obscure the selected
model and spending. Fail visibly and offer explicit retry with the current global
settings. A retry is a new immutable run linked to its predecessor.

No new "final approve" button is needed beyond locking; the UI cannot drift between
an approval boolean and actual paragraph state. All mutation paths, including undo,
must still pass domain validation. UI-only locks are insufficient.

## Follow-up specifications

- [Script workbench](../design/script-workbench-v0.1.md)
- [Shared AI](../design/shared-ai-v0.1.md)
- [Shared AI implementation and stage integration](../specs/shared-ai-integration.md)
- [Implementation and acceptance](../design/implementation-and-acceptance-v0.1.md)

Keep original DOCX files unchanged. Update these designs when implementation
evidence requires an engineering change; explicitly review changes to confirmed
product behavior.
