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
