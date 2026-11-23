import { expect, test } from "@playwright/test";
import { openWorkbench } from "./helpers/workbench";

test("locking and unlocking update one block and preserve the caret with one write and one read", async ({
  page,
  context,
}) => {
  await openWorkbench(page);
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
  await openWorkbench(observer);
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
