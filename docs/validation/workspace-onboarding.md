# Shared workbench onboarding validation

Scope: shared renderer follow-up on `feat/workspace-onboarding`, based on desktop
handoff `77104a0` and metadata backend `23657ec`. This report records Linux Chromium
checks on 2026-11-16, not native Windows/macOS or live-provider acceptance.

## Implemented behavior

The workbench reads an existing project or atomically ensures one localized default
project without a naming gate. Manual drafting remains explicit. Rename preserves
identity, content and history, retains ambiguous request identity, handles stale
names without losing the proposed title, and cannot reduce a concurrent manuscript
revision. A local metadata epoch fences old title reads after successful rename.

The gear opens Settings with General and AI & models. AI configuration loads only
on activation, advanced declarations start collapsed, and dismissal clears unsaved
keys while retaining unknown inference actions. A new explicit inference test clears
the previous receipt; resolving its submitted action retains the same identity and
makes no additional inference call. All templates use OpenAI-compatible Chat
Completions. Existing manual entry/discovery failure, bilingual and quota assertions
remain covered.

Manuscript and planning buffers stay mounted through settings, rename and locale
changes. Native dialogs contain keyboard focus and restore their trigger on close;
modal shortcuts do not invoke project history. The existing manuscript close
subscription dismisses shell dialogs before showing the original recovery decision.
Desktop recents render titles safely and pass opaque IDs back to the host; cancelled
or failed opening leaves the current editor intact.

## Browser evidence

The new workspace tests use a fresh isolated real core per case, including the
second-tab bootstrap case. The original planning/review isolated fixtures and
manuscript/export bridge fixtures use the new entry commands. Shared helpers locate
the workbench, explicit manual start and Settings by stable landmarks rather than
a fixed project title or the removed creation form.

| Follow-up case                  | Evidence                                                                                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WB-01: fresh entry and retry    | Real empty storage, two tabs share one ID, reload persists it; read failure creates nothing; ambiguous ensure reuses the command; Chinese initial title persists through locale change                                   |
| WB-02: metadata safety          | Unicode rename leaves manuscript/history unchanged; delayed rename response preserves newer autosave revision; ambiguous rename reuses identity; stale CAS preserves input; held old GET cannot restore an earlier title |
| WB-03: local editing and modals | Same editor DOM/local text survives held failed save and Settings; planning input survives failed save, settings, rename and locale; Tab/Escape/trigger focus; saved-project undo excluded from modal buttons            |
| WB-04: AI action identity       | Original counted fixture makes exactly two inference calls; separate same-profile fixture makes two explicit calls and resolves a lost second response after dismissal without a third call or stale success             |
| WB-05: desktop composition      | Fake native bridge with real core: safe recent title/opaque locator, cancelled picker/failed switch retain editor; existing close-recovery test now opens Settings before the native close request                       |
| WB-06: responsive workbench     | 375/768/1200 widths have no horizontal page overflow; 100+ character title remains one line; screenshots wait for visible paragraph locks                                                                                |

These cases preserve the relevant S1-AC05/06/08/12 and SAI-AC03/05 boundaries.
They supplement existing review/finalization/export acceptance; they do not close
native-host, real-provider or performance gaps from the stage acceptance matrix.

## Commands and outcomes

All commands sourced `scripts/cloud-env.sh`. Browser service builds used
`CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0` with system Chromium.

| Command/check                                                                   | Actual result                                                                                                             |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:e2e` before final receipt correction/additional same-profile case    | 32 passed, 3 explicitly skipped performance cases (35 total)                                                              |
| Later full 36-case attempt                                                      | 32 passed, 3 skipped, 1 new test locator failure before inference; corrected `Authentication` lookup to its combobox role |
| Final `pnpm test:e2e tests/e2e/ai-settings.spec.ts tests/e2e/workspace.spec.ts` | 11 passed, including same-profile receipt recovery and held old metadata GET                                              |
| `pnpm typecheck` after product corrections                                      | Passed all workspace TypeScript projects                                                                                  |
| `node --test tests/unit/locales.test.mjs`                                       | 1 passed; English/Chinese keys and nonempty strings match                                                                 |
| Changed-file `pnpm exec prettier --check ...` and `git diff --check`            | Passed; validation note formatting checked separately after writing                                                       |

The final full suite is left for root's integrated review after its separate
existing-project-open race correction. No full Cargo/integration suite, performance
benchmark, native desktop flow or real-provider inference was run in this UI slice.

Screenshots remain ignored local artifacts:

- `.artifacts/workbench-normal.png` and `workbench-narrow.png`: initial planning.
- `.artifacts/workbench-draft-1200.png`, `workbench-draft-768.png` and
  `workbench-draft-375.png`: long-title manuscript, review and paragraph locks.
- `.artifacts/workbench-settings.png`: Settings over a retained local-save failure.

## Migration and rollback

This renderer change adds no migration. Its metadata commands depend on the already
appended `010_project_metadata.sql`, which retains rename receipts for project
lifetime. Applied migrations 001–010 remain immutable. A schema-9 binary cannot be
used as a supported downgrade path for a migrated schema-10 project.

Before a binary rollback, preserve the current project and a verified backup.
Restore a verified pre-migration-010 snapshot with the matching older binary;
changes made after that snapshot are absent there and must remain preserved in the
current copy. Do not delete rename receipts, lower the schema ledger or copy a live
SQLite main file as a rollback shortcut. Global AI settings/credential storage stays
outside project backups and keeps its existing schema and recovery rules.
