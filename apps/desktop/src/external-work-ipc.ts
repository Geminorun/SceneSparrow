import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  commitMemberStream,
  prepareMemberDestination,
} from "./export-files.js";

interface Host {
  checkSender(event: IpcMainInvokeEvent, existing?: boolean): void;
  session(): { core: unknown; baseUrl: string; token: string };
  request(
    path: string,
    body?: unknown,
  ): Promise<{ ok: true; data: unknown } | { ok: false; code: string }>;
  reveal(path: string): Promise<void>;
  chooseFile(): Promise<string | null>;
  fetch: typeof fetch;
}
const uuid = (id: unknown): id is string =>
  typeof id === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    id,
  );
const hash = (id: unknown): id is string =>
  typeof id === "string" && /^[0-9a-f]{64}$/.test(id);
const query = (cursor: unknown) =>
  cursor === undefined
    ? ""
    : typeof cursor === "string" && cursor.length < 1024
      ? `?cursor=${encodeURIComponent(cursor)}`
      : (() => {
          throw Error("INVALID_REQUEST");
        })();
const pathFor = (id: unknown) => {
  if (!uuid(id)) throw Error("INVALID_REQUEST");
  return `/project/work-items/${id}`;
};
export function registerExternalWorkIpc(
  ipc: Pick<IpcMain, "handle">,
  host: Host,
) {
  const active = new Set<AbortController>();
  const routes: Record<string, (args: unknown[]) => [string, unknown?]> = {
    inspectGraphRecovery: ([intent]) => {
      if (!hash(intent)) throw Error("INVALID_REQUEST");
      return [`/project/file-recoveries/${intent}`];
    },
    readFileGraph: () => ["/project/file-graph"],
    readGraphFiles: ([cursor]) => [`/project/file-graph/files${query(cursor)}`],
    registerFileGraph: ([body]) => ["/project/file-graph/register", body],
    createWorkItem: ([body]) => ["/project/work-items", body],
    readWorkItems: ([cursor]) => [`/project/work-items${query(cursor)}`],
    readWorkItem: ([item]) => [pathFor(item)],
    readWorkOperation: ([request]) => {
      if (!uuid(request)) throw Error("INVALID_REQUEST");
      return [`/project/work-operations/${request}`];
    },
    readWorkCandidate: ([item, candidate]) => {
      if (!uuid(candidate)) throw Error("INVALID_REQUEST");
      return [`${pathFor(item)}/candidates/${candidate}`];
    },
    readWorkChanges: ([item, candidate, cursor]) => {
      if (!uuid(candidate)) throw Error("INVALID_REQUEST");
      return [
        `${pathFor(item)}/candidates/${candidate}/changes${query(cursor)}`,
      ];
    },
    readProductionFileLocks: ([cursor]) => [
      `/project/file-locks${query(cursor)}`,
    ],
    setProductionFileLocks: ([body]) => ["/project/file-locks", body],
    readGraphRecoveries: ([cursor]) => [
      `/project/file-recoveries${query(cursor)}`,
    ],
    readGraphRecoveryMembers: ([intent, cursor]) => {
      if (!hash(intent)) throw Error("INVALID_REQUEST");
      return [`/project/file-recoveries/${intent}/members${query(cursor)}`];
    },
  };
  for (const [name, suffix] of [
    ["inspectWorkItem", "inspect"],
    ["acceptWorkCandidate", "accept"],
    ["discardWorkItem", "discard"],
    ["controlWorkItem", "control"],
  ])
    routes[name!] = ([body]) => {
      if (!body || typeof body !== "object") throw Error("INVALID_REQUEST");
      return [
        `${pathFor((body as { workItemId?: unknown }).workItemId)}/${suffix}`,
        body,
      ];
    };
  const safe = (error: unknown) => ({
    ok: false as const,
    code:
      error instanceof Error &&
      [
        "INVALID_REQUEST",
        "CAPABILITY_EXPIRED",
        "PROJECT_CLOSING",
        "ORIGIN_DENIED",
        "DESTINATION_CHANGED",
        "ARTIFACT_MISMATCH",
        "DESTINATION_UNAVAILABLE",
        "DELIVERY_STATUS_UNKNOWN",
      ].includes(error.message)
        ? error.message
        : "DOWNLOAD_UNAVAILABLE",
  });
  for (const [name, route] of Object.entries(routes))
    ipc.handle(`external-work:${name}`, async (event, ...args: unknown[]) => {
      try {
        host.checkSender(event);
        const owner = host.session().core;
        const [path, body] = route(args);
        const result = await host.request(path, body);
        host.checkSender(event);
        if (host.session().core !== owner) throw Error("CAPABILITY_EXPIRED");
        return result;
      } catch (error) {
        return safe(error);
      }
    });
  ipc.handle("external-work:revealWorkItem", async (event, item: unknown) => {
    try {
      host.checkSender(event);
      const owner = host.session().core;
      const result = await host.request(`${pathFor(item)}/reveal`);
      host.checkSender(event);
      if (host.session().core !== owner) throw Error("CAPABILITY_EXPIRED");
      if (!result.ok) return result;
      if (typeof result.data !== "string") throw Error("INVALID_REQUEST");
      await host.reveal(result.data);
      host.checkSender(event);
      if (host.session().core !== owner) throw Error("CAPABILITY_EXPIRED");
      return { ok: true, data: true };
    } catch (error) {
      return safe(error);
    }
  });
  for (const name of [
    "downloadWorkCandidateMember",
    "downloadGraphRecoveryMember",
  ] as const)
    ipc.handle(`external-work:${name}`, async (event, ...args: unknown[]) => {
      const abort = new AbortController();
      active.add(abort);
      let response: Response | undefined;
      try {
        host.checkSender(event);
        const session = host.session();
        const check = () => {
          host.checkSender(event);
          if (host.session().core !== session.core || abort.signal.aborted)
            throw Error("CAPABILITY_EXPIRED");
        };
        let path: string;
        if (name === "downloadWorkCandidateMember") {
          const [item, candidate, member, role] = args;
          if (
            !uuid(candidate) ||
            !hash(member) ||
            (role !== "before" && role !== "after")
          )
            throw Error("INVALID_REQUEST");
          path = `${pathFor(item)}/candidates/${candidate}/members/${member}/${role}/bytes`;
        } else {
          const [intent, member] = args;
          if (!hash(intent) || !hash(member)) throw Error("INVALID_REQUEST");
          path = `/project/file-recoveries/${intent}/members/${member}/bytes`;
        }
        // Start the authenticated reader before the native dialog. The server's
        // bounded stream retains its immutable descriptor/lease through the await.
        response = await host.fetch(`${session.baseUrl}${path}`, {
          headers: { Authorization: `Bearer ${session.token}` },
          signal: abort.signal,
        });
        check();
        if (!response.ok || !response.body) throw Error("DOWNLOAD_UNAVAILABLE");
        const expected = response.headers.get("x-scenesparrow-content-sha256");
        if (!hash(expected)) throw Error("ARTIFACT_MISMATCH");
        const target = await host.chooseFile();
        check();
        if (!target) {
          await response.body.cancel();
          return { ok: true, data: false };
        }
        const destination = await prepareMemberDestination(target);
        check();
        const body = response.body;
        async function* chunks() {
          const reader = body!.getReader();
          try {
            for (;;) {
              const next = await reader.read();
              check();
              if (next.done) return;
              yield next.value;
            }
          } finally {
            reader.releaseLock();
          }
        }
        await commitMemberStream(destination, chunks(), expected, check);
        return { ok: true, data: true };
      } catch (error) {
        abort.abort();
        return safe(error);
      } finally {
        abort.abort();
        active.delete(abort);
      }
    });
  return {
    cancel() {
      for (const abort of active) abort.abort();
    },
  };
}
