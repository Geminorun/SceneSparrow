# OP1 validation: contracts, identity codec and standalone fixture

Reviewed on 2026-11-19 against the OP1 changes following `5733d1d`.
Scope: OPF-AC01–AC05 pure contract/codec portions and the standalone fixture
portion of AC17. File persistence, migration and platform integration remain open.

Root independently inspected the generated contract boundary, both validators,
source parser/patch/insertion paths and media fixture. Review found that Unicode
portable-path folding was inconsistent with protected namespace checks. The
implementation agent corrected both languages, added shared rejection/control
cases and stopped all writes/checks before root's final verification.

## Evidence

- Root reran six Node suites: open-project, manuscript-source, markdown,
  export-serializers, export-files and export-delivery. **129 passed**, no failed
  or skipped tests. This includes **69 shared Node/Rust agreement cases** and
  existing normalized Markdown/export regressions.
- Root reran `cargo test --locked -p scenesparrow-domain`: **19 passed**, no
  failures; zero doc tests. The native agreement test consumes the same fixtures.
- Agent checks passed: generated contract consistency, workspace typecheck,
  domain Clippy with warnings denied, Rustfmt, touched Prettier and diff checks.
  Root checked the final diff and formatted/checked its documentation changes.
- Shared source corpus: **17 exact insertion cases**, **6 read/failure cases**,
  plus no-op BOM/CRLF, scalar offsets, invalid units, stale/overlapping patches,
  literal/escaped/code comments, missing/duplicate/ambiguous identity checks.
- A fresh copy of the Remotion fixture outside the application checkout installed
  its own frozen public dependencies, listed `OpenProjectExample`, rendered H.264
  and a still using system Chromium. ffprobe measured **24 frames, 24 fps,
  320 × 180, 1 second, 10,421 bytes**. Root inspected the rendered frame.
- Actual HTML video playback over a temporary loopback server reached the end
  with 24 decoded frames. The fixture has no audio; no audio evidence is claimed.

Raw logs and generated media are local ignored artifacts under `.artifacts/op1/`.
The trusted standalone render does not establish isolation for arbitrary project
code. Native Markdown parsing, physical link/TOCTOU enforcement and application
speech/export marker removal are subsequent-stage work. Linux evidence does not
certify Windows/macOS packaging or filesystem behavior.

## Frozen result

The exact marker/container encoding is recorded in
[OP1](../specs/open-project-op1.md). The legacy serializer remains unchanged.
Manifest core objects remain strict; only the explicitly named bounded file JSON
extension types admit opaque payloads. Portable namespace protection uses the
same NFC/uppercase/lowercase/NFC key as collision checks.

Every shell sourced `scripts/cloud-env.sh`. Rust-invoking checks used
`CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=4`.
OP1 is accepted locally for its scoped gate; later runtime and final CI gates
must pass independently before this PR is ready.

## Full-CI compatibility correction

Foundation run `44439249970` on `e75cc5d` failed six existing Rust export tests.
Root reproduced an eager source-codec reexport failing in bare Node 24: its
extensionless import was resolved by the unit runner's tsx loader but not by the
supervised export worker. Native type stripping also required erasable error
class fields and an explicit JSON import attribute.

The normalized writer now keeps an independent `.` entry; the source codec is
available through `@scenesparrow/manuscript-format/source`. Two clean-environment
bare-Node subprocess regressions cover the real export module and codec subpath.
Root reran those plus contract/source/Markdown/export serializer suites:
**122 passed**, no failures or skips. The remote full gate remains required;
the earlier scoped checks did not establish worker-runtime compatibility.
Root also reran `cargo test --locked -p scenesparrow-infrastructure exports::`:
**15 passed**, including all six previously failing paths. This local run used
the current worktree with preserved, uncommitted OP2 changes; it does not accept
OP2 or replace the prospective merge-commit CI gate for the corrective commit.
