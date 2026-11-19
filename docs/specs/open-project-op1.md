# OP1: contracts, identity codec and portable skeleton

Status: independently reviewed on 2026-11-19. Branch `feat/open-project-format`,
starting at `5733d1d`. Root owns this brief and the frozen encoding below.
Parent contract: [open project format](open-project-format.md).

## Deliverables and boundaries

- OP1-T01: file manifest and media declaration schemas, with generated TypeScript
  and Rust consumers, separate from live strict transport DTO semantics.
- OP1-T02: pure manifest/identity/portable-path validation with deterministic
  typed failures and focused Node/Rust agreement fixtures. Physical symlink and
  TOCTOU enforcement remain OP2's responsibility.
- OP1-T03: a source-preserving Markdown document/marker codec in
  `packages/manuscript-format`, independently of the normalized legacy writer.
- OP1-T04: behavioral source/marker/patch fixtures proving fidelity and safe
  identity handling, including nested/unsupported Markdown and Unicode boundaries.
- OP1-T05: a small text-only fixture and a standalone Remotion project fixture
  with its own public dependencies/lockfile, licensed local inputs and explicit
  scripts. No private workspace imports, AI key, application API or project DB.
- OP1-T06: targeted consistency/type/test/build evidence and precise handoff.

The existing legacy writer and editor remain operational and unchanged in
behavior. Do not route persistence through the new codec yet. No database schema,
migration, UI, watcher, paid provider, Agent SDK or production untrusted-code
execution is introduced in this stage.

## Contract defaults

Manifest core fields follow the parent spec: format `scenesparrow`, version 1,
stable UUID projectId, manuscript relative path, optional name/audio/video and
namespaced extensions. Audio/video absence is valid. Extensions are bounded
opaque JSON, preserved exactly in value; supporting that one file-format shape
must not weaken live transport objects' deny-unknown-field validation. Reuse the
existing generation pipeline, adding narrowly scoped generator support if needed.

Validate path segments, not string prefixes. Reject dot/dotdot, empty segments,
absolute/drive/UNC paths, backslashes, control characters, reserved portable names
and case-colliding entries. Unicode filenames are allowed. Preserve stable IDs
without deriving them from display names or filesystem locations. Unsupported
future versions are identified for read-only handling, not silently coerced to v1.

## Markdown proof contract

The raw source is authoritative. A no-op returns identical bytes, including
unusual whitespace, CRLF and unsupported constructs. Changes are bounded source
patches with checked base/ranges and cannot normalize unrelated content. Identify
JavaScript UTF-16 offsets versus UTF-8 byte offsets explicitly; reject scalar-
splitting, out-of-range and overlapping patches.

The frozen marker spellings are `<!-- scenesparrow:block=<stable-id> -->` and
`<!-- scenesparrow:empty=<stable-id> -->`; IDs are canonical lowercase UUIDv4.
Recognize actual Markdown HTML-comment nodes, not marker-looking text inside
inline/fenced/indented code, escaped text or literal HTML contexts.

- Root paragraphs/headings use a standalone preceding marker with a blank
  separator. Code/HTML leaves use a standalone same-container marker without an
  added blank separator, preserving tight-list behavior.
- Container paragraphs use an inline suffix before terminal whitespace. Container
  headings use a suffix after the last inline child, preserving empty ATX syntax;
  reading also permits a heading prefix. Paragraph prefixes are unsupported.
- Lists/quotes are structural containers, not duplicate addressable parents.
  Every content leaf has its own ID and the nearest list-item address is exposed.
  A legacy multi-paragraph item requires an explicit leaf mapping during migration.
- Each empty marker owns one zero-content leaf and never consumes a following
  sibling. Consecutive/mixed root empty paragraphs and empty items with nested
  children are representable. Container-only quotes do not gain phantom parents.
- Insertion reparses and checks the metadata-free CommonMark AST, including list
  spread, code payload and raw HTML. Unproved placement fails without changing
  source. Duplicate, malformed, missing required or ambiguous bindings fail.

The shared insertion/read corpora are normative cross-language fixtures. Block
addresses are positions within the current source, not persistent IDs. The pure
`sourceMeaning` proof removes metadata from an AST; speech/export wiring remains
later work. Consumers validate required protected IDs after patches and before
persistence. UTF-8/UTF-16 units are explicit and unknown units reject.

Provide insertion/read/edit proofs for paragraphs, headings, nested ordered and
unordered lists, quotes, code blocks, mixed marks, hard/soft breaks and unsupported
tables/HTML. Missing/duplicate/ambiguous IDs are explicit binding failures, not
permission to invent new approved identities. Root reviews the concrete placement
and mapping before freezing it for OP2. If this proposal cannot represent a case
without loss, report the counterexample; do not paper over it with normalization.

## Ownership and checks

Allowed implementation owners: `packages/contracts`, the contract generator,
`packages/manuscript-format`, pure `crates/domain` validation, small sanitized
`tests/fixtures`, focused unit/domain tests and necessary pinned manifest/lockfile
updates. Do not edit root-owned design/plan/spec files; propose corrections in the
handoff. Do not stage/commit/push/switch branches/create worktrees/delegate.

Use `gpt-6.1-sol`, high effort, one writer. Source `scripts/cloud-env.sh` in every
shell. All Rust-invoking commands, including pnpm wrappers, use
`CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=4`.
Keep `.agents/` and unrelated user/process state unchanged.

Required evidence: generated-contract consistency, workspace typecheck, existing
Markdown/export serializer regressions, new contract/codec behavior tests, focused
Rust domain checks, touched formatting/Rustfmt, and actual standalone fixture
rendering with identified entry/composition/browser. Preserve exact commands,
counts, failures, skipped checks and owned-process cleanup. No claim of product
sandbox safety or native platform readiness follows from a fixture render.

Acceptance mapping: OPF-AC01–AC05 and the standalone portion of AC17. Final freeze:
all agent writes/checks stop before root review. The root independently inspects
the actual encoding and key regressions before committing or dispatching OP2.
