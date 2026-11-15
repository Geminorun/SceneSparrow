# Script workbench design, v0.1

These documents specify the first usable **SceneSparrow / 幕雀** manuscript
workbench. They translate the product interview into an implementation plan.
They describe planned behavior; the repository currently implements the bootstrap
integration samples only. This delivery adds documentation, not business code.

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

## Authority and status

The user's interview decisions Q1–Q31 and subsequent corrections take precedence
over conflicting recommendations in the original v0.1 attachments. The user has
authorized documenting this design and creating the feature branch. Engineering
choices below are proposed implementation decisions, not already tested features.
Implementation should follow explicit development instructions and the delivery
slices; the presence of a roadmap does not itself authorize developing everything.

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
