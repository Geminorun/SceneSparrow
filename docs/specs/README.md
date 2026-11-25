# Implementation specifications

Organize implementation specifications as **one document per delivery stage** and
**one independent document for shared AI**. Keep each stage's behavior, contracts,
tasks, and acceptance cases together. Do not split every module into its own spec
or combine all stages into one growing document.

The [technical designs](../design/README.md) define the product and architectural
boundaries. These specs make the next implementation slice concrete. The user's
confirmed product decisions remain authoritative; a spec may refine engineering
details but must identify changes to confirmed behavior explicitly.
The [eight-step execution workflow](../implementation-execution.md) maps these
tasks to the approved implementation sequence and review/commit/push gates.

| Document                                                         | Scope                                                                              | Status                                                                      |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [S1: manuscript editing foundation](s1-manuscript-foundation.md) | Document model, persistence, editor, autosave, bounded history, sources and import | Core/browser implemented; native/performance acceptance open                |
| [S2: outline and initial draft](s2-outline-and-initial-draft.md) | Planning UI and manuscript-specific AI orchestration                               | Core/browser implemented; native/provider acceptance open                   |
| [Shared AI](shared-ai-integration.md)                            | Global settings, credentials, adapters, generic task execution and lifecycle       | Shared core and text consumers implemented; native/provider acceptance open |
| [S3: review and finalization](s3-review-and-finalization.md)     | Anchors, questions/notes, candidates, comparison, acceptance and locks             | Core/browser implemented; native/provider/performance acceptance open       |
| [S4: delivery and validation](s4-delivery-and-validation.md)     | Copy/export, desktop integration, recovery and complete-workflow acceptance        | Core/browser implemented; native/provider/performance acceptance open       |

S2 and S3 reference the [independent shared AI spec](shared-ai-integration.md) instead of duplicating provider,
credential or execution rules. Shared AI must remain usable without manuscript
models. The [shared AI technical design](../design/shared-ai-v0.1.md) explains the
architecture; the implementation spec fixes its ports, dispatch/recovery behavior
and acceptance cases. All four stage specs and shared AI are written; step 1
implements the manual S1 subset with [evidence](../validation/step-01.md), step 2
adds [bounded history](../validation/step-02.md), and
step 3 adds [sources/import and recovery](../validation/step-03.md). Step 4 adds
[shared AI foundations](../validation/step-04.md); step 5 connects
[planning and complete drafting](../validation/step-05.md). Step 6 adds
[anchored review and candidate decisions](../validation/step-06.md). Step 7 adds
[locks, finalization and validated replay](../validation/step-07.md). Native, provider and
performance acceptance remains open. Step 8 adds
[delivery and verified recovery](../validation/step-08.md), with all 130 cases
tracked in the [acceptance matrix](../validation/acceptance-matrix.md).
The shared migration ledger records the applied sequence through S4.

Each stage spec includes scope, user behavior, domain/data rules, commands/events,
errors and recovery, ordered development tasks, and testable acceptance criteria.
Use stable stage-specific IDs such as `S1-AC01` and task IDs such as `S1-T01`.
Reference existing `SW-*`/`AI-*` acceptance cases where applicable and preserve the
distinction between a plan, implemented behavior, and actual validation evidence.

Specification prose does not replace executable JSON Schema contracts or migration
files. Those are introduced and checked with the implementation. Keep completed
specs aligned with the final behavior and record material deviations.

The [Markdown file project](markdown-file-project.md) documents the implemented
Web validation slice for file-backed manuscript creation, clean Markdown import,
save, reopen, and export. The [file-first Web writing workspace](web-file-workspace.md)
spec covers the next release slice for the default editor, session-only AI
writing, and external agent handoff.

The [Markdown workspace and protected agent handoff](markdown-agent-workspace.md)
spec covers restoring the established workbench over the file APIs and proposes
block-level protection as a follow-up.

The proposed [Markdown outline and shared document review](markdown-outline-review.md)
spec adds a saved outline, shared locks and comments, and document-level Agent ZIP
review to the Web workspace.
