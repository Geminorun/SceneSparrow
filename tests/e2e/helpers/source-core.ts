import { test as base, expect } from "@playwright/test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  unlink,
  stat,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
// @ts-expect-error Existing process fixture is plain ESM.
import { waitFor } from "../../../scripts/processes.mjs";

type Core = {
  receiptFailure: (id: string | null) => void;
  creative: (path: string, bytes: string | Uint8Array) => Promise<void>;
  workFile: (
    item: string,
    path: string,
    bytes: string | Uint8Array,
  ) => Promise<void>;
  workSource: (item: string) => Promise<string>;
  external: (source: string | null) => Promise<void>;
  disk: () => Promise<Buffer>;
  seed: (source: string) => Promise<any>;
  injectIntent: (
    unknown?: boolean,
    version?: number,
    applicationTaskId?: string,
  ) => Promise<void>;
  request: (path: string, body?: unknown, method?: string) => Promise<any>;
  intercept: (
    handler: (
      path: string,
      body: any,
      phase: "before" | "after",
    ) => Promise<void | "abort">,
  ) => void;
};
export const test = base.extend<{ core: Core }>({
  core: [
    async ({ context }, use) => {
      const directory = await mkdtemp(
        join(tmpdir(), "scenesparrow-workspace-"),
      );
      const token = randomBytes(32).toString("hex");
      const socket = createServer();
      await new Promise<void>((resolve) =>
        socket.listen(0, "127.0.0.1", resolve),
      );
      const port = (socket.address() as { port: number }).port;
      await new Promise<void>((resolve) => socket.close(() => resolve()));
      const url = `http://127.0.0.1:${port}/v1`;
      const child = spawn("./target/debug/scenesparrow-service", [], {
        env: {
          ...process.env,
          SCENESPARROW_PROJECT_OPEN_MODE: "format-create",
          SCENESPARROW_CORE_PORT: String(port),
          SCENESPARROW_SESSION_TOKEN: token,
          SCENESPARROW_PROJECT_DIR: join(directory, "project"),
          SCENESPARROW_APP_DATA_DIR: join(directory, "app"),
        },
        stdio: "ignore",
      });
      let intercept: (
        path: string,
        body: any,
        phase: "before" | "after",
      ) => Promise<void | "abort"> = async () => {};
      try {
        await waitFor(
          `${url}/health`,
          { Authorization: `Bearer ${token}` },
          child,
        );
        await context.route("**/api/**", async (route) => {
          const target = new URL(route.request().url());
          if (target.pathname.endsWith("/project/events")) {
            await route.fulfill({
              status: 200,
              contentType: "text/event-stream",
              body: "event: resync_required\ndata: {}\n\n",
            });
            return;
          }
          const body =
            route.request().method() === "POST" &&
            route
              .request()
              .headers()
              ["content-type"]?.includes("application/json")
              ? route.request().postDataJSON()
              : null;
          await intercept(target.pathname, body, "before");
          const response = await route.fetch({
            url: url + target.pathname.replace("/api/v1", "") + target.search,
            headers: {
              ...route.request().headers(),
              Authorization: `Bearer ${token}`,
            },
          });
          if ((await intercept(target.pathname, body, "after")) === "abort")
            await route.abort("failed");
          else await route.fulfill({ response });
        });
        const request = async (
          path: string,
          body?: unknown,
          method?: string,
        ) => {
          const response = await fetch(url + path, {
            method: method ?? (body ? "POST" : "GET"),
            headers: {
              Authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
          const data = await response.json();
          if (!response.ok) throw Error(JSON.stringify(data));
          return data;
        };
        const root = join(directory, "project"),
          management = join(root, ".scenesparrow");
        await use({
          receiptFailure: (id) => {
            const db = new DatabaseSync(join(management, "project.sqlite"));
            try {
              db.exec("DROP TRIGGER IF EXISTS browser_work_receipt_failure");
              if (id) {
                if (!/^[0-9a-f-]{36}$/.test(id))
                  throw Error("fixture request ID");
                db.exec(
                  `CREATE TRIGGER browser_work_receipt_failure BEFORE INSERT ON command_receipts WHEN NEW.request_id='${id}' BEGIN SELECT RAISE(FAIL,'browser fixture SQL cut'); END;`,
                );
              }
            } finally {
              db.close();
            }
          },
          creative: async (path, bytes) => {
            await mkdir(join(root, path, ".."), { recursive: true });
            await writeFile(join(root, path), bytes);
          },
          workFile: async (item, path, bytes) => {
            const target = join(
              management,
              "work-items",
              item,
              "project",
              path,
            );
            await mkdir(join(target, ".."), { recursive: true });
            await writeFile(target, bytes);
          },
          workSource: (item) =>
            readFile(
              join(management, "work-items", item, "project/manuscript.md"),
              "utf8",
            ),
          external: (source) =>
            source === null
              ? unlink(join(root, "manuscript.md"))
              : writeFile(join(root, "manuscript.md"), source),
          disk: () => readFile(join(root, "manuscript.md")),
          seed: async (source) => {
            const before = await request("/manuscript/source");
            return request("/manuscript/source", {
              requestId: randomUUID(),
              projectId: before.projectId,
              expectedWorkingRevision: before.workingRevision,
              expectedGeneration: before.generation,
              expectedHash: before.acceptedHash,
              source,
              group: {
                clientSessionId: randomUUID(),
                groupId: randomUUID(),
                groupSequence: 1,
                kind: "discrete",
              },
            });
          },
          injectIntent: async (
            unknown = false,
            version = 2,
            applicationTaskId?: string,
          ) => {
            // Native test setup only: install a sanitized uncommitted journal at
            // the same seam exercised by infrastructure fault-cut tests.
            const before = await request("/manuscript/source"),
              bytes = Buffer.from(before.source),
              hash = (b: Buffer) =>
                createHash("sha256").update(b).digest("hex");
            const after = Buffer.from("Staged pending version\r\n"),
              afterHash = hash(after),
              name = ".scenesparrow-stage-" + randomUUID(),
              identity = await stat(join(root, "manuscript.md"));
            const objectPath = join(management, "objects", afterHash);
            await writeFile(objectPath, after);
            await writeFile(
              join(root, name),
              unknown ? Buffer.from([0xef, 0xbb, 0xbf, 0xff, 0x00]) : after,
            );
            const stagedIdentity = await stat(join(root, name));
            let requestId = randomUUID(),
              digest = "0".repeat(64);
            if (applicationTaskId) {
              const db = new DatabaseSync(join(management, "project.sqlite"), {
                readOnly: true,
              });
              try {
                requestId = (
                  db
                    .prepare(
                      "SELECT application_command_id FROM script_ai_tasks WHERE id=?",
                    )
                    .get(applicationTaskId) as {
                    application_command_id: string;
                  }
                ).application_command_id;
              } finally {
                db.close();
              }
              const history = await request("/history");
              digest = hash(
                Buffer.from(
                  JSON.stringify({
                    type: "UsePlanningResult",
                    requestId,
                    projectId: before.projectId,
                    expectedWorkingRevision: before.workingRevision,
                    payload: {
                      taskId: applicationTaskId,
                      expectedHistoryRevision: history.historyRevision,
                      explicit: false,
                    },
                  }),
                ),
              );
            }
            const intent = {
              version,
              request_id: requestId,
              digest,
              project_id: before.projectId,
              expected_generation: before.generation,
              changes: [
                {
                  relative_path: "manuscript.md",
                  before_hash: hash(bytes),
                  after_hash: afterHash,
                  before_identity: {
                    device: identity.dev,
                    inode: identity.ino,
                  },
                  after_identity: {
                    device: stagedIdentity.dev,
                    inode: stagedIdentity.ino,
                  },
                  staged_name: name,
                },
              ],
              ...(version === 2
                ? {
                    accepted: {
                      before_hash: before.acceptedHash,
                      after_hash: afterHash,
                    },
                  }
                : {}),
            };
            await writeFile(
              join(management, "source-intent.json"),
              JSON.stringify(intent),
            );
            if (unknown)
              await writeFile(
                join(root, "manuscript.md"),
                "Unknown live version\r\n",
              );
          },
          intercept: (handler) => {
            intercept = handler;
          },
          request: async (path, body, method) => {
            const response = await fetch(url + path, {
              method: method ?? (body ? "POST" : "GET"),
              headers: {
                Authorization: `Bearer ${token}`,
                "content-type": "application/json",
              },
              ...(body ? { body: JSON.stringify(body) } : {}),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(JSON.stringify(data));
            return data;
          },
        });
      } finally {
        await context.unrouteAll({ behavior: "ignoreErrors" });
        const stopped = once(child, "exit");
        child.kill();
        await stopped;
        await rm(directory, { recursive: true, force: true });
      }
    },
    { auto: true },
  ],
});
export { expect };
