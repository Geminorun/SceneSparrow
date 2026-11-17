# Shared creator workbench

Historical follow-up: the later [reference workspace](reference-workspace.md)
supersedes this layout, and [model services](ai-model-services.md) supersedes its
Settings presentation. The lifecycle and recovery invariants below remain in
force; the older visual tokens and provider menu are not the current UI.

This follow-up replaces the project-name creation gate with a workbench that opens
immediately. It keeps the existing S1/S2/S3 boundaries: a new project starts in
planning; **Start writing** is still explicit. Opening or initializing the workbench does not submit a new AI task.

The shared React renderer lives in `packages/editor-ui`; `apps/web` loads it for
both Web and Electron. A slim header contains the project title, rename action,
language and Settings gear. Desktop also exposes project files and recent projects
when the platform client supplies those capabilities. Recent entries contain only
titles and opaque host locator IDs; the renderer receives no filesystem paths.
One private Web deployment continues to share one project and AI configuration.
This change adds neither user isolation nor cross-device synchronization.

The visual system uses canvas `#f3f6f8`, white paper, ink `#21313d`, muted text
`#566675`, border `#d9e2e8` and accent `#147d92`. System sans controls surround local
serif manuscript prose. Compact menus preserve horizontal room for heading
navigation, the manuscript, review cards and paragraph locks. Long titles truncate
visually while their complete accessible text and rename form remain available.

The renderer reads the project before calling atomic `ensureProject` on a genuine
null result. Read errors show retry without creating a replacement. An ambiguous
ensure or rename retains its command identity for retry. Rename compares the
project ID and previous title, refreshes a stale title while keeping the proposed
name, and merges only title metadata into the open project. A delayed metadata
response must not reduce a newer manuscript revision or readiness projection.

Settings opens as a sibling native dialog with General and **AI & models**.
AI settings load on first activation. Provider/model controls retain their mounted
state, including an uncertain paid-test action, through dismissal; unsaved keys
clear. Capability, token and temperature declarations are collapsed under Advanced
model options. Every endpoint template uses the same OpenAI-compatible Chat
Completions adapter, including Gemini's compatible URL. No native vendor protocol
or audio/video generation is added.

The manuscript and planning save queues remain mounted and keyed only by project
ID through settings, rename, locale and metadata changes. Modal controls keep local
keyboard behavior; project undo excludes dialog targets. The existing manuscript
close handler dismisses shell dialogs before presenting local-edit recovery. No
second desktop close subscription is registered. Focus stays inside modal controls
and returns to the initiating gear/title action when dismissed.

See [validation evidence](../validation/workspace-onboarding.md) for the runnable
cases and platform limits.
