import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  AgentContext,
  AgentConversationSummary,
  AgentGeneration,
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
import { conversationDefaults, type AgentCatalog } from "./catalog";

type Turn = {
  instruction: string;
  createdAt: number;
  id?: string;
  sessionId?: string;
  capture?: AgentCapture;
  context?: AgentContext;
  reply: string;
  progress: string;
  status: AgentTurnStatus;
  error?: unknown;
  proposal?: AgentProposal | undefined;
  outcome?: "applied" | "discarded" | undefined;
  applying?: boolean;
};
export function AgentConversation({
  client,
  catalog,
  projectId,
  t,
  active,
  contextLabel,
  clearSelection,
  composition,
  prepareIntent,
  validate,
  apply,
  restoreCapture,
  generate,
  openGeneration,
  review,
}: {
  client: ExternalWritingClient | undefined;
  catalog: AgentCatalog;
  projectId: string;
  t: typeof en;
  active: boolean;
  contextLabel: string;
  clearSelection?: (() => void) | undefined;
  composition: CompositionActions;
  prepareIntent: () => () => Promise<AgentCapture>;
  validate: (capture: AgentCapture) => void;
  apply: (
    capture: AgentCapture,
    proposal: AgentProposal,
    sessionId: string,
    turnId: string,
  ) => Promise<void>;
  restoreCapture: (context: AgentContext) => AgentCapture;
  generate: (
    kind: "outline" | "draft",
    brief: string,
    conversation: () => Promise<string>,
  ) => Promise<boolean>;
  openGeneration: (generation: AgentGeneration) => Promise<void>;
  review?: ReactNode;
}) {
  const savedDefaults = useSyncExternalStore(
    applicationPreferences.subscribe,
    applicationPreferences.getSnapshot,
  ).agentDefault;
  const defaults = conversationDefaults(savedDefaults, catalog.defaultChoice);
  const [explicitChoice, setChoice] = useState<{
    engineId: string;
    modelId: string;
  } | null>(null);
  const choice = explicitChoice ?? defaults;
  const engine = catalog.engines.find((e) => e.id === choice.engineId);
  const model =
    engine?.models.find((m) => m.id === choice.modelId) ??
    (choice.engineId !== "deepseek" && !choice.modelId
      ? engine?.models[0]
      : undefined);
  const [turns, setTurns] = useState<Turn[]>([]),
    [generations, setGenerations] = useState<AgentGeneration[]>([]);
  const [text, setText] = useState(""),
    [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<AgentConversationSummary[]>([]),
    [historyOpen, setHistoryOpen] = useState(false);
  const [search, setSearch] = useState(""),
    [renaming, setRenaming] = useState<string | null>(null),
    [rename, setRename] = useState("");
  const [pendingGeneration, setPendingGeneration] =
    useState<AgentGeneration | null>(null);
  const [title, setTitle] = useState(""),
    [more, setMore] = useState(false),
    [following, setFollowing] = useState(true);
  const textRef = useRef(text);
  textRef.current = text;
  const draftEpoch = useRef(0),
    running = useRef(false),
    mounted = useRef(true),
    generation = useRef(0);
  const session = useRef<AgentSession | null>(null),
    stream = useRef<AbortController | null>(null),
    currentTurn = useRef<Turn | null>(null);
  const sendIntent = useRef<{ key: string; dispatched: boolean } | null>(null);
  const transcript = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    historyMenu = useRef<HTMLDivElement>(null);
  const notice = useNoticeOwner(),
    openSettings = useOpenSettings();
  const redraw = () => {
    if (mounted.current) setTurns((current) => [...current]);
  };
  const refreshHistory = async () => {
    const data = await client?.history?.(projectId);
    if (mounted.current && data) setHistory(data.conversations);
    return data;
  };
  function detach() {
    generation.current++;
    if (sendIntent.current) composition.cancel(sendIntent.current.key);
    sendIntent.current = null;
    stream.current?.abort();
    stream.current = null;
    currentTurn.current = null;
    running.current = false;
  }
  async function watch(owner: AgentSession, turn: Turn, identity: number) {
    if (!client || !turn.id) return;
    const controller = new AbortController();
    stream.current = controller;
    currentTurn.current = turn;
    running.current = true;
    setBusy(true);
    try {
      await client.stream(
        projectId,
        owner.id,
        turn.id,
        0,
        (event) => {
          if (
            !mounted.current ||
            generation.current !== identity ||
            controller.signal.aborted ||
            event.sessionId !== owner.id ||
            event.turnId !== turn.id ||
            event.projectId !== projectId
          )
            return;
          if (event.type === "text") turn.reply += event.text;
          else if (event.type === "progress") turn.progress = event.text;
          else if (event.type === "proposal") turn.proposal = event.proposal;
          else {
            turn.reply = event.reply;
            turn.status = event.status;
            turn.progress = "";
            if (event.status !== "completed") delete turn.proposal;
            if (event.errorCode) {
              turn.error = event.errorCode;
              notice.report(event.errorCode);
            }
          }
          redraw();
        },
        controller.signal,
      );
      if (generation.current === identity && turn.status === "running")
        throw new ApiError("AGENT_STREAM_INTERRUPTED");
    } catch (failure) {
      if (
        mounted.current &&
        generation.current === identity &&
        !controller.signal.aborted
      ) {
        turn.status = "failed";
        turn.error = failure;
        notice.report(failure);
        redraw();
      }
    } finally {
      if (mounted.current && generation.current === identity) {
        running.current = false;
        setBusy(false);
        stream.current = null;
        void refreshHistory().catch(notice.report);
      }
    }
  }
  async function load(id: string) {
    if (!client) return;
    detach();
    setPendingGeneration(null);
    const identity = generation.current;
    setBusy(true);
    try {
      await client.conversationAction?.(projectId, id, {
        action: "open",
        value: "",
      });
      const owner = await client.read(projectId, id);
      if (owner.projectId !== projectId)
        throw new ApiError("AGENT_CONTEXT_INVALID");
      if (!mounted.current || generation.current !== identity) return;
      session.current = owner;
      setTitle(owner.title);
      setChoice({ engineId: owner.engineId, modelId: owner.modelId });
      const loaded: Turn[] = owner.turns.map((turn) => ({
        instruction: turn.instruction,
        createdAt: turn.createdAt,
        id: turn.id,
        sessionId: owner.id,
        context: turn.context,
        reply: turn.reply,
        progress: "",
        status: turn.status,
        error: turn.errorCode ?? turn.applyError,
        proposal: turn.proposal ?? undefined,
        outcome: turn.outcome ?? undefined,
      }));
      setTurns(loaded);
      setGenerations(owner.generations);
      setPendingGeneration(null);
      setHistoryOpen(false);
      follow.current = true;
      setFollowing(true);
      const pending = loaded.find((turn) => turn.status === "running");
      if (pending) void watch(owner, pending, identity);
      else setBusy(false);
    } catch (failure) {
      if (mounted.current && generation.current === identity) {
        setBusy(false);
        notice.report(failure);
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    const identity = generation.current;
    void refreshHistory()
      .then((data) => {
        if (
          mounted.current &&
          generation.current === identity &&
          !session.current &&
          data?.currentId
        )
          void load(data.currentId);
      })
      .catch(notice.report);
    return () => {
      mounted.current = false;
      detach();
    };
  }, [client, projectId]);
  useEffect(() => {
    if (active && follow.current && transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [turns, generations, active]);
  useEffect(() => {
    if (!historyOpen) return;
    const close = (event: PointerEvent) => {
      if (!historyMenu.current?.contains(event.target as Node))
        setHistoryOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [historyOpen]);
  async function fresh(next: typeof choice | null = null) {
    detach();
    session.current = null;
    setBusy(false);
    setTurns([]);
    setGenerations([]);
    setPendingGeneration(null);
    setTitle("");
    setChoice(next);
    setHistoryOpen(false);
    await client?.conversationAction?.(projectId, "new", {
      action: "new",
      value: "",
    });
  }
  async function owner(identity: number, generationOnly = false) {
    if (!client || (!generationOnly && (!engine || !model)))
      throw new ApiError("AGENT_MODEL_UNAVAILABLE");
    if (session.current) return session.current;
    const created = await client.create(projectId, {
      requestId: crypto.randomUUID(),
      engineId:
        generationOnly && (!engine?.available || !model)
          ? "direct-api"
          : engine!.id,
      modelId:
        generationOnly && (!engine?.available || !model)
          ? "global-text-default"
          : model!.id,
    });
    if (!mounted.current || generation.current !== identity) {
      void client.close(projectId, created.id).catch(() => {});
      throw new ApiError("AGENT_CONTEXT_STALE");
    }
    session.current = created;
    setChoice({ engineId: created.engineId, modelId: created.modelId });
    return created;
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
          turn = {
            instruction,
            createdAt: Date.now(),
            reply: "",
            progress: "",
            status: "running",
          };
          setTurns((current) => [...current, turn!]);
          currentTurn.current = turn;
          const capture = await prepareContext();
          if (!valid()) return;
          turn.capture = capture;
          const attachment = await agentAttachment(capture);
          if (!valid()) return;
          validate(capture);
          const conversation = await owner(identity);
          if (!valid()) return;
          validate(capture);
          turn.sessionId = conversation.id;
          intent.dispatched = true;
          const accepted = await client.send(projectId, conversation.id, {
            requestId: crypto.randomUUID(),
            instruction,
            attachment,
          });
          if (!valid()) return;
          turn.id = accepted.id;
          turn.createdAt = accepted.createdAt;
          turn.context = accepted.context;
          setTitle(conversation.title || instruction.slice(0, 60));
          if (draftEpoch.current === epoch && retry === undefined) {
            textRef.current = "";
            setText("");
          }
          await watch(conversation, turn, identity);
        },
        valid,
      );
    } catch (failure) {
      if (valid()) {
        if (turn) {
          turn.status = "failed";
          turn.error = failure;
          delete turn.proposal;
          redraw();
        }
        notice.report(failure);
      }
    } finally {
      if (valid()) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  async function stop() {
    const turn = currentTurn.current,
      conversation = session.current,
      identity = generation.current;
    if (turn?.id && conversation && client) {
      try {
        const settled = await client.cancel(
          projectId,
          conversation.id,
          turn.id,
        );
        turn.status = settled.status;
        if (settled.status !== "running") turn.progress = "";
        turn.error = settled.errorCode ?? undefined;
        turn.reply = settled.reply || turn.reply;
        turn.proposal = settled.proposal ?? undefined;
        turn.outcome = settled.outcome ?? undefined;
        redraw();
      } catch (failure) {
        if (mounted.current && generation.current === identity)
          notice.report(failure);
        return;
      }
    } else if (sendIntent.current?.dispatched && conversation && client) {
      await client.close(projectId, conversation.id).catch(notice.report);
      if (
        mounted.current &&
        generation.current === identity &&
        session.current === conversation
      )
        session.current = null;
    }
    if (
      mounted.current &&
      generation.current === identity &&
      (session.current === conversation || session.current === null)
    ) {
      if (turn && !turn.id) {
        turn.status = "cancelled";
        turn.progress = "";
        redraw();
      }
      detach();
      setBusy(false);
    }
  }
  async function runGeneration(kind: "outline" | "draft") {
    if (running.current) return;
    const identity = generation.current;
    running.current = true;
    setBusy(true);
    setMore(false);
    currentTurn.current = null;
    setPendingGeneration({
      id: `pending-${crypto.randomUUID()}`,
      kind,
      instruction: textRef.current,
      status: "running",
      text: "",
      errorCode: null,
      revision: "",
      outlineRevision: null,
      createdAt: Date.now(),
    });
    try {
      await composition.run(
        `agent:generation:${crypto.randomUUID()}`,
        async () => {
          if (!mounted.current || generation.current !== identity) return;
          const brief = textRef.current,
            epoch = draftEpoch.current;
          setPendingGeneration(
            (current) => current && { ...current, instruction: brief },
          );
          const completed = await generate(kind, brief, async () => {
            if (!mounted.current || generation.current !== identity)
              throw new ApiError("AGENT_CONTEXT_STALE");
            return (await owner(identity, true)).id;
          });
          if (!completed) return;
          const conversation = session.current;
          if (!conversation) throw new ApiError("AGENT_CONTEXT_STALE");
          if (mounted.current && generation.current === identity) {
            if (epoch === draftEpoch.current) {
              setText("");
              textRef.current = "";
            }
            await load(conversation.id);
          }
        },
      );
    } catch (failure) {
      if (mounted.current && generation.current === identity) {
        notice.report(failure);
        if (session.current) await load(session.current.id);
      }
    } finally {
      if (mounted.current && generation.current === identity) {
        running.current = false;
        setBusy(false);
      }
      if (mounted.current && generation.current === identity)
        setPendingGeneration(null);
      void refreshHistory().catch(notice.report);
    }
  }
  const timeline = [
    ...turns.map((turn) => ({ createdAt: turn.createdAt, turn, entry: null })),
    ...[...generations, ...(pendingGeneration ? [pendingGeneration] : [])].map(
      (entry) => ({
        createdAt: entry.createdAt,
        turn: null,
        entry,
      }),
    ),
  ].sort((a, b) => a.createdAt - b.createdAt);
  return (
    <div className="agent-conversation">
      <header className="agent-heading">
        <strong title={title}>{title || t.agentConversation}</strong>
        <div ref={historyMenu} className="agent-history-anchor">
          <button
            className="quiet-button"
            aria-expanded={historyOpen}
            onClick={() => {
              setHistoryOpen(!historyOpen);
              void refreshHistory().catch(notice.report);
            }}
          >
            {t.agentHistory}
          </button>
          {historyOpen && (
            <div
              className="agent-history-menu"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setHistoryOpen(false);
                }
              }}
            >
              <input
                autoFocus
                aria-label={t.agentHistorySearch}
                placeholder={t.agentHistorySearch}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <div className="agent-history-list">
                {history
                  .filter((item) =>
                    item.title
                      .toLocaleLowerCase()
                      .includes(search.toLocaleLowerCase()),
                  )
                  .map((item) => (
                    <div key={item.id} className="agent-history-row">
                      {renaming === item.id ? (
                        <form
                          onSubmit={(event) => {
                            event.preventDefault();
                            void client
                              ?.conversationAction?.(projectId, item.id, {
                                action: "rename",
                                value: rename,
                              })
                              .then(() => {
                                setRenaming(null);
                                if (session.current?.id === item.id)
                                  setTitle(rename);
                                return refreshHistory();
                              })
                              .catch(notice.report);
                          }}
                        >
                          <input
                            autoFocus
                            aria-label={t.agentRename}
                            value={rename}
                            onChange={(event) => setRename(event.target.value)}
                          />
                          <button disabled={!rename.trim()}>
                            {t.markdownSave}
                          </button>
                        </form>
                      ) : (
                        <>
                          <button
                            className="quiet-button agent-history-title"
                            aria-current={
                              session.current?.id === item.id
                                ? "true"
                                : undefined
                            }
                            onClick={() => void load(item.id)}
                          >
                            {item.title || t.agentConversation}
                          </button>
                          <button
                            className="quiet-button"
                            aria-label={`${t.agentRename}: ${item.title}`}
                            onClick={() => {
                              setRenaming(item.id);
                              setRename(item.title);
                            }}
                          >
                            {t.agentRename}
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                {!history.length && (
                  <p className="muted">{t.agentHistoryEmpty}</p>
                )}
              </div>
            </div>
          )}
        </div>
        <button
          className="quiet-button"
          aria-label={t.agentNewConversation}
          title={t.agentNewConversation}
          onClick={() => void fresh().catch(notice.report)}
        >
          ＋
        </button>
      </header>
      <div
        ref={transcript}
        className="agent-transcript"
        role="log"
        aria-label={t.agentConversation}
        aria-live="polite"
        onScroll={() => {
          const node = transcript.current!;
          follow.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 48;
          setFollowing(follow.current);
        }}
      >
        {!turns.length && !generations.length && (
          <p className="muted">{t.agentWelcome}</p>
        )}
        {timeline.map(({ turn, entry }, index) =>
          turn ? (
            <article
              className="agent-turn"
              key={turn.id ?? index}
              data-agent-status={turn.status}
            >
              <p className="agent-instruction">{turn.instruction}</p>
              <p className="agent-reply">{turn.reply}</p>
              {(turn.progress || turn.error || turn.status !== "completed") && (
                <p role="status" className="muted">
                  {turn.error
                    ? errorMessage(turn.error, t)
                    : turn.progress === "agentWorking"
                      ? t.agentWorking
                      : turn.progress || t[`agentStatus_${turn.status}`]}
                </p>
              )}
              {turn.proposal && turn.status === "completed" && (
                <section
                  className="agent-proposal"
                  aria-label={t.agentProposal}
                >
                  <ExchangeComparison
                    current={turn.proposal.context.selection?.quote ?? ""}
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
                    <div className="agent-toolbar">
                      <button
                        disabled={turn.applying}
                        onClick={() => {
                          if (turn.applying || !turn.sessionId || !turn.id)
                            return;
                          turn.applying = true;
                          redraw();
                          void Promise.resolve()
                            .then(() => {
                              const capture =
                                turn.capture ??
                                restoreCapture(turn.proposal!.context);
                              proposalText(capture, turn.proposal!);
                              return apply(
                                capture,
                                turn.proposal!,
                                turn.sessionId!,
                                turn.id!,
                              );
                            })
                            .then(() => {
                              turn.outcome = "applied";
                              delete turn.error;
                            })
                            .catch((failure) => {
                              turn.error = failure;
                              notice.report(failure);
                            })
                            .finally(() => {
                              turn.applying = false;
                              redraw();
                            });
                        }}
                      >
                        {t.agentApply}
                      </button>
                      <button
                        disabled={turn.applying}
                        onClick={() =>
                          void client
                            ?.conversationAction?.(projectId, turn.sessionId!, {
                              action: "discard",
                              value: turn.id!,
                            })
                            .then(() => {
                              turn.outcome = "discarded";
                              redraw();
                            })
                            .catch(notice.report)
                        }
                      >
                        {t.agentDiscard}
                      </button>
                    </div>
                  )}
                </section>
              )}
              {["failed", "cancelled"].includes(turn.status) && (
                <button
                  disabled={busy}
                  onClick={() => void send(turn.instruction)}
                >
                  {t.agentRetryFresh}
                </button>
              )}
            </article>
          ) : entry ? (
            <article
              className="agent-turn"
              key={entry.id}
              data-generation-status={entry.status}
            >
              <strong>
                {entry.kind === "outline"
                  ? t.markdownGenerateOutline
                  : t.markdownGenerateDraft}
              </strong>
              {entry.instruction && (
                <p className="agent-instruction">{entry.instruction}</p>
              )}
              {entry.errorCode ? (
                <p role="status">{errorMessage(entry.errorCode, t)}</p>
              ) : entry.status === "running" ? (
                <p role="status">{t.markdownWritingProgress}</p>
              ) : null}
              {entry.text && (
                <>
                  <details>
                    <summary>{t.agentGenerationResult}</summary>
                    <pre>{entry.text}</pre>
                  </details>
                  <button
                    onClick={() =>
                      void openGeneration(entry).catch(notice.report)
                    }
                  >
                    {entry.kind === "draft"
                      ? t.markdownDraftPreview
                      : t.writingOutline}
                  </button>
                </>
              )}
              {entry.status === "failed" && (
                <button
                  disabled={busy}
                  onClick={() => {
                    setText(entry.instruction);
                    textRef.current = entry.instruction;
                    void runGeneration(entry.kind);
                  }}
                >
                  {t.agentRetryFresh}
                </button>
              )}
            </article>
          ) : null,
        )}
        {review && (
          <details id="agent-review-tools" className="agent-review-tools">
            <summary>{t.workspaceTab_review}</summary>
            {review}
          </details>
        )}
      </div>
      {!following && (
        <button
          className="agent-jump-latest"
          onClick={() => {
            follow.current = true;
            setFollowing(true);
            const node = transcript.current;
            if (node) node.scrollTop = node.scrollHeight;
          }}
        >
          {t.agentLatest}
        </button>
      )}
      <div className="agent-composer">
        <div className="agent-context-chip" title={contextLabel}>
          {contextLabel}
          {clearSelection && (
            <button
              className="quiet-button"
              aria-label={t.agentRemoveQuote}
              onClick={clearSelection}
            >
              ×
            </button>
          )}
        </div>
        {!engine?.available && choice.engineId !== "direct-api" && (
          <p role="status" className="muted">
            {catalog.loading ? t.agentChecking : t.AGENT_UNAVAILABLE}{" "}
            <button
              className="quiet-button"
              onClick={() => openSettings("agent")}
            >
              {t.notificationOpenSettings}
            </button>
          </p>
        )}
        <textarea
          id="markdown-agent-composer"
          aria-label={t.agentInstruction}
          placeholder={t.agentPlaceholder}
          value={text}
          onChange={(event) => {
            draftEpoch.current++;
            textRef.current = event.target.value;
            setText(event.target.value);
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
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.ctrlKey || event.metaKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="agent-toolbar">
          <div className="agent-add-anchor">
            <button
              className="quiet-button"
              aria-label={t.agentAdd}
              aria-expanded={more}
              onClick={() => setMore(!more)}
            >
              ＋
            </button>
            {more && (
              <div className="agent-add-menu">
                <button
                  disabled={busy || !text.trim()}
                  onClick={() => void runGeneration("outline")}
                >
                  {t.markdownGenerateOutline}
                </button>
                <button
                  disabled={busy}
                  onClick={() => void runGeneration("draft")}
                >
                  {t.markdownGenerateDraft}
                </button>
              </div>
            )}
          </div>
          <select
            aria-label={t.agentEngine}
            value={
              engine?.id ??
              (choice.engineId === "direct-api" ? "direct-api" : "")
            }
            onChange={(event) =>
              void fresh({ engineId: event.target.value, modelId: "" }).catch(
                notice.report,
              )
            }
          >
            {choice.engineId === "direct-api" && (
              <option value="direct-api">{t.markdownAiWriting}</option>
            )}
            {catalog.engines.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <select
            aria-label={t.agentModel}
            value={model?.id ?? ""}
            onChange={(event) =>
              void fresh({
                engineId: engine!.id,
                modelId: event.target.value,
              }).catch(notice.report)
            }
          >
            {!model && (
              <option value="">
                {choice.engineId === "direct-api"
                  ? t.aiDefaultModels
                  : engine?.models.length
                    ? t.deepseekChooseModel
                    : t.agentNoModels}
              </option>
            )}
            {engine?.models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          {busy && pendingGeneration ? (
            <button disabled>{t.agentWorking}</button>
          ) : busy ? (
            <button onClick={() => void stop()}>{t.agentStop}</button>
          ) : (
            <button
              disabled={!engine?.available || !model || !text.trim()}
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
