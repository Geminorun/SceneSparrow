import type {
  AgentAttachment,
  AgentProposal,
  AgentSelection,
  MarkdownDocumentKind,
} from "@scenesparrow/contracts";
import { ApiError } from "@scenesparrow/platform-client";

export type AgentCapture = {
  projectId: string;
  kind: MarkdownDocumentKind;
  session: object;
  epoch: number;
  text: string;
  revision: string | null;
  selection: AgentSelection | null;
};
export async function agentAttachment(
  capture: AgentCapture,
): Promise<AgentAttachment> {
  const bytes = new TextEncoder().encode(capture.text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return {
    kind: capture.kind,
    revision: capture.revision,
    sourceDigest: Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
    selection: capture.selection,
    buffer: capture.selection ? null : capture.text,
  };
}
export function proposalText(capture: AgentCapture, proposal: AgentProposal) {
  const selection = capture.selection;
  if (
    !selection ||
    proposal.context.projectId !== capture.projectId ||
    proposal.context.kind !== capture.kind ||
    proposal.context.revision !== capture.revision ||
    proposal.context.selection?.quote !== selection.quote ||
    proposal.context.selection.range.start !== selection.range.start ||
    proposal.context.selection.range.end !== selection.range.end
  )
    throw new ApiError("AGENT_PROPOSAL_STALE");
  const bytes = new TextEncoder().encode(capture.text);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  if (
    selection.range.start < 0 ||
    selection.range.end > bytes.length ||
    selection.range.start >= selection.range.end ||
    decoder.decode(
      bytes.subarray(selection.range.start, selection.range.end),
    ) !== selection.quote
  )
    throw new ApiError("AGENT_SELECTION_INVALID");
  return (
    decoder.decode(bytes.subarray(0, selection.range.start)) +
    proposal.text +
    decoder.decode(bytes.subarray(selection.range.end))
  );
}
