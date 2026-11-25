# External writing Agent validation

[Specification](../specs/external-writing-agent.md) · [PR #30](https://github.com/Geminorun/SceneSparrow/pull/30)

## EWA-T01 — Sessions and protected selection writes

The authenticated Web routes bind each turn to a project and a captured
document. Selection turns carry the saved revision, UTF-8 byte range, source
digest and exact quote. The stored proposal owns the target. Apply checks
live locks under the existing document writer mutex and retains a compact
receipt for repeated requests.

| Acceptance | Backend evidence                                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EWA-AC01   | The Manuscript and Outline tests keep the original target and preserve BOM, CRLF, Unicode and all source outside the replacement range.                                                 |
| EWA-AC02   | Tests reject unsaved or changed source and a new overlapping lock. Locked text remains available for questions. Applying over a live lock fails even when the replacement is identical. |
| EWA-AC03   | Service and stream tests verify authenticated project scope, ordered replay, duplicate requests, cancellation, delayed adapter cleanup, explicit retries and bounded session retention. |

Ponytail Review checked the contract, adapter and Markdown write paths.
The implementation passed the Web build, workspace tests and strict Clippy.
Root checks covered contract generation, Rust formatting, the focused service,
application and infrastructure cases, and client and gateway stream handling.
The tests used an injected fixture engine. Browser editing and native runtime
validation are tracked in the following tasks.

## EWA-T02 — Conversation pane and Agent settings

The Web Markdown workspace adds an Agent tab alongside the built-in AI
assistant and Comments. The conversation scrolls above a fixed composer with
the selected context, engine, model, Send and Stop. A completed edit shows the
existing Markdown comparison with Apply and Discard. Engine/model changes
and explicit retries start a fresh session. Settings and the composer share
discovery state, and defaults use the existing browser-level preferences
across projects.

| Acceptance | Browser evidence                                                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| EWA-AC01   | A replacement stays bound to Manuscript after switching to Outline. Source-mode selection preserves surrounding BOM, CRLF and Unicode, including text in fenced code.                                                                                              |
| EWA-AC02   | A live lock or newer local edits block Apply and retain the proposal. Failed or stale preflight saves dispatch zero turns. Late Apply keeps newer typing and pauses autosave. Repeated clicks dispatch one Apply.                                                  |
| EWA-AC03   | Stop and project switches fence late events. Cancelled creation, missing send acknowledgments, explicit retry and overlapping Apply/Stop preserve their owning request or session.                                                                                 |
| EWA-AC04   | The composer preserves focus and stays visible on narrow and wide screens. IME Send retains the original tab, committed instruction and newer composition text. Invalid ranges fail without broadening the attachment. English and Simplified Chinese are covered. |
| EWA-AC05   | Fixture engines exercise model switching, defaults and recovery from an unavailable connection. All 31 existing Markdown workspace browser cases passed.                                                                                                           |

The implementation passed `pnpm check`, `pnpm build` and all 14 integration
cases. The full Markdown browser run passed 47 cases. After the last source
and layout changes, all 17 Agent browser cases and three affected existing
cases passed, along with formatting, typecheck and the Web build. Root review
checked the selection, save, Apply, stream and settings boundaries and reran
focused browser and unit checks. Browser adapters are injected from tests.
Native runtime availability is covered in EWA-T03.
