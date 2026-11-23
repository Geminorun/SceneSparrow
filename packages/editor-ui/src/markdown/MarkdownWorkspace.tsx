import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { MarkdownProject } from "@scenesparrow/contracts";
import { ApiError, type PlatformClient } from "@scenesparrow/platform-client";
import {
  applicationPreferences,
  type SaveMode,
  type SaveDelay,
} from "../app-preferences";
import {
  NotificationPresenter,
  useNoticeOwner,
} from "../feedback/NotificationPresenter";
import { CompositionActions } from "../project-session/composition-actions";
import { WorkspaceRibbon } from "../workbench/WorkspaceRibbon";
import { HeadingNavigation } from "./HeadingNavigation";
import en from "../locales/en.json";
import zhCN from "../locales/zh-CN.json";

type Buffer = { project: MarkdownProject; text: string; epoch: number };
const withoutBom = (text: string) =>
  text.startsWith("\ufeff") ? text.slice(1) : text;
const lastProjectKey = "scenesparrow.markdown-project";
export function MarkdownWorkspace({
  client,
}: {
  client: NonNullable<PlatformClient["markdownProjects"]>;
}) {
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
  const [busy, setBusy] = useState(false);
  const switching = useRef(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const pendingSave = useRef<Promise<void> | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
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
    setSaveFailed(false);
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
  function save(): Promise<void> {
    if (pendingSave.current) return pendingSave.current;
    const current = buffer.current;
    if (!current || current.text === current.project.text)
      return Promise.resolve();
    const { text, project } = current;
    setSaving(true);
    const promise = client
      .save(project.projectId, { text, revision: project.revision })
      .then((saved) => {
        if (buffer.current === current) {
          current.project = saved;
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
    void composition.run("save", save).catch(notice.report);
  }
  function closeMenu() {
    if (projectMenu.current) projectMenu.current.open = false;
  }
  const current = buffer.current;
  const dirty = !!current && current.text !== current.project.text;
  useEffect(() => {
    if (
      !dirty ||
      saving ||
      saveFailed ||
      preferences.saveMode !== "after_delay"
    )
      return;
    const timer = setTimeout(runSave, preferences.saveDelaySeconds * 1000);
    return () => clearTimeout(timer);
  }, [current?.epoch, dirty, saving, saveFailed, preferences]);
  useEffect(() => {
    const blur = () => {
      if (preferences.saveMode === "on_window_change" && !saveFailed) runSave();
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
  }, [preferences, saveFailed]);
  function changed(value: string) {
    const current = buffer.current;
    if (!current || value === withoutBom(current.text).replace(/\r\n?/g, "\n"))
      return;
    // Textarea editing uses LF. Keep an imported BOM outside the visible editor.
    current.text = (current.text.startsWith("\ufeff") ? "\ufeff" : "") + value;
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
        const url = URL.createObjectURL(
          new Blob([new TextEncoder().encode(current.text)], {
            type: "text/markdown;charset=utf-8",
          }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = "manuscript.md";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      })
      .catch(notice.report);
  }
  return (
    <div className="workspace markdown-workspace">
      <NotificationPresenter t={t} />
      <a className="skip-link" href="#markdown-editor">
        {t.skipToWorkbench}
      </a>
      <WorkspaceRibbon t={t} onWrite={() => editor.current?.focus()} />
      <header className="workspace-header">
        <div className="workspace-brand">{t.appName}</div>
        <div className="workspace-actions">
          <details className="project-menu" ref={projectMenu}>
            <summary>{t.markdownProjectMenu}</summary>
            <nav aria-label={t.markdownProjectMenu}>
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
            </nav>
          </details>
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
          <select
            aria-label={t.language}
            value={locale}
            onChange={(event) => setLocale(event.target.value)}
          >
            <option value="en">English</option>
            <option value="zh-CN">简体中文</option>
          </select>
        </div>
      </header>
      <main className="markdown-main">
        <div className="markdown-toolbar">
          <strong>{t.markdownWorkspace}</strong>
          <span role="status">
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
                    saveDelaySeconds: Number(event.target.value) as SaveDelay,
                  })
                }
              >
                {([5, 10, 30] as const).map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {t.autosaveSeconds.replace("{seconds}", String(seconds))}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {!current && !loading && <p>{t.markdownOpenFailed}</p>}
        {current && (
          <div className="markdown-document">
            <HeadingNavigation
              key={`contents-${current.project.projectId}`}
              text={withoutBom(current.text).replace(/\r\n?/g, "\n")}
              label={t.workspaceTab_structure}
              empty={t.noHeadings}
              onSelect={(offset) => {
                editor.current?.setSelectionRange(offset, offset);
                editor.current?.focus();
              }}
            />
            <textarea
              key={current.project.projectId}
              ref={editor}
              id="markdown-editor"
              aria-label={t.markdownText}
              autoFocus
              defaultValue={withoutBom(current.text)}
              onChange={(event) => changed(event.currentTarget.value)}
              onCompositionStart={() =>
                composition.composition("markdown", true)
              }
              onCompositionEnd={() =>
                composition.composition("markdown", false)
              }
              onBlur={() =>
                composition.blur("markdown", () => {
                  if (editor.current) changed(editor.current.value);
                  composition.composition("markdown", false);
                })
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
          </div>
        )}
      </main>
    </div>
  );
}
