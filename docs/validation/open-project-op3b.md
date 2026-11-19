# OP3-B validation: lossless shared Markdown authoring

Independently reviewed on Linux/Chromium, 2026-11-19, following `c4fac7d`.
Together with [OP3-A](open-project-op3a.md), this completes the scoped OP3 local
gate: OP3-T01–T07 / OPF-AC04/05/08/09/12/19. Later multi-file/package/platform gates
remain required; this is not production audio/video or arbitrary-code execution.

## Implemented behavior

Native-format projects use one stable CodeMirror 6 view, exact raw Markdown and
normalized-view bounded edits. Legacy projects retain Tiptap. Only an explicit
unsupported capability selects legacy; source read failures keep retry/recovery
instead of creating a blank editor. BOM, mixed endings and unsupported syntax
survive no-op and unrelated edits. Live preview and source mode share one buffer.
Real metadata is hidden without large empty gaps; code literals remain literal.

ProjectSession remains the one command, save, input and five-transition history
owner, with existing 5/10/30-second preferences and composition intent. Late ACKs
cannot flush or erase newer input. Proved marker additions rebase through same-leaf
edits; composition defers metadata adoption. Ambiguous topology retains both local
and accepted versions for explicit recovery. Original source DTO/receipt identity
survives uncertain mutation/readback outcomes; generic receipt-route NOT_FOUND is
not mistaken for a durable rejection.

The manuscript surface port adapts existing review/locks and bounded visible-block
geometry. Token-owned source/decoded/grapheme maps support ordinary inline syntax,
Chinese/emoji and line endings. Unsupported scopes refuse explicitly. Independent
locked A keeps its revision/anchor while B changes, empties/retypes or supported
root paragraphs are added/removed. Existing whole/scoped task guards remain.

Changes shows bounded contextual hunks, full-source details and explicit native
candidate decisions. Dirty resolution uses the shared queue directly. One stable
proposal textarea preserves DOM, caret, raw endings and composition during reads;
apply is bound to the displayed captured candidate. Recovery exposes retained
staged bytes, including exact invalid UTF-8 downloads. Source-clean copy/export
uses the existing captured delivery pipeline. Retained AI results apply with the
same paid run and no additional SDK call.

## Independent review corrections

Root reviewed source mapping/proof, session/receipt ownership, native scope and
projection, adapters, recovery UI and actual desktop/mobile screenshots. Findings
were returned to the same coding agent, except the final localized browser guard:

- Business/readback errors alone originally retired source request identity.
  Receipt lookup and captured pending intent now prove settlement first.
- Stored source rejections were missing from the native receipt decoder. Native
  and real HTTP replay now return their original rejection, not storage failure.
- CRLF text and multiline inline code had inconsistent native semantics. Canonical
  text now uses LF; inline code uses CommonMark spaces/padding from raw token ranges.
  This does not rewrite raw files or legacy semantics.
- Raw insertion of new root paragraphs initially widened impact to all text.
  A bounded complete-root proof now preserves unchanged identities/order/gaps/BOM,
  with conservative unknown/container/movement controls and task guards.
- Root screenshots exposed syntax-only presentation, metadata gaps and full-source
  comparisons. Inactive live formatting and contextual hunks replaced them.
- Proposal refresh could remount its field. Held-read browser evidence now proves
  the same DOM, focus/caret and raw draft, without retargeting an apply.
- Marker offsets could bind an inserted heading to the submitted paragraph's ID.
  Topology/ownership/meaning checks refuse ambiguous and multi-leaf replacements.
- Single-ID repeated proof made bulk ACKs quadratic. The codec now plans a batch
  against one captured AST and proves the final bindings/meaning once. Mapped
  newer checkpoints stage atomically; acknowledged checkpoints are retired first.
- Root reproduced an unguarded browser refresh when only a proposal was dirty.
  The beforeunload boundary now includes that owned input, matching controlled
  close. The new isolated browser regression failed before the one-condition fix.

No delivered migrations 001–012, journal version, application defaults or deployment
configuration changed. Source contracts remain compatible. The new public codec
batch entry keeps frozen single-insertion bytes and the independent legacy worker
entry; the new source browser command is included in Foundation checks.

## Verification

Root's independent checks:

| Check                                                          | Result     |
| -------------------------------------------------------------- | ---------- |
| Domain                                                         | 29 passed  |
| Native `open_source::`                                         | 46 passed  |
| Rebuilt-service source integration                             | 9 passed   |
| Focused source/session/selection/client suites, initial review | 120 passed |
| All Node suites after batch correction                         | 424 passed |
| Source browser after batch correction                          | 15 passed  |
| Source browser after root proposal-only close correction       | 16 passed  |
| Independent legacy review/input browser subset                 | 11 passed  |
| Final Web/desktop builds, typecheck and formatting             | passed     |

Root's added proposal-only browser close case and the resulting 16-case source
rerun passed after the final localized correction. Logs are under ignored
`.artifacts/op3b/root-*.log`. Root inspected the final source, Changes and Chinese
mobile screenshots. The proposal-only failing probe first used an existing case
with an unsaved manuscript; the isolated case then reproduced the actual omission
with the manuscript saved. The fix changes only that browser warning boundary.

On the identical isolated Node24 100/300-paragraph shapes, root measured ACK proof
at 1,065/7,865 ms before batching and 63/114 ms afterward; a 2,000-paragraph sample
took 692 ms. These are single ordered samples, not medians or full UI budgets.
The agent's repeated medians were 11.1/35.2 ms for 100/300 and 240.1 ms for 2,000;
10,000-leaf ACK sanity was about 1.31 s, full conservative rebase about 3.14 s.
Bulk proof no longer reparses per ID; overall large-document performance is open.

Agent final checkpoints additionally passed all 265 Rust tests (29 domain,
231 infrastructure, five service), Clippy, contracts, formatting, typecheck,
Web/desktop builds and 21 HTTP integrations. An uninterrupted legacy browser run
passed 96 with three explicit performance skips. Later source-only ACK/proposal
and batch changes were checked by 424 Node and 15 source browser cases; unchanged
native/legacy suites were not repeated for those changes. The Web bundle retains
its existing large-chunk advisory. All calls used counted local provider fixtures.

Every managed shell sourced scripts/cloud-env.sh. Rust-invoking commands/wrappers
used both zero-debug profile exports and CARGO_BUILD_JOBS=4; no parallel Cargo.
One early agent malformed-token probe ran an already-built binary without those
profile variables and exited before readiness; successful probes/final gates used
the required exports. All owned processes stopped before independent review.

## Deliberate limits and later gates

Mapping ambiguity offers retained versions/manual recovery instead of guessed
identity attachment. Root structural proof covers supported root leaves; unknown
or container effects retain conservative protection. A combined CRLF empty quote/
nested-list fixture was refused by the existing native placement proof before ACK;
its LF counterpart passes the real browser batch case. Raw bytes are retained;
this observed refusal is a capability limit, not an unrun platform test.

Previously created experimental source projects using the broken line-ending
projection may require recreation or verified recovery. Reopen refuses a mismatch
instead of silently rebuilding trusted state. Existing legacy projects keep their
semantics and await explicit OP5 migration.

OP4 adds multi-file work copies/protection, OP5 migration/complete ZIPs, and OP6
native macOS/Windows implementation, default/lifecycle and recovery-only startup.
Unknown pending intent can still prevent startup before HTTP recovery; OP6 must
close that gap. Evidence currently has scoped reads plus a last-intent UI hint;
fresh-client durable discovery is an OP6 requirement. Native GUI/packaging, hardware
IME, real providers and full large-document/RSS acceptance remain separate.
