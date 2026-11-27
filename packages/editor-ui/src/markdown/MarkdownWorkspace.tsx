import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import type {
  MarkdownExchangeDocument,
  MarkdownProject,
  MarkdownDocument,
  MarkdownDocumentKind,
  MarkdownAnnotations,
  MarkdownComment,
  MarkdownRange,
  AgentProposal,
  AgentGeneration,
} from "@scenesparrow/contracts";
import {
  ApiError,
  MARKDOWN_EXCHANGE_MAX_BYTES,
  type PlatformClient,
} from "@scenesparrow/platform-client";
import {
  applicationPreferences,
  type SaveMode,
  type SaveDelay,
} from "../app-preferences";
import {
  NotificationPresenter,
  useNoticeOwner,
  SettingsActions,
  type SettingsSection,
} from "../feedback/NotificationPresenter";
import { CompositionActions } from "../project-session/composition-actions";
import { WorkspaceRibbon } from "../workbench/WorkspaceRibbon";
import { AgentConversation } from "../agent/AgentConversation";
import { useAgentCatalog } from "../agent/catalog";
import { AgentSettings } from "../agent/AgentSettings";
import { proposalText, type AgentCapture } from "../agent/context";
import { commentSpans } from "./editor-annotations";
import { WorkspacePane, useAuxiliaryPane } from "../workbench/WorkspacePane";
import { WorkspaceIcon } from "../ui/WorkspaceIcon";
import { trapDialogFocus } from "../ui/dialog-focus";
import type { Editor } from "@tiptap/core";
import { MarkdownEditor } from "./MarkdownEditor";
import { FileMenu } from "./FileMenu";
import { MarkdownReview, type ReviewCapture } from "./MarkdownReview";
import { protectsSource, emptyAnnotations } from "./annotations";
import {
  projectSource,
  sourceBlocks,
  utf16Offset,
  utf8Offset,
} from "./source-projection";
import { type WritingCapture, type WritingDraft } from "./MarkdownWriting";
import { MarkdownPreview } from "./MarkdownPreview";
import { ExchangeReview } from "./ExchangeReview";
import { HeadingNavigation } from "./HeadingNavigation";
import en from "../locales/en.json";
import zhCN from "../locales/zh-CN.json";

type ExchangeDocumentCandidate = MarkdownExchangeDocument & {
  capture: {
    session: Buffer | null;
    epoch: number | undefined;
    text: string | undefined;
    revision: string | null | undefined;
  };
};
type ExchangeCandidate = { documents: ExchangeDocumentCandidate[] };
type Buffer = {
  project: MarkdownDocument;
  text: string;
  epoch: number;
  saving?: boolean;
  failed?: boolean;
  paused?: boolean;
  pauseReason?: "AGENT_NEWER_INPUT";
  pending?: Promise<void>;
  editedAt: number;
  editorSession: number;
};
function documentBuffer(project: MarkdownDocument): Buffer {
  return {
    project,
    text: project.text,
    epoch: 0,
    editedAt: 0,
    editorSession: 0,
  };
}
const visibleSource = (text: string) =>
  text.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
function sourceOffsets(text: string) {
  const offsets = [text.startsWith("\ufeff") ? 1 : 0];
  for (let index = offsets[0]!; index < text.length; index++) {
    if (text[index] === "\r" && text[index + 1] === "\n") index++;
    offsets.push(index + 1);
  }
  return offsets;
}
const lastProjectKey = "scenesparrow.markdown-project";
export function MarkdownWorkspace({
  platformClient,
}: {
  platformClient: PlatformClient;
}) {
  const client = platformClient.markdownProjects!;
  const preferences = useSyncExternalStore(
    applicationPreferences.subscribe,
    applicationPreferences.getSnapshot,
  );
  const [locale, setLocale] = useState(() => {
    try {
      return (
        localStorage.getItem("scenesparrow.locale") ??
        (navigator.language.startsWith("zh") ? "zh-CN" : "en")
      );
    } catch {
      return "en";
    }
  });
  const t = locale === "zh-CN" ? zhCN : en;
  const buffer = useRef<Buffer | null>(null);
  const outlineBuffer = useRef<Buffer | null>(null);
  const [, render] = useState(0);
  const [loading, setLoading] = useState(true);
  const [annotations, setAnnotations] = useState<
    Record<MarkdownDocumentKind, MarkdownAnnotations>
  >({ manuscript: emptyAnnotations(), outline: emptyAnnotations() });
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const [selections, setSelections] = useState<
    Record<
      MarkdownDocumentKind,
      {
        ranges: MarkdownRange[];
        range: MarkdownRange;
        source: string;
        explicit: boolean;
      } | null
    >
  >({ manuscript: null, outline: null });
  const selectionsRef = useRef(selections);
  selectionsRef.current = selections;
  const [agentAttachment, setAgentAttachment] = useState<{
    kind: MarkdownDocumentKind;
    owner: Buffer;
    selected: NonNullable<typeof selections.manuscript>;
  } | null>(null);
  const agentAttachmentRef = useRef(agentAttachment);
  agentAttachmentRef.current = agentAttachment;
  const annotationGeneration = useRef({ manuscript: 0, outline: 0 });
  function annotated(kind: MarkdownDocumentKind, data: MarkdownAnnotations) {
    annotationGeneration.current[kind]++;
    setAnnotations((current) => ({ ...current, [kind]: data }));
  }
  async function refreshAnnotations(
    kind: MarkdownDocumentKind,
    projectId: string,
  ) {
    const generation = ++annotationGeneration.current[kind];
    const session = documentBufferFor(kind);
    const revision = session?.project.revision;
    const data = await client.annotations(projectId, kind);
    if (
      annotationGeneration.current[kind] === generation &&
      documentBufferFor(kind) === session &&
      session?.project.projectId === projectId &&
      session.project.revision === revision
    )
      annotated(kind, data);
  }
  const pane = useAuxiliaryPane(true);
  const [view, setView] = useState<
    "manuscript" | "outline" | "draft" | "exchange"
  >("manuscript");
  const settings = useRef<HTMLDialogElement>(null);
  const sourceDialog = useRef<HTMLDialogElement>(null);
  const sourceInput = useRef<HTMLTextAreaElement>(null);
  const documentMenu = useRef<HTMLDetailsElement>(null);
  const [draft, setDraft] = useState<WritingDraft | null>(null);
  const draftRef = useRef<WritingDraft | null>(null);
  const [exchange, setExchange] = useState<ExchangeCandidate | null>(null);
  const exchangeRef = useRef<ExchangeCandidate | null>(null);
  const [separateProject, setSeparateProject] = useState<string | null>(null);
  const [exchangeBusy, setExchangeBusy] = useState(false);
  const exchangeRunning = useRef(false);
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection | null>(null);
  const [busy, setBusy] = useState(false);
  const switching = useRef(false);
  const editor = useRef<Editor | null>(null);
  const outlineEditor = useRef<Editor | null>(null);
  const sourceBase = useRef("");
  const sourceKind = useRef<MarkdownDocumentKind>("manuscript");
  const sourceOpen = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const composition = useRef(new CompositionActions()).current;
  const notice = useNoticeOwner();
  const agentCatalog = useAgentCatalog(
    platformClient.agent,
    settingsSection === "agent" ||
      (pane.right.tab === "agent" && pane.visible("right")),
    platformClient,
  );
  const redraw = () => render((value) => value + 1);
  function install(
    project: MarkdownProject,
    outline?: MarkdownDocument | null,
  ) {
    const url = new URL(window.location.href);
    url.searchParams.set("project", project.projectId);
    window.history.replaceState(null, "", url);
    try {
      localStorage.setItem(lastProjectKey, project.projectId);
    } catch {
      // The explicit URL remains usable when browser storage is unavailable.
    }
    buffer.current = documentBuffer({ ...project, kind: "manuscript" });
    outlineBuffer.current =
      outline === null
        ? null
        : documentBuffer(
            outline ?? {
              projectId: project.projectId,
              kind: "outline",
              text: "",
              revision: null,
            },
          );
    draftRef.current = null;
    setDraft(null);
    exchangeRef.current = null;
    setExchange(null);
    setSeparateProject(null);
    setView("manuscript");
    setSelections({ manuscript: null, outline: null });
    setAgentAttachment(null);
    setAnnotations({
      manuscript: emptyAnnotations(),
      outline: emptyAnnotations(),
    });
    for (const kind of ["manuscript", "outline"] as const)
      void refreshAnnotations(kind, project.projectId).catch(notice.report);
    redraw();
  }
  useEffect(() => {
    let active = true;
    let id = new URL(window.location.href).searchParams.get("project");
    if (id === null) {
      try {
        id = localStorage.getItem(lastProjectKey);
      } catch {
        // Profiles without browser storage can still open an explicit URL.
      }
    }
    void (id === null ? client.create("") : client.read(id))
      .then(
        async (project) => {
          try {
            const outline = await client.readDocument(
              project.projectId,
              "outline",
            );
            if (active) install(project, outline);
          } catch (failure) {
            if (active) {
              install(project, null);
              notice.report(failure);
            }
          }
        },
        (failure) => {
          if (active) notice.report(failure);
        },
      )
      .catch((failure) => {
        if (active) notice.report(failure);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      composition.dispose();
    };
  }, [client]);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = `${t.markdownWorkspace} · ${t.appName}`;
    try {
      localStorage.setItem("scenesparrow.locale", locale);
    } catch {
      /* Session preference remains available. */
    }
  }, [locale, t]);
  function documentBufferFor(kind: MarkdownDocumentKind) {
    return kind === "outline" ? outlineBuffer.current : buffer.current;
  }
  function activeKind(): MarkdownDocumentKind {
    return view === "outline" ? "outline" : "manuscript";
  }
  function save(
    adoption?: { text: string; outlineRevision?: string },
    kind: MarkdownDocumentKind = "manuscript",
  ): Promise<void> {
    const current = documentBufferFor(kind);
    if (!current) return Promise.resolve();
    if (current.pending) return current.pending;
    if (
      !adoption &&
      current.text === current.project.text &&
      current.project.revision !== null
    )
      return Promise.resolve();
    const { project, epoch } = current;
    const text = adoption?.text ?? current.text;
    current.saving = true;
    redraw();
    const request =
      kind === "manuscript"
        ? client
            .save(project.projectId, {
              text,
              revision: project.revision!,
              ...(adoption?.outlineRevision !== undefined
                ? { outlineRevision: adoption.outlineRevision }
                : {}),
            })
            .then((saved) => ({ ...saved, kind }))
        : client.saveDocument(project.projectId, kind, {
            text,
            revision: project.revision,
          });
    const promise = request
      .then((saved) => {
        if (documentBufferFor(kind) === current) {
          current.project = saved;
          const retainedNewerInput = !!adoption && current.epoch !== epoch;
          if (adoption) {
            if (current.epoch === epoch) {
              current.text = saved.text;
              current.epoch++;
              current.editorSession++;
            } else {
              current.paused = true;
              notice.report("MARKDOWN_DRAFT_NEWER_INPUT");
            }
          }
          if (!retainedNewerInput) {
            current.paused = false;
            delete current.pauseReason;
          }
          current.failed = false;
          void refreshAnnotations(kind, saved.projectId).catch(notice.report);
          redraw();
        }
      })
      .catch((failure) => {
        current.failed = true;
        throw failure;
      })
      .finally(() => {
        if (current.pending === promise) delete current.pending;
        current.saving = false;
        redraw();
      });
    current.pending = promise;
    return promise;
  }
  function runDocumentSave(kind: MarkdownDocumentKind) {
    const captured = documentBufferFor(kind);
    void composition
      .run(`save:${kind}`, async () => {
        if (documentBufferFor(kind) !== captured) return;
        const epoch = captured?.epoch;
        if (captured?.pending) await captured.pending;
        if (documentBufferFor(kind) !== captured || captured?.epoch !== epoch)
          return;
        await save(undefined, kind);
      })
      .catch(notice.report);
  }
  function runSave() {
    runDocumentSave(sourceOpen.current ? sourceKind.current : activeKind());
  }
  function capture(): WritingCapture {
    const current = buffer.current;
    if (!current) throw new ApiError("MARKDOWN_WRITING_INVALID");
    return {
      session: current,
      projectId: current.project.projectId,
      revision: current.project.revision!,
      text: current.text,
      epoch: current.epoch,
      outline: outlineBuffer.current
        ? {
            session: outlineBuffer.current,
            text: outlineBuffer.current.text,
            revision: outlineBuffer.current.project.revision,
            epoch: outlineBuffer.current.epoch,
          }
        : undefined,
    };
  }
  function draftChanged(candidate: WritingDraft) {
    const current = buffer.current;
    const base = candidate.capture;
    return (
      candidate.conflict === true ||
      (base.outline !== undefined &&
        (outlineBuffer.current !== base.outline.session ||
          outlineBuffer.current?.epoch !== base.outline.epoch ||
          outlineBuffer.current?.text !== base.outline.text ||
          (outlineBuffer.current?.project.revision !== base.outline.revision &&
            outlineBuffer.current?.project.text !== base.outline.text))) ||
      current !== base.session ||
      current?.epoch !== base.epoch ||
      current.text !== base.text ||
      (current.project.revision !== base.revision &&
        current.project.text !== base.text)
    );
  }
  function assertDraft(candidate: WritingDraft) {
    if (draftRef.current !== candidate || draftChanged(candidate))
      throw new ApiError("MARKDOWN_DRAFT_CONFLICT");
  }
  async function useOutline(candidate: WritingDraft) {
    await composition.run("use-outline", async () => {
      if (buffer.current !== candidate.capture.session) return;
      const outline = outlineBuffer.current;
      if (!outline || !candidate.capture.outline || draftChanged(candidate))
        throw new ApiError("MARKDOWN_OUTLINE_CHANGED");
      if (outline.pending) await outline.pending;
      if (buffer.current !== candidate.capture.session) return;
      if (draftChanged(candidate))
        throw new ApiError("MARKDOWN_OUTLINE_CHANGED");
      await save({ text: candidate.text }, "outline");
      if (outlineBuffer.current !== outline) return;
      if (outline.paused) throw new ApiError("MARKDOWN_DRAFT_NEWER_INPUT");
      if (sourceOpen.current) closeSource();
      setView("outline");
    });
  }
  async function useDraft() {
    const candidate = draftRef.current;
    if (!candidate || applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true);
    try {
      await composition.run("use-draft", async () => {
        assertDraft(candidate);
        const pending = buffer.current?.pending;
        if (pending) await pending;
        assertDraft(candidate);
        await save({
          text: candidate.text,
          outlineRevision: candidate.capture.outline!.revision!,
        });
        if (draftRef.current === candidate) {
          draftRef.current = null;
          setDraft(null);
          setView("manuscript");
        }
      });
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "MARKDOWN_CONFLICT") {
        candidate.conflict = true;
        redraw();
      }
      notice.report(failure);
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  }
  const current = buffer.current;
  const projection = useMemo(
    () => (current ? projectSource(current.text) : null),
    [current?.project.projectId, current?.editorSession],
  );
  const outlineCurrent = outlineBuffer.current;
  const outlineText = outlineCurrent?.text ?? "";
  const outlineProjection = useMemo(
    () => (outlineCurrent ? projectSource(outlineCurrent.text) : null),
    [outlineCurrent?.project.projectId, outlineCurrent?.editorSession],
  );
  const activeBuffer = documentBufferFor(activeKind());
  const agentSelection = agentAttachment?.selected;
  const agentExcerpt = useMemo(
    () =>
      agentSelection?.explicit
        ? new TextDecoder("utf-8", { ignoreBOM: true })
            .decode(
              new TextEncoder()
                .encode(agentSelection.source)
                .subarray(agentSelection.range.start, agentSelection.range.end),
            )
            .slice(0, 120)
        : null,
    [agentSelection],
  );
  const saving = !!activeBuffer?.saving;
  const saveFailed = !!activeBuffer?.failed;
  const autosavePaused = !!activeBuffer?.paused;
  useEffect(() => {
    if (settingsSection) settings.current?.showModal();
  }, [settingsSection]);
  function openSource(offset = 0) {
    if (documentMenu.current) documentMenu.current.open = false;
    const kind = activeKind();
    const raw = documentBufferFor(kind)?.text ?? "";
    sourceBase.current = raw;
    sourceOpen.current = true;
    flushSync(() => {
      sourceKind.current = kind;
      redraw();
    });
    sourceDialog.current?.showModal();
    const input = sourceInput.current;
    if (!input) return;
    input.focus();
    const position = visibleSource(raw.slice(0, offset)).length;
    input.setSelectionRange(position, position);
    selectSource(input, kind);
  }
  function closeSource(restoreFocus = true) {
    sourceDialog.current?.close();
    sourceOpen.current = false;
    const current = documentBufferFor(sourceKind.current);
    if (current?.text !== sourceBase.current) {
      if (current) current.editorSession++;
      redraw();
    } else if (restoreFocus)
      (sourceKind.current === "outline"
        ? outlineEditor
        : editor
      ).current?.commands.focus();
  }
  function sourceChanged(value: string, kind: MarkdownDocumentKind) {
    const raw = documentBufferFor(kind)?.text ?? "";
    const visible = visibleSource(raw);
    if (value === visible) return;
    let start = 0,
      end = 0;
    while (
      start < visible.length &&
      start < value.length &&
      visible[start] === value[start]
    )
      start++;
    while (
      end < visible.length - start &&
      end < value.length - start &&
      visible[visible.length - 1 - end] === value[value.length - 1 - end]
    )
      end++;
    const offsets = sourceOffsets(raw);
    const newline = /\r\n|\r|\n/.exec(raw)?.[0] ?? "\n";
    changed(
      raw.slice(0, offsets[start]) +
        value.slice(start, value.length - end).replace(/\n/g, newline) +
        raw.slice(offsets[visible.length - end]),
      kind,
    );
  }
  function selectSource(
    input: HTMLTextAreaElement,
    kind: MarkdownDocumentKind,
  ) {
    const raw = documentBufferFor(kind)?.text ?? "";
    if (input.value !== visibleSource(raw)) return;
    const offsets = sourceOffsets(raw);
    const start = offsets[input.selectionStart]!;
    const end = offsets[input.selectionEnd]!;
    const collapsed = start === end;
    const selected = sourceBlocks(raw).filter((block) =>
      collapsed
        ? block.start <= start && start <= block.contentEnd
        : block.start < end && block.contentEnd > start,
    );
    const ranges = (collapsed ? selected.slice(-1) : selected).map((block) => ({
      start: utf8Offset(raw, block.start),
      end: utf8Offset(raw, block.end),
    }));
    const selection =
      ranges.length || !collapsed
        ? {
            ranges,
            range: collapsed
              ? ranges[0]!
              : { start: utf8Offset(raw, start), end: utf8Offset(raw, end) },
            source: raw,
            explicit: !collapsed,
          }
        : null;
    setSelections((previous) => ({ ...previous, [kind]: selection }));
  }
  function showComments() {
    if (sourceOpen.current) {
      const kind = sourceKind.current;
      const selection = selections[kind];
      flushSync(() => closeSource(false));
      setSelections((previous) => ({ ...previous, [kind]: selection }));
    }
    pane.open("review");
    requestAnimationFrame(() => {
      const tools = document.getElementById(
        "agent-review-tools",
      ) as HTMLDetailsElement | null;
      if (tools) tools.open = true;
      document.getElementById("markdown-comment-composer")?.focus();
    });
  }
  function sourceField(kind: MarkdownDocumentKind, dialog = false) {
    const scope = dialog ? "source" : `source:${kind}`;
    return (
      <textarea
        ref={dialog ? sourceInput : undefined}
        id={
          dialog
            ? undefined
            : kind === "outline"
              ? "markdown-outline-editor"
              : "markdown-editor"
        }
        aria-label={
          dialog
            ? t.markdownRawSourceTitle
            : kind === "outline"
              ? t.markdownWritingOutline
              : t.markdownText
        }
        value={visibleSource(documentBufferFor(kind)?.text ?? "")}
        spellCheck={false}
        onFocus={(event) => selectSource(event.currentTarget, kind)}
        onSelect={(event) => selectSource(event.currentTarget, kind)}
        onChange={(event) => {
          const input = event.currentTarget;
          sourceChanged(input.value, kind);
          selectSource(input, kind);
        }}
        onCompositionStart={() => composition.composition(scope, true)}
        onCompositionEnd={() => composition.composition(scope, false)}
        onBlur={() =>
          composition.blur(scope, () => composition.composition(scope, false))
        }
        onKeyDown={(event) => {
          if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "s"
          ) {
            event.preventDefault();
            runDocumentSave(kind);
          }
        }}
      />
    );
  }
  function sourceActions(kind: MarkdownDocumentKind) {
    const locked = selectionLocked(kind);
    const selected = selections[kind];
    const hasSelection =
      !!selected?.ranges.length &&
      selected.source === documentBufferFor(kind)?.text;
    const label = locked ? t.markdownUnlock : t.markdownLockSelection;
    return (
      <div className="markdown-source-actions">
        <button
          disabled={
            !selected?.explicit ||
            selected.range.end <= selected.range.start ||
            selected.source !== documentBufferFor(kind)?.text
          }
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (sourceOpen.current) closeSource(false);
            askSelection(kind);
          }}
        >
          {t.markdownAsk}
        </button>
        <button
          type="button"
          className="markdown-icon-button"
          aria-label={label}
          title={label}
          disabled={!hasSelection}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (sourceOpen.current) closeSource(false);
            toggleLock(kind);
          }}
        >
          <WorkspaceIcon name={locked ? "lock" : "unlock"} />
        </button>
        <button
          type="button"
          className="markdown-icon-button"
          title={t.markdownAddComment}
          aria-label={t.markdownAddComment}
          disabled={!hasSelection}
          onMouseDown={(event) => event.preventDefault()}
          onClick={showComments}
        >
          <WorkspaceIcon name="comment" />
        </button>
      </div>
    );
  }
  async function copyMarkdown() {
    const current = documentBufferFor(activeKind());
    if (!current) return;
    try {
      await navigator.clipboard.writeText(current.text);
      notice.report("MARKDOWN_SOURCE_COPIED", { tone: "success" });
    } catch {
      notice.report("MARKDOWN_SOURCE_COPY_FAILED");
    }
  }
  const dirty =
    !!activeBuffer && activeBuffer.text !== activeBuffer.project.text;
  useEffect(() => {
    if (preferences.saveMode !== "after_delay") return;
    const timers = (["manuscript", "outline"] as const).flatMap((kind) => {
      const value = documentBufferFor(kind);
      if (
        !value ||
        value.text === value.project.text ||
        value.saving ||
        value.failed ||
        value.paused
      )
        return [];
      return [
        setTimeout(
          () => runDocumentSave(kind),
          Math.max(
            0,
            value.editedAt + preferences.saveDelaySeconds * 1000 - Date.now(),
          ),
        ),
      ];
    });
    return () => timers.forEach(clearTimeout);
  });
  useEffect(() => {
    const blur = () => {
      if (preferences.saveMode === "on_window_change")
        for (const kind of ["manuscript", "outline"] as const) {
          const value = documentBufferFor(kind);
          if (
            value &&
            !value.failed &&
            !value.paused &&
            value.text !== value.project.text
          )
            runDocumentSave(kind);
        }
    };
    const visibility = () => {
      if (document.hidden) blur();
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (
        [buffer.current, outlineBuffer.current].some(
          (value) => value && value.text !== value.project.text,
        )
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("beforeunload", unload);
    };
  });
  function changed(value: string, kind: MarkdownDocumentKind = "manuscript") {
    const current = documentBufferFor(kind);
    if (!current || value === current.text) return;
    if (!protectsSource(current.text, value, annotationsRef.current[kind])) {
      notice.report("MARKDOWN_LOCKED");
      return;
    }
    current.text = value;
    current.epoch++;
    current.editedAt = Date.now();
    redraw();
  }
  function selectedLocks(
    kind: MarkdownDocumentKind,
    selection = selections[kind],
  ) {
    const locks = annotationsRef.current[kind].locks;
    if (
      !locks.length ||
      !selection ||
      selection.source !== documentBufferFor(kind)?.text
    )
      return [];
    const { source, ranges } = selection;
    const bytes = new TextEncoder().encode(source);
    const decoder = new TextDecoder();
    let blocks: ReturnType<typeof sourceBlocks> | undefined;
    return locks.filter((lock) =>
      lock.anchors.some((anchor) => {
        let start = anchor.resolvedStart;
        let end = anchor.resolvedEnd;
        if (start === null || end === null) return false;
        // Saved offsets can shift while adjacent text is still unsaved.
        if (decoder.decode(bytes.subarray(start, end)) !== anchor.quote) {
          const matches = (blocks ??= sourceBlocks(source)).filter(
            (block) => source.slice(block.start, block.end) === anchor.quote,
          );
          if (matches.length !== 1) return false;
          start = utf8Offset(source, matches[0]!.start);
          end = utf8Offset(source, matches[0]!.end);
        }
        return ranges.some((range) => range.start < end && range.end > start);
      }),
    );
  }
  function selectionLocked(kind: MarkdownDocumentKind) {
    return selectedLocks(kind).length > 0;
  }
  function toggleLock(kind: MarkdownDocumentKind, selected = selections[kind]) {
    const initial = documentBufferFor(kind);
    if (!selected?.ranges.length || !initial) return;
    void composition
      .run(`lock:${kind}`, async () => {
        if (
          documentBufferFor(kind) !== initial ||
          selected.source !== initial.text
        )
          throw new ApiError("MARKDOWN_CONFLICT");
        const existing = selectedLocks(kind, selected);
        if (existing.some((lock) => lock.anchors.length > 1)) {
          pane.open("review");
          requestAnimationFrame(() => {
            const tools = document.getElementById(
              "agent-review-tools",
            ) as HTMLDetailsElement | null;
            if (tools) tools.open = true;
          });
          return;
        }
        const capture = await prepareReview(kind, existing.length === 0);
        if (capture.text !== selected.source)
          throw new ApiError("MARKDOWN_CONFLICT");
        const actions = existing.length
          ? existing.map((lock) => ({ action: "unlock" as const, id: lock.id }))
          : [
              {
                action: "lock" as const,
                revision: capture.revision,
                ranges: selected.ranges,
              },
            ];
        for (const action of actions) {
          validateReview(capture);
          const data = await client.annotate(capture.projectId, kind, action);
          if (documentBufferFor(kind) === capture.session)
            annotated(kind, data);
        }
      })
      .catch(notice.report);
  }
  async function prepareReview(
    kind: MarkdownDocumentKind,
    persist = true,
  ): Promise<ReviewCapture> {
    const current = documentBufferFor(kind);
    if (!current) throw new ApiError("MARKDOWN_ANCHOR_INVALID");
    const epoch = current.epoch;
    const assert = () => {
      if (documentBufferFor(kind) !== current || current.epoch !== epoch)
        throw new ApiError("MARKDOWN_CONFLICT");
    };
    if (current.pending) await current.pending;
    assert();
    if (persist) await save(undefined, kind);
    assert();
    return {
      kind,
      session: current,
      epoch,
      text: current.text,
      revision: current.project.revision!,
      projectId: current.project.projectId,
    };
  }
  function askSelection(kind: MarkdownDocumentKind) {
    const selected = selectionsRef.current[kind];
    const owner = documentBufferFor(kind);
    if (
      !selected?.explicit ||
      !owner ||
      selected.source !== owner.text ||
      selected.range.end <= selected.range.start
    )
      return;
    setAgentAttachment({ kind, owner, selected });
    pane.open("agent");
    requestAnimationFrame(() =>
      document.getElementById("markdown-agent-composer")?.focus(),
    );
  }
  async function inlineComment(
    kind: MarkdownDocumentKind,
    source: string,
    range: MarkdownRange,
    text: string,
    existing?: MarkdownComment,
    resolve = false,
  ) {
    const capture = await prepareReview(kind);
    if (capture.text !== source) throw new ApiError("MARKDOWN_CONFLICT");
    validateReview(capture);
    const ids = new Set(
      annotationsRef.current[kind].comments.map((comment) => comment.id),
    );
    const data = await client.annotate(
      capture.projectId,
      kind,
      existing
        ? resolve
          ? { action: "resolve", id: existing.id }
          : {
              action: "edit",
              id: existing.id,
              revision: capture.revision,
              previousText: existing.text,
              text,
            }
        : { action: "comment", revision: capture.revision, range, text },
    );
    if (documentBufferFor(kind) === capture.session) annotated(kind, data);
    return data.comments.find((comment) =>
      existing ? comment.id === existing.id : !ids.has(comment.id),
    );
  }
  function validateReview(capture: ReviewCapture) {
    const current = documentBufferFor(capture.kind);
    if (
      current !== capture.session ||
      current?.epoch !== capture.epoch ||
      current.project.revision !== capture.revision ||
      current.text !== capture.text
    )
      throw new ApiError("MARKDOWN_CONFLICT");
  }
  async function prepareWriting(
    kind: "outline" | "draft",
  ): Promise<WritingCapture> {
    const captured = capture();
    if (kind === "draft") {
      const outline = outlineBuffer.current;
      if (!outline) throw new ApiError("MARKDOWN_WRITING_INVALID");
      if (outline.pending) await outline.pending;
      if (draftChanged({ capture: captured, text: "" }))
        throw new ApiError("MARKDOWN_DRAFT_CONFLICT");
      await save(undefined, "outline");
      if (draftChanged({ capture: captured, text: "" }))
        throw new ApiError("MARKDOWN_DRAFT_CONFLICT");
    }
    return capture();
  }
  async function openGeneration(entry: AgentGeneration) {
    const context = capture();
    if (
      context.revision !== entry.revision ||
      (entry.kind === "draft" &&
        context.outline?.revision !== entry.outlineRevision)
    )
      throw new ApiError("MARKDOWN_DRAFT_CONFLICT");
    if (
      entry.kind === "outline" &&
      context.outline?.text.trim() &&
      context.outline.text !== entry.text &&
      !window.confirm(t.markdownReplaceOutlineConfirm)
    )
      return;
    const candidate = { capture: context, text: entry.text };
    if (entry.kind === "outline") await useOutline(candidate);
    else {
      draftRef.current = candidate;
      setDraft(candidate);
      setView("draft");
    }
  }
  async function generateInConversation(
    kind: "outline" | "draft",
    brief: string,
    conversation: () => Promise<string>,
  ) {
    const context = await prepareWriting(kind);
    if (
      kind === "outline" &&
      context.outline?.text.trim() &&
      !window.confirm(t.markdownReplaceOutlineConfirm)
    )
      return false;
    const conversationId = await conversation();
    if (draftChanged({ capture: context, text: "" }))
      throw new ApiError("MARKDOWN_DRAFT_CONFLICT");
    const [settings, ready] = await Promise.all([
      platformClient.readAiSettings(),
      platformClient.resolveAiConfiguration(),
    ]);
    if (draftChanged({ capture: context, text: "" }))
      throw new ApiError("MARKDOWN_DRAFT_CONFLICT");
    const result = await platformClient.markdownProjects!.write(
      context.projectId,
      {
        actionId: crypto.randomUUID(),
        sessionId: settings.sessionId,
        fingerprint: ready.configuration.fingerprint,
        kind,
        brief,
        outline: context.outline?.text ?? "",
        text: context.text,
        revision: context.revision,
        conversationId,
        ...(kind === "draft"
          ? { outlineRevision: context.outline!.revision! }
          : {}),
      },
    );
    const candidate = { capture: context, text: result.text };
    if (buffer.current !== context.session) return true;
    if (kind === "outline") await useOutline(candidate);
    else {
      draftRef.current = candidate;
      setDraft(candidate);
      setView("draft");
    }
    return true;
  }
  async function prepareAgent(
    kind: MarkdownDocumentKind,
    owner: Buffer | null,
  ): Promise<AgentCapture> {
    const current = documentBufferFor(kind);
    if (!current || current !== owner)
      throw new ApiError("AGENT_CONTEXT_INVALID");
    const attached = agentAttachmentRef.current;
    const selected =
      attached?.kind === kind && attached.owner === current
        ? attached.selected
        : null;
    if (selected?.explicit && selected.source !== current.text)
      throw new ApiError("AGENT_CONTEXT_STALE");
    if (selected?.explicit && selected.range.end <= selected.range.start)
      throw new ApiError("AGENT_SELECTION_INVALID");
    const selection = selected?.explicit
      ? {
          range: { ...selected.range },
          quote: new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(
            new TextEncoder()
              .encode(current.text)
              .subarray(selected.range.start, selected.range.end),
          ),
        }
      : null;
    const captured: AgentCapture = {
      projectId: current.project.projectId,
      kind,
      session: current,
      epoch: current.epoch,
      text: current.text,
      revision: current.project.revision,
      selection,
    };
    const unchanged = () => {
      if (
        documentBufferFor(kind) !== current ||
        current.epoch !== captured.epoch ||
        current.text !== captured.text
      )
        throw new ApiError("AGENT_CONTEXT_STALE");
    };
    if (
      selection ||
      current.text !== current.project.text ||
      annotationsRef.current[kind].comments.some(
        (comment) => comment.status === "open",
      )
    ) {
      if (current.pending) await current.pending;
      unchanged();
      await save(undefined, kind);
      unchanged();
      if (current.pending || current.text !== current.project.text)
        throw new ApiError("AGENT_CONTEXT_STALE");
      captured.revision = current.project.revision;
    }
    return captured;
  }
  function validateAgent(capture: AgentCapture, code = "AGENT_PROPOSAL_STALE") {
    const current = documentBufferFor(capture.kind);
    if (
      current !== capture.session ||
      current?.project.projectId !== capture.projectId ||
      current.epoch !== capture.epoch ||
      current.text !== capture.text ||
      current.project.revision !== capture.revision ||
      (capture.selection &&
        (current.pending || current.project.text !== capture.text))
    )
      throw new ApiError(code);
  }
  async function applyAgent(
    capture: AgentCapture,
    proposal: AgentProposal,
    sessionId: string,
    turnId: string,
  ) {
    const delivered = await composition.run(
      `agent:apply:${proposal.id}`,
      async () => {
        const current = documentBufferFor(capture.kind);
        if (proposal.batch) {
          if (
            current !== capture.session ||
            current?.project.projectId !== capture.projectId ||
            current.epoch !== capture.epoch ||
            current.text !== capture.text ||
            current.pending ||
            current.text !== current.project.text
          )
            throw new ApiError("AGENT_CONTEXT_STALE");
        } else validateAgent(capture);
        if (!current) throw new ApiError("AGENT_CONTEXT_STALE");
        const proposedText = proposal.batch
          ? null
          : proposalText(capture, proposal);
        current.saving = true;
        redraw();
        const pending = platformClient
          .agent!.apply(capture.projectId, sessionId, turnId, proposal.id)
          .then(async (result) => {
            const saved = proposal.batch
              ? await client.readDocument(capture.projectId, capture.kind)
              : null;
            if (documentBufferFor(capture.kind) !== current) return;
            const text = saved?.text ?? proposedText!;
            current.project = {
              ...current.project,
              text,
              revision: saved?.revision ?? result.revision,
            };
            current.failed = false;
            if (
              current.epoch === capture.epoch &&
              current.text === capture.text
            ) {
              current.text = text;
              current.epoch++;
              current.editorSession++;
              current.paused = false;
            } else {
              current.paused = true;
              current.pauseReason = "AGENT_NEWER_INPUT";
              notice.report("AGENT_NEWER_INPUT");
            }
            void refreshAnnotations(capture.kind, capture.projectId).catch(
              notice.report,
            );
          })
          .finally(() => {
            if (current.pending === pending) delete current.pending;
            current.saving = false;
            redraw();
          });
        current.pending = pending;
        await pending;
      },
    );
    if (delivered === false) throw new ApiError("AGENT_CONTEXT_STALE");
  }
  function same(captured: Buffer | null, epoch: number | undefined) {
    if (buffer.current !== captured || captured?.epoch !== epoch)
      throw new ApiError("MARKDOWN_SWITCH_PENDING");
  }
  async function open(text: () => Promise<string>) {
    if (switching.current) return;
    switching.current = true;
    setBusy(true);
    try {
      await composition.run("open", async () => {
        const captured = buffer.current;
        const epoch = captured?.epoch;
        const outline = outlineBuffer.current;
        const outlineEpoch = outline?.epoch;
        const assertOutline = () => {
          if (
            outlineBuffer.current !== outline ||
            outline?.epoch !== outlineEpoch
          )
            throw new ApiError("MARKDOWN_SWITCH_PENDING");
        };
        const nextText = await text();
        same(captured, epoch);
        if (buffer.current?.pending) await buffer.current.pending;
        same(captured, epoch);
        if (captured) await save();
        same(captured, epoch);
        if (outline?.pending) await outline.pending;
        assertOutline();
        if (outline && outline.text !== outline.project.text)
          await save(undefined, "outline");
        same(captured, epoch);
        assertOutline();
        const project = await client.create(nextText);
        same(captured, epoch);
        assertOutline();
        install(project);
      });
    } catch (failure) {
      notice.report(failure);
    } finally {
      switching.current = false;
      setBusy(false);
    }
  }
  function importFile(file: File, count: number) {
    if (count !== 1 || !/\.(md|zip)$/i.test(file.name)) {
      notice.report("MARKDOWN_IMPORT_INVALID");
      return;
    }
    if (/\.zip$/i.test(file.name)) {
      if (!buffer.current) notice.report("MARKDOWN_IMPORT_NO_PROJECT");
      else void importChanges(file);
      return;
    }
    void open(async () => {
      if (file.size > 2 * 1024 * 1024)
        throw new ApiError("MARKDOWN_TEXT_INVALID");
      try {
        return new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(await file.arrayBuffer());
      } catch {
        throw new ApiError("MARKDOWN_TEXT_INVALID");
      }
    });
  }
  function download() {
    const kind = activeKind();
    const captured = documentBufferFor(kind);
    void composition
      .run("download", () => {
        const current = documentBufferFor(kind);
        if (!current || current !== captured) return;
        deliver(
          new TextEncoder().encode(current.text),
          `${kind}.md`,
          "text/markdown;charset=utf-8",
        );
      })
      .catch(notice.report);
  }
  function deliver(bytes: Uint8Array<ArrayBuffer>, name: string, type: string) {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function downloadProject() {
    if (exchangeRunning.current) return;
    exchangeRunning.current = true;
    setExchangeBusy(true);
    try {
      await composition.run("download-project", async () => {
        const captured = (["manuscript", "outline"] as const).map((kind) => {
          const session = documentBufferFor(kind);
          return { kind, session, epoch: session?.epoch, text: session?.text };
        });
        const assert = () => {
          for (const { kind, session, epoch, text } of captured) {
            if (
              !session ||
              documentBufferFor(kind) !== session ||
              session.epoch !== epoch ||
              session.text !== text
            )
              throw new ApiError("MARKDOWN_EXCHANGE_EXPORT_CHANGED");
          }
        };
        for (const { kind, session } of captured) {
          if (session?.pending) await session.pending;
          assert();
          if (session && session.text !== session.project.text)
            await save(undefined, kind);
          assert();
        }
        const saved = buffer.current!.project;
        const bytes = await client.download(
          saved.projectId,
          saved.revision!,
          outlineBuffer.current!.project.revision,
        );
        assert();
        deliver(
          bytes as Uint8Array<ArrayBuffer>,
          "scenesparrow-project.zip",
          "application/zip",
        );
        notice.report("MARKDOWN_PROJECT_EXPORTED", { tone: "success" });
      });
    } catch (failure) {
      notice.report(failure);
    } finally {
      exchangeRunning.current = false;
      setExchangeBusy(false);
    }
  }
  async function importChanges(file: File) {
    if (exchangeRunning.current) return;
    exchangeRunning.current = true;
    setExchangeBusy(true);
    try {
      await composition.run("import-changes", async () => {
        const projectId = buffer.current!.project.projectId;
        const captures = Object.fromEntries(
          (["manuscript", "outline"] as const).map((kind) => {
            const session = documentBufferFor(kind);
            return [
              kind,
              {
                session,
                epoch: session?.epoch,
                text: session?.text,
                revision: session?.project.revision,
              },
            ];
          }),
        ) as Record<MarkdownDocumentKind, ExchangeDocumentCandidate["capture"]>;
        if (file.size > MARKDOWN_EXCHANGE_MAX_BYTES)
          throw new ApiError("MARKDOWN_EXCHANGE_INVALID");
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (buffer.current !== captures.manuscript.session) return;
        const review = await client.review(projectId, bytes);
        if (buffer.current !== captures.manuscript.session) return;
        const candidate = {
          documents: review.documents.map((document) => ({
            ...document,
            capture: captures[document.kind],
          })),
        };
        exchangeRef.current = candidate;
        setExchange(candidate);
        setView("exchange");
        setSeparateProject(null);
      });
    } catch (failure) {
      notice.report(failure);
    } finally {
      exchangeRunning.current = false;
      setExchangeBusy(false);
    }
  }
  function exchangeChanged(candidate: ExchangeDocumentCandidate) {
    const value = documentBufferFor(candidate.kind);
    const base = candidate.capture;
    return (
      !!candidate.conflict ||
      value !== base.session ||
      value?.epoch !== base.epoch ||
      value?.text !== base.text ||
      value?.project.revision !== base.revision ||
      candidate.currentRevision !== candidate.baseRevision ||
      value?.project.revision !== candidate.baseRevision ||
      value?.text !== value?.project.text
    );
  }
  async function applyChanges(candidate: ExchangeDocumentCandidate) {
    const review = exchangeRef.current;
    if (!review || applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true);
    const assert = () => {
      if (exchangeRef.current !== review || exchangeChanged(candidate))
        throw new ApiError("MARKDOWN_EXCHANGE_CONFLICT");
    };
    try {
      await composition.run(`apply-changes:${candidate.kind}`, async () => {
        assert();
        const pending = documentBufferFor(candidate.kind)?.pending;
        if (pending) await pending;
        assert();
        await save({ text: candidate.text }, candidate.kind);
        if (exchangeRef.current !== review) return;
        const value = documentBufferFor(candidate.kind);
        if (
          value !== candidate.capture.session ||
          value?.text !== candidate.text ||
          value?.paused
        ) {
          candidate.conflict = "MARKDOWN_EXCHANGE_CONFLICT";
          redraw();
          return;
        }
        const documents = review.documents.filter(
          (document) => document !== candidate,
        );
        if (documents.length) {
          exchangeRef.current = { documents };
          setExchange(exchangeRef.current);
        } else {
          exchangeRef.current = null;
          setExchange(null);
          setView(candidate.kind);
        }
      });
    } catch (failure) {
      if (failure instanceof ApiError) {
        candidate.conflict = failure.code;
        redraw();
      }
      notice.report(failure);
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  }
  async function saveReturnedSeparately() {
    const review = exchangeRef.current;
    const candidate = review?.documents.find(
      (document) => document.kind === "manuscript",
    );
    if (!candidate || exchangeRunning.current) return;
    exchangeRunning.current = true;
    setExchangeBusy(true);
    try {
      const project = await client.create(candidate.text);
      if (exchangeRef.current !== review) return;
      const url = new URL(window.location.href);
      url.searchParams.set("project", project.projectId);
      setSeparateProject(url.href);
    } catch (failure) {
      notice.report(failure);
    } finally {
      exchangeRunning.current = false;
      setExchangeBusy(false);
    }
  }
  return (
    <SettingsActions.Provider
      value={(section) =>
        setSettingsSection(section === "general" ? "general" : "agent")
      }
    >
      <div className="workspace markdown-workspace">
        <NotificationPresenter t={t} />
        <a className="skip-link" href="#markdown-editor">
          {t.skipToWorkbench}
        </a>
        <WorkspaceRibbon
          t={t}
          onWrite={() =>
            (activeKind() === "outline"
              ? outlineEditor
              : editor
            ).current?.commands.focus()
          }
        />
        <header className="workspace-header">
          <div className="workspace-brand">{t.appName}</div>
          <div className="workspace-actions">
            <FileMenu
              t={t}
              create={{
                disabled: loading || busy,
                run: () => void open(async () => ""),
              }}
              importFile={{
                disabled: loading || busy || exchangeBusy,
                run: () => fileInput.current?.click(),
              }}
              save={{ disabled: !activeBuffer || saving, run: runSave }}
              exportMarkdown={{ disabled: !activeBuffer, run: download }}
              exportProject={{
                disabled: !current || exchangeBusy,
                savesFirst: [buffer.current, outlineBuffer.current].some(
                  (value) =>
                    value &&
                    (value.text !== value.project.text ||
                      value.saving === true),
                ),
                run: () => void downloadProject(),
              }}
            />
            <input
              ref={fileInput}
              hidden
              type="file"
              accept=".md,text/markdown,.zip,application/zip"
              onChange={(event) => {
                const files = event.currentTarget.files;
                const file = files?.[0];
                const count = files?.length ?? 0;
                event.currentTarget.value = "";
                if (file) importFile(file, count);
              }}
            />
            <label className="language">
              <span>{t.language}</span>
              <select
                aria-label={t.language}
                value={locale}
                onChange={(event) => setLocale(event.target.value)}
              >
                <option value="en">English</option>
                <option value="zh-CN">简体中文</option>
              </select>
            </label>
            <button
              className="quiet-button settings-trigger"
              aria-label={t.settings}
              title={t.settings}
              onClick={() => setSettingsSection("general")}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                width="20"
                height="20"
              >
                <path
                  d="m9 3-.6 2.3-2 .9-2.1-.6L2.8 8.2l1.5 1.7-.2 2.3-1.4 1.9L4.4 17l2.4-.4 1.9 1.3.5 2.4h3.5l.7-2.4 2-1.1 2.3.5 1.8-3-1.5-1.8.1-2.3 1.5-1.8-1.7-2.8-2.3.4-1.9-1.2L12.5 3H9Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <circle
                  cx="10.8"
                  cy="11.5"
                  r="3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
            </button>
          </div>
        </header>
        <main id="workbench" aria-label={t.workbench}>
          <section className="project-workbench">
            <div className="manuscript-workspace">
              <WorkspacePane
                pane={pane}
                t={t}
                availableTabs={{
                  left: ["structure"],
                  right: ["agent"],
                }}
                panels={{
                  structure: current ? (
                    <HeadingNavigation
                      text={view === "outline" ? outlineText : current.text}
                      label={t.workspaceTab_structure}
                      empty={t.noHeadings}
                      onSelect={(offset) => {
                        if (view === "outline") {
                          const outline = outlineEditor.current;
                          const projection = projectSource(outlineText);
                          const index = projection?.ranges.findIndex(
                            (range) => range.start === offset,
                          );
                          if (outline && index !== undefined && index >= 0) {
                            let position = 1;
                            for (let i = 0; i < index; i++)
                              position += outline.state.doc.child(i).nodeSize;
                            outline
                              .chain()
                              .focus()
                              .setTextSelection(position)
                              .scrollIntoView()
                              .run();
                          }
                          return;
                        }
                        const projection = projectSource(current.text);
                        const index = projection?.ranges.findIndex(
                          (range) => range.start === offset,
                        );
                        if (
                          index !== undefined &&
                          index >= 0 &&
                          editor.current
                        ) {
                          let position = 1;
                          for (let i = 0; i < index; i++)
                            position +=
                              editor.current.state.doc.child(i).nodeSize;
                          editor.current
                            .chain()
                            .focus()
                            .setTextSelection(position)
                            .scrollIntoView()
                            .run();
                        } else openSource(offset);
                      }}
                    />
                  ) : null,
                  planning: null,
                  review: null,
                  sources: null,
                }}
                rightContent={
                  current ? (
                    <>
                      <section
                        role="tabpanel"
                        id="auxiliary-agent"
                        aria-labelledby="auxiliary-tab-agent"
                        hidden={pane.right.tab !== "agent"}
                        inert={pane.right.tab !== "agent"}
                        className="agent-panel"
                      >
                        <AgentConversation
                          key={current.project.projectId}
                          client={platformClient.agent}
                          catalog={agentCatalog}
                          projectId={current.project.projectId}
                          t={t}
                          active={
                            pane.right.tab === "agent" && pane.visible("right")
                          }
                          composition={composition}
                          contextLabel={`${(agentAttachment?.kind ?? activeKind()) === "outline" ? t.writingOutline : t.manuscript} · ${agentExcerpt !== null ? `${t.agentSelectionContext}: ${agentExcerpt}` : t.agentDocumentContext}`}
                          clearSelection={
                            agentAttachment
                              ? () => setAgentAttachment(null)
                              : undefined
                          }
                          prepareIntent={() => {
                            const kind = agentAttachment?.kind ?? activeKind();
                            const owner =
                              agentAttachment?.owner ?? documentBufferFor(kind);
                            return () => prepareAgent(kind, owner);
                          }}
                          validate={(capture) =>
                            validateAgent(capture, "AGENT_CONTEXT_STALE")
                          }
                          apply={applyAgent}
                          restoreCapture={(context) => {
                            const owner = documentBufferFor(context.kind);
                            if (
                              !owner ||
                              owner.project.projectId !== context.projectId ||
                              (!context.batch &&
                                owner.project.revision !== context.revision) ||
                              owner.text !== owner.project.text
                            )
                              throw new ApiError("MARKDOWN_CONFLICT");
                            return {
                              projectId: context.projectId,
                              kind: context.kind,
                              session: owner,
                              epoch: owner.epoch,
                              text: owner.text,
                              revision: context.revision,
                              selection: context.selection,
                            };
                          }}
                          jump={(context, scope) => {
                            const owner = documentBufferFor(context.kind);
                            if (
                              !owner ||
                              owner.project.projectId !== context.projectId ||
                              owner.project.revision !== context.revision ||
                              owner.text !== owner.project.text
                            )
                              throw new ApiError("MARKDOWN_CONFLICT");
                            flushSync(() =>
                              setView(
                                context.kind === "outline"
                                  ? "outline"
                                  : "manuscript",
                              ),
                            );
                            const target =
                              context.kind === "outline"
                                ? outlineEditor.current
                                : editor.current;
                            if (!target) {
                              openSource(
                                utf16Offset(owner.text, scope.range.start),
                              );
                              const input = sourceInput.current;
                              if (input) {
                                input.setSelectionRange(
                                  input.selectionStart,
                                  visibleSource(
                                    owner.text.slice(
                                      0,
                                      utf16Offset(owner.text, scope.range.end),
                                    ),
                                  ).length,
                                );
                                selectSource(input, context.kind);
                              }
                              return;
                            }
                            const sourceRange = {
                              start: utf16Offset(owner.text, scope.range.start),
                              end: utf16Offset(owner.text, scope.range.end),
                            };
                            const spans = commentSpans(
                              target.state.doc,
                              owner.text,
                              sourceRange,
                            );
                            if (spans.length)
                              target
                                .chain()
                                .focus()
                                .setTextSelection({
                                  from: spans[0]!.from,
                                  to: spans.at(-1)!.to,
                                })
                                .scrollIntoView()
                                .run();
                          }}
                          generate={generateInConversation}
                          openGeneration={openGeneration}
                          review={
                            <MarkdownReview
                              key={current.project.projectId}
                              client={platformClient}
                              t={t}
                              kind={activeKind()}
                              annotations={annotations[activeKind()]}
                              selection={
                                selections[activeKind()]?.ranges.length
                                  ? selections[activeKind()]
                                  : null
                              }
                              composition={composition}
                              prepare={prepareReview}
                              validate={validateReview}
                              annotated={(capture, data) => {
                                if (
                                  documentBufferFor(capture.kind) ===
                                  capture.session
                                ) {
                                  if (
                                    documentBufferFor(capture.kind)?.project
                                      .revision === capture.revision
                                  )
                                    annotated(capture.kind, data);
                                  else
                                    void refreshAnnotations(
                                      capture.kind,
                                      capture.projectId,
                                    ).catch(notice.report);
                                }
                              }}
                              applied={(capture, saved) => {
                                const current = documentBufferFor(capture.kind);
                                if (current !== capture.session) return;
                                current.project = saved;
                                if (current.epoch === capture.epoch) {
                                  current.text = saved.text;
                                  current.epoch++;
                                  current.editorSession++;
                                } else current.paused = true;
                                void refreshAnnotations(
                                  capture.kind,
                                  saved.projectId,
                                ).catch(notice.report);
                                redraw();
                              }}
                              locate={(comment) => {
                                if (comment.anchor.resolvedStart !== null)
                                  openSource(
                                    utf16Offset(
                                      documentBufferFor(comment.kind)?.text ??
                                        "",
                                      comment.anchor.resolvedStart,
                                    ),
                                  );
                              }}
                            />
                          }
                        />
                      </section>
                    </>
                  ) : null
                }
              >
                <div className="manuscript-header">
                  <div
                    className="writing-view-switch"
                    role="group"
                    aria-label={t.writingView}
                  >
                    <button
                      aria-pressed={view === "manuscript"}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setView("manuscript")}
                    >
                      {t.manuscript}
                    </button>
                    <button
                      aria-pressed={view === "outline"}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setView("outline")}
                    >
                      {t.writingOutline}
                    </button>
                    {draft && (
                      <button
                        aria-pressed={view === "draft"}
                        onClick={() => setView("draft")}
                      >
                        {t.markdownDraftPreview}
                      </button>
                    )}
                    {exchange && (
                      <button
                        aria-pressed={view === "exchange"}
                        onClick={() => setView("exchange")}
                      >
                        {t.markdownExchangePreview}
                      </button>
                    )}
                  </div>
                  <div className="manuscript-context">
                    <h3>
                      {(view === "outline"
                        ? outlineText
                        : (current?.text ?? "")
                      )
                        .replace(/^\ufeff/, "")
                        .match(/^#{1,6} +(.+)/m)?.[1] ||
                        (view === "outline" ? t.writingOutline : t.manuscript)}
                    </h3>
                    <div className="save-feedback">
                      <span role="status" data-testid="save-status">
                        {saving
                          ? t.save_saving
                          : saveFailed
                            ? t.save_error
                            : dirty
                              ? t.save_pending
                              : current
                                ? t.save_saved
                                : loading
                                  ? t.workspaceLoading
                                  : ""}
                      </span>
                      {(saveFailed || autosavePaused) && (
                        <button onClick={runSave}>{t.markdownSave}</button>
                      )}
                    </div>
                  </div>
                  {(view === "outline" || view === "manuscript") && (
                    <button
                      type="button"
                      className="markdown-icon-button"
                      title={t.markdownCopySource}
                      aria-label={t.markdownCopySource}
                      disabled={!activeBuffer}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void copyMarkdown()}
                    >
                      <WorkspaceIcon name="copy" />
                    </button>
                  )}
                  <details className="document-menu" ref={documentMenu}>
                    <summary
                      aria-label={t.documentMenu}
                      title={t.documentMenu}
                      onMouseDown={(event) => event.preventDefault()}
                    >
                      <WorkspaceIcon name="menu" />
                    </summary>
                    <div className="document-menu-content">
                      <button
                        disabled={!activeBuffer}
                        onClick={() => openSource()}
                      >
                        {t.markdownEditSource}
                      </button>
                      <button
                        onMouseDown={(event) => event.preventDefault()}
                        disabled={
                          !(view === "outline" ? outlineEditor : editor).current
                            ?.can()
                            .undo()
                        }
                        onClick={() => {
                          (view === "outline" ? outlineEditor : editor).current
                            ?.chain()
                            .focus()
                            .undo()
                            .run();
                          if (documentMenu.current)
                            documentMenu.current.open = false;
                        }}
                      >
                        {t.undo}
                        <kbd>Ctrl/⌘ Z</kbd>
                      </button>
                      <button
                        onMouseDown={(event) => event.preventDefault()}
                        disabled={
                          !(view === "outline" ? outlineEditor : editor).current
                            ?.can()
                            .redo()
                        }
                        onClick={() => {
                          (view === "outline" ? outlineEditor : editor).current
                            ?.chain()
                            .focus()
                            .redo()
                            .run();
                          if (documentMenu.current)
                            documentMenu.current.open = false;
                        }}
                      >
                        {t.redo}
                        <kbd>Ctrl/⌘ ⇧ Z</kbd>
                      </button>
                    </div>
                  </details>
                </div>
                {autosavePaused && (
                  <p className="markdown-conflict">
                    {
                      t[
                        activeBuffer?.pauseReason ??
                          "MARKDOWN_DRAFT_NEWER_INPUT"
                      ]
                    }
                  </p>
                )}
                {!current && !loading && <p>{t.markdownOpenFailed}</p>}
                <div
                  className="outline-surface"
                  hidden={view !== "outline"}
                  inert={view !== "outline"}
                >
                  {!outlineCurrent && !loading && (
                    <p>{t.markdownOutlineOpenFailed}</p>
                  )}
                  {outlineCurrent &&
                    (outlineProjection ? (
                      <MarkdownEditor
                        key={`${outlineCurrent.project.projectId}:${outlineCurrent.editorSession}`}
                        projection={outlineProjection}
                        guard={(text) =>
                          protectsSource(
                            outlineBuffer.current?.text ?? "",
                            text,
                            annotationsRef.current.outline,
                          )
                        }
                        selection={(ranges, range, source, explicit) =>
                          setSelections((current) => ({
                            ...current,
                            outline:
                              ranges.length || explicit
                                ? { ranges, range, source, explicit }
                                : null,
                          }))
                        }
                        annotations={annotations.outline}
                        ask={() => askSelection("outline")}
                        comment={(source, range, text, existing, resolve) =>
                          inlineComment(
                            "outline",
                            source,
                            range,
                            text,
                            existing,
                            resolve,
                          )
                        }
                        lock={(ranges, source) =>
                          toggleLock("outline", {
                            ranges,
                            range: ranges[0]!,
                            source,
                            explicit: false,
                          })
                        }
                        scope="outline"
                        autofocus={false}
                        t={{ ...t, markdownText: t.markdownWritingOutline }}
                        composition={composition}
                        changed={(text) => {
                          if (!sourceOpen.current) changed(text, "outline");
                        }}
                        save={() => runDocumentSave("outline")}
                        ready={(value) => {
                          outlineEditor.current = value;
                        }}
                      />
                    ) : (
                      <div className="source-fallback">
                        {sourceActions("outline")}
                        {sourceField("outline")}
                      </div>
                    ))}
                </div>
                <div
                  className="document-layout"
                  hidden={view !== "manuscript"}
                  inert={view !== "manuscript"}
                >
                  {current &&
                    (projection ? (
                      <MarkdownEditor
                        key={`${current.project.projectId}:${current.editorSession}`}
                        projection={projection}
                        guard={(text) =>
                          protectsSource(
                            buffer.current?.text ?? "",
                            text,
                            annotationsRef.current.manuscript,
                          )
                        }
                        selection={(ranges, range, source, explicit) =>
                          setSelections((current) => ({
                            ...current,
                            manuscript:
                              ranges.length || explicit
                                ? { ranges, range, source, explicit }
                                : null,
                          }))
                        }
                        annotations={annotations.manuscript}
                        ask={() => askSelection("manuscript")}
                        comment={(source, range, text, existing, resolve) =>
                          inlineComment(
                            "manuscript",
                            source,
                            range,
                            text,
                            existing,
                            resolve,
                          )
                        }
                        lock={(ranges, source) =>
                          toggleLock("manuscript", {
                            ranges,
                            range: ranges[0]!,
                            source,
                            explicit: false,
                          })
                        }
                        t={t}
                        composition={composition}
                        changed={(text) => {
                          if (!sourceOpen.current) changed(text);
                        }}
                        save={runSave}
                        ready={(value) => {
                          editor.current = value;
                        }}
                      />
                    ) : (
                      <div className="source-fallback">
                        {sourceActions("manuscript")}
                        {sourceField("manuscript")}
                      </div>
                    ))}
                </div>
                {current && exchange && (
                  <section
                    className="markdown-draft markdown-exchange"
                    hidden={view !== "exchange"}
                    inert={view !== "exchange"}
                    aria-label={t.markdownExchangePreview}
                  >
                    <div className="dialog-heading">
                      <h2>{t.markdownExchangePreview}</h2>
                      <button
                        disabled={applying}
                        onClick={() => {
                          exchangeRef.current = null;
                          setExchange(null);
                          setView("manuscript");
                        }}
                      >
                        {t.markdownKeepCurrent}
                      </button>
                    </div>
                    <p>{t.markdownExchangeHelp}</p>
                    <ExchangeReview
                      documents={exchange.documents.map((candidate) => ({
                        kind: candidate.kind,
                        text: candidate.text,
                        current: documentBufferFor(candidate.kind)?.text ?? "",
                        conflict: exchangeChanged(candidate)
                          ? (candidate.conflict ?? "MARKDOWN_EXCHANGE_CONFLICT")
                          : null,
                      }))}
                      t={t}
                      applying={applying}
                      apply={(kind) =>
                        void applyChanges(
                          exchange.documents.find(
                            (candidate) => candidate.kind === kind,
                          )!,
                        )
                      }
                      saveSeparate={saveReturnedSeparately}
                      separateBusy={exchangeBusy || !!separateProject}
                      separateProject={separateProject}
                    />
                  </section>
                )}
                {draft && (
                  <section
                    className="markdown-draft"
                    hidden={view !== "draft"}
                    inert={view !== "draft"}
                    aria-label={t.markdownDraftPreview}
                  >
                    <div className="dialog-heading">
                      <h2>{t.markdownDraftPreview}</h2>
                      <button
                        disabled={applying}
                        onClick={() => {
                          draftRef.current = null;
                          setDraft(null);
                          setView("manuscript");
                        }}
                      >
                        {t.close}
                      </button>
                    </div>
                    <p>{t.markdownDraftHelp}</p>
                    {draftChanged(draft) && (
                      <p className="markdown-conflict">
                        {t.MARKDOWN_DRAFT_CONFLICT}
                      </p>
                    )}
                    <MarkdownPreview text={draft.text} />
                    <button
                      disabled={applying || draftChanged(draft)}
                      onClick={() => void useDraft()}
                    >
                      {t.markdownUseDraft}
                    </button>
                  </section>
                )}
              </WorkspacePane>
            </div>
          </section>
        </main>
        <dialog
          ref={sourceDialog}
          className="markdown-source-dialog"
          aria-labelledby="markdown-source-title"
          onKeyDown={(event) => trapDialogFocus(event, event.currentTarget)}
          onCancel={(event) => {
            event.preventDefault();
            closeSource();
          }}
        >
          <div className="dialog-heading">
            <h2 id="markdown-source-title">{t.markdownRawSourceTitle}</h2>
            <button
              className="quiet-button"
              aria-label={t.closeMarkdownSource}
              onClick={() => closeSource()}
            >
              <WorkspaceIcon name="close" />
            </button>
          </div>
          <p className="muted">{t.markdownRawSourceHelp}</p>
          {sourceActions(sourceKind.current)}
          {sourceField(sourceKind.current, true)}
        </dialog>
        <dialog
          ref={settings}
          className="settings-dialog"
          aria-label={t.settings}
          onClose={() => setSettingsSection(null)}
          onKeyDown={(event) => trapDialogFocus(event, event.currentTarget)}
        >
          <div className="dialog-heading">
            <h2>{t.settings}</h2>
            <button
              className="quiet-button"
              onClick={() => settings.current?.close()}
            >
              {t.close}
            </button>
          </div>
          <div className="settings-layout">
            <nav aria-label={t.settingsSections}>
              {(["general", "agent"] as const).map((section) => (
                <button
                  key={section}
                  aria-current={
                    settingsSection === section ? "page" : undefined
                  }
                  onClick={() => setSettingsSection(section)}
                >
                  {section === "general"
                    ? t.generalSettings
                    : t.workspaceTab_agent}
                </button>
              ))}
            </nav>
            <div className="settings-content">
              <section hidden={settingsSection !== "general"}>
                <h3>{t.generalSettings}</h3>
                <p>{t.applicationPreferencesHelp}</p>
                <label>
                  {t.interfaceLanguage}
                  <select
                    value={locale}
                    onChange={(event) => setLocale(event.target.value)}
                  >
                    <option value="en">English</option>
                    <option value="zh-CN">简体中文</option>
                  </select>
                </label>
                <label>
                  {t.autosaveMode}
                  <select
                    value={preferences.saveMode}
                    onChange={(event) =>
                      applicationPreferences.update({
                        saveMode: event.target.value as SaveMode,
                      })
                    }
                  >
                    <option value="after_delay">{t.autosaveAfterDelay}</option>
                    <option value="on_window_change">
                      {t.autosaveOnWindowChange}
                    </option>
                    <option value="off">{t.autosaveOff}</option>
                  </select>
                </label>
                {preferences.saveMode === "after_delay" && (
                  <label>
                    {t.autosaveDelay}
                    <select
                      value={preferences.saveDelaySeconds}
                      onChange={(event) =>
                        applicationPreferences.update({
                          saveDelaySeconds: Number(
                            event.target.value,
                          ) as SaveDelay,
                        })
                      }
                    >
                      {([5, 10, 30] as const).map((seconds) => (
                        <option key={seconds} value={seconds}>
                          {t.autosaveSeconds.replace(
                            "{seconds}",
                            String(seconds),
                          )}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <p className="muted">{t.manualSaveHelp}</p>
              </section>
              <AgentSettings
                client={platformClient}
                open={settingsSection !== null}
                catalog={agentCatalog}
                t={t}
                active={settingsSection === "agent"}
              />
            </div>
          </div>
        </dialog>
      </div>
    </SettingsActions.Provider>
  );
}
