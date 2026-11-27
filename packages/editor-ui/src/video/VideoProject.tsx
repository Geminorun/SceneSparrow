import { useEffect, useRef, useState } from "react";
import type {
  VideoProject as Project,
  VideoComposition,
} from "@scenesparrow/contracts";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type en from "../locales/en.json";
import { WritingDialog } from "../ui/WritingDialog";
import { useNoticeOwner } from "../feedback/NotificationPresenter";
import { errorMessage } from "../feedback/notifications";
import { useAgentCatalog } from "../agent/catalog";

export function VideoProject({
  projectId,
  client,
  t,
  close,
}: {
  projectId: string;
  client: PlatformClient;
  t: typeof en;
  close: () => void;
}) {
  const api = client.videoProjects!;
  const notice = useNoticeOwner();
  const catalog = useAgentCatalog(client.agent, true, client);
  const [project, setProject] = useState<Project | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [instruction, setInstruction] = useState("");
  const input = useRef("");
  const [choice, setChoice] = useState<{
    engineId: string;
    modelId: string;
  } | null>(null);
  const [media, setMedia] = useState<string | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  const composing = useRef(false);
  const defaults = catalog.defaultChoice;
  const defaultModel =
    catalog.engines.find((engine) => engine.id === defaults.engineId)?.models[0]
      ?.id ?? "";
  const selected = choice ?? {
    ...defaults,
    modelId: defaults.modelId || defaultModel,
  };
  const modelAvailable = catalog.engines.some(
    (engine) =>
      engine.available &&
      engine.id === selected.engineId &&
      engine.models.some((model) => model.id === selected.modelId),
  );
  const proposal = project?.proposals.at(-1);
  const pending =
    proposal?.status === "pending" || proposal?.status === "running";
  useEffect(() => {
    mounted.current = true;
    void api
      .read(projectId)
      .then((value) => {
        if (mounted.current) {
          setProject(value);
          setLoaded(true);
        }
      })
      .catch(notice.report);
    return () => {
      mounted.current = false;
    };
  }, [api, projectId, notice.report]);
  useEffect(() => {
    if (proposal?.status !== "running") return;
    const timer = setInterval(() => {
      void api
        .read(projectId)
        .then((value) => {
          if (mounted.current) setProject(value);
        })
        .catch(notice.report);
    }, 2000);
    return () => clearInterval(timer);
  }, [api, projectId, proposal?.status, notice.report]);
  useEffect(() => {
    let current = true;
    let url: string | undefined;
    setMedia(null);
    if (project?.renderRevision === project?.revision && project) {
      void api
        .bytes(projectId, project.revision, "render")
        .then((bytes) => {
          if (!current) return;
          url = URL.createObjectURL(
            new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "video/mp4" }),
          );
          setMedia(url);
        })
        .catch(notice.report);
    }
    return () => {
      current = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [
    api,
    projectId,
    project?.revision,
    project?.renderRevision,
    notice.report,
  ]);
  async function action(run: () => Promise<Project>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const result = await run();
      if (mounted.current) setProject(result);
    } catch (error) {
      notice.report(error);
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function send() {
    if (!project || composing.current || !input.current.trim()) return;
    const captured = input.current;
    const revision = project.revision;
    const requestId = crypto.randomUUID();
    await action(async () => {
      const result = await api.request(projectId, {
        requestId,
        revision,
        ...selected,
        instruction: captured,
      });
      if (mounted.current && input.current === captured) {
        input.current = "";
        setInstruction("");
      }
      return result;
    });
  }
  async function download() {
    if (!project || running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const bytes = await api.bytes(projectId, project.revision, "export");
      if (!mounted.current) return;
      const url = URL.createObjectURL(
        new Blob([bytes as Uint8Array<ArrayBuffer>], {
          type: "application/zip",
        }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "scenesparrow-video.zip";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      notice.report(error);
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const fields: Array<[keyof VideoComposition, string]> = [
    ["title", t.videoTitle],
    ["background", t.videoBackground],
    ["accent", t.videoAccent],
    ["direction", t.videoDirection],
  ];
  return (
    <WritingDialog title={t.videoProject} close={close} closeLabel={t.close}>
      <section className="video-project" aria-busy={busy}>
        {!project ? (
          <>
            <p>{t.videoIntroduction}</p>
            <button
              disabled={!loaded || busy}
              onClick={() => void action(() => api.create(projectId))}
            >
              {t.videoCreate}
            </button>
          </>
        ) : (
          <>
            <p className="video-skill">
              <strong>{project.skill.name}</strong> · {project.skill.version}
              <br />
              <small>
                {t.videoSkillInstalled} · {project.skill.revision.slice(0, 12)}
              </small>
            </p>
            <p>{t.videoScope}</p>
            <div className="video-actions">
              <button disabled={busy} onClick={() => void download()}>
                {t.videoExport}
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void action(() => api.render(projectId, project.revision))
                }
              >
                {t.videoRender}
              </button>
            </div>
            {media ? (
              <video
                controls
                playsInline
                src={media}
                aria-label={t.videoPreview}
              />
            ) : null}
            {proposal ? (
              <article className="video-proposal">
                <p>
                  <strong>{proposal.instruction}</strong>
                </p>
                {proposal.status === "running" ? (
                  <p role="status">{t.videoWorking}</p>
                ) : (
                  <p>{proposal.reply}</p>
                )}
                {proposal.errorCode ? (
                  <p role="status">{errorMessage(proposal.errorCode, t)}</p>
                ) : null}
                {proposal.composition ? (
                  <table>
                    <caption>composition.json</caption>
                    <thead>
                      <tr>
                        <th>{t.videoField}</th>
                        <th>{t.videoCurrent}</th>
                        <th>{t.videoProposed}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fields.map(([key, label]) => (
                        <tr key={key}>
                          <th>{label}</th>
                          <td>{project.composition[key]}</td>
                          <td>{proposal.composition![key]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
                {proposal.status === "pending" ? (
                  <div className="video-actions">
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void action(() =>
                          api.decide(projectId, {
                            requestId: proposal.requestId,
                            decision: "apply",
                          }),
                        )
                      }
                    >
                      {t.agentApply}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action(() =>
                          api.decide(projectId, {
                            requestId: proposal.requestId,
                            decision: "discard",
                          }),
                        )
                      }
                    >
                      {t.agentDiscard}
                    </button>
                  </div>
                ) : proposal.status === "applied" ? (
                  <p>{t.videoApplied}</p>
                ) : proposal.status === "discarded" ? (
                  <p>{t.videoDiscarded}</p>
                ) : null}
              </article>
            ) : null}
            <label>
              {t.videoInstruction}
              <textarea
                value={instruction}
                maxLength={4096}
                onCompositionStart={() => {
                  composing.current = true;
                }}
                onCompositionEnd={() => {
                  composing.current = false;
                }}
                onChange={(event) => {
                  input.current = event.target.value;
                  setInstruction(event.target.value);
                }}
                placeholder={t.videoInstructionExample}
              />
            </label>
            <div className="video-actions">
              <select
                aria-label={t.videoModel}
                value={`${selected.engineId}:${selected.modelId}`}
                onChange={(event) => {
                  const [engineId, ...modelId] = event.target.value.split(":");
                  setChoice({
                    engineId: engineId!,
                    modelId: modelId.join(":"),
                  });
                }}
              >
                {!selected.modelId ? (
                  <option value={`${selected.engineId}:`}>
                    {t.videoDefaultModel}
                  </option>
                ) : null}
                {catalog.engines.flatMap((engine) =>
                  engine.models.map((model) => (
                    <option
                      key={`${engine.id}:${model.id}`}
                      value={`${engine.id}:${model.id}`}
                    >
                      {engine.label} · {model.label}
                    </option>
                  )),
                )}
              </select>
              <button
                className="primary"
                disabled={
                  busy || pending || !modelAvailable || !instruction.trim()
                }
                onClick={() => void send()}
              >
                {t.agentSend}
              </button>
            </div>
            <details>
              <summary>{t.videoComposition}</summary>
              <pre>{JSON.stringify(project.composition, null, 2)}</pre>
            </details>
          </>
        )}
      </section>
    </WritingDialog>
  );
}
