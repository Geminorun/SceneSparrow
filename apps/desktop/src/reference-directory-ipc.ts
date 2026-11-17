import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  ReferenceDirectoryRegistry,
  intakeReferenceDirectory,
  type DirectoryIntakePort,
} from "./reference-directory.js";

interface Host {
  checkSender(event: IpcMainInvokeEvent, existing?: boolean): void;
  projectId(): Promise<string>;
  chooseDirectory(): Promise<string | null>;
  registry: ReferenceDirectoryRegistry;
  intakePort(): DirectoryIntakePort;
}

/** All renderer arguments are opaque IDs. The host alone supplies filesystem locators. */
export function registerReferenceDirectoryIpc(
  ipc: Pick<IpcMain, "handle">,
  host: Host,
) {
  const active = new Map<
    string,
    { sender: number; abort: AbortController; settled: Promise<void> }
  >();
  const safeError = (error: unknown, aborted = false) => ({
    ok: false as const,
    code: aborted
      ? "DOCUMENT_JOB_INTERRUPTED"
      : error instanceof Error &&
          [
            "INVALID_REQUEST",
            "OBJECT_NOT_FOUND",
            "REGISTRY_INVALID",
            "PROJECT_CLOSING",
            "ORIGIN_DENIED",
          ].includes(error.message)
        ? error.message
        : "STORAGE_UNAVAILABLE",
  });
  ipc.handle("reference-directory:read", async (event) => {
    host.checkSender(event);
    try {
      const projectId = await host.projectId();
      host.checkSender(event);
      return { ok: true, data: host.registry.read(projectId) };
    } catch (error) {
      return safeError(error);
    }
  });
  ipc.handle("reference-directory:cancel", (event, id: unknown) => {
    host.checkSender(event, true);
    if (typeof id !== "string") return safeError(Error("INVALID_REQUEST"));
    const entry = active.get(id);
    if (entry?.sender === event.sender.id) entry.abort.abort();
    return { ok: true, data: null };
  });
  for (const channel of [
    "reference-directory:pick",
    "reference-directory:refresh",
  ] as const) {
    ipc.handle(channel, async (event, id: unknown, capabilityId: unknown) => {
      host.checkSender(event);
      if (
        typeof id !== "string" ||
        !/^[0-9a-f-]{36}$/.test(id) ||
        active.size ||
        (channel.endsWith(":refresh") && typeof capabilityId !== "string")
      )
        return safeError(Error("INVALID_REQUEST"));
      const abort = new AbortController();
      let finish!: () => void;
      const settled = new Promise<void>((resolve) => {
        finish = resolve;
      });
      active.set(id, { sender: event.sender.id, abort, settled });
      // Capture authentication for this project generation; closing waits for cleanup.
      const port = host.intakePort();
      try {
        const projectId = await host.projectId();
        let association;
        let directory;
        if (channel.endsWith(":pick")) {
          const selected = await host.chooseDirectory();
          if (abort.signal.aborted || !selected)
            return { ok: true, data: null };
          host.checkSender(event);
          association = await host.registry.record(projectId, selected);
          directory = host.registry.resolve(projectId, association.id);
        } else {
          directory = host.registry.resolve(projectId, capabilityId);
          association = host.registry.read(projectId)!;
        }
        abort.signal.throwIfAborted();
        host.checkSender(event);
        const batch = await intakeReferenceDirectory(
          directory,
          association,
          port,
          abort.signal,
        );
        if (abort.signal.aborted || event.sender.isDestroyed()) {
          await Promise.allSettled(
            batch.entries.map(({ intake }) => port.cancel(intake.id)),
          );
          throw Error("DOCUMENT_JOB_INTERRUPTED");
        }
        return { ok: true, data: batch };
      } catch (error) {
        return safeError(error, abort.signal.aborted);
      } finally {
        active.delete(id);
        finish();
      }
    });
  }
  return {
    async abortAndSettle() {
      const entries = [...active.values()];
      for (const entry of entries) entry.abort.abort();
      await Promise.all(entries.map((entry) => entry.settled));
    },
  };
}
