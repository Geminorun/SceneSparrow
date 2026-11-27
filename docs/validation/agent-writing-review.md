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
