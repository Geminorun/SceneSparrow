# Unified Agent writing and project skills

Status — proposed for implementation.

## Delivery

Deliver all five phases in the same pull request. Review and validate each
phase as it lands. The final acceptance covers Markdown editing, conversation
history, batch revision, source research, and Remotion skill use.

The established workbench layout is the baseline. Keep the left outline, the
central Manuscript and Outline tabs, and the right pane. The file-backed Web
workspace is the end-to-end acceptance surface. Share the editor and
conversation controls with desktop through the existing platform client.

This spec updates the editor, review, and conversation behavior described in
the [Markdown outline spec](markdown-outline-review.md),
[external writing Agent spec](external-writing-agent.md), and
[DeepSeek Harness spec](deepseek-harness-agent.md). Those specs define the
existing file format, writer guarantees, and runtime and credential boundaries.

| Task    | Phase | Deliverable                                                             | Acceptance  |
| ------- | ----- | ----------------------------------------------------------------------- | ----------- |
| AWR-T01 | 1     | Shared Markdown editor, block locks, and inline comments                | AWR-AC01–02 |
| AWR-T02 | 2     | Single Agent pane, durable project conversations, and provider settings | AWR-AC03–05 |
| AWR-T03 | 3     | One revision proposal from the current document's pending comments      | AWR-AC06–07 |
| AWR-T04 | 4     | Read-only research from the selection, with sources in the conversation | AWR-AC08–09 |
| AWR-T05 | 5     | Remotion project template, skill management, and native skill loading   | AWR-AC10–11 |

## UI and interaction requirements

The document is the primary surface. Keep the established SceneSparrow
paper, panel, ink, and accent tokens, with one type scale and a shared
spacing rhythm across the editor, Agent, and settings. Keep a continuous
writing surface with aligned text edges, quiet pane dividers, and a
dedicated gutter for block controls. Use thin borders and restrained
elevation to distinguish menus, popovers, and the active controls. Reserve
accent color for actions and state. Use one icon style and concise labels.

- **Claudian** informs the Agent's compact composer, separate document and
  per-turn context, searchable history, and provider settings. Keep typing
  and the latest conversation visible together. Reuse its interaction
  patterns in SceneSparrow's workbench layout.
  [Single-pane reference](https://github.com/YishenTu/claudian/blob/2fe7556de0b5f6f4f9c8eaa8206b7e1585b6f892/assets/main-chat-single-pane.png)
  · [Context tray](https://github.com/YishenTu/claudian/blob/2fe7556de0b5f6f4f9c8eaa8206b7e1585b6f892/src/features/chat/composer/ComposerContextTray.ts#L10)
  · [DeepSeek settings](https://github.com/YishenTu/claudian/blob/2fe7556de0b5f6f4f9c8eaa8206b7e1585b6f892/src/providers/deepseek/ui/DeepSeekSettingsTab.ts)
- **Review Comments** informs selection-local actions, a quiet highlight
  with a small comment marker, and viewing or editing a note near its
  anchor. Implement these interactions in SceneSparrow's editor with its
  existing JSON sidecars and clean Markdown.
  [Selection toolbar](https://github.com/shotashirai1719/obsidian-review-comments/blob/2a3e06c61b44042a16c2753ee6000016ec223e01/src/floating-bar.ts)
  · [Comment marker and popover](https://github.com/shotashirai1719/obsidian-review-comments/blob/2a3e06c61b44042a16c2753ee6000016ec223e01/src/ui/comment-bubble.ts#L51)

Use the established controls and breakpoints. In the narrow layout, let
the secondary pane overlay or collapse so the text retains a readable
width. Wrap long Chinese and English content, including URLs and model
names, within its own surface. Provide visible keyboard focus, accessible
names for icon controls, and text or icon cues for states conveyed by
color. Honor reduced-motion preferences. Keep the editor caret, scroll
position, and input available through saving, streaming, and background
status changes.

## Phase 1 — Restore the shared Markdown editor

Render and edit both documents in the same central canvas with the same
content width, typography, scroll behavior, and directory navigation. A
thematic break such as `---` currently sends the entire document to the
source editor. Support thematic breaks in the visual projection and exercise
headings, paragraphs, emphasis, and nested lists in the same document.
Preserve the underlying Markdown bytes outside edited ranges. Keep the
explicit source and copy actions available from the document header or menu.

Place the lock control at the right edge of each lockable block. Expose it on
hover and keyboard focus. A locked block has a subtle background across the
block and a visible lock icon. Toggle lock state within the reserved gutter
so the text keeps its position and width. The lock tint applies to the
whole block. A comment hint highlights only its anchored span. Use the
existing server-backed lock rules for both editors.

Anchor a compact toolbar near the visible selection and place it within the
editor viewport. Preserve the selected range when focus moves into the
toolbar. Show the actions after selection settles and keep them out of the
way during IME composition. The toolbar has two actions.

- **Ask** attaches the quote and document to the Agent composer and focuses
  its input. The user supplies the question. Phase 4 connects this action to
  source research.
- **Comment** opens an inline editor at the selection. Saving anchors the
  instruction and leaves a subtle span highlight and a small marker. Open
  the marker to read, edit, or resolve the note in a popover next to the
  original text. On Save or Escape, return focus to the originating
  passage so the user can continue reviewing. Selecting text during
  ordinary editing leaves the conversation attachment unchanged.

Use the shared editor and annotation APIs. File-backed `manuscript.md` and
`outline.md` remain the authoritative text. `locks.json` stores protected
anchors and `comments.json` stores anchored instructions and their current
state. Save the captured buffer before anchoring new annotations to it.

## Phase 2 — Consolidate Agent, history, and settings

The right pane has one **Agent** surface. Its header shows the current
conversation, **History**, and **New conversation**. The middle shows messages
and results in a single scrolling timeline. Keep the composer docked at
the bottom. Group the input, a visible Send or Stop action, and the
configured Agent and model in one compact control. Show the current
document and any attached quote nearby, with a way to remove the quote.
**Generate outline** and **Write draft from outline** move into the
composer's add menu and record progress and results in that conversation.

Keep the empty state brief. Present answers as readable prose and show
progress near the turn it belongs to. Group secondary details in a
disclosure. Follow streaming text while the reader is at the end. When
they scroll back, preserve their reading position and offer a way to jump
to the latest reply. Keep the composer visible when a long answer, diff,
or source list wraps.
[Claudian transcript follow behavior](https://github.com/YishenTu/claudian/blob/2fe7556de0b5f6f4f9c8eaa8206b7e1585b6f892/src/features/chat/rendering/TranscriptFollow.ts#L6)

Reuse the existing generation and adoption rules. A generated outline opens
in the central Outline tab once saved. Confirm before replacing an existing
outline. Draft generation uses the saved outline and presents a preview
before adoption. Keep pending inputs and revision conflicts recoverable.

### Conversation lifecycle

Adapt Claudian's compact history interaction to the React workbench. Show
the current project's conversations in recent-activity order, with title
search, rename, and open-to-continue. Open history from the header in an
anchored menu. Put search above the list and keep its focus as results
filter. Indicate the active conversation and close the menu when a row is
opened. Create the record on the first send and derive its initial title from
the first instruction.
[Claudian history menu](https://github.com/YishenTu/claudian/blob/2fe7556de0b5f6f4f9c8eaa8206b7e1585b6f892/src/features/chat/session-manager/HistoryDropdown.ts#L51)

SceneSparrow owns one JSON record per conversation in application-managed
storage keyed by project ID. Save stable IDs, title, activity time, provider
and model, user and Agent messages, and durable result references and
dispositions. Use server storage for Web and local application storage for
desktop. The current conversation is restored per project on reopen. The
collaboration ZIP includes the Markdown and annotation files under its
existing allowlist.

Persist accepted messages and settled turns independently of the native
session lifetime. New conversation, history navigation, and pane closure
change the displayed conversation. In-flight results remain attached to
their originating conversation. After an interruption, keep the user message
and expose a manual retry in the affected conversation. Reopening history
uses its saved context to continue through a fresh native session when
necessary. Preserve the existing limits on how much history is sent to a
runner.

### Global Agent settings

Use a compact provider selector with one detail surface for the selected
Agent. Put the provider name and connection status together at the top.
Group masked credential and model controls by purpose. Keep the relevant
next action visible, such as adding a key or selecting a model. Distinguish
a missing runner, a missing or rejected key, and an unavailable model with
localized status.
Use the global default for a new conversation and allow a model change to
start a new conversation. Surface existing direct API profiles through
advanced compatibility settings and retain their saved bindings. Reuse the
credential vault and the existing inference test action.

## Phase 3 — Process comments in one revision

Users leave any number of comments on Manuscript or Outline, then use a
normal message such as “Revise this draft” in the Agent composer. The send
automatically captures the active document's saved revision, open comment
IDs and instructions, resolved source ranges, and live locks. Show the
attached document and comment count in the conversation. The same format is
available to external Agents through the project ZIP. The Markdown files are
the edit targets and the exported sidecars provide guidance.

An ordinary question asks for an answer. An edit instruction asks for a
proposal. If the instruction is ambiguous, ask what the user wants to
change. Read the full captured document for context. For a comment-driven
edit, produce replacements for anchored ranges tied to the requested
comments. Group overlapping comments into a single replacement. Report
locked ranges, detached anchors, and comments that need clarification as
unresolved items.

Show one reviewable diff in the conversation. Lead with a concise summary of
applicable and unresolved changes, with a single primary **Apply** action.
Expand individual changes to see the original and proposed text and jump
to the corresponding passage. Associate each replacement with its comments.
**Apply** writes the group in one Markdown save. **Discard** records the
outcome and leaves the comments open. The Rust writer checks the saved
revision, quotes, affected comment records, and current locks while holding
the project writer boundary. Untouched source bytes stay identical.

Capture project and document identity before dispatch. Changes to other
tabs, selections, and conversations cannot redirect a result. A version
conflict retains the preview and current text. Resolve only the comments
whose edits were saved. Keep a stable proposal identity so that a duplicate
Apply or an interrupted acknowledgement can return the settled result
without rewriting the document or resolving unrelated comments.

## Phase 4 — Research a question about selected text

**Ask** sends the captured quote with a read-only research request after
the user enters a question. Search relevant references available to the
project first. If those references are insufficient, query configured public
search. Attach source titles and links or project reference IDs to the
result. Say when the available sources do not verify a claim.

Keep source retrieval behind a bounded application capability. The current
writing Harness accepts text only. SceneSparrow supplies retrieved excerpts
through the existing writing input boundary. A research turn produces an
answer with evidence and has no document write path. Apply existing
operation identity and cancellation to retrieval and answer generation.
Keep unavailable search or partial results visible in the saved turn.

## Phase 5 — Install and load Remotion project skills

Extend the existing Remotion sample into an exportable video project
template. Use a standard Remotion TypeScript entry and composition, a pinned
dependency manifest, and project-local assets. Install the complete official
`remotion-best-practices` skill package at
`.agents/skills/remotion-best-practices/`, including the files referenced by
`SKILL.md`. Include that directory in the video project export so a
compatible external Agent can discover it from the project root.
[Remotion Agent Skills](https://www.remotion.dev/docs/agents/skills)

SceneSparrow manages the installed package in the video project. Show which
skill and version the project contains and preserve the package as a unit.
Use the official distribution and record the installed revision. Follow
Claudian's approach of delegating discovery and instruction loading to the
Harness. Use DeepSeek's `dsh-skill-filesystem` and `dsh-tool-skill` packages.
The pinned writing Harness version already passed a local discovery test
with the official Remotion package, including a relative reference. Live use
and rendering are phase acceptance checks.
[Claudian DeepSeek preset](https://github.com/YishenTu/claudian/blob/2fe7556de0b5f6f4f9c8eaa8206b7e1585b6f892/src/providers/deepseek/runtime/DeepSeekPresetPlugins.ts#L67)

The video runner gets its own project workspace and capability profile. It
can read its video project and skill resources, make a video project change,
and submit it through the supervised Remotion renderer. Restrict its file
scope to a staged copy of the video project. Reuse the existing renderer
isolation for the render step and use approved preview/adoption to bring
changes into the authoritative project. The text-only writing profile keeps
its existing tool policy. Expose the result as a playable render from the
template fixture.

## Acceptance

1. **AWR-AC01** — Open an outline with a thematic break, nested list,
   headings, and inline emphasis. It renders in the same central canvas as
   Manuscript. Edit one block, save, and verify the untouched bytes and
   directory navigation.
2. **AWR-AC02** — Lock a block in each document. Verify keyboard access and
   the whole-block treatment. Select text, verify Ask and Comment, and save
   and reopen an inline comment. Check that its marker returns to the anchor.
3. **AWR-AC03** — Start a conversation, produce a reply, open a new
   conversation, refresh, and restart the runner. Search, rename, and
   reopen the original conversation and continue with its saved context.
   Switch projects during a turn and verify replies stay in their project.
4. **AWR-AC04** — Run outline and draft generation from the unified composer.
   Check that the outline is saved in Outline and that the draft has a
   preview. Open the resulting history from the same Agent pane.
5. **AWR-AC05** — Exercise connected, unavailable, and missing or rejected
   credential states. Select a default model and verify it is used by a new
   conversation. Reopen an upgraded configuration with a saved API profile.
6. **AWR-AC06** — Leave three comments in an outline. Put one in a locked
   block. Send one ordinary edit instruction. Review the two applicable
   edits, apply them together, and verify the locked bytes and pending
   comment are retained. Repeat on Manuscript.
7. **AWR-AC07** — During review, change the document or add a lock. Verify
   the write is rejected and the preview remains available. Exercise
   duplicate Apply and an interrupted acknowledgement without another
   document write or unintended comment resolution.
8. **AWR-AC08** — Ask about a selected claim with a matching project
   reference, then ask a question requiring public search. Verify the
   evidence links are present in history and the document and open comments
   are unchanged.
9. **AWR-AC09** — Cancel a query and exercise unavailable search. Verify
   the corresponding conversation records the outcome and preserves the
   user input for an explicit retry.
10. **AWR-AC10** — Create and export a video project. Find the official
    skill and a bundled reference using the native skill loader from both
    project locations. Verify the installed skill version in the UI.
11. **AWR-AC11** — In a video project session, load the skill and request a
    change to the template composition. Review the project change, render it
    in the supervised worker, and play the resulting video. Verify the
    writing runner still satisfies its existing tool-policy check.
12. **AWR-AC12** — Review the implemented workbench in a real Web session
    at 1280 × 720 with three panes and at 960 × 720 in the narrow layout.
    Capture a compact set of screenshots in the PR showing the rendered
    outline with a locked block and open comment, the Agent composer with
    history open, the batch revision preview, and one provider's settings.
    Use realistic Chinese and English content. Verify the comment opens
    without shifting the document and returns focus to the same passage
    on close. Scroll back during a streamed response and verify the
    reading position and composer stay in place. Check visible focus and
    clipping with keyboard navigation and a long message. Review this
    evidence against the UI requirements before accepting the UI phases.

Use deterministic Agent and search fixtures for ordinary CI. Record real
Harness loading and Remotion rendering separately in the validation report.
Use English and Simplified Chinese for new UI strings and actionable errors.
