import { test, expect } from "./helpers/core";
import { openWorkbench, openPanel, pasteMarkdown } from "./helpers/workbench";

const saved = async (page: any) =>
  expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );

test("invalid saved pane preferences recover without blocking the manuscript", async ({
  page,
  core,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("scenesparrow.workspace-panes", "null");
    localStorage.setItem("scenesparrow.auxiliary", "[]");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkbench(page);
  await expect(page.locator(".tiptap")).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Contents", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Create", exact: true }),
  ).toBeVisible();
  expect((await core.request("/manuscript")).blocks).toEqual([]);
});

test("independent panes persist widths, keep editor identity and replace fake project chrome", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkbench(page);
  const editor = page.locator(".tiptap"),
    node = await editor.elementHandle();
  await expect(page.locator(".project-heading")).toHaveCount(0);
  await expect(page.getByText("Project files", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("manuscript-title")).toHaveText("Manuscript");
  await editor.focus();
  await pasteMarkdown(page, "# 鸟鸣的方向\n\n连续的文字与空间。");
  await saved(page);
  await expect(page.getByTestId("manuscript-title")).toHaveText("鸟鸣的方向");
  expect(
    await editor.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  ).toBe("rgb(246, 245, 242)");
  await openPanel(page, "Library");
  await openPanel(page, "Create");
  await page
    .getByRole("button", { name: "Close navigator", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Create", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close assistant", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open navigator", exact: true })
    .click();
  await page.getByRole("tab", { name: "Library", exact: true }).focus();
  await page.keyboard.press("Home");
  await expect(
    page.getByRole("tab", { name: "Contents", exact: true }),
  ).toBeFocused();
  const separator = page.getByRole("separator", { name: "Resize navigator" });
  await separator.focus();
  await page.keyboard.press("End");
  await expect(separator).toHaveAttribute("aria-valuenow", "360");
  expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
  await page.reload();
  await expect(separator).toHaveAttribute("aria-valuenow", "360");
  await expect(
    page.getByRole("button", { name: "Open assistant", exact: true }),
  ).toBeVisible();
  await page.locator(".project-menu > summary").click();
  await expect(
    page.getByRole("button", { name: "Project settings", exact: true }),
  ).toBeVisible();
});

test("narrow drawers are exclusive, trap focus and restore their opener without remounting editor", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 820 });
  await openWorkbench(page);
  const node = await page.locator(".tiptap").elementHandle();
  await openPanel(page, "Library");
  await expect(page.locator(".manuscript-main")).toHaveAttribute("inert", "");
  await expect(
    page.getByRole("tab", { name: "Create", exact: true }),
  ).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Open navigator", exact: true }),
  ).toBeFocused();
  await openPanel(page, "Create");
  await expect(
    page.getByRole("tab", { name: "Library", exact: true }),
  ).toBeHidden();
  await page.getByRole("tab", { name: "Create", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  expect(
    await page.evaluate(() => !!document.activeElement?.closest(".right-pane")),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Open assistant", exact: true }),
  ).toBeFocused();
  await expect(page.locator(".manuscript-main")).not.toHaveAttribute("inert");
  expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    375,
  );
});

test("nested folder references persist, require explicit valid UTF-8 consent, deduplicate and clear consent on refresh", async ({
  page,
  core,
}) => {
  const chooseFolder = async (text: string) => {
    await page
      .getByLabel("Add reference folder", { exact: true })
      .evaluate((node: HTMLInputElement, content) => {
        const file = new File([content], "鸟.md", { type: "text/markdown" });
        Object.defineProperty(file, "webkitRelativePath", {
          value: "研究资料/研究/鸟.md",
        });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        node.files = transfer.files;
        node.dispatchEvent(new Event("change", { bubbles: true }));
      }, text);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkbench(page);
  await openPanel(page, "Library");
  await expect(
    page.getByLabel("Add reference folder", { exact: true }),
  ).toHaveAttribute("webkitdirectory", "");
  await chooseFolder("中文参考 🐦\n第二行");
  const item = page.getByTestId("source-item").filter({ hasText: "鸟.md" });
  await expect(item).toContainText("Text ready");
  await expect(
    item.getByRole("checkbox", { name: "Use for creation", exact: true }),
  ).not.toBeChecked();
  await item
    .getByRole("checkbox", { name: "Use for creation", exact: true })
    .click();
  await expect(
    item.getByRole("checkbox", { name: "Use for creation", exact: true }),
  ).toBeChecked();
  await saved(page);
  let planning = await core.request("/planning");
  expect(planning.content.evidence[0].start).toBe(0);
  expect(planning.content.evidence[0].end).toBe(
    Buffer.byteLength("中文参考 🐦\n第二行"),
  );
  const sources = await core.request("/sources"),
    source = sources.items.find(
      (entry: any) => entry.source.title === "鸟.md",
    ).source;
  expect(source.relativePath).toContain("研究/鸟.md");
  await openPanel(page, "Create");
  await expect(page.locator(".planning-reference-summary")).toContainText(
    "Selected references: 1",
  );
  await expect(
    page.locator(".planning-reference-summary input[type=checkbox]"),
  ).toHaveCount(0);
  await page.reload();
  await openPanel(page, "Library");
  await expect(
    item.getByRole("checkbox", { name: "Use for creation", exact: true }),
  ).toBeChecked();
  await chooseFolder("中文参考 🐦\n第二行");
  await expect(page.locator(".library-upload-status")).toContainText("Skipped");
  expect(
    (await core.request("/sources")).items.filter(
      (entry: any) => entry.source.id === source.id,
    ),
  ).toHaveLength(1);
  page.once("dialog", (dialog) => dialog.accept());
  await chooseFolder("更新后的资料 🐦");
  await expect(item).toContainText("Text ready");
  await expect(
    item.getByRole("checkbox", { name: "Use for creation", exact: true }),
  ).not.toBeChecked();
  const after = await core.request("/sources");
  expect(
    after.items.find((entry: any) => entry.source.id === source.id).source
      .revision,
  ).toBeGreaterThan(source.revision);
  planning = await core.request("/planning");
  expect(planning.content.evidence).toEqual([]);
});

test("pending reference text cannot overwrite newer topic input and existing body remains protected", async ({
  page,
  core,
}) => {
  await page.route("**/api/v1/project/events", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: "retry: 60000\nevent: resync_required\ndata: {}\n\n",
    }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkbench(page);
  await openPanel(page, "Library");
  await page.getByLabel("Add file reference", { exact: true }).setInputFiles({
    name: "pending.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("异步资料 🐦"),
  });
  const item = page
    .getByTestId("source-item")
    .filter({ hasText: "pending.txt" });
  await expect(item).toContainText("Text ready");
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let held = false;
  core.intercept(async (path, _body, phase) => {
    if (!held && phase === "before" && path.includes("/source-extractions/")) {
      held = true;
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
  });
  await item
    .getByRole("checkbox", { name: "Use for creation", exact: true })
    .click();
  await waiting;
  const topic = page.getByLabel("Topic", { exact: true });
  await openPanel(page, "Create");
  if (await topic.isHidden())
    await page.locator(".creation-assistance > summary").click();
  const node = await topic.elementHandle();
  await topic.fill("新主题保持输入");
  release();
  await expect
    .poll(async () => (await core.request("/planning")).content.evidence.length)
    .toBe(1);
  await saved(page);
  await expect(topic).toHaveValue("新主题保持输入");
  expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
  const editor = page.locator(".tiptap");
  await editor.fill("Existing manuscript must remain.");
  await saved(page);
  await expect(
    page.getByRole("button", {
      name: "Confirm outline and generate draft",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Review manuscript", exact: true }),
  ).toBeVisible();
});

test("cancelling one queued reference keeps the rest of a multi-file batch", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await openPanel(page, "Library");
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let held = false;
  core.intercept(async (path, _body, phase) => {
    if (!held && phase === "before" && path.endsWith("/intakes")) {
      held = true;
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
  });
  await page.getByLabel("Add file reference", { exact: true }).setInputFiles([
    {
      name: "kept.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Keep this reference"),
    },
    {
      name: "cancelled.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Do not upload this reference"),
    },
  ]);
  await waiting;
  await page
    .getByRole("button", { name: "Cancel cancelled.txt", exact: true })
    .click();
  release();
  await expect(
    page.getByTestId("source-item").filter({ hasText: "kept.txt" }),
  ).toContainText("Text ready");
  await expect(page.locator(".library-upload-status")).toContainText(
    "Cancelled",
  );
  expect(
    (await core.request("/sources")).items.map(
      (item: any) => item.source.title,
    ),
  ).toEqual(["kept.txt"]);
});
