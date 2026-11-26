import type { AgentEvent } from "@scenesparrow/contracts";
import { ApiError } from "./errors";
import { decodeJson, fetchResponse } from "./transport";

/** A stream replays display events only. Retrying a turn always needs a new explicit request. */
export async function streamAgentEvents(
  url: string,
  scope: { projectId: string; sessionId: string; turnId: string },
  after: number,
  handler: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!Number.isSafeInteger(after) || after < 0 || after > 512)
    throw new ApiError("AGENT_CURSOR_INVALID");
  const response = await fetchResponse(`${url}?after=${after}`, {
    headers: { accept: "text/event-stream" },
    signal,
  });
  if (!response.ok) await decodeJson(response);
  if (
    !response.body ||
    !response.headers.get("content-type")?.startsWith("text/event-stream")
  )
    throw new ApiError("AGENT_STREAM_INVALID");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "",
    bytes = 0,
    final = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (signal.aborted) return;
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 8 * 1024 * 1024) throw new ApiError("AGENT_OUTPUT_LIMIT");
      pending += decoder.decode(chunk.value, { stream: true });
      let boundary;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const lines = frame.split("\n");
        if (!lines.includes("event: agent")) continue;
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        const events = JSON.parse(data) as AgentEvent[];
        if (!Array.isArray(events) || events.length > 512)
          throw new ApiError("AGENT_STREAM_INVALID");
        for (const event of events) {
          if (signal.aborted) return;
          if (
            event.projectId !== scope.projectId ||
            event.sessionId !== scope.sessionId ||
            event.turnId !== scope.turnId ||
            !Number.isSafeInteger(event.sequence) ||
            event.sequence < 1 ||
            event.sequence > 512 ||
            !["text", "progress", "proposal", "final"].includes(event.type)
          )
            throw new ApiError("AGENT_STREAM_INVALID");
          if (event.sequence <= after) continue;
          if (event.sequence !== after + 1 || final)
            throw new ApiError("AGENT_STREAM_INVALID");
          after = event.sequence;
          final = event.type === "final";
          handler(event);
        }
      }
      if (final) return;
    }
    if (!final) throw new ApiError("AGENT_STREAM_INTERRUPTED");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
