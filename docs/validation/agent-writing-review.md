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
