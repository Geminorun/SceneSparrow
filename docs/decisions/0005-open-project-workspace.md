# Open project files and external Agent collaboration

Status: accepted direction; specification/preparation only, 2026-11-19.
Implementation and platform acceptance are pending.

## Context

The user wants creative projects that Codex, Claude and other mature Agents can
modify directly. Desktop is the primary workflow; Web supports rapid cloud
development/private validation with the same core and UI. The current repository
stores canonical manuscript blocks in SQLite and exposes a normalized Markdown
projection. Its Remotion code is a smoke fixture, not a complete media workbench.

## Decision

Use ordinary Markdown, public media/subtitle formats and standard Remotion source
inside a portable project directory. A small versioned manifest declares identity
and stage entries. New-format authored text/source files are the creative source
of truth; core-owned SQLite records retain review, locks, decisions, tasks,
receipts and bounded history. Confirmed snapshots remain immutable.

External edits are candidates, not approval commands. The core validates actual
diffs, base identity and transitive lock impact before explicit user acceptance.
Agent workspaces do not gain permission to replace management state. Preserve
independent generic AI execution; embedding mature Agent hosts is a later adapter.

A project package is an ordinary ZIP of a fixed saved revision and its referenced
closure, excluding credentials and rebuildable caches. Legacy migration is
explicit, backed up, validated and recoverable. Do not rewrite delivered migrations.

Both clients use the same format and protocol. Cloud developer projects and a
deployed server's persisted volume remain separate; deploying application code
does not synchronize user projects. Native execution and arbitrary-code isolation
need actual platform evidence. A separate process does not establish a sandbox.

## Consequences

The current lossy Markdown projection cannot simply become file persistence.
Source fidelity, stable identities, external-write conflicts and cross-file crash
recovery require dedicated acceptance gates. Metadata is still durable state;
deleting it cannot be advertised as cache cleanup. Existing S1–S4 functionality,
five-step history and original paid-task identities must survive migration.

The [common spec](../specs/open-project-format.md) records the contract and explicit
early engineering gates. The [six-stage plan](../open-project-execution.md)
preserves root-owned design, one writer, independent review and root-only Git.
This decision does not itself enable new storage or execute external code.
