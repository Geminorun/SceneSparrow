import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { PackageChunkRequest } from "@scenesparrow/contracts";
interface Host {
  checkSender(event: IpcMainInvokeEvent, existing?: boolean): void;
  request(path: string, body?: unknown): Promise<unknown>;
  uploadChunk(
    request: PackageChunkRequest,
    bytes: Uint8Array,
  ): Promise<unknown>;
}
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    v,
  );
export function registerProjectPackageIpc(
  ipc: Pick<IpcMain, "handle">,
  host: Host,
) {
  const field = (body: unknown, key: string) => {
    if (
      !body ||
      typeof body !== "object" ||
      !uuid((body as Record<string, unknown>)[key])
    )
      throw Error("INVALID_REQUEST");
    return (body as Record<string, string>)[key]!;
  };
  const routes: Record<string, (a: unknown[]) => [string, unknown?]> = {
    readPackageBase: () => ["/project/packages/base"],
    startProjectPackageExport: ([b]) => ["/project/packages/exports", b],
    startWorkCopyPackageExport: ([b]) => [
      `/project/work-items/${field(b, "workItemId")}/package`,
      b,
    ],
    readPackageOperation: ([id]) => {
      if (!uuid(id)) throw Error("INVALID_REQUEST");
      return [`/project/packages/operations/${id}`];
    },
    controlPackageOperation: ([b]) => [
      `/project/packages/operations/${field(b, "operationId")}/control`,
      b,
    ],
    createPackageIntake: ([b]) => ["/project/package-intakes", b],
    readPackageIntake: ([id]) => {
      if (!uuid(id)) throw Error("INVALID_REQUEST");
      return [`/project/package-intakes/${id}`];
    },
    controlPackageIntake: ([b]) => [
      `/project/package-intakes/${field(b, "intakeId")}/control`,
      b,
    ],
    inspectPackage: ([b]) => ["/project/packages/inspections", b],
    readPackageInspection: ([id]) => {
      if (!uuid(id)) throw Error("INVALID_REQUEST");
      return [`/project/packages/inspections/${id}`];
    },
    issuePackageRestoreTarget: ([b]) => [
      "/project/packages/restore-targets",
      b,
    ],
    restorePackage: ([b]) => ["/project/packages/restores", b],
    returnPackage: ([b]) => ["/project/packages/returns", b],
  };
  for (const [name, route] of Object.entries(routes))
    ipc.handle(`project-package:${name}`, async (event, ...args: unknown[]) => {
      try {
        host.checkSender(
          event,
          name.startsWith("read") || name.startsWith("control"),
        );
        return await host.request(...route(args));
      } catch (e) {
        return {
          ok: false,
          code:
            e instanceof Error &&
            ["INVALID_REQUEST", "ORIGIN_DENIED", "PROJECT_CLOSING"].includes(
              e.message,
            )
              ? e.message
              : "CORE_UNAVAILABLE",
        };
      }
    });
  ipc.handle(
    "project-package:uploadPackageChunk",
    async (event, request: unknown, bytes: unknown) => {
      try {
        host.checkSender(event);
        field(request, "intakeId");
        field(request, "ownerProjectId");
        if (
          !(bytes instanceof Uint8Array) ||
          bytes.byteLength > 1024 * 1024 ||
          !request ||
          typeof request !== "object"
        )
          throw Error("INVALID_REQUEST");
        if (
          Object.keys(request).sort().join(",") !==
          "hash,intakeId,length,offset,ownerProjectId"
        )
          throw Error("INVALID_REQUEST");
        const r = request as PackageChunkRequest;
        if (
          !Number.isSafeInteger(r.offset) ||
          r.offset < 0 ||
          !Number.isSafeInteger(r.length) ||
          r.length !== bytes.byteLength ||
          !/^([0-9a-f]{64})$/.test(r.hash)
        )
          throw Error("INVALID_REQUEST");
        return await host.uploadChunk(r, bytes);
      } catch (e) {
        return {
          ok: false,
          code:
            e instanceof Error &&
            ["INVALID_REQUEST", "ORIGIN_DENIED", "PROJECT_CLOSING"].includes(
              e.message,
            )
              ? e.message
              : "CORE_UNAVAILABLE",
        };
      }
    },
  );
}
