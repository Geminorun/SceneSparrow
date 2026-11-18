import type { ProjectEvent } from "@scenesparrow/contracts";
import { TransportError } from "./errors";
import { decodeJson, fetchResponse, reportTransport } from "./transport";

/** Fetch-based SSE carries authentication headers only; cursor replay never invokes commands. */
export function subscribeProjectEvents(
  url: string,
  headers: Record<string, string>,
  handler: (event: ProjectEvent) => void,
  resync: () => void,
) {
  const abort = new AbortController();
  let after = 0;
  void (async () => {
    while (!abort.signal.aborted) {
      try {
        const response = await fetchResponse(`${url}?after=${after}`, {
          headers,
          signal: abort.signal,
        });
        if (!response.ok) await decodeJson(response);
        if (!response.body)
          throw new TransportError(
            "NETWORK_FAILED",
            response.status,
            response.headers.get("X-SceneSparrow-Trace-Id"),
          );
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            pending += decoder
              .decode(value, { stream: true })
              .replaceAll("\r\n", "\n");
            if (pending.length > 1024 * 1024)
              throw new Error("INVALID_REQUEST");
            let boundary;
            while ((boundary = pending.indexOf("\n\n")) >= 0) {
              const frame = pending.slice(0, boundary);
              pending = pending.slice(boundary + 2);
              const data = frame
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trimStart())
                .join("\n");
              if (
                frame.split("\n").some((l) => l === "event: resync_required")
              ) {
                after = Number(data) || 0;
                resync();
              } else if (data) {
                const event = JSON.parse(data) as ProjectEvent;
                if (
                  Number.isSafeInteger(event.sequence) &&
                  event.sequence > after
                ) {
                  after = event.sequence;
                  handler(event);
                }
              }
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } catch (error) {
        if (!abort.signal.aborted) reportTransport(error, "/v1/project/events");
        /* Reconnect using the last delivered cursor, without replaying work. */
      }
      if (!abort.signal.aborted)
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            abort.signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, 500);
          abort.signal.addEventListener("abort", finish, { once: true });
          if (abort.signal.aborted) finish();
        });
    }
  })();
  return () => abort.abort();
}
