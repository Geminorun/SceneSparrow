import type { IpcMain, IpcMainInvokeEvent } from "electron";

interface Host {
  checkSender(event: IpcMainInvokeEvent): void;
  request(path: string, body?: unknown, method?: string): Promise<unknown>;
  session(): { baseUrl: string; token: string };
  fetch: typeof fetch;
}

export function registerAiIpc(ipc: Pick<IpcMain, "handle">, host: Host) {
  for (const [channel, path, method] of [
    ["ai:settings-read", "/ai/settings", "GET"],
    ["ai:settings-update", "/ai/settings", "PUT"],
    ["ai:credential-update", "/ai/credentials", "POST"],
    ["ai:credential-delete", "/ai/credentials/delete", "POST"],
    ["ai:configuration", "/ai/configuration", "GET"],
    ["ai:models", "/ai/models/discover", "POST"],
    ["ai:test-prepare", "/ai/connection-tests/prepare", "POST"],
    ["ai:test", "/ai/connection-tests", "POST"],
    ["ai:run", "/ai/runs", "GET"],
    ["ai:cancel", "/ai/runs", "POST"],
  ] as const) {
    ipc.handle(channel, (event, value: unknown) => {
      host.checkSender(event);
      if (channel === "ai:run" || channel === "ai:cancel") {
        if (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value))
          return { ok: false, code: "INVALID_REQUEST" };
        return host.request(
          `${path}/${value}${channel === "ai:cancel" ? "/cancel" : ""}`,
          undefined,
          method,
        );
      }
      return host.request(path, method === "GET" ? undefined : value, method);
    });
  }
  ipc.handle("ai:result", async (event, id: unknown) => {
    host.checkSender(event);
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id))
      return { ok: false, code: "INVALID_REQUEST" };
    const { baseUrl, token } = host.session();
    const response = await host.fetch(`${baseUrl}/ai/runs/${id}/result`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      const error = await response.json();
      return { ok: false, code: error.code ?? "RESULT_UNAVAILABLE" };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 8388608)
      return { ok: false, code: "OUTPUT_TRUNCATED" };
    return { ok: true, data: bytes };
  });
}
