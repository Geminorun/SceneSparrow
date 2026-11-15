import { useEffect, useState, type FormEvent } from "react";
import { Player } from "@remotion/player";
import type { Project } from "@scenesparrow/contracts";
import type { PlatformClient } from "@scenesparrow/platform-client";
import { MotionSample, sampleMetadata } from "@scenesparrow/video-runtime";
import { AiSettings } from "./AiSettings";
import { Manuscript } from "./editor/Manuscript";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

type Locale = "en" | "zh-CN";
const catalogs: Record<Locale, typeof en> = { en, "zh-CN": zhCN };

export function App({ client }: { client: PlatformClient }) {
  const [locale, setLocale] = useState<Locale>(() => {
    const saved = localStorage.getItem("scenesparrow.locale");
    return saved === "en" || saved === "zh-CN"
      ? saved
      : navigator.language.startsWith("zh")
        ? "zh-CN"
        : "en";
  });
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<{
    title: string;
    requestId: string;
  } | null>(null);
  const t = catalogs[locale];

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t.appName;
    localStorage.setItem("scenesparrow.locale", locale);
  }, [locale, t.appName]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const response = await client.readProject();
      setProject(response.project);
    } catch {
      setError("error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [client]);

  useEffect(() => {
    if (!project) return;
    const projectId = project.id;
    let active = true,
      generation = 0;
    const refresh = async () => {
      const ticket = ++generation;
      try {
        const response = await client.readProject();
        if (
          active &&
          ticket === generation &&
          response.project?.id === projectId
        ) {
          const next = response.project;
          setProject((current) =>
            current?.id === projectId &&
            next.workingRevision >= current.workingRevision
              ? next
              : current,
          );
        }
      } catch {
        /* A later event/resync retries the current project projection. */
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

  async function create(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    // Reuse the request identity after an ambiguous network failure.
    const command =
      request?.title === title
        ? request
        : { title, requestId: crypto.randomUUID() };
    setRequest(command);
    try {
      setProject((await client.createProject(command)).project);
    } catch (failure) {
      const code = failure instanceof Error ? failure.message : "error";
      setError(code in t ? code : "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="workspace">
      <header>
        <div>
          <span className="brand-mark" aria-hidden="true">
            ✦
          </span>
          <strong>{t.appName}</strong>
        </div>
        <label className="language">
          {t.language}
          <select
            aria-label={t.language}
            value={locale}
            onChange={(event) => setLocale(event.target.value as Locale)}
          >
            <option value="en">English</option>
            <option value="zh-CN">简体中文</option>
          </select>
        </label>
      </header>
      {client.pickProject && (
        <nav aria-label={t.projectFiles}>
          <button
            onClick={() => {
              void client.pickProject?.().catch(() => setError("error"));
            }}
          >
            {t.openProject}
          </button>
          <button
            onClick={() => {
              void client.pickProject?.(true).catch(() => setError("error"));
            }}
          >
            {t.recoverProject}
          </button>
          {client.backupProject && project && (
            <button
              onClick={() => {
                void client
                  .backupProject?.()
                  .then(() => window.alert(t.backupComplete))
                  .catch(() => setError("error"));
              }}
            >
              {t.backupProject}
            </button>
          )}
        </nav>
      )}
      <AiSettings client={client} t={t} />
      <section className="intro">
        <p className="eyebrow">SCENESPARROW</p>
        <h1>{t.tagline}</h1>
      </section>
      {error && (
        <div role="alert" className="error">
          {t[error as keyof typeof en]}{" "}
          <button onClick={() => void load()}>{t.retry}</button>
        </div>
      )}
      {loading ? (
        <p role="status">{t.connecting}</p>
      ) : project ? (
        <section className="project-card">
          <div className="project-details">
            <p className="saved">{t.saved}</p>
            <h2>{project.title}</h2>
            <dl>
              <div>
                <dt>{t.revision}</dt>
                <dd>
                  {new Intl.NumberFormat(locale).format(
                    project.workingRevision,
                  )}
                </dd>
              </div>
              <div>
                <dt>{t.baseline}</dt>
                <dd data-testid="approval-status">
                  {project.approvedBaseline !== null
                    ? t.finalized
                    : t.notApproved}
                </dd>
              </div>
            </dl>
          </div>
          <Manuscript
            client={client}
            projectId={project.id}
            t={t}
            onRevision={(workingRevision) =>
              setProject((p) =>
                p && workingRevision > p.workingRevision
                  ? { ...p, workingRevision }
                  : p,
              )
            }
          />
          <details className="preview">
            <summary>{t.preview}</summary>
            <div>
              <h3>{t.preview}</h3>
              <Player
                component={MotionSample}
                {...sampleMetadata}
                controls
                style={{ width: "100%", borderRadius: 12 }}
              />
              <p className="muted">{t.previewDescription}</p>
            </div>
          </details>
        </section>
      ) : (
        !error && (
          <form
            onSubmit={(event) => void create(event)}
            className="create-card"
          >
            <h2>{t.newProject}</h2>
            <label htmlFor="project-title">{t.projectTitle}</label>
            <input
              id="project-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              autoFocus
              disabled={saving}
            />
            <button type="submit" disabled={saving || !title.trim()}>
              {saving ? t.creating : t.create}
            </button>
          </form>
        )
      )}
    </main>
  );
}
