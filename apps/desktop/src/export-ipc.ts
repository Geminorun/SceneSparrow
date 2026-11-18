import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type {
  PreparedCopy,
  ExportJob,
  DeliveryAction,
  DeliveryReceipt,
} from "@scenesparrow/contracts";
import { createHash } from "node:crypto";
import {
  NativeDelivery,
  NativeClipboard,
  deliveryError,
} from "./export-delivery.js";
import { commitExportFile, prepareDestination } from "./export-files.js";

interface Host {
  checkSender(event: IpcMainInvokeEvent, existing?: boolean): void;
  request(
    path: string,
    body?: unknown,
    method?: string,
  ): Promise<{ ok: true; data: unknown } | { ok: false; code: string }>;
  session(): { core: unknown; baseUrl: string; token: string };
  fetch: typeof fetch;
  chooseFile(job: ExportJob): Promise<string | null>;
  writeClipboard(text: string): void;
}

export function registerExportIpc(ipc: Pick<IpcMain, "handle">, host: Host) {
  const nativeDelivery = new NativeDelivery<
    Awaited<ReturnType<typeof prepareDestination>>
  >({
    intent: async (action) => {
      const r = await host.request("/manuscript/deliveries", action);
      if (!r.ok) throw Error(r.code);
      return r.data as unknown as DeliveryReceipt;
    },
    artifact: (action) => verifiedArtifact(action.jobId, action.artifactHash),
    choose: async (job) => {
      const selected = await host.chooseFile(job);
      return selected ? prepareDestination(selected, job.format) : null;
    },
    commit: commitExportFile,
    finish: async (action, status) => {
      const r = await host.request(`/manuscript/deliveries/${status}`, action);
      if (!r.ok) throw Error(r.code);
      return r.data as unknown as DeliveryReceipt;
    },
  });
  const nativeClipboard = new NativeClipboard(
    async (id) => {
      const result = await host.request(`/manuscript/copies/${id}`);
      if (!result.ok) throw Error(result.code);
      return result.data as unknown as PreparedCopy;
    },
    (text) => host.writeClipboard(text),
  );
  const idValid = (id: unknown): id is string =>
    typeof id === "string" && /^[0-9a-f-]{36}$/.test(id);
  async function verifiedArtifact(id: string, hash?: string) {
    const result = await host.request(`/manuscript/exports/${id}`);
    if (!result.ok)
      throw Error("code" in result ? result.code : "EXPORT_FAILED");
    const job = result.data as unknown as ExportJob;
    if (job.status !== "ready" || (hash && job.artifactHash !== hash))
      throw Error("ARTIFACT_MISMATCH");
    const { baseUrl, token } = host.session();
    const response = await host.fetch(
      `${baseUrl}/manuscript/exports/${id}/artifact`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) throw Error("DOWNLOAD_UNAVAILABLE");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (
      bytes.length > 32 * 1024 * 1024 ||
      createHash("sha256").update(bytes).digest("hex") !== job.artifactHash
    )
      throw Error("ARTIFACT_MISMATCH");
    return { job, bytes };
  }
  for (const [channel, action] of [
    ["export:start", ""],
    ["export:job", "read"],
    ["export:cancel", "cancel"],
    ["export:retry", "retry"],
  ] as const) {
    ipc.handle(channel, (event, id: unknown, body: unknown) => {
      host.checkSender(event);
      if (!action) return host.request("/manuscript/exports", id);
      if (!idValid(id)) return { ok: false, code: "INVALID_REQUEST" };
      return host.request(
        `/manuscript/exports/${id}${action === "read" ? "" : `/${action}`}`,
        action === "read" ? undefined : body,
      );
    });
  }
  ipc.handle("export:bytes", async (event, id: unknown) => {
    host.checkSender(event);
    if (!idValid(id)) return { ok: false, code: "INVALID_REQUEST" };
    try {
      return { ok: true, data: (await verifiedArtifact(id)).bytes };
    } catch (e) {
      return {
        ok: false,
        code: e instanceof Error ? e.message : "DOWNLOAD_UNAVAILABLE",
      };
    }
  });
  function deliveryAction(value: unknown): DeliveryAction {
    const a = value as DeliveryAction;
    if (
      !a ||
      Object.keys(a).some(
        (k) => !["deliveryId", "jobId", "artifactHash"].includes(k),
      ) ||
      !idValid(a.deliveryId) ||
      !idValid(a.jobId) ||
      !/^[a-f0-9]{64}$/.test(a.artifactHash)
    )
      throw Error("INVALID_REQUEST");
    return a;
  }
  ipc.handle("export:list", (event) => {
    host.checkSender(event);
    return host.request("/manuscript/exports");
  });
  ipc.handle("copy:prepare", (event, body: unknown) => {
    host.checkSender(event);
    return host.request("/manuscript/copies", body);
  });
  ipc.handle("export:clipboard", async (event, value: unknown) => {
    host.checkSender(event);
    try {
      const a = value as {
        deliveryId: string;
        preparationId: string;
        bodyHash: string;
      };
      if (
        !a ||
        Object.keys(a).some(
          (k) => !["deliveryId", "preparationId", "bodyHash"].includes(k),
        ) ||
        !idValid(a.deliveryId) ||
        !idValid(a.preparationId) ||
        !/^[a-f0-9]{64}$/.test(a.bodyHash)
      )
        throw Error("INVALID_REQUEST");
      const owningCore = host.session().core;
      await nativeClipboard.copy(a, () => {
        host.checkSender(event, true);
        if (host.session().core !== owningCore)
          throw Error("CAPABILITY_EXPIRED");
      });
      return { ok: true, data: null };
    } catch {
      return { ok: false, code: "CLIPBOARD_UNAVAILABLE" };
    }
  });
  ipc.handle("export:save", async (event, value: unknown) => {
    host.checkSender(event);
    const owningCore = host.session().core;
    try {
      return {
        ok: true,
        data: await nativeDelivery.save(deliveryAction(value), () => {
          host.checkSender(event, true);
          if (host.session().core !== owningCore)
            throw Error("CAPABILITY_EXPIRED");
        }),
      };
    } catch (e) {
      return { ok: false, code: deliveryError(e) };
    }
  });
  return {
    async settled() {
      await nativeDelivery.settled();
      await nativeClipboard.settled();
    },
    clear() {
      nativeDelivery.clear();
      nativeClipboard.clear();
    },
  };
}
