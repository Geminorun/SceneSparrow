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
  if (
    proposal.context.projectId !== capture.projectId ||
    proposal.context.kind !== capture.kind ||
    proposal.context.revision !== capture.revision
  )
    throw new ApiError("AGENT_PROPOSAL_STALE");
  if (proposal.batch) {
    const scopes = proposal.context.batch?.scopes;
    if (!scopes) throw new ApiError("AGENT_PROPOSAL_STALE");
    const bytes = new TextEncoder().encode(capture.text);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const changes = proposal.batch.changes
      .map((change) => {
        const scope = scopes.find((scope) => scope.id === change.scopeId);
        if (!scope) throw new ApiError("AGENT_PROPOSAL_STALE");
        const { start, end } = scope.selection.range;
        if (
          start < 0 ||
          end > bytes.length ||
          start >= end ||
          decoder.decode(bytes.subarray(start, end)) !== scope.selection.quote
        )
          throw new ApiError("AGENT_SELECTION_INVALID");
        return { start, end, text: change.text };
      })
      .sort((a, b) => b.start - a.start);
    if (changes.some((c, i) => i > 0 && c.end > changes[i - 1]!.start))
      throw new ApiError("AGENT_SELECTION_INVALID");
    let text = "",
      end = bytes.length;
    for (const change of changes) {
      text =
        change.text + decoder.decode(bytes.subarray(change.end, end)) + text;
      end = change.start;
    }
    return decoder.decode(bytes.subarray(0, end)) + text;
  }
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
