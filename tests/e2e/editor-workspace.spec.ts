import { test, expect } from "./helpers/core";
import { openWorkbench, openPanel } from "./helpers/workbench";
const input = (page: import("@playwright/test").Page) =>
  page.getByRole("textbox", { name: "Manuscript", exact: true });
const saved = (page: import("@playwright/test").Page) =>
  expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
test("blank workspace and Planning use compact editor geometry at desktop, tablet and phone sizes", async ({
  page,
}) => {
  await openWorkbench(page);
  await expect(input(page)).toBeVisible();
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const close = page.getByRole("button", { name: "Close auxiliary panel" });
    if (await close.isVisible()) await close.click();
    await page.screenshot({
      path: `.artifacts/editor-workspace-blank-${width}.png`,
    });
    await openPanel(page, "Planning");
    await page.screenshot({
      path: `.artifacts/editor-workspace-planning-${width}.png`,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
  }
});
test("real continuous typing across save acknowledgements retains node, focus and caret; Undo returns to the same empty editor", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  const editor = input(page),
    node = await editor.elementHandle();
  let edits = 0;
  core.intercept(async (_path, body, phase) => {
    if (body?.type === "ApplyDocumentEdit" && phase === "after") {
      edits++;
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
  });
  await editor.click();
  const text =
    "Continuous manuscript typing across several real save round trips.";
  await page.keyboard.type(text, { delay: 75 });
  await saved(page);
  expect(edits).toBeGreaterThanOrEqual(2);
  expect(
    await editor.evaluate((current, original) => current === original, node),
  ).toBe(true);
  await expect(editor).toBeFocused();
  expect(
    await editor.evaluate((current) => {
      const selection = window.getSelection()!;
      return (
        selection.focusNode?.textContent?.length === selection.focusOffset &&
        current.contains(selection.focusNode)
      );
    }),
  ).toBe(true);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(editor).toBeEmpty();
  expect((await core.request("/manuscript")).workspaceStage).toBe("outline");
  expect(
    await editor.evaluate((current, original) => current === original, node),
  ).toBe(true);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(editor).toContainText(text);
  await page.reload();
  await expect(editor).toContainText(text);
});
test("side tabs preserve buffers and selection actions open Review from Planning", async ({
  page,
}) => {
  await openWorkbench(page);
  await input(page).fill("Selected manuscript words");
  await saved(page);
  const node = await input(page).elementHandle();
  await openPanel(page, "Planning");
  const topic = page.getByLabel("Topic", { exact: true });
  await topic.fill("Unfinished planning buffer");
  await openPanel(page, "Sources");
  await openPanel(page, "Planning");
  await expect(topic).toHaveValue("Unfinished planning buffer");
  await input(page).focus();
  await page.keyboard.press("ControlOrMeta+a");
  const floating = page.locator(".review-floating-selection");
  await expect(floating).toBeVisible();
  await floating.getByRole("button", { name: "Question", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "Review", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".review-panel blockquote").first()).toContainText(
    "Selected manuscript words",
  );
  await page
    .getByLabel("Your question or instruction")
    .fill("Keep this unsent review");
  await openPanel(page, "Structure");
  await openPanel(page, "Review");
  await expect(page.getByLabel("Your question or instruction")).toHaveValue(
    "Keep this unsent review",
  );
  expect(
    await input(page).evaluate(
      (current, original) => current === original,
      node,
    ),
  ).toBe(true);
});
test("planning validation correction resumes autosave, error geometry is stable and discard cancellation keeps focus", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await openPanel(page, "Planning");
  const topic = page.getByLabel("Topic", { exact: true });
  const language = page.getByLabel("Manuscript language", { exact: true });
  await expect(language.locator("option")).toHaveCount(2);
  await language.selectOption("zh-CN");
  const node = await topic.elementHandle();
  const top = (await topic.boundingBox())!.y;
  await topic.fill("x".repeat(501));
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "error",
  );
  expect(Math.abs((await topic.boundingBox())!.y - top)).toBeLessThan(4);
  await expect(topic).toBeFocused();
  await page.screenshot({
    path: ".artifacts/editor-workspace-validation-error-1280.png",
  });
  await topic.fill("Corrected topic");
  await saved(page);
  expect((await core.request("/planning")).content.brief.topic).toBe(
    "Corrected topic",
  );
  await topic.fill("x".repeat(501));
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "error",
  );
  await page
    .locator(".planning-recovery-actions")
    .getByRole("button", { name: "Details", exact: true })
    .click();
  await topic.focus();
  page.once("dialog", (dialog) => void dialog.dismiss());
  // Invoke without moving focus so cancelled destructive intent preserves the active input.
  await page
    .getByRole("button", { name: "Discard unsaved changes", exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(topic).toHaveValue("x".repeat(501));
  await expect(topic).toBeFocused();
  page.once("dialog", (dialog) => void dialog.accept());
  await page
    .getByRole("button", { name: "Discard unsaved changes", exact: true })
    .click();
  await expect(topic).toHaveValue("Corrected topic");
  expect(
    await topic.evaluate((current, original) => current === original, node),
  ).toBe(true);
});
test("older receipts during IME and formatting cannot steal Planning focus", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await openPanel(page, "Planning");
  let release = () => {},
    entered = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let hold = true;
  core.intercept(async (_path, body, phase) => {
    if (hold && body?.type === "ApplyDocumentEdit" && phase === "after") {
      hold = false;
      entered();
      await held;
    }
  });
  const editor = input(page),
    node = await editor.elementHandle();
  await editor.fill("Older manuscript save");
  await seen;
  await editor.dispatchEvent("compositionstart", { data: "中" });
  await page.keyboard.insertText("中");
  release();
  await page.waitForTimeout(350);
  await expect(editor).toBeFocused();
  await editor.dispatchEvent("compositionend", { data: "中" });
  await saved(page);
  await editor.press("End");
  await page.keyboard.type(" delayed formatting");
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  const topic = page.getByLabel("Topic", { exact: true });
  await topic.focus();
  await topic.dispatchEvent("compositionstart", { data: "规" });
  await topic.fill("规划 planning input");
  await page.waitForTimeout(400);
  await expect(topic).toBeFocused();
  await expect(topic).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Add section", exact: true }),
  ).toBeEnabled();
  await topic.dispatchEvent("compositionend", { data: "规划" });
  await saved(page);
  expect(
    await editor.evaluate((current, original) => current === original, node),
  ).toBe(true);
});

test("body-owned Retry resolves its original failure before a pending plan without losing either buffer", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await openPanel(page, "Planning");
  let blocked = true;
  await page.route("**/api/v1/manuscript/commands", async (route) => {
    if (blocked && route.request().postDataJSON().type === "ApplyDocumentEdit")
      await route.abort("failed");
    else await route.fallback();
  });
  await input(page).fill("Body retained across the uncertain request");
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "error",
  );
  await page
    .getByLabel("Topic", { exact: true })
    .fill("Plan retained while the body is offline");
  await page.waitForTimeout(450);
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-owner",
    "manuscript",
  );
  blocked = false;
  await page
    .locator(".save-feedback")
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await saved(page);
  expect((await core.request("/manuscript")).blocks[0].runs[0].text).toBe(
    "Body retained across the uncertain request",
  );
  expect((await core.request("/planning")).content.brief.topic).toBe(
    "Plan retained while the body is offline",
  );
});

test("a committed plan read failure and later body failure with the same code keep Retry on the body owner", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await openPanel(page, "Planning");
  let failedReads = true,
    blockedBody = true;
  const plans: string[] = [];
  await page.route("**/api/v1/planning", async (route) => {
    if (failedReads)
      await route.fulfill({
        status: 500,
        json: { code: "STORAGE_UNAVAILABLE" },
      });
    else await route.fallback();
  });
  await page.route("**/api/v1/manuscript/commands", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type === "SavePlanning") plans.push(command.requestId);
    if (blockedBody && command.type === "ApplyDocumentEdit")
      await route.fulfill({
        status: 500,
        json: { code: "STORAGE_UNAVAILABLE" },
      });
    else await route.fallback();
  });
  await page
    .getByLabel("Topic", { exact: true })
    .fill("Proven plan awaiting its canonical read");
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-owner",
    "planning",
  );
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "error",
  );
  await input(page).fill("Body awaiting its original receipt");
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-owner",
    "manuscript",
  );
  blockedBody = false;
  failedReads = false;
  await page
    .locator(".save-feedback")
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await saved(page);
  expect(plans).toHaveLength(1);
  expect((await core.request("/planning")).content.brief.topic).toBe(
    "Proven plan awaiting its canonical read",
  );
  expect((await core.request("/manuscript")).blocks[0].runs[0].text).toBe(
    "Body awaiting its original receipt",
  );
});

test("formatting requested during synthetic body composition is deferred and keeps later Planning focus", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await openPanel(page, "Planning");
  const editor = input(page);
  await editor.fill("Formatting intent through IME");
  await saved(page);
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+a");
  await editor.dispatchEvent("compositionstart", { data: "中" });
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await page.getByRole("button", { name: "Bullet list", exact: true }).click();
  expect((await core.request("/manuscript")).blocks[0].kind).toBe("paragraph");
  const topic = page.getByLabel("Topic", { exact: true });
  await topic.focus();
  await topic.fill("Later input keeps focus");
  await editor.dispatchEvent("compositionend", { data: "中" });
  await saved(page);
  await expect(topic).toBeFocused();
  const canonical = await core.request("/manuscript");
  expect(canonical.blocks[0].kind).toBe("list_item");
  expect(
    canonical.blocks[0].runs.some((run: any) =>
      run.marks.some((mark: any) => mark.type === "bold"),
    ),
  ).toBe(true);

  await topic.dispatchEvent("compositionstart", { data: "规" });
  await page.getByRole("button", { name: "Italic", exact: true }).click();
  await expect(topic).toBeFocused();
  expect(
    (await core.request("/manuscript")).blocks[0].runs.some((run: any) =>
      run.marks.some((mark: any) => mark.type === "italic"),
    ),
  ).toBe(false);
  await topic.dispatchEvent("compositionend", { data: "规" });
  await expect
    .poll(async () =>
      (await core.request("/manuscript")).blocks[0].runs.some((run: any) =>
        run.marks.some((mark: any) => mark.type === "italic"),
      ),
    )
    .toBe(true);
  await expect(topic).toBeFocused();
});

test("pane keyboard navigation, resizing, close focus and saved preferences remain accessible", async ({
  page,
}) => {
  await openWorkbench(page);
  const structure = page.getByRole("tab", { name: "Structure", exact: true });
  await structure.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Planning", exact: true }),
  ).toBeFocused();
  const separator = page.getByRole("separator", {
    name: "Resize auxiliary panel",
  });
  const prior = Number(await separator.getAttribute("aria-valuenow"));
  await separator.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(separator).toHaveAttribute("aria-valuenow", String(prior + 16));
  await page.getByLabel("Topic", { exact: true }).focus();
  await page.getByRole("tab", { name: "Sources", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "Sources", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Open auxiliary panel" }),
  ).toBeFocused();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Open auxiliary panel" }),
  ).toBeVisible();
  await openPanel(page, "Planning");
  await expect(separator).toHaveAttribute("aria-valuenow", String(prior + 16));
  await page.setViewportSize({ width: 375, height: 900 });
  await expect(page.locator(".manuscript-main")).toHaveAttribute("inert", "");
  await page.getByLabel("Topic", { exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Open auxiliary panel" }),
  ).toBeFocused();
  await expect(page.locator(".manuscript-main")).not.toHaveAttribute("inert");
});

test("Draft, Review, Sources and Settings remain usable across screenshot sizes", async ({
  page,
}) => {
  await openWorkbench(page);
  await input(page).fill(
    "A manuscript for review.\nA second paragraph with room to think.",
  );
  await saved(page);
  await input(page).focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page
    .locator(".review-floating-selection")
    .getByRole("button", { name: "Question", exact: true })
    .click();
  await page
    .getByLabel("Your question or instruction")
    .fill("Does this introduction explain the idea clearly?");
  await page.getByRole("button", { name: "Save comment", exact: true }).click();
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const close = page.getByRole("button", { name: "Close auxiliary panel" });
    if (await close.isVisible()) await close.click();
    await page.locator("[data-lock-block]").first().click();
    await page.screenshot({
      path: `.artifacts/editor-workspace-draft-locks-${width}.png`,
    });
    await openPanel(page, "Review");
    await page.screenshot({
      path: `.artifacts/editor-workspace-review-${width}.png`,
    });
    await openPanel(page, "Sources");
    await page.screenshot({
      path: `.artifacts/editor-workspace-sources-${width}.png`,
    });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.screenshot({
      path: `.artifacts/editor-workspace-settings-${width}.png`,
    });
    await page.keyboard.press("Escape");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
  }
});
