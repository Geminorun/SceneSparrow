// Injected by Playwright at the renderer entry; this module is never in a product bundle.
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../packages/editor-ui/src/app/App";
import {
  createHttpClient,
  type ExternalWritingClient,
} from "../../packages/platform-client/src/index";
import type {
  AgentSession,
  AgentSendTurn,
  AgentTurn,
  AgentEvent,
} from "../../packages/contracts/src/index";
import "../../packages/editor-ui/src/styles.css";

const client = createHttpClient();
const sessions = new Map<string, AgentSession>();
const inputs = new Map<string, AgentSendTurn>();
const receipts = new Map<string, any>();
const currentIds = new Map<string, string | null>();
const fixture = {
  calls: [] as { type: string; body?: any }[],
  release: null as (() => void) | null,
  hold: false,
  available: true,
  holdSend: false,
  releaseSend: null as (() => void) | null,
  holdApply: false,
  releaseApply: null as (() => void) | null,
  holdCreate: false,
  releaseCreate: null as (() => void) | null,
};
(window as any).agentFixture = fixture;
const agent: ExternalWritingClient = {
  async history(projectId) {
    return {
      currentId: currentIds.get(projectId) ?? null,
      conversations: [...sessions.values()]
        .filter((s) => s.projectId === projectId)
        .map(({ turns, generations, requestId, ...summary }) => summary),
    };
  },
  async conversationAction(projectId, id, action) {
    if (action.action === "new") currentIds.set(projectId, null);
    else if (action.action === "open") currentIds.set(projectId, id);
    else if (action.action === "rename") sessions.get(id)!.title = action.value;
    else if (action.action === "discard")
      sessions.get(id)!.turns.find((t) => t.id === action.value)!.outcome =
        "discarded";
  },
  async catalog() {
    fixture.calls.push({ type: "catalog" });
    return [
      {
        id: "codex",
        label: "Codex",
        available: fixture.available,
        models: [
          { id: "openai.gpt-5.4", label: "GPT 5.4" },
          { id: "openai.gpt-5.4-mini", label: "GPT Mini" },
        ],
      },
      {
        id: "claude",
        label: "Claude",
        available: fixture.available,
        models: [{ id: "sonnet", label: "Sonnet" }],
      },
    ];
  },
  async create(projectId, request) {
    fixture.calls.push({ type: "create", body: request });
    if (fixture.holdCreate)
      await new Promise<void>((resolve) => {
        fixture.releaseCreate = resolve;
      });
    const session = {
      id: crypto.randomUUID(),
      projectId,
      engineId: request.engineId,
      modelId: request.modelId,
      turns: [],
      requestId: request.requestId,
      title: "",
      updatedAt: Date.now(),
      generations: [],
    };
    sessions.set(session.id, session);
    return session;
  },
  async read(_, id) {
    return sessions.get(id)!;
  },
  async close(_, id) {
    fixture.calls.push({ type: "close", body: id });
    sessions.delete(id);
  },
  async send(projectId, id, input) {
    fixture.calls.push({ type: "send", body: input });
    const turn: AgentTurn = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      requestId: input.requestId,
      instruction: input.instruction,
      attachment: input.attachment,
      reply: "",
      outcome: null,
      applyResult: null,
      applyError: null,
      status: "running",
      errorCode: null,
      proposal: null,
      context: {
        projectId,
        kind: input.attachment.kind,
        revision: input.attachment.revision,
        sourceDigest: input.attachment.sourceDigest,
        selection: input.attachment.selection,
      },
    };
    sessions.get(id)!.turns.push(turn);
    sessions.get(id)!.title ||= input.instruction.slice(0, 60);
    currentIds.set(projectId, id);
    inputs.set(turn.id, input);
    if (fixture.holdSend)
      await new Promise<void>((resolve) => {
        fixture.releaseSend = resolve;
      });
    return turn;
  },
  async cancel(_, id, turnId) {
    fixture.calls.push({ type: "cancel" });
    const turn = sessions.get(id)!.turns.find((t) => t.id === turnId)!;
    turn.status = "cancelled";
    return turn;
  },
  async stream(projectId, sessionId, turnId, _, handler, signal) {
    const turn = sessions.get(sessionId)!.turns.find((t) => t.id === turnId)!;
    let sequence = 0;
    const emit = (event: any) =>
      handler({
        projectId,
        sessionId,
        turnId,
        sequence: ++sequence,
        ...event,
      } as AgentEvent);
    emit({ type: "text", text: "Partial reply" });
    emit({ type: "progress", text: "Checking selection" });
    if (fixture.hold)
      await new Promise<void>((resolve) => {
        fixture.release = resolve;
      });
    // Deliberately deliver after abort too, to exercise the component's scope fence.
    const input = inputs.get(turnId)!;
    if (input.attachment.selection) {
      turn.proposal = {
        id: crypto.randomUUID(),
        context: turn.context,
        text: "Revised 中文 paragraph.",
      };
      emit({ type: "proposal", proposal: turn.proposal });
    }
    emit({
      type: "final",
      status: "completed",
      reply: "Authoritative final reply",
      errorCode: null,
    });
    if (turn.status !== "cancelled") {
      turn.status = "completed";
      turn.reply = "Authoritative final reply";
    }
  },
  async apply(projectId, sessionId, turnId, proposalId) {
    fixture.calls.push({ type: "apply", body: sessionId });
    if (!sessions.has(sessionId)) throw new Error("AGENT_SESSION_CLOSED");
    if (receipts.has(proposalId)) return receipts.get(proposalId);
    const turn = sessions.get(sessionId)!.turns.find((t) => t.id === turnId)!;
    const input = inputs.get(turnId)!;
    const attachment = input.attachment,
      selection = attachment.selection!;
    const doc = await client.markdownProjects!.readDocument(
      projectId,
      attachment.kind,
    );
    const bytes = new TextEncoder().encode(doc.text),
      decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    if (
      doc.revision !== attachment.revision ||
      decoder.decode(
        bytes.subarray(selection.range.start, selection.range.end),
      ) !== selection.quote
    )
      throw new Error("MARKDOWN_CONFLICT");
    const text =
      decoder.decode(bytes.subarray(0, selection.range.start)) +
      turn.proposal!.text +
      decoder.decode(bytes.subarray(selection.range.end));
    const saved = await client.markdownProjects!.saveDocument(
      projectId,
      attachment.kind,
      { revision: doc.revision, text },
    );
    if (fixture.holdApply)
      await new Promise<void>((resolve) => {
        fixture.releaseApply = resolve;
      });
    const result = {
      projectId,
      sessionId,
      turnId,
      proposalId,
      revision: saved.revision!,
    };
    receipts.set(proposalId, result);
    return result;
  },
};
client.agent = agent;
createRoot(document.getElementById("root")!).render(<App client={client} />);
