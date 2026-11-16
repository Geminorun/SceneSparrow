# Script workbench design, v0.1

These documents specify the first usable **SceneSparrow / 幕雀** manuscript
workbench. They translate the product interview into an implementation plan.
They describe intended behavior. The repository now implements execution steps
1–8: manual editing/history, sources/import, shared AI, outline-to-draft generation,
anchored review/candidate decisions, production locks, derived finalization and
validated review rebinding, clean copy/exports and verified recovery. The
[step 8 report](../validation/step-08.md) and
[acceptance matrix](../validation/acceptance-matrix.md) retain performance and
platform gaps. The [execution workflow](../implementation-execution.md) and linked
validation reports record actual scope and limits; remaining design prose is not
proof of implementation or platform readiness.

The feature branch is `feat/script-workbench`, created directly from remote
`origin/main` at `ba71ffc48946dcf11c3401b4b7c67916009b288c` after bootstrap PR #1.

## Reading order

1. [Script workbench technical design](script-workbench-v0.1.md): product rules,
   editor behavior, domain models, persistence, commands, and recovery.
2. [Shared AI technical design](shared-ai-v0.1.md): application-wide configuration,
   provider adapters, task lifecycle, credentials, and business integration ports.
3. [Implementation and acceptance](implementation-and-acceptance-v0.1.md): four
   delivery slices, acceptance cases, performance experiments, and validation gates.
4. [Decision record](../decisions/0001-script-workbench-and-shared-ai.md): changes
   from the preliminary proposal and the reasons for the selected boundaries.
5. [Stage specifications](../specs/README.md): one spec per stage plus independent
   shared AI. [S1](../specs/s1-manuscript-foundation.md),
   [S2](../specs/s2-outline-and-initial-draft.md),
   [S3](../specs/s3-review-and-finalization.md), and
   [S4](../specs/s4-delivery-and-validation.md) supply concrete commands,
   persistence rules, ordered development tasks and acceptance cases.
6. [Shared AI implementation spec](../specs/shared-ai-integration.md): concrete
   settings/execution ports, secure credential lifecycle, one-dispatch invariant,
   recovery modes and the initial migration sequence shared with S1–S4.
7. [Remote diagnostics](remote-diagnostics-v0.1.md): private Web observability,
   response classification and temporary read-only support access. RD-1/RD-2 are
   implemented in source; see the [evidence and limits](../validation/remote-diagnostics.md).

The later [shared creator workbench](workspace-onboarding.md) follow-up replaces
the creation gate and locates global AI configuration under Settings while
preserving the manuscript stage boundaries.

## Authority and status

The user's interview decisions Q1–Q31 and subsequent corrections take precedence
over conflicting recommendations in the original v0.1 attachments. The user has
authorized the [eight-step implementation workflow](../implementation-execution.md),
including delegated implementation, root review and per-step commit/push.
Engineering choices below require implementation evidence. Follow the approved
sequence and confirmed product scope; a roadmap alone does not expand it.

Preserve the [original references](../reference/README.md) unchanged. In particular:

- Deliver the manuscript stage before audio/video production.
- Keep the local Rust core, shared browser/Electron UI, SQLite, and Node workers.
- Use one global AI configuration with text, audio, and video categories; implement
  text now. Video will use script/code generation and a separate render executor.
- Prioritize user-supplied OpenAI-compatible API access, replacing the preliminary
  preference for a Codex-specific first adapter.
- Keep internal revisions and provenance without a user-facing version manager.
- Derive manuscript finalization from paragraph locks; add no separate approval gate.
- Keep five project undo steps and one current review comparison, rather than an
  unbounded manuscript history.

The `SW-*` and `AI-*` acceptance IDs in this design are new. They are not aliases
for the differently numbered `REQ-v0.1:T*` and `DESIGN-v0.1:T*` cases.
