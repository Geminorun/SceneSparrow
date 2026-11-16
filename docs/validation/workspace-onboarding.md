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

The final integrated results, including the separate existing-project-open race
correction, are recorded below. No performance benchmark, native desktop flow or
real-provider inference was run in this UI slice.

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

## Existing-project open correction

Root review identified a gap between desktop preflight and the actual child-process
SQLite open: removing a remembered database during that interval could let ordinary
create/open initialization produce an empty replacement. The correction adds a shared
repository `open_existing` path and validated service environment mode
`SCENESPARROW_PROJECT_OPEN_MODE=existing|create`. Existing mode creates no project
root, uses SQLite read/write without `SQLITE_OPEN_CREATE`, and refuses schema zero
before WAL setup or migrations. Supported legacy migrations still use the same
implementation and verified backups. Unset mode retains Web/development CLI behavior.

Desktop explicitly selects existing mode for remembered, picked, recovered and
rollback activation. Only unremembered missing/empty default or explicit-override
folders initialize in create mode; an empty existing folder does not require a
second directory creation. Once recorded, a missing database cannot become a new
initialization on retry. This changes no protocol or applied migration.

Focused evidence on the final correction tree:

- `cargo test --locked -p scenesparrow-infrastructure existing_open -- --nocapture`:
  2 passed; missing directory/database refusal, exact zero-schema byte preservation,
  and valid schema-1 migration with stable project identity and backup.
- `cargo build --locked -p scenesparrow-service` and
  `node --test tests/integration/project-open-mode.test.mjs`: build passed,
  3 integration tests passed. A real service inspected a valid project before its
  database/directory was deleted or moved; existing-mode child startup failed
  without replacement data. Also verified zero-byte refusal, invalid-mode rejection,
  unset/create compatibility and successful existing-mode identity restore.
- `node --import tsx --test tests/unit/project-registry.test.mjs tests/unit/desktop-projects.test.mjs`:
  18 passed; includes explicit spawn-mode assertions for restore/recent/rollback and
  recovery, initial empty-folder create compatibility, and existing mode after a
  database disappears during inspection.
- Desktop TypeScript and scoped Prettier/Rust format checks passed; `git diff --check`
  passed. Commands sourced `scripts/cloud-env.sh`; Rust checks used
  `CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0`.

This supplements S4-T09/T10 and S4-AC18/20/21/22 safeguards. Native Windows/macOS
filesystem/dialog behavior remains unverified; these Linux tests do not close that
platform acceptance gap.

## Final integrated review

Root independently reviewed the implementation and screenshots, requested the
existing-only open correction, and verified the combined tree on 2026-11-16. All
commands sourced `scripts/cloud-env.sh` and used `CARGO_PROFILE_DEV_DEBUG=0` and
`CARGO_PROFILE_TEST_DEBUG=0` with system Chromium.

| Command                 | Result                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `pnpm check`            | Passed: contracts, formatting, TypeScript, 128 Node tests, 168 Rust tests, and Clippy |
| `pnpm build`            | Passed: shared Web renderer, Electron main/preload, and Rust workspace                |
| `pnpm test:integration` | 10 passed, including real-process restart and existing-only open refusal              |
| `pnpm test:e2e`         | 33 passed; three opt-in performance benchmarks skipped                                |

The build retains Vite's non-blocking large-chunk warning. Screenshots cover the
initial planning workspace, Settings, and draft/review/paragraph-lock layouts at
375, 768 and 1200 pixels, including long titles. No native Windows/macOS launch,
packaging/signing, live-provider inference or cross-device synchronization was
validated or introduced by this change.
