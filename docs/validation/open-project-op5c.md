# OP5-C: visible project transfer and captured input ownership

Status: independently reviewed locally, 2026-11-19. Baseline OP5-B is `9c8a24c`.
This checkpoint delivers visible transfer and bounded browser/native delivery.
Actual host activation, default native startup and macOS/Windows physical
capabilities remain OP6. No merge, tag, deployment or environment publication.

## Delivered behavior

The existing application menu and WritingDialog provide explicit legacy conversion
and complete project export/import. Recorded work copies offer package export
through existing Changes UI. Inspection keeps dirty input mounted and distinguishes
verified restoration from trusted-base returned edits. Returned candidates target
the exact work item/candidate in the existing diff/grant/lock/acceptance owner,
including off-page lookup and stale-candidate refusal. The source stays active
while a new verified target is prepared.

One ProjectSession queue lease spans clicked manuscript and hidden planning
checkpoints, base verification and original capture acknowledgment. Newer input
remains pending; IME and active input DOM remain stable. Checkpoint custody ends
inside the queue before its next handoff, including refusal/error. Never-entered
cancellation releases input custody synchronously; separate bounded admission
remains owned through promise completion. Canonical no-op pruning, ordinary
predecessor settlement and overlapping planning discard cannot consume newer
input or recursively deadlock the queue. Related Copy/Export paths use this owner.

Browser intake uses pinned incremental SHA-256 with at most 1 MiB slices and exact
chunks. Authorized attachment preflight is bounded and cancels without aggregation;
an anchor starts the browser download without navigating the editor or reporting
completion as Saved. Native main/preload exposes closed named chooser/intake/
new-file-save/read-status capabilities without renderer paths. Linux Core holds
the created output identity, no-clobber publication and reader/worker guard through
final verification. Original status lookup never chooses or writes, including
a cold cache or archive expiry. Proved pre-dispatch failure is distinct from an
unknown dispatched write; held-file size/type/baseline checks precede hashing.

Known settled retries get new explicit request/target identities; unknown controls
retain their original DTO per operation. Bounded reload hints (20 records, 256 KiB,
seven days) grant lookup only, with no bytes/prose/keys/private paths. One compact
Recent transfers entry selects operations inside the existing dialog. English and
Simplified Chinese copy, three-second notices and compact durable status remain.
No new workspace/name gate, dashboard, generic path API or acceptance owner.

## Independent review and correction

Root rejected three earlier freezes after deterministic review. Corrections cover
ordinary predecessor draining, foreign source readback, planning-discard reentry,
settled retry/target reuse, native pre-effect admission and size checks, no-op
checkpoint pruning, partial settlement, per-operation uncertain controls, and
checkpoint release ordering between two consecutive captures. Root retained the
failing proofs and reran their exact sources against the final implementation.

The final 56-file manifest SHA-256 is
`3e3c113554a7e8baeb30e0d8ff7da30871f8785377853ada5a4e8ac4263d1a2a`.
All hashes matched before/after review. The queue/cancellation review is clean.
The independent native review remains applicable to the 30 unchanged native/
platform/contracts/HTTP/Core/test owners, verified against its reviewed bytes.

## Checks actually run

Root independently ran:

- Full Node suite: **503/503**, no skips or cancellations.
- Full HTTP integration suite: **35/35**, against the built actual service.
- Full Rust workspace: **397** (29 domain, 363 infrastructure, five service),
  retained against unchanged Rust hashes through the final freeze.
- Three externally bounded queue reproducers: unchanged A exports A with C pending;
  ordinary A predecessor then captured B exports B with C pending; two distinct
  captures export B then D. All exit successfully within eight seconds.

The implementation agent ran the final current-byte gates:

- Source browser suite: **38/38**, including 13 transfer cases and retained
  source/Changes/locks/history/IME cases.
- Focused legacy browser suite: **8/8**, covering conversion, Copy behind an actual
  preceding save, save preferences, planning composition and offline export.
- Focused queue/planning/captured-input suite: **124/124**, including B/D captures
  with later E pending, failed first ACK, cancellation and bounded admission.
- Contracts, TypeScript, Prettier/Cargo formatting and whole workspace build pass.
- Locked workspace Clippy with warnings denied passes on unchanged Rust bytes.
- Actual Linux native tests cover save/replay/status after expiry, destination
  collision, stage replacement, continuous reader/worker proof and quiescence.

An existing AI timeout fixture sometimes expired its 50 ms SDK deadline before
localhost dispatch under the expanded suite. Only its test changed: bounded
two-second deadlines and dispatch latches preserve exact one-then-two call counts,
no retry and redirect bearer-canary checks. No AI production behavior changed.

## Presentation and evidence limits

Root inspected normal/narrow export and recent-transfer screenshots: compact
controls retain the existing off-white editor/panel presentation and leave the
editor usable with 20 retained operations. Conversion and accepted returned-work
screenshots are retained. Browser attachment evidence uses a real authenticated
same-origin fixture proxy and checks downloaded Markdown and SQLite planning;
Chromium anchor navigation bypassed the earlier route-mock harness.

Native renderer presentation uses safe DTO mocks after real Core export; Main
uses real bounded temporary-file I/O with mocked private transport. Rust/HTTP
exercise Linux physical delivery. This does not establish an interactive OS
chooser run, macOS/Windows file behavior, GUI packaging, live providers or large
project performance. OP6 owns the remaining native and lifecycle implementation.

Logs, exact reproducer sources, manifests and images are under `.artifacts/op5c/`.
Current-head Foundation is recorded after this checkpoint is pushed; earlier
OP5-B Foundation run 44553634824 succeeded on `9c8a24c`.
