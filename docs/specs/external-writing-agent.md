# External writing Agent and Claudian port

Status — Web implementation in PR #30. Hosted-provider validation is pending.

## Scope and references

Add an Agent conversation to the right side of the file-backed Web workspace.
Use Claudian as the interaction reference. The first useful workflow starts
with a selection in Manuscript or Outline and ends with applying one reviewed
replacement to that selection. Use Codex App Server as the first external
engine. Keep the engine interface suitable for a later Claude Agent SDK adapter.

| Claudian reference                                                                                                                                                                                                                                                                                             | Behavior to carry over                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [Input toolbar](https://github.com/YishenTu/claudian/blob/2fe7556de0b5f6f4f9c8eaa8206b7e1585b6f892/src/features/chat/composer/toolbar/InputToolbar.ts) and [stream controller](https://github.com/YishenTu/claudian/blob/2fe7556de0b5f6f4f9c8eaa8206b7e1585b6f892/src/features/chat/turns/StreamController.ts) | Conversation above a fixed composer, with send, stop, progress and errors.                   |
| [Context tray](https://github.com/YishenTu/claudian/blob/2fe7556de0b5f6f4f9c8eaa8206b7e1585b6f892/src/features/chat/composer/ComposerContextTray.ts) and [selection capture](https://github.com/YishenTu/claudian/blob/2fe7556de0b5f6f4f9c8eaa8206b7e1585b6f892/src/features/chat/input/ComposerSelections.ts) | Show the attached document or selection and capture it when sending.                         |
| [Inline edit acceptance](https://github.com/YishenTu/claudian/blob/2fe7556de0b5f6f4f9c8eaa8206b7e1585b6f892/src/features/inline-edit/ui/InlineEditModal.ts#L1088)                                                                                                                                              | Show the difference and validate the source again when applying.                             |
| [Provider session](https://github.com/YishenTu/claudian/blob/2fe7556de0b5f6f4f9c8eaa8206b7e1585b6f892/src/core/execution/ProviderExecutionSession.ts) and [Codex settings](https://github.com/YishenTu/claudian/blob/2fe7556de0b5f6f4f9c8eaa8206b7e1585b6f892/src/providers/codex/ui/CodexSettingsTab.ts)      | Use one conversation interface and discover settings and models through each engine adapter. |

The reference is Claudian 2.3.48 at commit `2fe7556`. Use SceneSparrow's existing
React controls and document APIs for the host integration. Preserve the
copyright and [MIT notice](https://github.com/YishenTu/claudian/blob/2fe7556de0b5f6f4f9c8eaa8206b7e1585b6f892/LICENSE)
with any copied upstream code.

## Conversation and settings

- Put the conversation above a fixed composer in the existing right pane.
  Show the attached document or selected text near the composer. While a turn
  runs, expose Stop and keep editing available. Use the existing localized
  notice for errors and mark the affected turn so its outcome remains visible.
- Show the current Agent and available model in the composer. A new
  conversation uses the global Agent default. Keep each conversation tied to
  its project and engine. Switching engines opens a new conversation.
- Add a global **Settings → Agent** page for connection status, available models
  and the default Agent. The Web adapter discovers the installed runtime and
  checks its server-side authentication and model catalog. Keep runtime paths
  and credentials on the server. Connection checks query runtime status and
  available models without starting a writing turn.
- Keep **Model services** and **Default models** for the existing built-in
  writing actions. Generation that already saves directly into Outline
  continues through its existing path. Agent conversation state and pending
  proposals live in the session. The project files and ZIP format remain
  governed by the [Markdown outline and review spec](markdown-outline-review.md).

## Document context and applying a proposal

Every turn starts with an explicit document attachment. Use the active
Manuscript or Outline tab as the default. Capture its identity and the
attached selection when sending. A text-only question can use the displayed
buffer. A turn with a selection can return a replacement for that selection.

1. Settle text input and capture the project ID, document kind, selection and
   quoted text. For a replacement-capable turn, use the existing save flow to
   get the saved revision for that exact buffer. If saving fails or the
   selection's source changes while it is being captured, retain local text
   and stop before dispatch.
2. Carry the saved revision, half-open UTF-8 byte range and exact original
   quote with the accepted turn. The adapter returns suggested replacement
   text linked to that turn. The host derives the target from the captured
   selection. A turn with no selection displays a reply without an Apply
   action. Moving the caret or changing tabs after sending leaves the target
   bound to the captured document and selection.
3. Show a before/after diff in the conversation with **Apply** and **Discard**.
   Reuse the existing comparison and protected Markdown write path. The
   current editor buffer must still match the captured version. In the Rust
   writer lock, verify the project, document kind, expected revision, exact
   range and quote, and live locks. Replace only the captured range and
   preserve all surrounding source bytes. A conflict keeps the proposal and
   current text for review. Applying the same proposal again returns its
   settled outcome within the live session.

## Agent boundary

The authenticated Web backend accepts a project-bound conversation turn and
streams events back to the right pane. The app-side adapter owns the external
process, maps native messages to the shared events and forwards cancellation.
The Rust document service owns authorized project reads and writes. Use
the existing origin and authentication checks for both turns and event streams.

Adapt only the first workflow's common operations. Start a session, send a
turn, stream reply/progress, produce a validated replacement proposal, and
cancel. Carry a stable request ID and a session/turn ID. Run one turn at a time
per conversation. A cancelled or failed turn settles once. Ignore late results
after cancellation or a project switch. Retrying is an explicit user action.

The first adapter uses [Codex App Server](https://developers.openai.com/codex/app-server)
over server-side stdio. The optional Linux runner exposes a private socket to
the Web core and supervises the native process. The adapter uses native model
discovery and cancellation. For selection turns, verify the runtime's structured output support and map
the final response to a reply and an optional replacement. Validate the
replacement before emitting a proposal event. Surface a localized setup error
if the runtime or authentication is unavailable. [Runner setup](../codex-writing-runner.md)

Pass the captured text as input and run in a separate scratch directory. Limit
the engine to the writing workflow's capabilities. Keep arbitrary shell and
generated-code execution disabled and enforce the runtime's filesystem and
tool restrictions before enabling the live adapter. The authoritative project
root, application credentials and operator secrets stay outside the engine's
environment. A scratch directory alone supplies a working location. Runtime
validation must establish the actual isolation boundary.

## Implementation and acceptance

| Task    | Deliverable                                                                                                                                | Acceptance  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| EWA-T01 | Project-bound turn context, common event contract, fixture adapter and guarded proposal application. Reuse the existing file-write checks. | EWA-AC01–03 |
| EWA-T02 | Claudian-style composer and conversation, source context, diff actions and global Agent settings.                                          | EWA-AC04–05 |
| EWA-T03 | Codex App Server adapter, status/model discovery, supervised cancellation and live runtime validation.                                     | EWA-AC06–07 |

1. **EWA-AC01** — Select a paragraph, send an edit request and switch tabs while
   it runs. The proposal still identifies the original document and selection.
   Applying changes only that range and preserves the rest of the Markdown.
2. **EWA-AC02** — Edit the target or lock the selected text after generation. Applying the
   proposal fails cleanly and keeps both the local text and the proposal.
   Exercise a failed pre-dispatch save and a repeated Apply as well.
3. **EWA-AC03** — Stop a streaming turn, switch projects, or navigate away. Late
   events and proposals stay fenced from the current editor. Verify duplicate
   sends and explicit retries.
4. **EWA-AC04** — Send a question from the right pane, see the current context
   and streamed reply, then make an edit with one diff and one Apply action.
   Verify keyboard focus and English/Simplified Chinese controls and errors.
5. **EWA-AC05** — Show an unavailable Agent with a recoverable status. Check
   default and per-conversation model selection, new sessions when switching
   engines using fixtures, and the existing built-in Outline and draft actions.
6. **EWA-AC06** — Use a controlled App Server fixture to exercise connection,
   discovery, streaming, cancellation and cleanup. Use a configured runtime
   for one manual Web edit before declaring live integration ready.
7. **EWA-AC07** — Verify the runtime restrictions, allowed inputs and bounded
   outputs, authenticated project scope, and secret handling with a temporary
   project. Confirm the adapter cannot make authoritative document writes.

Follow the [implementation workflow](../implementation-execution.md) after this
spec is accepted. The fixture adapter supplies ordinary CI coverage. Record the
real-runtime test separately. Follow-up candidates are Claude Agent SDK, ACP,
file references, resumable conversation history, slash commands and Skills.
