# Writing interaction and generation follow-up

Status: approved for implementation on 2026-11-18. Base: `release/1.0.0` at
`546c050`. This follow-up supersedes conflicting input gates, persistent notices,
output-token budgets and result-dialog presentation in
[writing-workspace.md](writing-workspace.md). Preserve its central editors,
single planning owner, explicit evidence consent, immutable receipts, locks,
five-step history, global model settings and task-start pinning.

## WIG-01: Input is independent of operation availability

Audit planning, manuscript, review, sources, history and shared action entry points.
Composition and background saving must not disable unrelated controls or replace
the active editor. A click requiring finalized input records one bounded intent,
waits for composition completion, then revalidates the current context and uses
the existing serialized save/business path. Duplicate clicks cannot duplicate a
paid task. Changing context/unmounting cancels stale intents. Native IME Enter,
Escape and undo remain native. Actual in-flight conflicting commands, reservations,
locks and invalid data still fence mutation; navigation remains available.

Share the interaction mechanism rather than adding independent composition event
workarounds. Preserve the final composed characters, input identity, selection,
delayed save acknowledgments, explicit-save boundaries and original uncertain
request identities. Cover composition cancellation/blur and delayed action delivery.

## WIG-02: Compact reference rows

Keep files, folders and links in the existing Library tree. Link rows have explicit
layout slots for selection, icon, title and menu; show at most two title lines and
one domain/status line. Long URLs cannot squeeze titles or overflow narrow panes.
Show the complete URL in details with copy/open actions; rename and remove remain
explicit. A focused Add link form takes a required URL and optional title, closes
after a successful add and retains input on failure. Preserve existing file/folder
intake, portable paths, extraction and reference selection behavior.

Saving a link, selecting it for a task and obtaining page content are distinct.
Keep link-only references honest; do not fetch metadata, screenshots or webpage
contents automatically. Use a generic link icon and a domain fallback title.
Selection continues through the existing evidence owner and task-start snapshot.

## WIG-03: Current progress and generation history

Remove the Results and details modal from normal creation. An accessible History
icon in the AI assistant opens Generation history within the same auxiliary pane,
with an explicit return action; the central editor stays visible and mounted.
The assistant shows real current-stage progress and Cancel without fabricated
percentages. Manual manuscript writing remains available independently of AI.

History rows show localized operation, time where available, understandable
outcome and a concise safe failure reason. Distinguish viewing an applied central
artifact, using a retained unapplied result and explicitly generating again with
current saved input/settings. Do not offer unavailable result/retry actions or
claim an evicted payload is recoverable. Previously completed stages remain usable
after later failure. Retry creates a new task only on an explicit user action;
uncertain original start readback retains its immutable identity.

Keep raw structured output, task IDs and provenance in collapsed diagnostic details.
Keep recovery available outside transient notices. Remaining native dialogs use
defined theme variables, opaque warm surfaces, fixed headings/close controls and
scrollable bodies. Fix all uses of the undefined surface/text variables.

## WIG-04: Remove application output-token budgets

Remove user-configured output-token amounts from model settings, current generic
AI parameters, category bindings, preparation DTOs and newly built requests.
Do not transmit `max_tokens` or `max_completion_tokens`, inject a hidden default,
or retain an advanced override. Remove the now-unused token-parameter selector.
Keep actual reported token usage and independently known model capabilities.
Context validation still checks bounded input and known model context without
inventing an output reservation. Keep response byte bounds, deadlines, schema
validation and complete-output business application.

Old settings/projects/receipts must remain readable without regenerating secrets,
rewriting migration 001–010 or mutating durable task identities. Old configured
budgets cannot reappear in newly started tasks. Verify stored fingerprint/receipt
compatibility and task-start pinning explicitly. Keep the runtime independent of
manuscript orchestration and retain at-most-one dispatch, no automatic paid retry,
provider fallback or continuation. Supplier output/context limits still exist;
local fake-provider tests cannot certify unlimited real-provider completion.
Supplier truncation remains a typed incomplete result, never partial manuscript
application, and the UI no longer tells users to increase an application token cap.

Compatibility decision: strict live DTOs reject retired fields. Narrow persisted
settings/run readers remove only the known retired keys in memory, preserving
stored bytes and historical fingerprints. A pre-upgrade queued, undispatched run
settles with `CONFIGURATION_STALE` through existing consumer cleanup before any
credential lease/provider call; a user can explicitly start a distinct fresh task.
This prevents silently changing already pinned request semantics. Completed and
already dispatched facts/receipt identities remain unchanged. Upgrade the shared
clients/core/worker together; an already open old client needs a refresh.

## WIG-05: Three-second transient notices

Both errors and success notices remain visible for three seconds, then fade out
briefly. Pause expiration while hovered or keyboard-focused and preserve top-layer
dialog placement, localization, bounded queues, deduplication and owner cleanup.
Polling cannot replay expired failures. Dismissal does not clear durable errors,
local input, task state or recovery. Save recovery and generation history remain
available after expiration; notice callbacks cannot become the only recovery path.

## Implementation and acceptance

Root owns this design, Git and independent review. Use one implementation writer
at a time, with separate reviewed checkpoints: shared AI contract/runtime removal;
input/action and notice lifecycle; Library/history presentation. Stop source writes
during checks and review. Update affected live specs and record exact test evidence.
The new PR targets `release/1.0.0`; this task does not authorize merge/deployment.

Acceptance covers continuous Chinese composition without unrelated disabled
controls; final text and exactly one action after a click; stale-intent cancellation;
save acknowledgment/caret stability; compact long-title/URL and narrow Library
layouts; preserved file/folder/evidence behavior; readable nonmodal stage history
and truthful retained-result actions; persistent recovery after three-second fade;
no output-token keys in counted compatible requests; readable legacy settings and
durable tasks; no duplicate inference after ambiguous start/restart; unchanged
locks, explicit acceptance and five-transition undo; English and Simplified Chinese.

## Product references

These public documents informed presentation, not implementation permissions:

- [Notion link mentions](https://www.notion.com/help/create-links-and-backlinks):
  compact icon/source/title and optional preview.
- [Zotero webpage items](https://www.zotero.org/support/adding_items_to_zotero#saving_webpages):
  link metadata and optional snapshots are separate.
- [NotebookLM sources](https://support.google.com/notebooklm/answer/16215270?hl=en):
  independent source selection and viewing. Its webpage importing is not adopted.
- [Gamma creation](https://help.gamma.app/en/articles/7838093-how-do-i-create-a-new-presentation-document-or-webpage-in-gamma):
  review a plan before building and edit the resulting content.
- [ChatGPT deep research](https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt):
  plan, progress, final artifact and activity history have distinct roles.
- [n8n executions](https://docs.n8n.io/build/understand-workflows/understand-executions/view-executions-for-a-single-workflow.md):
  execution records and workflow versions are distinct.
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/):
  omitting a request token cap still uses supplier defaults and inherent limits.
