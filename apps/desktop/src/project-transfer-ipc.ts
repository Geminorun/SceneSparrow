import type { IpcMain, IpcMainInvokeEvent } from "electron";
interface Host {
  checkSender(event: IpcMainInvokeEvent, existing?: boolean): void;
  request(path: string, body?: unknown): Promise<unknown>;
}
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    v,
  );
export function registerProjectTransferIpc(
  ipc: Pick<IpcMain, "handle">,
  host: Host,
) {
  const routes: Record<string, (args: unknown[]) => [string, unknown?]> = {
    inspectLegacyMigration: () => ["/project/migration"],
    issueMigrationTarget: ([body]) => ["/project/migration-targets", body],
    startLegacyMigration: ([body]) => ["/project/migrations", body],
    readMigrationOperation: ([id]) => {
      if (!uuid(id)) throw Error("INVALID_REQUEST");
      return [`/project/migrations/${id}`];
    },
    controlMigration: ([body]) => {
      if (
        !body ||
        typeof body !== "object" ||
        !uuid((body as { operationId?: unknown }).operationId)
      )
        throw Error("INVALID_REQUEST");
      return [
        `/project/migrations/${(body as { operationId: string }).operationId}/control`,
        body,
      ];
    },
  };
  for (const [name, route] of Object.entries(routes))
    ipc.handle(
      `project-transfer:${name}`,
      async (event, ...args: unknown[]) => {
        try {
          host.checkSender(
            event,
            name === "readMigrationOperation" || name === "controlMigration",
          );
          return await host.request(...route(args));
        } catch (error) {
          return {
            ok: false,
            code:
              error instanceof Error &&
              ["INVALID_REQUEST", "ORIGIN_DENIED", "PROJECT_CLOSING"].includes(
                error.message,
              )
                ? error.message
                : "CORE_UNAVAILABLE",
          };
        }
      },
    );
}
