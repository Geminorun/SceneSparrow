import { expect, test as base } from "@playwright/test";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error Existing process fixture is plain ESM.
import { start, waitFor } from "../../scripts/processes.mjs";
import { openWorkbench } from "./helpers/workbench";

async function unusedPort() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((done) => socket.close(() => done()));
  return port;
}

const test = base.extend<{ url: string }>({
  // Use a private workspace and the normal SSE transport for both tabs.
  url: async ({}, use) => {
    const [webPort, corePort] = await Promise.all([unusedPort(), unusedPort()]);
    const directory = await mkdtemp(join(tmpdir(), "scenesparrow-lock-e2e-"));
    const url = `http://127.0.0.1:${webPort}`;
    const child = start(process.execPath, ["scripts/dev.mjs"], {
      env: {
        ...process.env,
        SCENESPARROW_WEB_PORT: String(webPort),
        SCENESPARROW_CORE_PORT: String(corePort),
        SCENESPARROW_PROJECT_DIR: join(directory, "project"),
        SCENESPARROW_APP_DATA_DIR: join(directory, "app"),
      },
      stdio: "ignore",
    });
    const exited = once(child, "exit");
    try {
      await waitFor(url, {}, child);
      await use(url);
    } finally {
      child.kill();
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
});

test("locking and unlocking update one block and preserve the caret with one write and one read", async ({
  page,
  context,
  url,
}) => {
  await openWorkbench(page, { url });
  const editor = page.getByRole("textbox", { name: "Manuscript", exact: true });
  await editor.fill("Protected paragraph");
  await editor.press("End");
  await editor.press("Enter");
  await page.keyboard.insertText("Unrelated paragraph");
  await editor.press("ControlOrMeta+s");
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );

  const observer = await context.newPage();
  await openWorkbench(observer, { url });
  const lock = page.locator("[data-lock-block]").first();
  const observed = observer.locator("[data-lock-block]").first();
  await expect(lock).toBeEnabled();
  await expect(observed).toBeEnabled();
  await page.bringToFront();
  const blockId = await lock.getAttribute("data-lock-block");
  const block = editor.locator(`[data-blockid="${blockId}"]`);
  await editor.press("ControlOrMeta+End");

  const selection = () =>
    editor.evaluate(() => {
      const caret = window.getSelection()!;
      return [caret.focusNode?.textContent, caret.focusOffset];
    });
  const caret = await selection();
  expect(caret[0]).toBe("Unrelated paragraph");
  const editorNode = await editor.elementHandle();
  let release!: () => void;
  let received!: () => void;
  const requests: string[] = [];
  let hold: Promise<void>;
  await page.route("**/api/v1/manuscript/commands", async (route) => {
    if (route.request().postDataJSON()?.type !== "SetUserLocks")
      return route.continue();
    const response = await route.fetch();
    received();
    await hold;
    await route.fulfill({ response });
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/v1/") && path !== "/api/v1/project/events")
      requests.push(`${request.method()} ${path}`);
  });

  for (const locked of [true, false]) {
    const commandReachedCore = new Promise<void>((resolve) => {
      received = resolve;
    });
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    requests.length = 0;
    try {
      await lock.click();
      await commandReachedCore;
      await expect(lock).toHaveAttribute("aria-busy", "true");
      await expect(lock).toHaveAttribute("aria-pressed", String(!locked));
      await expect(observed).toHaveAttribute("aria-pressed", String(locked));
    } finally {
      release();
    }
    await expect(lock).toBeEnabled();
    await expect(lock).toHaveAttribute("aria-pressed", String(locked));
    await expect(lock).toHaveAttribute(
      "title",
      locked ? "Unlock block" : "Lock block",
    );
    if (locked) await expect(block).toHaveAttribute("contenteditable", "false");
    else await expect(block).not.toHaveAttribute("contenteditable", "false");
    await expect(editor).toBeFocused();
    expect(await selection()).toEqual(caret);
    expect(
      await editor.evaluate(
        (current, original) => current === original,
        editorNode,
      ),
    ).toBe(true);
    // Include the SSE polling window so this also detects late duplicate reads.
    await page.waitForTimeout(500);
    expect(requests).toEqual([
      "POST /api/v1/manuscript/commands",
      "GET /api/v1/manuscript/finalization",
    ]);
  }
});
