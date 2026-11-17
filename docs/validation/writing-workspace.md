# Writing workspace validation

Date: 2026-11-17. Branch: `feat/writing-workspace`, based on
`release/1.0.0` at `cefe535`. Scope: [WW-01–WW-07](../design/writing-workspace.md).
Root reviewed sequential implementation slices before committing and pushing.

## Implemented behavior

- WW-01: a constant saved-key mask and explicit replacement/delete, a dedicated
  masked non-login token entry, and direct saved-service rows instead of a Manage
  dialog. Existing provider IDs, models, bindings and ambiguous-write handling remain.
- WW-02: startup and failed reads retain stable workbench geometry with accessible
  loading placeholders and an owned top-layer retry, without creating replacement data.
- WW-03: persistent localized error notices with owner-scoped recovery/settings
  actions; successful messages may expire. Passive refreshes cannot remove richer
  actions. Save status is compact; recovery decisions remain explicit dialogs.
- WW-04: distinct provider-token and application-size failures. New model entries
  use 8192 output tokens, clamped to known limits. Saved budgets remain unchanged.
  Planning prompt v2 uses interpreter v1; compatible saved v1 results remain usable.
- WW-05: mounted central Outline/Manuscript views share one planning owner and one
  serialized project queue. Outlines retain heading identities, key points and
  subtree order. Invalid Markdown remains recoverable locally and fences saves and
  dependent dispatch; unfinished typing does not produce a tip for each character.
  View restoration and ordinary refresh cannot replace in-progress manual writing.
- WW-06: the right pane is AI assistant/Comments, with compact brief/preferences,
  selected-reference and model-setting context, one primary stage action and an
  explicit route from an adjusted outline to drafting. Ask/Revise uses anchored
  scope and explicit candidate acceptance. Activity is compact; retained planning
  results/provenance, full comparisons and follow-ups remain deliberately accessible.
  Retired planning cards, raw task dashboard and prepared-context form are removed.

## Final root checks

| Check                                         | Result                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm check`                                  | Passed: contracts, formatting, workspace types, 257 Node tests, 195 Rust tests and Clippy |
| `pnpm build`                                  | Passed: shared Web, desktop and Rust builds; existing large-bundle warning remains        |
| `pnpm test:integration`                       | 12/12 passed                                                                              |
| Browser suite plus affected correction reruns | All 78 active cases passed across runs; three opt-in performance cases skipped            |
| Markdown relative links and staged whitespace | Passed                                                                                    |

The initial full browser run recorded 66 passes, five failures, three opt-in skips
and seven unrun cases after a serial-group failure. It exposed the retired
4096-token new-model expectation, the renamed recovery button, old inline-export
error expectations and missing owned export/unknown-save feedback. After correcting
those paths, the entire affected manuscript group passed 12/12, delivery passed 3/3,
and the new-default settings case passed 1/1. The expanded unsent-review
recovery/cancellation case also passed 1/1. Thus every active case has successful
local evidence; this report does not call the initial full command successful.
The final `pnpm check`, build and 12 HTTP integrations were rerun after the source
corrections. The PR's Foundation check independently reruns the full final source.

The first CI browser run exposed a fixture dispatching composition events before
the asynchronously selected Outline became visible, and a persistent notice
covering a header recovery control under the runner's font metrics. The fixture
now waits for the visible surface before composition; body-level notices start
below the workspace chrome, while native-dialog notices retain their top-layer
placement. Conflict recovery asserts that the notice lies below the header controls.
Correction checks passed: the IME case 1/1, notification cases 4/4 and the entire
manuscript serial group 12/12.

All Rust commands used `CARGO_PROFILE_DEV_DEBUG=0` and
`CARGO_PROFILE_TEST_DEBUG=0` in this managed environment. Browser tests used
`/usr/bin/chromium`. The CI check applies to the PR merge commit independently.

## Behavioral evidence

`tests/integration/writing-output-limits.test.mjs` persists a complete initial
manuscript containing exactly 2000 Han characters under an 8192-token setting in
one successful counted SDK request. Token and response-size failures each make
one request, apply no partial body/history change, release their reservation and
never redispatch after restart. Total requests: three. Reopen, stable identities,
monotonic Undo/Redo revisions, provenance and duplicate receipts are asserted.

`tests/e2e/planning.spec.ts` exercises central generation, manual outline editing,
AI adjustment, one complete approximately 2000-character Chinese draft, retained
outline/view restoration, selected-text questions, revision preview and acceptance.
Six counted local-provider requests cover the three planning operations, scoped
question/revision and explicit whole-manuscript question. Accepted StartPlanningTask/readback and SaveReview/version-read
failures require explicit recovery without duplicate starts, threads or inference.
No generation call is repeated by refresh.

`tests/e2e/writing-workspace.spec.ts`, existing save/history/reference/review suites
and the new codec/range/controller unit cases cover incomplete/unsupported source,
invalid-buffer fencing, copy/discard recovery, stable pasted/reordered identities,
five Undo/Redo transitions, IME and late acknowledgments, delayed planning startup,
selection defaults, explicit whole scope and rejection above 100 blocks without
creating a review thread or starting inference. Existing reference consent and
production locks remain enforced. Unsent drafts recover to their original
assistant/Comments composer from Outline; explicit Cancel clears the local comment
without a saved review or hidden history guard.

`tests/e2e/zz-delivery.spec.ts` verifies localized top-layer export/clipboard
feedback, clearing recovered notices, original Cancel/Retry identities and
unknown native-save receipt recovery against a simulated preload bridge. The
same immutable artifact is retained; selecting a new destination creates a new
explicit delivery intent. This is not native OS delivery acceptance.

Settings/startup/notification browser cases cover masked first paint and paste,
saved-key readback without plaintext, direct legacy services, nested-dialog focus,
persistent owned actions, read retry, rename/save conflicts and localized errors.
A read-only implementation audit and root review found and corrected accepted
SaveReview readback recovery and retained Comments-layout positioning in Assistant.

## Screenshots

- [writing-outline-zh-desktop.png](assets/writing-outline-zh-desktop.png)
- [writing-manuscript-en-desktop.png](assets/writing-manuscript-en-desktop.png)
- [writing-assistant-zh-narrow.png](assets/writing-assistant-zh-narrow.png)
- [writing-manuscript-zh-narrow.png](assets/writing-manuscript-zh-narrow.png)
- [api-token-saved-zh-narrow.png](assets/api-token-saved-zh-narrow.png)
- [workspace-startup-skeleton.png](assets/workspace-startup-skeleton.png)

These images use synthetic local fixtures and contain no real credentials.

## Limits

- All provider evidence comes from counted local HTTP fixtures; real OpenAI,
  DeepSeek and compatible proxy behavior remains a separate acceptance task.
- Headless Chromium establishes input type, masking and interaction behavior,
  not every native password manager or extension's prompt heuristics. Unsupported
  text-security browsers retain a masked password fallback.
- Native Windows/macOS packaging, keyrings, input methods and window lifecycle
  were not exercised. Existing worker RSS and large-document performance gaps remain.
- The outline codec supports heading depths 0–3 and key-point bullets. Unsupported
  syntax is retained as an unsaved local buffer, not silently converted. Browser
  crashes can still lose unacknowledged input. View/save preferences are local to
  the browser/Electron profile, not synchronized between devices.
- No database migration, dependency, protocol-schema, deployment workflow, live
  publication or user-data conversion is introduced. No merge or deployment ran.
