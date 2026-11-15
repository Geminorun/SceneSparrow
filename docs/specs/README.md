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

| Document                                                         | Scope                                                                              | Status                                              |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| [S1: manuscript editing foundation](s1-manuscript-foundation.md) | Document model, persistence, editor, autosave, bounded history, sources and import | Editing/history implemented; sources/import pending |
| [S2: outline and initial draft](s2-outline-and-initial-draft.md) | Planning UI and manuscript-specific AI orchestration                               | Written; implementation pending                     |
| [Shared AI](shared-ai-integration.md)                            | Global settings, credentials, adapters, generic task execution and lifecycle       | Written; implementation pending                     |
| [S3: review and finalization](s3-review-and-finalization.md)     | Anchors, questions/notes, candidates, comparison, acceptance and locks             | Written; implementation pending                     |
| [S4: delivery and validation](s4-delivery-and-validation.md)     | Copy/export, desktop integration, recovery and complete-workflow acceptance        | Written; implementation pending                     |

S2 and S3 reference the [independent shared AI spec](shared-ai-integration.md) instead of duplicating provider,
credential or execution rules. Shared AI must remain usable without manuscript
models. The [shared AI technical design](../design/shared-ai-v0.1.md) explains the
architecture; the implementation spec fixes its ports, dispatch/recovery behavior
and acceptance cases. All four stage specs and shared AI are written; step 1
implements the manual S1 subset with [evidence](../validation/step-01.md), step 2
adds [bounded history](../validation/step-02.md), and
later implementation and complete-stage validation remain pending. Its migration ledger reserves the sequence
from bootstrap through S4.

Each stage spec includes scope, user behavior, domain/data rules, commands/events,
errors and recovery, ordered development tasks, and testable acceptance criteria.
Use stable stage-specific IDs such as `S1-AC01` and task IDs such as `S1-T01`.
Reference existing `SW-*`/`AI-*` acceptance cases where applicable and preserve the
distinction between a plan, implemented behavior, and actual validation evidence.

Specification prose does not replace executable JSON Schema contracts or migration
files. Those are introduced and checked with the implementation. Keep completed
specs aligned with the final behavior and record material deviations.
