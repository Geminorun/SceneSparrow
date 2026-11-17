import { test as base, expect } from "@playwright/test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
// @ts-expect-error Existing process fixture is plain ESM.
import { waitFor } from "../../../scripts/processes.mjs";

type Core = {
  request: (path: string, body?: unknown) => Promise<any>;
  intercept: (
    handler: (
      path: string,
      body: any,
      phase: "before" | "after",
    ) => Promise<void>,
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
      ) => Promise<void> = async () => {};
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
          await intercept(target.pathname, body, "after");
          await route.fulfill({ response });
        });
        await use({
          intercept: (handler) => {
            intercept = handler;
          },
          request: async (path, body) => {
            const response = await fetch(url + path, {
              method: body ? "POST" : "GET",
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
