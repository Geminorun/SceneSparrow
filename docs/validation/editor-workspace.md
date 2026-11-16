# Editor-first workspace validation

This report tracks the confirmed [EW-01–12 requirements](../design/editor-workspace.md)
on `feat/editor-workspace`, based on release `0567f24`. The private diagnostics
delivery is retained. Platform/provider/performance acceptance remains separate.

## Core and command foundation

The first actual canonical document edit atomically transitions an empty Outline
project to Draft in the same history entry and receipt. Empty/no-op edits do not
change stage or create history. Undo/Redo and reopen retain stable block identity
and monotonic revision tokens. Autosave adopts the acknowledged stage without
replacing later local text or composition state.

Planning saves and outline generation/adjustment work alongside a Draft. Initial
draft generation retains operation-specific Outline eligibility at prepare, start
and result application; late results cannot replace subsequent manual writing.
Blank outline headings may be saved as partial inputs, but generation/output
validation still requires complete headings. Existing language tags remain valid.

Implementation-agent checks passed on Linux with `scripts/cloud-env.sh` and
`CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0`:

- Domain and infrastructure libraries: 12 + 160 tests passed; an additional late
  initial-result safety test passed separately (infrastructure now has 161 tests).
- Autosave Node suite: 45 passed, including first-edit acknowledgement during
  later IME input and resolution of an ambiguous first receipt.
- Counted actual-SDK planning integration: one test passed with eight explicit
  provider calls. Draft planning saves/results preserved body, review, locks,
  approved baseline and finalized state, allowing expected working revisions to
  advance. Reopen preserved the same state.
- Service build, generated-contract checks, editor UI TypeScript, scoped formatting
  and whitespace checks passed. No protocol or storage migration was required.

Root reviewed the actual command/domain/controller changes and independently ran
the first-edit storage tests, first-edit autosave cases and contract checks before
committing this slice. Shared layout/input recovery and final integrated evidence
will be added as their implementation is reviewed.
