import { useEffect, useRef, useState } from "react";
import type {
  AgentProposal,
  AgentSession,
  AgentTurnStatus,
} from "@scenesparrow/contracts";
import type { ExternalWritingClient } from "@scenesparrow/platform-client";
import { ApiError } from "@scenesparrow/platform-client";
import type en from "../locales/en.json";
import { applicationPreferences } from "../app-preferences";
import {
  useNoticeOwner,
  useOpenSettings,
} from "../feedback/NotificationPresenter";
import { errorMessage } from "../feedback/notifications";
import type { CompositionActions } from "../project-session/composition-actions";
import { ExchangeComparison } from "../markdown/ExchangeComparison";
import { agentAttachment, proposalText, type AgentCapture } from "./context";
import type { AgentCatalog } from "./catalog";

type Turn = {
  instruction: string;
  id?: string;
  sessionId?: string;
  capture?: AgentCapture;
  reply: string;
  progress: string;
  status: AgentTurnStatus;
  error?: unknown;
  proposal?: AgentProposal;
  outcome?: "applied" | "discarded";
  applying?: boolean;
};
export function AgentConversation({
  client,
  catalog,
  projectId,
  t,
  active,
  contextLabel,
  composition,
  prepareIntent,
  validate,
  apply,
}: {
  client: ExternalWritingClient | undefined;
  catalog: AgentCatalog;
  projectId: string;
  t: typeof en;
  active: boolean;
  contextLabel: string;
  composition: CompositionActions;
  prepareIntent: () => () => Promise<AgentCapture>;
  validate: (capture: AgentCapture) => void;
  apply: (
    capture: AgentCapture,
    proposal: AgentProposal,
    sessionId: string,
    turnId: string,
  ) => Promise<void>;
}) {
  const defaults = applicationPreferences.getSnapshot().agentDefault;
  const [choice, setChoice] = useState({
    engineId: defaults?.engineId ?? "codex",
    modelId: defaults?.modelId ?? "",
  });
  const engine =
    catalog.engines.find((e) => e.id === choice.engineId) ?? catalog.engines[0];
  const model =
    engine?.models.find((m) => m.id === choice.modelId) ?? engine?.models[0];
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const textRef = useRef(text);
  textRef.current = text;
  const draftEpoch = useRef(0);
  const [busy, setBusy] = useState(false);
  const running = useRef(false),
    mounted = useRef(true),
    generation = useRef(0);
  const sendIntent = useRef<{ key: string; dispatched: boolean } | null>(null);
  const session = useRef<AgentSession | null>(null),
    stream = useRef<AbortController | null>(null),
    currentTurn = useRef<Turn | null>(null);
  const notice = useNoticeOwner(),
    openSettings = useOpenSettings();
  const end = useRef<HTMLDivElement>(null);
  const redraw = () => setTurns((current) => [...current]);
  function close() {
    generation.current++;
    sendIntent.current = null;
    composition.cancelScope("agent:");
    stream.current?.abort();
    stream.current = null;
    const old = session.current;
    session.current = null;
    if (old && client) void client.close(old.projectId, old.id).catch(() => {});
    currentTurn.current = null;
    running.current = false;
  }
  useEffect(() => {
    mounted.current = true;
    const leave = () => close();
    window.addEventListener("pagehide", leave);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", leave);
      close();
    };
  }, [client, projectId]);
  useEffect(() => {
    if (active) end.current?.scrollIntoView({ block: "nearest" });
  }, [turns, active]);
  function fresh(next = choice) {
    close();
    setBusy(false);
    setTurns([]);
    setChoice(next);
  }
  async function send(retry?: string) {
    if (running.current || !client || !engine?.available || !model) return;
    running.current = true;
    setBusy(true);
    const identity = generation.current,
      prepareContext = prepareIntent();
    const intent = {
      key: `agent:send:${crypto.randomUUID()}`,
      dispatched: false,
    };
    sendIntent.current = intent;
    currentTurn.current = null;
    const valid = () =>
      mounted.current &&
      generation.current === identity &&
      sendIntent.current === intent;
    let turn: Turn | undefined;
    try {
      await composition.run(
        intent.key,
        async () => {
          if (!valid()) return;
          const instruction = retry ?? textRef.current;
          if (!instruction.trim()) return;
          const epoch = draftEpoch.current;
          turn = { instruction, reply: "", progress: "", status: "running" };
          setTurns((current) => [...current, turn!]);
          currentTurn.current = turn;
          const capture = await prepareContext();
          if (!valid()) return;
          turn.capture = capture;
          const attachment = await agentAttachment(capture);
          if (!valid()) return;
          validate(capture);
          if (!session.current) {
            const created = await client.create(projectId, {
              requestId: crypto.randomUUID(),
              engineId: engine.id,
              modelId: model.id,
            });
            if (!valid()) {
              void client.close(projectId, created.id).catch(() => {});
              return;
            }
            session.current = created;
            setChoice({ engineId: created.engineId, modelId: created.modelId });
          }
          validate(capture);
          if (!valid()) return;
          const owner = session.current;
          intent.dispatched = true;
          turn.sessionId = owner.id;
          const accepted = await client.send(projectId, owner.id, {
            requestId: crypto.randomUUID(),
            instruction,
            attachment,
          });
          if (!valid()) return;
          turn.id = accepted.id;
          if (draftEpoch.current === epoch && retry === undefined) {
            textRef.current = "";
            setText("");
          }
          const controller = new AbortController();
          stream.current = controller;
          const displayTurn = turn;
          await client.stream(
            projectId,
            owner.id,
            accepted.id,
            0,
            (event) => {
              if (
                !valid() ||
                controller.signal.aborted ||
                currentTurn.current !== displayTurn ||
                event.sessionId !== owner.id ||
                event.turnId !== accepted.id ||
                event.projectId !== projectId
              )
                return;
              if (event.type === "text") displayTurn.reply += event.text;
              else if (event.type === "progress")
                displayTurn.progress = event.text;
              else if (event.type === "proposal") {
                proposalText(capture, event.proposal);
                if (
                  event.proposal.context.sourceDigest !==
                  attachment.sourceDigest
                )
                  throw new ApiError("AGENT_PROPOSAL_STALE");
                displayTurn.proposal = event.proposal;
              } else {
                displayTurn.reply = event.reply;
                displayTurn.status = event.status;
                displayTurn.progress = "";
                if (event.status !== "completed") delete displayTurn.proposal;
                if (event.errorCode) {
                  displayTurn.error = event.errorCode;
                  notice.report(event.errorCode);
                }
              }
              redraw();
            },
            controller.signal,
          );
          if (valid() && displayTurn.status === "running")
            throw new ApiError("AGENT_STREAM_INTERRUPTED");
        },
        valid,
      );
    } catch (failure) {
      if (valid() && turn && turn.status === "running") {
        turn.status = "failed";
        turn.error = failure;
        delete turn.proposal;
        notice.report(failure);
        redraw();
      }
    } finally {
      if (valid()) {
        running.current = false;
        setBusy(false);
        stream.current = null;
      }
    }
  }
  async function stop() {
    const turn = currentTurn.current,
      owner = session.current;
    if (turn && turn.status !== "running") return;
    const intent = sendIntent.current;
    sendIntent.current = null;
    if (intent) composition.cancel(intent.key);
    stream.current?.abort();
    stream.current = null;
    if (turn) {
      turn.status = "cancelled";
      delete turn.proposal;
      redraw();
    }
    running.current = false;
    setBusy(false);
    // A send awaiting its acknowledgement has no turn ID yet; close fences it server-side.
    if (!turn?.id) {
      if (intent?.dispatched && owner && client) {
        session.current = null;
        void client.close(projectId, owner.id).catch(notice.report);
      }
      return;
    }
    if (owner && client)
      try {
        await client.cancel(projectId, owner.id, turn.id);
      } catch (failure) {
        notice.report(failure);
      }
  }
  return (
    <div className="agent-conversation">
      <header className="agent-heading">
        <strong>{t.agentConversation}</strong>
        <button
          className="quiet-button"
          onClick={() =>
            fresh({
              engineId: defaults?.engineId ?? "codex",
              modelId: defaults?.modelId ?? "",
            })
          }
        >
          {t.agentNewConversation}
        </button>
      </header>
      <div
        className="agent-transcript"
        role="log"
        aria-label={t.agentConversation}
        aria-live="polite"
      >
        {!turns.length && <p className="muted">{t.agentWelcome}</p>}
        {turns.map((turn, index) => (
          <article
            className="agent-turn"
            key={index}
            data-agent-status={turn.status}
          >
            <p className="agent-instruction">{turn.instruction}</p>
            <p className="agent-reply">{turn.reply}</p>
            {turn.progress && <p className="muted">{turn.progress}</p>}
            <p role="status">
              {turn.error
                ? errorMessage(turn.error, t)
                : t[`agentStatus_${turn.status}`]}
            </p>
            {turn.proposal && turn.capture && turn.status === "completed" && (
              <section className="agent-proposal" aria-label={t.agentProposal}>
                <p>
                  {turn.capture.kind === "outline"
                    ? t.writingOutline
                    : t.manuscript}{" "}
                  · {t.agentSelectionContext}
                </p>
                <ExchangeComparison
                  current={turn.capture.selection!.quote}
                  returned={turn.proposal.text}
                  t={t}
                />
                {turn.outcome ? (
                  <p role="status">
                    {turn.outcome === "applied"
                      ? t.agentApplied
                      : t.agentDiscarded}
                  </p>
                ) : (
                  <>
                    <button
                      disabled={turn.applying}
                      onClick={() => {
                        if (turn.applying || !turn.sessionId || !turn.id)
                          return;
                        turn.applying = true;
                        redraw();
                        const identity = generation.current;
                        void apply(
                          turn.capture!,
                          turn.proposal!,
                          turn.sessionId,
                          turn.id,
                        )
                          .then(() => {
                            if (identity === generation.current) {
                              turn.outcome = "applied";
                              delete turn.error;
                            }
                          })
                          .catch((failure) => {
                            if (identity === generation.current) {
                              turn.error = failure;
                              notice.report(failure);
                            }
                          })
                          .finally(() => {
                            if (identity === generation.current) {
                              turn.applying = false;
                              redraw();
                            }
                          });
                      }}
                    >
                      {t.agentApply}
                    </button>
                    <button
                      disabled={turn.applying}
                      onClick={() => {
                        turn.outcome = "discarded";
                        redraw();
                      }}
                    >
                      {t.agentDiscard}
                    </button>
                  </>
                )}
              </section>
            )}
            {["failed", "cancelled"].includes(turn.status) && (
              <button
                disabled={busy}
                onClick={() => {
                  fresh();
                  void send(turn.instruction);
                }}
              >
                {t.agentRetryFresh}
              </button>
            )}
          </article>
        ))}
        <div ref={end} />
      </div>
      <div className="agent-composer">
        {catalog.loading && (
          <p role="status" className="muted">
            {t.agentChecking}
          </p>
        )}
        <div className="agent-context-chip" title={contextLabel}>
          {contextLabel}
        </div>
        {!engine?.available && (
          <p role="status">
            {t.AGENT_UNAVAILABLE}{" "}
            <button
              className="quiet-button"
              onClick={() => openSettings("agent")}
            >
              {t.notificationOpenSettings}
            </button>
          </p>
        )}
        <textarea
          aria-label={t.agentInstruction}
          placeholder={t.agentPlaceholder}
          value={text}
          onChange={(e) => {
            draftEpoch.current++;
            textRef.current = e.target.value;
            setText(e.target.value);
          }}
          onCompositionStart={() =>
            composition.composition("agent-composer", true)
          }
          onCompositionEnd={() =>
            composition.composition("agent-composer", false)
          }
          onBlur={() =>
            composition.blur("agent-composer", () =>
              composition.composition("agent-composer", false),
            )
          }
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              (e.ctrlKey || e.metaKey) &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="agent-toolbar">
          <select
            aria-label={t.agentEngine}
            disabled={busy}
            value={engine?.id ?? ""}
            onChange={(e) => fresh({ engineId: e.target.value, modelId: "" })}
          >
            {catalog.engines.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
          <select
            aria-label={t.agentModel}
            disabled={busy || !engine?.models.length}
            value={model?.id ?? ""}
            onChange={(e) =>
              fresh({ engineId: engine!.id, modelId: e.target.value })
            }
          >
            {!model && <option value="">{t.agentNoModels}</option>}
            {engine?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {busy && currentTurn.current?.status !== "completed" ? (
            <button onClick={() => void stop()}>{t.agentStop}</button>
          ) : (
            <button
              disabled={busy || !engine?.available || !model || !text.trim()}
              onClick={() => void send()}
            >
              {t.agentSend}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
