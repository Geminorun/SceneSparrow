import { test, expect } from "./helpers/core";
import {
  openWorkbench,
  openPanel,
  openDocumentMenu,
  pasteMarkdown,
  projectHistory,
  openExports,
} from "./helpers/workbench";
const input = (page: import("@playwright/test").Page) =>
  page.getByRole("textbox", { name: "Manuscript", exact: true });
const saved = (page: import("@playwright/test").Page) =>
  expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
const viewSource = async (page: import("@playwright/test").Page) => {
  await openDocumentMenu(page);
  await page
    .getByRole("button", { name: "View Markdown source", exact: true })
    .click();
  return page.getByRole("textbox", {
    name: "Markdown source (normalized)",
    exact: true,
  });
};
test("Markdown typing previews headings, lists, marks and safe links without permanent command rows", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await expect(page.locator(".editor-toolbar,.history-toolbar")).toHaveCount(0);
  const editor = input(page);
  await editor.pressSequentially("# Heading");
  await editor.press("Enter");
  await editor.pressSequentially(
    "**bold** *italic* `code` [link](https://example.com)",
  );
  await editor.press("Enter");
  await editor.pressSequentially("- Parent");
  await editor.press("Enter");
  await editor.press("Tab");
  await editor.pressSequentially("Nested child");
  await saved(page);
  const state = await core.request("/manuscript");
  expect(state.blocks[0].kind).toBe("heading");
  expect(state.blocks[0].attrs.level).toBe(1);
  expect(
    state.blocks[1].runs.flatMap((run: any) =>
      run.marks.map((mark: any) => mark.type),
    ),
  ).toEqual(expect.arrayContaining(["bold", "italic", "code", "link"]));
  expect(state.blocks.at(-1).attrs.depth).toBe(1);
  await expect(editor.locator('a[href="https://example.com"]')).toHaveText(
    "link",
  );
  const source = await viewSource(page);
  await expect(source).toHaveValue(
    /# Heading[\s\S]*\*\*bold\*\*[\s\S]*\[link\]\(https:\/\/example.com\)/,
  );
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(editor.locator("h1")).toHaveText("Heading");
  await expect(editor.locator("li li")).toHaveText("Nested child");
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  await editor.press("Enter");
  await editor.press("Enter");
  await editor.pressSequentially("![alt](https://example.com)");
  await editor.press("Enter");
  await editor.pressSequentially("\\[literal](https://example.com)");
  await saved(page);
  await expect(editor).toContainText("![alt](https://example.com)");
  await expect(editor).toContainText("\\[literal](https://example.com)");
  await expect(
    editor.locator("a").filter({ hasText: /^(alt|literal)$/ }),
  ).toHaveCount(0);
});

test("external mixed-MIME Markdown paste preserves selected-range identity, unsupported text, lock guards and project history", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  const editor = input(page);
  await editor.fill("Keep this paragraph");
  await saved(page);
  const original = (await core.request("/manuscript")).blocks[0];
  await editor.press("End");
  await editor.press("Enter");
  await pasteMarkdown(
    page,
    "## 中文标题\n\n**粗体** 与 `代码`\n\n- 项目\n  - 子项",
    "<pre>## 中文标题\n\n**粗体** 与 `代码`</pre>",
  );
  await saved(page);
  const inserted = await core.request("/manuscript");
  expect(inserted.blocks[0]).toEqual(original);
  expect(inserted.blocks[1].kind).toBe("heading");
  expect(new Set(inserted.blocks.map((block: any) => block.id)).size).toBe(
    inserted.blocks.length,
  );
  await projectHistory(page, "Undo");
  await expect(editor.locator("h2")).toHaveCount(0);
  await projectHistory(page, "Redo");
  await expect(editor.locator("h2")).toHaveText("中文标题");
  // A partial selection changes only the existing paragraph and keeps its ID.
  await editor
    .locator("p")
    .first()
    .evaluate((el) => {
      const range = document.createRange();
      range.setStart(el.firstChild!, 5);
      range.setEnd(el.firstChild!, 9);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      (el.closest(".tiptap") as HTMLElement).focus();
      document.dispatchEvent(new Event("selectionchange"));
    });
  await pasteMarkdown(page, "**only**");
  await saved(page);
  const replaced = await core.request("/manuscript");
  expect(replaced.blocks[0].id).toBe(original.id);
  expect(replaced.blocks[0].runs.map((run: any) => run.text).join("")).toBe(
    "Keep only paragraph",
  );
  await page.locator(`[data-lock-block="${original.id}"]`).click();
  await expect(
    page.locator(`[data-lock-block="${original.id}"]`),
  ).toHaveAttribute("aria-label", "Unlock block");
  await editor.locator(`[data-blockid="${original.id}"]`).click();
  const protectedBefore = await core.request("/manuscript");
  await pasteMarkdown(page, "**blocked**");
  await page.waitForTimeout(450);
  expect((await core.request("/manuscript")).blocks[0]).toEqual(
    protectedBefore.blocks[0],
  );
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  await editor.press("Enter");
  await editor.press("Enter");
  let fetched = 0;
  page.on("request", (request) => {
    if (request.url().includes("invalid.example")) fetched++;
  });
  const raw =
    "![image](https://invalid.example/pixel) **untouched** <script>alert(1)</script>";
  await pasteMarkdown(page, raw);
  await saved(page);
  await expect(editor).toContainText(raw);
  await expect(editor.locator("img,script")).toHaveCount(0);
  expect(fetched).toBe(0);
  expect(
    (await core.request("/manuscript")).blocks
      .at(-1)
      .runs.every((run: any) => run.marks.length === 0),
  ).toBe(true);
});

test("read-only source uses pending local/IME text, preserves the editor and creates no revision or history entry", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  const editor = input(page),
    node = await editor.elementHandle();
  await editor.fill("Saved base");
  await saved(page);
  await page.waitForTimeout(850);
  const before = await core.request("/manuscript"),
    history = await core.request("/history");
  let writes = 0;
  core.intercept(async (_path, body, phase) => {
    if (body?.type === "ApplyDocumentEdit" && phase === "before") writes++;
  });
  const source = await viewSource(page);
  await expect(source).toHaveValue("Saved base\n");
  await expect(source).toHaveAttribute("readonly", "");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  expect((await core.request("/manuscript")).workingRevision).toBe(
    before.workingRevision,
  );
  expect(await core.request("/history")).toEqual(history);
  expect(writes).toBe(0);
  await editor.focus();
  await editor.press("End");
  await editor.dispatchEvent("compositionstart", { data: "中" });
  await page.keyboard.insertText(" 未保存的本地输入");
  await viewSource(page);
  await expect(source).toHaveValue(/Saved base 未保存的本地输入/);
  await page.waitForTimeout(400);
  expect(writes).toBe(0);
  await page.keyboard.press("Escape");
  await editor.dispatchEvent("compositionend", { data: "中" });
  await saved(page);
  expect(
    await editor.evaluate((current, original) => current === original, node),
  ).toBe(true);
  await editor.focus();
  await editor.press("End");
  let release = () => {},
    entered = () => {};
  const held = new Promise<void>((resolve) => (release = resolve)),
    seen = new Promise<void>((resolve) => (entered = resolve));
  core.intercept(async (_path, body, phase) => {
    if (body?.type === "ApplyDocumentEdit" && phase === "before") {
      entered();
      await held;
    }
  });
  await page.keyboard.insertText(" Pending receipt");
  await seen;
  await viewSource(page);
  await expect(source).toHaveValue(/Pending receipt/);
  await page.keyboard.press("Escape");
  release();
  await saved(page);
  expect(
    await editor.evaluate((current, original) => current === original, node),
  ).toBe(true);
});

test("Chinese manuscript keeps the continuous document, auxiliary panels and source/export menus usable across widths", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openWorkbench(page);
  const editor = input(page);
  await editor.focus();
  await pasteMarkdown(
    page,
    "# 城市醒来之前\n\n清晨六点，街角的面包店亮起了灯。第一班电车驶过河岸，**城市的节奏**从这些细小的声音里慢慢展开。\n\n## 从一条街道开始\n\n镜头沿着石板路向前：有人推开窗，有人摆好早餐的桌椅。我们用平静的旁白，讲述日常生活中容易被忽略的连接。\n\n- 用环境声建立清晨的空间感\n- 保留人物动作，让画面自然衔接\n- 在河岸的远景中结束这一段\n\n## 让故事回到生活\n\n当阳光照进街道，城市已经开始了新的一天。每一个普通的早晨，都值得被认真看见。",
  );
  await saved(page);
  await expect(editor.locator("h1")).toHaveText("城市醒来之前");
  await openPanel(page, "Planning");
  await page
    .getByLabel("Topic", { exact: true })
    .fill("一座城市如何开始新的一天");
  await page
    .getByLabel("Manuscript language", { exact: true })
    .selectOption("zh-CN");
  await saved(page);
  for (const width of [1440, 1280, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "Close auxiliary panel" }).click();
    await page.screenshot({ path: `.artifacts/notion-document-${width}.png` });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await viewSource(page);
    await expect(
      page.getByRole("dialog", { name: "Markdown source (normalized)" }),
    ).toBeVisible();
    await page.screenshot({ path: `.artifacts/notion-source-${width}.png` });
    await page.keyboard.press("Escape");
    await openExports(page);
    await expect(page.locator(".export-panel")).toBeVisible();
    const box = await page.locator(".export-panel").boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await page.locator(".document-menu > summary").click();
    await openPanel(page, "Planning");
    await page.screenshot({ path: `.artifacts/notion-planning-${width}.png` });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Close auxiliary panel" }).click();
  await editor
    .locator("p")
    .first()
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      (el.closest(".tiptap") as HTMLElement).focus();
      document.dispatchEvent(new Event("selectionchange"));
    });
  await page
    .locator(".review-floating-selection")
    .getByRole("button", { name: "Question", exact: true })
    .click();
  await page
    .getByLabel("Your question or instruction")
    .fill("这一段能否用更具体的声音细节，让清晨的氛围更鲜明？");
  await page.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(page.locator(".review-card").first()).toBeVisible();
  await page.screenshot({ path: ".artifacts/notion-review-1280.png" });
  await page.setViewportSize({ width: 375, height: 900 });
  await page.screenshot({ path: ".artifacts/notion-review-375.png" });
});
