# OP2 validation: native source store and recoverable promotion

Reviewed independently on Linux, 2026-11-19, following `04ca8e4`.
This accepts the scoped OP2 backend gate (OPF-AC01, AC03, AC06, AC07, AC19);
OP3–OP6 and the final prospective merge CI remain required.

## Implemented behavior

Explicit format create/adopt/open and read-only inspection retain legacy loaders.
Ordinary unmanaged Markdown receives native-proved identity comments in a batch;
its exact original bytes are retained. Existing legacy management requires
migration. Missing/corrupt known management never initializes an unlocked copy.

Generated named HTTP/preload source read/save APIs use the existing writer,
receipts, policy and history. Native parsing matches the frozen shared identity
and span fixtures without Node. Accepted raw source and immutable snapshots retain
BOM, line endings, unsupported syntax and unedited regions. Simple nested lists
and structural accepted AI edits have real-core evidence. Unknown syntax remains
raw; incomplete semantic exports/full approval refuse explicitly.

The durable intent records raw before/after hashes, physical identities and the
original request. File promotion precedes the guarded SQL commit, which includes
source generation, receipt and operation identity. Restart settles known states
before jobs/collection. Unexpected bytes are preserved and block recovery.
Pending intents fence new commands and task UOW entry; old receipts replay first.
Current/history/approved/task raw references participate in retention.

## Independent review and checks

Root inspected native projection/patching, common command coordination, journal
states/recovery, retention, approval, backup/restore and HTTP/preload boundaries.
The review identified and corrected several implementation defects before this
stage was submitted:

- A raw edit originally affected every block. Native scaffold proof now preserves
  unrelated revisions, locks and review anchors for proved independent leaf edits.
- Missing-marker binding repeatedly reparsed the whole document per leaf. Native
  batch insertion now proves the captured source and candidate once.
- Unsupported list parents could leave orphan projected children. Their complete
  subtree now stays raw, with no invented parent or depth change.
- Physical namespace checks initially used ASCII comparison. Root reproduced
  acceptance of `.ſcenesparrow`, `.gıt` and `project.jſon`; the corrected inventory
  reuses OP1's Unicode portable key and rejects them before writes.
- Full interface regression exposed a synthetic empty sentinel blocking initial
  drafting. The guard now distinguishes actual bound content. Final entry-point
  review also fenced fast commands/paid task UOWs during unresolved recovery.

Root's final independent checks on corrected source passed:

| Check                                                                 | Result                                                                                                |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `cargo test --locked -p scenesparrow-domain`                          | 25 passed, including native codec/batch fixtures and 69 shared validation cases                       |
| `cargo test --locked -p scenesparrow-infrastructure open_source::`    | 25 passed, including 10 journal cut points, real external replacement and text-only backup round-trip |
| `node --test tests/integration/open-source.test.mjs`                  | 4 real-core flows passed against the rebuilt corrected service                                        |
| Authored-source client, desktop adapter and bare-Node Markdown suites | 8 passed                                                                                              |
| Isolated CLI alias probes                                             | All three aliases rejected; all original bytes unchanged                                              |

The agent additionally passed all 386 Node unit tests, a 236-test full Rust run,
workspace typecheck, desktop build, contracts consistency, Clippy and formatting.
The full Rust run preceded a final transient planning-recovery adjustment and
the narrow Unicode correction; affected planning (30), domain (4), source (25),
Clippy and rebuilt service/source integrations were checked afterward. All 16
service integrations passed after the planning adjustment; the four source flows
were rerun again after the namespace correction. These counts describe actual
runs, not a claimed full run on the later source.

The source flows include authenticated no-Node create/save/reopen, independent
locks/revisions/Undo/Redo, explicit adoption/future inspection, counted SDK-fixture
initial list drafting and scoped revision, and section insertion preserving fenced
source. No real provider was called. Logs remain under ignored `.artifacts/op2/`.
Every shell sourced `scripts/cloud-env.sh`; Rust-invoking checks used
`CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=4`.

## Remaining delivery gates

Physical exchange is implemented on Linux only. macOS promotion and Windows
source access/promotion are missing capabilities for OP6 to implement; they are
not described merely as unrun tests. No native packaging/GUI acceptance follows
from these Linux checks.

Source-capable UI, filesystem reconciliation and reachable same-process recovery
are OP3. Browser refresh alone does not reopen a deployed core. Intent v1 uses a
list envelope but this stage registers/recovers one manuscript file; OP4 extends
multi-file coordination. Text-only verified backup reconstructs manifest/source/
management and retained raw history; complete creative/media packages and explicit
legacy migration are OP5.

One debug-profile batch sample measured about 0.49 s for 1,000 leaves and 10.79 s
for 10,000 leaves (0.95 MB bound source), with substantial pinned-parser cost.
Batching removes repeated application-level insertion parses; optimized-release,
interaction and RSS budgets remain open. No arbitrary project-code execution or
production audio/video workflow is enabled or certified here.
