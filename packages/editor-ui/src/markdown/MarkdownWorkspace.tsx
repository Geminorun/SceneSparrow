import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import type {
  MarkdownExchangeReview,
  MarkdownProject,
  MarkdownDocument,
  MarkdownDocumentKind,
} from "@scenesparrow/contracts";
import { ApiError, type PlatformClient } from "@scenesparrow/platform-client";
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
import { AiSettings } from "../ai-settings/AiSettings";
import { WorkspacePane, useAuxiliaryPane } from "../workbench/WorkspacePane";
import { WorkspaceIcon } from "../ui/WorkspaceIcon";
import { trapDialogFocus } from "../ui/dialog-focus";
import type { Editor } from "@tiptap/core";
import { MarkdownEditor } from "./MarkdownEditor";
import { FileMenu } from "./FileMenu";
import { projectSource } from "./source-projection";
import {
  MarkdownWriting,
  type WritingCapture,
  type WritingDraft,
} from "./MarkdownWriting";
import { MarkdownPreview } from "./MarkdownPreview";
import { ExchangeComparison } from "./ExchangeComparison";
import { HeadingNavigation } from "./HeadingNavigation";
import en from "../locales/en.json";
import zhCN from "../locales/zh-CN.json";

type ExchangeCandidate = WritingDraft & {
  review: MarkdownExchangeReview;
  conflict: boolean;
};
type Buffer = {
  project: MarkdownDocument;
  text: string;
  epoch: number;
  saving?: boolean;
  failed?: boolean;
  paused?: boolean;
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
const withoutBom = (text: string) =>
  text.startsWith("\ufeff") ? text.slice(1) : text;
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
  const pane = useAuxiliaryPane();
  const [view, setView] = useState<
    "manuscript" | "outline" | "draft" | "exchange"
  >("manuscript");
  const settings = useRef<HTMLDialogElement>(null);
  const sourceDialog = useRef<HTMLDialogElement>(null);
  const sourceInput = useRef<HTMLTextAreaElement>(null);
  const documentMenu = useRef<HTMLDetailsElement>(null);
  const [source, setSource] = useState("");
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
    adoption?: WritingDraft,
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
              ...(adoption?.kind === "manuscript"
                ? { outlineRevision: adoption.capture.outline!.revision! }
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
          if (!retainedNewerInput) current.paused = false;
          current.failed = false;
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
      (candidate.kind !== undefined &&
        base.outline !== undefined &&
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
  async function useDraft() {
    const candidate = draftRef.current;
    if (!candidate || applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true);
    try {
      await composition.run("use-draft", async () => {
        assertDraft(candidate);
        const pending = documentBufferFor(
          candidate.kind ?? "manuscript",
        )?.pending;
        if (pending) await pending;
        assertDraft(candidate);
        await save(candidate, candidate.kind ?? "manuscript");
        if (draftRef.current === candidate) {
          draftRef.current = null;
          setDraft(null);
          setView(candidate.kind ?? "manuscript");
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
  const saving = !!activeBuffer?.saving;
  const saveFailed = !!activeBuffer?.failed;
  const autosavePaused = !!activeBuffer?.paused;
  useEffect(() => {
    if (settingsSection) settings.current?.showModal();
  }, [settingsSection]);
  function openSource(offset = 0) {
    if (documentMenu.current) documentMenu.current.open = false;
    sourceKind.current = activeKind();
    sourceBase.current = documentBufferFor(sourceKind.current)?.text ?? "";
    sourceOpen.current = true;
    flushSync(() =>
      setSource(withoutBom(sourceBase.current).replace(/\r\n?/g, "\n")),
    );
    sourceDialog.current?.showModal();
    sourceInput.current?.focus();
    sourceInput.current?.setSelectionRange(offset, offset);
  }
  function closeSource() {
    sourceDialog.current?.close();
    sourceOpen.current = false;
    const current = documentBufferFor(sourceKind.current);
    if (current?.text !== sourceBase.current) {
      if (current) current.editorSession++;
      redraw();
    } else
      (sourceKind.current === "outline"
        ? outlineEditor
        : editor
      ).current?.commands.focus();
  }
  function sourceChanged(value: string) {
    const raw = documentBufferFor(sourceKind.current)?.text ?? "";
    const visible = withoutBom(raw).replace(/\r\n?/g, "\n");
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
    const offsets = [raw.startsWith("\ufeff") ? 1 : 0];
    for (let index = offsets[0]!; index < raw.length; index++) {
      if (raw[index] === "\r" && raw[index + 1] === "\n") index++;
      offsets.push(index + 1);
    }
    const newline = /\r\n|\r|\n/.exec(raw)?.[0] ?? "\n";
    changed(
      raw.slice(0, offsets[start]) +
        value.slice(start, value.length - end).replace(/\n/g, newline) +
        raw.slice(offsets[visible.length - end]),
      sourceKind.current,
    );
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
    current.text = value;
    current.epoch++;
    current.editedAt = Date.now();
    redraw();
  }
  async function prepareWriting(
    kind: "outline" | "draft",
  ): Promise<WritingCapture> {
    const captured = capture();
    if (kind === "draft") {
      const outline = outlineBuffer.current;
      if (!outline) throw new ApiError("MARKDOWN_WRITING_INVALID");
      if (outline.pending) await outline.pending;
      if (draftChanged({ capture: captured, text: "", kind: "manuscript" }))
        throw new ApiError("MARKDOWN_DRAFT_CONFLICT");
      await save(undefined, "outline");
      if (draftChanged({ capture: captured, text: "", kind: "manuscript" }))
        throw new ApiError("MARKDOWN_DRAFT_CONFLICT");
    }
    return capture();
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
        const base = capture();
        const captured = buffer.current;
        const assert = () => same(captured, base.epoch);
        if (buffer.current?.pending) await buffer.current.pending;
        assert();
        await save();
        assert();
        const saved = buffer.current!.project;
        const bytes = await client.download(saved.projectId, saved.revision!);
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
        const base = capture();
        if (file.size > 2 * 1024 * 1024 + 65536)
          throw new ApiError("MARKDOWN_EXCHANGE_INVALID");
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (buffer.current !== base.session) return;
        const review = await client.review(base.projectId, bytes);
        if (buffer.current !== base.session) return;
        const candidate = {
          capture: base,
          text: review.text,
          review,
          conflict: false,
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
  function exchangeChanged(candidate: ExchangeCandidate) {
    const value = buffer.current;
    return (
      candidate.conflict ||
      draftChanged(candidate) ||
      candidate.review.currentRevision !== candidate.review.baseRevision ||
      value?.project.revision !== candidate.review.baseRevision ||
      value.text !== value.project.text
    );
  }
  async function applyChanges() {
    const candidate = exchangeRef.current;
    if (!candidate || applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true);
    const assert = () => {
      if (exchangeRef.current !== candidate || exchangeChanged(candidate))
        throw new ApiError("MARKDOWN_EXCHANGE_CONFLICT");
    };
    try {
      await composition.run("apply-changes", async () => {
        assert();
        if (buffer.current?.pending) await buffer.current.pending;
        assert();
        await save(candidate);
        if (exchangeRef.current === candidate) {
          exchangeRef.current = null;
          setExchange(null);
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
  async function saveReturnedSeparately() {
    const candidate = exchangeRef.current;
    if (!candidate || exchangeRunning.current) return;
    exchangeRunning.current = true;
    setExchangeBusy(true);
    try {
      const project = await client.create(candidate.text);
      if (exchangeRef.current !== candidate) return;
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
    <SettingsActions.Provider value={setSettingsSection}>
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
                savesFirst: dirty || saving,
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
                availableTabs={{ left: ["structure"], right: ["planning"] }}
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
                    <MarkdownWriting
                      key={current.project.projectId}
                      client={platformClient}
                      t={t}
                      composition={composition}
                      capture={prepareWriting}
                      validate={(capture) => {
                        if (
                          draftChanged({
                            capture,
                            text: "",
                            kind: "manuscript",
                          })
                        )
                          throw new ApiError("MARKDOWN_DRAFT_CONFLICT");
                      }}
                      outline={outlineCurrent ? outlineText : null}
                      onDraft={(candidate) => {
                        if (buffer.current !== candidate.capture.session)
                          return;
                        draftRef.current = candidate;
                        setDraft(candidate);
                        setView("draft");
                      }}
                    />
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
                        {draft.kind === "outline"
                          ? t.markdownOutlinePreview
                          : t.markdownDraftPreview}
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
                        {t.viewMarkdownSource}
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
                    {t.MARKDOWN_DRAFT_NEWER_INPUT}
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
                        <button onClick={() => openSource()}>
                          {t.viewMarkdownSource}
                        </button>
                        <MarkdownPreview text={outlineText} />
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
                        <p className="muted">{t.markdownVisualUnsupported}</p>
                        <button onClick={() => openSource()}>
                          {t.viewMarkdownSource}
                        </button>
                        <MarkdownPreview text={current.text} />
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
                    {exchangeChanged(exchange) && (
                      <p className="markdown-conflict">
                        {t.MARKDOWN_EXCHANGE_CONFLICT}
                      </p>
                    )}
                    {current.text === exchange.text ? (
                      <p>{t.markdownExchangeUnchanged}</p>
                    ) : (
                      <ExchangeComparison
                        current={current.text}
                        returned={exchange.text}
                        t={t}
                      />
                    )}
                    <button
                      disabled={
                        applying ||
                        exchangeChanged(exchange) ||
                        current.text === exchange.text
                      }
                      onClick={() => void applyChanges()}
                    >
                      {t.markdownApplyChanges}
                    </button>
                    <button
                      disabled={exchangeBusy || !!separateProject}
                      onClick={() => void saveReturnedSeparately()}
                    >
                      {t.markdownSaveReturned}
                    </button>
                    {separateProject && (
                      <a
                        href={separateProject}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t.markdownOpenReturned}
                      </a>
                    )}
                  </section>
                )}
                {draft && (
                  <section
                    className="markdown-draft"
                    hidden={view !== "draft"}
                    inert={view !== "draft"}
                    aria-label={
                      draft.kind === "outline"
                        ? t.markdownOutlinePreview
                        : t.markdownDraftPreview
                    }
                  >
                    <div className="dialog-heading">
                      <h2>
                        {draft.kind === "outline"
                          ? t.markdownOutlinePreview
                          : t.markdownDraftPreview}
                      </h2>
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
                      {draft.kind === "outline"
                        ? t.markdownUseOutline
                        : t.markdownUseDraft}
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
              onClick={closeSource}
            >
              <WorkspaceIcon name="close" />
            </button>
          </div>
          <p className="muted">{t.markdownRawSourceHelp}</p>
          <textarea
            ref={sourceInput}
            aria-label={t.markdownRawSourceTitle}
            value={source}
            spellCheck={false}
            onChange={(event) => {
              setSource(event.currentTarget.value);
              sourceChanged(event.currentTarget.value);
            }}
            onCompositionStart={() => composition.composition("source", true)}
            onCompositionEnd={() => composition.composition("source", false)}
            onBlur={() =>
              composition.blur("source", () =>
                composition.composition("source", false),
              )
            }
            onKeyDown={(event) => {
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key.toLowerCase() === "s"
              ) {
                event.preventDefault();
                runSave();
              }
            }}
          />
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
              {(["general", "services", "defaults"] as const).map((section) => (
                <button
                  key={section}
                  aria-current={
                    settingsSection === section ? "page" : undefined
                  }
                  onClick={() => setSettingsSection(section)}
                >
                  {section === "general"
                    ? t.generalSettings
                    : section === "services"
                      ? t.aiModels
                      : t.aiDefaultModels}
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
              <AiSettings
                client={platformClient}
                t={t}
                active={
                  settingsSection === "services" ||
                  settingsSection === "defaults"
                }
                open={settingsSection !== null}
                section={
                  settingsSection === "defaults" ? "defaults" : "services"
                }
              />
            </div>
          </div>
        </dialog>
      </div>
    </SettingsActions.Provider>
  );
}
