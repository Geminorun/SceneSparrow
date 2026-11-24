import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  MarkdownExchangeReview,
  MarkdownProject,
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
type Buffer = { project: MarkdownProject; text: string; epoch: number };
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
  const [, render] = useState(0);
  const [loading, setLoading] = useState(true);
  const pane = useAuxiliaryPane();
  const [view, setView] = useState<
    "manuscript" | "outline" | "draft" | "exchange"
  >("manuscript");
  const [outlineTarget, setOutlineTarget] = useState<HTMLDivElement | null>(
    null,
  );
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
  const exchangeInput = useRef<HTMLInputElement>(null);
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false);
  const [editorSession, setEditorSession] = useState(0);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection | null>(null);
  const [busy, setBusy] = useState(false);
  const switching = useRef(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [autosavePaused, setAutosavePaused] = useState(false);
  const pendingSave = useRef<Promise<void> | null>(null);
  const editor = useRef<Editor | null>(null);
  const outlineEditor = useRef<Editor | null>(null);
  const sourceBase = useRef("");
  const sourceOpen = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const projectMenu = useRef<HTMLDetailsElement>(null);
  const composition = useRef(new CompositionActions()).current;
  const notice = useNoticeOwner();
  const redraw = () => render((value) => value + 1);
  function install(project: MarkdownProject) {
    const url = new URL(window.location.href);
    url.searchParams.set("project", project.projectId);
    window.history.replaceState(null, "", url);
    try {
      localStorage.setItem(lastProjectKey, project.projectId);
    } catch {
      // The explicit URL remains usable when browser storage is unavailable.
    }
    buffer.current = { project, text: project.text, epoch: 0 };
    draftRef.current = null;
    setDraft(null);
    exchangeRef.current = null;
    setExchange(null);
    setSeparateProject(null);
    setView("manuscript");
    setSaveFailed(false);
    setAutosavePaused(false);
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
        (project) => {
          if (active) install(project);
        },
        (failure) => {
          if (active) notice.report(failure);
        },
      )
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
  function save(adoption?: WritingDraft): Promise<void> {
    if (pendingSave.current) return pendingSave.current;
    const current = buffer.current;
    if (!current || (!adoption && current.text === current.project.text))
      return Promise.resolve();
    const { project, epoch } = current;
    const text = adoption?.text ?? current.text;
    setSaving(true);
    const promise = client
      .save(project.projectId, { text, revision: project.revision })
      .then((saved) => {
        if (buffer.current === current) {
          current.project = saved;
          const retainedNewerInput = !!adoption && current.epoch !== epoch;
          if (adoption) {
            if (current.epoch === epoch) {
              current.text = saved.text;
              current.epoch++;
              setEditorSession((value) => value + 1);
            } else {
              setAutosavePaused(true);
              notice.report("MARKDOWN_DRAFT_NEWER_INPUT");
            }
          }
          if (!retainedNewerInput) setAutosavePaused(false);
          setSaveFailed(false);
          redraw();
        }
      })
      .catch((failure) => {
        setSaveFailed(true);
        throw failure;
      })
      .finally(() => {
        if (pendingSave.current === promise) pendingSave.current = null;
        setSaving(false);
      });
    pendingSave.current = promise;
    return promise;
  }
  function runSave() {
    void composition.run("save", () => save()).catch(notice.report);
  }
  function capture(): WritingCapture {
    const current = buffer.current;
    if (!current) throw new ApiError("MARKDOWN_WRITING_INVALID");
    return {
      session: current,
      projectId: current.project.projectId,
      revision: current.project.revision,
      text: current.text,
      epoch: current.epoch,
    };
  }
  function draftChanged(candidate: WritingDraft) {
    const current = buffer.current;
    const base = candidate.capture;
    return (
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
        if (pendingSave.current) await pendingSave.current;
        assertDraft(candidate);
        await save(candidate);
        if (draftRef.current === candidate) {
          draftRef.current = null;
          setDraft(null);
          setView("manuscript");
        }
      });
    } catch (failure) {
      notice.report(failure);
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  }
  function closeMenu() {
    if (projectMenu.current) projectMenu.current.open = false;
  }
  const current = buffer.current;
  const projection = useMemo(
    () => (current ? projectSource(current.text) : null),
    [current?.project.projectId, editorSession],
  );
  const [outlineText, setOutlineText] = useState("");
  useEffect(() => {
    if (settingsSection) settings.current?.showModal();
  }, [settingsSection]);
  function openSource(offset = 0) {
    if (documentMenu.current) documentMenu.current.open = false;
    sourceBase.current = buffer.current?.text ?? "";
    sourceOpen.current = true;
    setSource(withoutBom(sourceBase.current).replace(/\r\n?/g, "\n"));
    sourceDialog.current?.showModal();
    requestAnimationFrame(() => {
      sourceInput.current?.focus();
      sourceInput.current?.setSelectionRange(offset, offset);
    });
  }
  function closeSource() {
    sourceDialog.current?.close();
    sourceOpen.current = false;
    if (buffer.current?.text !== sourceBase.current)
      setEditorSession((value) => value + 1);
    else editor.current?.commands.focus();
  }
  function sourceChanged(value: string) {
    const raw = buffer.current?.text ?? "";
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
    );
  }
  const dirty = !!current && current.text !== current.project.text;
  useEffect(() => {
    if (
      !dirty ||
      saving ||
      saveFailed ||
      autosavePaused ||
      preferences.saveMode !== "after_delay"
    )
      return;
    const timer = setTimeout(runSave, preferences.saveDelaySeconds * 1000);
    return () => clearTimeout(timer);
  }, [current?.epoch, dirty, saving, saveFailed, autosavePaused, preferences]);
  useEffect(() => {
    const blur = () => {
      if (
        preferences.saveMode === "on_window_change" &&
        !saveFailed &&
        !autosavePaused
      )
        runSave();
    };
    const visibility = () => {
      if (document.hidden) blur();
    };
    const unload = (event: BeforeUnloadEvent) => {
      const value = buffer.current;
      if (value && value.text !== value.project.text) {
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
  }, [preferences, saveFailed, autosavePaused]);
  function changed(value: string) {
    const current = buffer.current;
    if (!current || value === current.text) return;
    current.text = value;
    current.epoch++;
    redraw();
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
        const nextText = await text();
        same(captured, epoch);
        if (pendingSave.current) await pendingSave.current;
        same(captured, epoch);
        if (captured) await save();
        same(captured, epoch);
        const project = await client.create(nextText);
        same(captured, epoch);
        install(project);
      });
    } catch (failure) {
      notice.report(failure);
    } finally {
      switching.current = false;
      setBusy(false);
    }
  }
  function download() {
    void composition
      .run("download", () => {
        const current = buffer.current;
        if (!current) return;
        deliver(
          new TextEncoder().encode(current.text),
          "manuscript.md",
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
        if (pendingSave.current) await pendingSave.current;
        assert();
        await save();
        assert();
        const saved = buffer.current!.project;
        const bytes = await client.download(saved.projectId, saved.revision);
        assert();
        deliver(
          bytes as Uint8Array<ArrayBuffer>,
          "scenesparrow-project.zip",
          "application/zip",
        );
      });
    } catch (failure) {
      notice.report(failure);
    } finally {
      exchangeRunning.current = false;
      setExchangeBusy(false);
    }
  }
  async function importChanges(file: File, count: number) {
    if (exchangeRunning.current) return;
    exchangeRunning.current = true;
    setExchangeBusy(true);
    try {
      await composition.run("import-changes", async () => {
        const base = capture();
        if (
          count !== 1 ||
          !/\.zip$/i.test(file.name) ||
          file.size > 2 * 1024 * 1024 + 65536
        )
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
        if (pendingSave.current) await pendingSave.current;
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
          onWrite={() => editor.current?.commands.focus()}
        />
        <header className="workspace-header">
          <div className="workspace-brand">{t.appName}</div>
          <div className="workspace-actions">
            <details className="project-menu" ref={projectMenu}>
              <summary>{t.applicationMenu}</summary>
              <nav aria-label={t.applicationMenu}>
                <button
                  disabled={loading || busy}
                  onClick={() => {
                    closeMenu();
                    void open(async () => "");
                  }}
                >
                  {t.markdownNew}
                </button>
                <button
                  disabled={loading || busy}
                  onClick={() => {
                    closeMenu();
                    fileInput.current?.click();
                  }}
                >
                  {t.markdownImport}
                </button>
                <button
                  disabled={!current || saving}
                  onClick={() => {
                    closeMenu();
                    runSave();
                  }}
                >
                  {t.markdownSave}
                </button>
                <button
                  disabled={!current}
                  onClick={() => {
                    closeMenu();
                    download();
                  }}
                >
                  {t.markdownDownload}
                </button>
                <p>{t.markdownExchangeHelp}</p>
                <button
                  disabled={!current || exchangeBusy}
                  onClick={() => {
                    closeMenu();
                    void downloadProject();
                  }}
                >
                  {dirty || saving
                    ? t.markdownSaveDownload
                    : t.markdownDownloadProject}
                </button>
                <button
                  disabled={!current || exchangeBusy}
                  onClick={() => {
                    closeMenu();
                    exchangeInput.current?.click();
                  }}
                >
                  {t.markdownImportChanges}
                </button>
              </nav>
            </details>
            <input
              ref={exchangeInput}
              hidden
              type="file"
              accept=".zip,application/zip"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                const count = event.currentTarget.files?.length ?? 0;
                event.currentTarget.value = "";
                if (file) void importChanges(file, count);
              }}
            />
            <input
              ref={fileInput}
              hidden
              type="file"
              accept=".md,text/markdown"
              onChange={(event) => {
                const files = event.currentTarget.files;
                const file = files?.[0];
                const count = files?.length;
                event.currentTarget.value = "";
                if (!file) return;
                void open(async () => {
                  if (
                    count !== 1 ||
                    !/\.md$/i.test(file.name) ||
                    file.size > 2 * 1024 * 1024
                  )
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
                      capture={capture}
                      outlineTarget={outlineTarget}
                      onOutline={(text, activate = true) => {
                        setOutlineText(text);
                        if (activate) setView("outline");
                      }}
                      onOutlineReady={(value) => {
                        outlineEditor.current = value;
                      }}
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
                        disabled={!current}
                        onClick={() => {
                          if (documentMenu.current)
                            documentMenu.current.open = false;
                          fileInput.current?.click();
                        }}
                      >
                        {t.importManuscript}
                      </button>
                      <button disabled={!current} onClick={() => openSource()}>
                        {t.viewMarkdownSource}
                      </button>
                      <button
                        onMouseDown={(event) => event.preventDefault()}
                        disabled={!editor.current?.can().undo()}
                        onClick={() => {
                          editor.current?.chain().focus().undo().run();
                          if (documentMenu.current)
                            documentMenu.current.open = false;
                        }}
                      >
                        {t.undo}
                        <kbd>Ctrl/⌘ Z</kbd>
                      </button>
                      <button
                        onMouseDown={(event) => event.preventDefault()}
                        disabled={!editor.current?.can().redo()}
                        onClick={() => {
                          editor.current?.chain().focus().redo().run();
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
                  ref={setOutlineTarget}
                  className="outline-surface"
                  hidden={view !== "outline"}
                  inert={view !== "outline"}
                />
                <div
                  className="document-layout"
                  hidden={view !== "manuscript"}
                  inert={view !== "manuscript"}
                >
                  {current &&
                    (projection ? (
                      <MarkdownEditor
                        key={`${current.project.projectId}:${editorSession}`}
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
                    <button disabled={applying} onClick={() => void useDraft()}>
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
