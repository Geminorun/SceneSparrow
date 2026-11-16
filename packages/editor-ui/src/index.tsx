import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { Project, RenameProject } from "@scenesparrow/contracts";
import type {
  PlatformClient,
  RecentProject,
} from "@scenesparrow/platform-client";
import { AiSettings } from "./AiSettings";
import { Manuscript } from "./editor/Manuscript";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

type Locale = "en" | "zh-CN";
const catalogs: Record<Locale, typeof en> = { en, "zh-CN": zhCN };

function trapDialogFocus(event: ReactKeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab") return;
  const controls = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, summary, a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter(
    (element) =>
      !element.matches(":disabled") &&
      element.getClientRects().length > 0 &&
      (!element.closest("details:not([open])") ||
        element ===
          element
            .closest("details:not([open])")
            ?.querySelector(":scope > summary")),
  );
  const first = controls[0],
    last = controls.at(-1);
  if (
    first &&
    last &&
    ((event.shiftKey && document.activeElement === first) ||
      (!event.shiftKey && document.activeElement === last))
  ) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

export function App({ client }: { client: PlatformClient }) {
  const [locale, setLocale] = useState<Locale>(() => {
    const saved = localStorage.getItem("scenesparrow.locale");
    return saved === "en" || saved === "zh-CN"
      ? saved
      : navigator.language.startsWith("zh")
        ? "zh-CN"
        : "en";
  });
  const t = catalogs[locale];
  const initialTitle = useRef(t.untitledProject);
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const bootstrap = useRef<{ title: string; requestId: string } | null>(null);
  const loadGeneration = useRef(0);
  const metadataEpoch = useRef(0);
  const settings = useRef<HTMLDialogElement>(null);
  const renameDialog = useRef<HTMLDialogElement>(null);
  const gear = useRef<HTMLButtonElement>(null);
  const titleButton = useRef<HTMLButtonElement>(null);
  const projectMenu = useRef<HTMLDetailsElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [section, setSection] = useState<"general" | "ai">("general");
  const [renameTitle, setRenameTitle] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState("");
  const renameCommand = useRef<RenameProject | null>(null);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [recentError, setRecentError] = useState(false);
  const [filesBusy, setFilesBusy] = useState(false);
  const [fileStatus, setFileStatus] = useState("");

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = project ? `${project.title} · ${t.appName}` : t.appName;
    localStorage.setItem("scenesparrow.locale", locale);
  }, [locale, t.appName, project?.title]);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const epoch = metadataEpoch.current;
    setLoading(true);
    setError(false);
    try {
      const read = await client.readProject();
      // A read failure must never fall through into workspace creation. Preserve
      // this command after an ambiguous ensure response, including across retries.
      if (!read.project && !bootstrap.current)
        bootstrap.current = {
          title: initialTitle.current,
          requestId: crypto.randomUUID(),
        };
      const next =
        read.project ??
        (await client.ensureProject(bootstrap.current!)).project;
      if (generation === loadGeneration.current && next)
        setProject((current) =>
          current?.id === next.id &&
          current.workingRevision > next.workingRevision
            ? {
                ...current,
                title:
                  epoch === metadataEpoch.current ? next.title : current.title,
              }
            : current?.id === next.id && epoch !== metadataEpoch.current
              ? { ...next, title: current.title }
              : next,
        );
    } catch {
      if (generation === loadGeneration.current) setError(true);
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [client]);
  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current++;
    };
  }, [load]);

  useEffect(() => {
    if (!project) return;
    const projectId = project.id;
    let active = true,
      generation = 0;
    const refresh = async () => {
      const ticket = ++generation;
      const epoch = metadataEpoch.current;
      try {
        const next = (await client.readProject()).project;
        if (active && ticket === generation && next?.id === projectId)
          setProject((current) =>
            current?.id === projectId &&
            next.workingRevision >= current.workingRevision
              ? {
                  ...next,
                  title:
                    epoch === metadataEpoch.current
                      ? next.title
                      : current.title,
                }
              : current,
          );
      } catch {
        /* The editor keeps its local state; a later event can resync metadata. */
      }
    };
    void refresh();
    const stop = client.subscribeEvents(
      (event) => {
        if (
          [
            "manuscript.readinessChanged",
            "locks.changed",
            "manuscript.changed",
          ].includes(event.type)
        )
          void refresh();
      },
      () => void refresh(),
    );
    return () => {
      active = false;
      generation++;
      stop();
    };
  }, [client, project?.id]);

  const onRevision = useCallback((workingRevision: number) => {
    setProject((current) =>
      current && workingRevision > current.workingRevision
        ? { ...current, workingRevision }
        : current,
    );
  }, []);
  // Manuscript owns the one native-close subscription. Keep this callback stable
  // so showing a modal never disposes its autosave queue.
  const dismissDialogs = useCallback(() => {
    settings.current?.close();
    renameDialog.current?.close();
    if (projectMenu.current) projectMenu.current.open = false;
  }, []);

  async function rename(event: FormEvent) {
    event.preventDefault();
    if (!project || renameBusy) return;
    const command =
      renameCommand.current?.title === renameTitle &&
      renameCommand.current.projectId === project.id
        ? renameCommand.current
        : {
            requestId: crypto.randomUUID(),
            projectId: project.id,
            previousTitle: project.title,
            title: renameTitle,
          };
    renameCommand.current = command;
    setRenameBusy(true);
    setRenameError("");
    try {
      const next = (await client.renameProject(command)).project;
      // Metadata commands do not own manuscript revisions/readiness. An older
      // response must not roll back a concurrent autosave or lock projection.
      metadataEpoch.current++;
      if (next)
        setProject((current) =>
          current?.id === next.id ? { ...current, title: next.title } : current,
        );
      renameCommand.current = null;
      renameDialog.current?.close();
    } catch (failure) {
      const code = failure instanceof Error ? failure.message : "error";
      if (code === "PROJECT_CONFLICT") {
        renameCommand.current = null;
        try {
          const next = (await client.readProject()).project;
          metadataEpoch.current++;
          if (next)
            setProject((current) =>
              current?.id === next.id
                ? { ...current, title: next.title }
                : current,
            );
        } catch {
          /* Keep the proposed title and editor available for another attempt. */
        }
      }
      setRenameError(
        code === "PROJECT_CONFLICT"
          ? "renameConflict"
          : code in t
            ? code
            : "error",
      );
    } finally {
      setRenameBusy(false);
    }
  }
  async function fileAction(action: () => Promise<unknown>, success = "") {
    if (filesBusy) return;
    setFilesBusy(true);
    setFileStatus("");
    try {
      await action();
      setFileStatus(success);
    } catch {
      setFileStatus("projectOpenFailed");
    } finally {
      setFilesBusy(false);
    }
  }

  return (
    <div className="workspace">
      <a className="skip-link" href="#workbench">
        {t.skipToWorkbench}
      </a>
      <header className="workspace-header">
        <div className="workspace-brand">
          <svg aria-hidden="true" viewBox="0 0 32 32" width="30" height="30">
            <path
              fill="currentColor"
              d="M4 23c7-1 9-8 12-15 0 5 1 8 5 9l7-2-5 6c-6 5-11 7-19 2Z"
            />
            <circle cx="21" cy="14" r="2" fill="currentColor" />
          </svg>
          <span>{t.appName}</span>
        </div>
        <div className="project-heading">
          <h1 data-testid="project-title" title={project?.title}>
            {project?.title ?? t.appName}
          </h1>
          {project && (
            <button
              ref={titleButton}
              className="quiet-button rename-trigger"
              aria-label={t.renameProject}
              onClick={() => {
                if (!renameCommand.current) setRenameTitle(project.title);
                setRenameError("");
                renameDialog.current?.showModal();
              }}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                width="16"
                height="16"
              >
                <path
                  d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15v5Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                />
              </svg>
            </button>
          )}
        </div>
        <div className="workspace-actions">
          {(client.pickProject || client.readRecentProjects) && (
            <details
              className="project-menu"
              ref={projectMenu}
              onToggle={(event) => {
                if (event.currentTarget.open && client.readRecentProjects) {
                  setRecentError(false);
                  void client
                    .readRecentProjects()
                    .then(setRecent, () => setRecentError(true));
                }
              }}
            >
              <summary>{t.projectFiles}</summary>
              <nav aria-label={t.projectFiles}>
                {client.pickProject && (
                  <>
                    <button
                      disabled={filesBusy}
                      onClick={() =>
                        void fileAction(() => client.pickProject!())
                      }
                    >
                      {t.openProject}
                    </button>
                    <button
                      disabled={filesBusy}
                      onClick={() =>
                        void fileAction(() => client.pickProject!(true))
                      }
                    >
                      {t.recoverProject}
                    </button>
                  </>
                )}
                {client.backupProject && project && (
                  <button
                    disabled={filesBusy}
                    onClick={() =>
                      void fileAction(
                        () => client.backupProject!(),
                        "backupComplete",
                      )
                    }
                  >
                    {t.backupProject}
                  </button>
                )}
                {client.readRecentProjects && (
                  <>
                    <h2>{t.recentProjects}</h2>
                    {recentError ? (
                      <p role="alert">{t.recentProjectsFailed}</p>
                    ) : recent.length ? (
                      recent.map((item) => (
                        <button
                          key={item.id}
                          disabled={filesBusy || !client.openRecentProject}
                          onClick={() =>
                            void fileAction(() =>
                              client.openRecentProject!(item.id),
                            )
                          }
                        >
                          {item.title}
                        </button>
                      ))
                    ) : (
                      <p>{t.noRecentProjects}</p>
                    )}
                  </>
                )}
                {fileStatus && (
                  <p role="status">{t[fileStatus as keyof typeof en]}</p>
                )}
              </nav>
            </details>
          )}
          <label className="language">
            <span>{t.language}</span>
            <select
              aria-label={t.language}
              value={locale}
              onChange={(event) => setLocale(event.target.value as Locale)}
            >
              <option value="en">English</option>
              <option value="zh-CN">简体中文</option>
            </select>
          </label>
          <button
            ref={gear}
            className="quiet-button settings-trigger"
            aria-label={t.settings}
            aria-haspopup="dialog"
            onClick={() => {
              setSettingsOpen(true);
              settings.current?.showModal();
            }}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22">
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
        {error && (
          <div role="alert" className="error">
            {t.error}{" "}
            <button disabled={loading} onClick={() => void load()}>
              {t.retry}
            </button>
          </div>
        )}
        {project ? (
          <section className="project-workbench" data-project-id={project.id}>
            <div className="project-meta">
              <span>
                {t.revision}{" "}
                {new Intl.NumberFormat(locale).format(project.workingRevision)}
              </span>
            </div>
            <Manuscript
              key={project.id}
              client={client}
              projectId={project.id}
              t={t}
              onRevision={onRevision}
              approvedBaseline={project.approvedBaseline}
              onBeforeClose={dismissDialogs}
            />
          </section>
        ) : (
          loading && (
            <p role="status" className="workspace-loading">
              {t.connecting}
            </p>
          )
        )}
      </main>
      <dialog
        ref={settings}
        onKeyDown={trapDialogFocus}
        className="settings-dialog"
        aria-labelledby="settings-title"
        onClose={() => {
          setSettingsOpen(false);
          gear.current?.focus();
        }}
      >
        <div className="dialog-heading">
          <h2 id="settings-title">{t.settings}</h2>
          <button
            className="quiet-button"
            onClick={() => settings.current?.close()}
          >
            {t.close}
          </button>
        </div>
        <div className="settings-layout">
          <nav aria-label={t.settingsSections}>
            <button
              aria-current={section === "general" ? "page" : undefined}
              onClick={() => setSection("general")}
            >
              {t.generalSettings}
            </button>
            <button
              aria-current={section === "ai" ? "page" : undefined}
              onClick={() => setSection("ai")}
            >
              {t.aiModels}
            </button>
          </nav>
          <div className="settings-content">
            <section hidden={section !== "general"}>
              <h3>{t.generalSettings}</h3>
              <p>{t.workspaceHelp}</p>
              <label>
                {t.interfaceLanguage}
                <select
                  value={locale}
                  onChange={(event) => setLocale(event.target.value as Locale)}
                >
                  <option value="en">English</option>
                  <option value="zh-CN">简体中文</option>
                </select>
              </label>
            </section>
            <AiSettings
              client={client}
              t={t}
              active={settingsOpen && section === "ai"}
            />
          </div>
        </div>
      </dialog>
      <dialog
        ref={renameDialog}
        onKeyDown={trapDialogFocus}
        className="rename-dialog"
        aria-labelledby="rename-title"
        onClose={() => titleButton.current?.focus()}
      >
        <form onSubmit={(event) => void rename(event)}>
          <h2 id="rename-title">{t.renameProject}</h2>
          <label htmlFor="rename-project-title">{t.projectTitle}</label>
          <input
            autoFocus
            id="rename-project-title"
            value={renameTitle}
            required
            maxLength={240}
            disabled={renameBusy}
            onChange={(event) => {
              setRenameTitle(event.target.value);
            }}
          />
          {renameError && (
            <p role="alert">{t[renameError as keyof typeof en]}</p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="quiet-button"
              onClick={() => renameDialog.current?.close()}
            >
              {t.cancel}
            </button>
            <button disabled={renameBusy || !renameTitle.trim()} type="submit">
              {renameBusy ? t.creating : t.saveProjectName}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
