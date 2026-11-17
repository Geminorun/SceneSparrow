import { test, expect } from "./helpers/core";
import {
  openWorkbench,
  openPanel,
  openDocumentMenu,
  pasteMarkdown,
} from "./helpers/workbench";
import type { Page } from "@playwright/test";
const manuscript = (page: Page) =>
  page.getByRole("textbox", { name: "Manuscript", exact: true });
const outline = (page: Page) =>
  page.getByRole("textbox", { name: "Outline", exact: true });
const saved = (page: Page) =>
  expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
async function view(page: Page, name: "Outline" | "Manuscript") {
  await page
    .locator(".writing-view-switch")
    .getByRole("button", { name, exact: true })
    .click();
  await expect(
    name === "Outline" ? outline(page) : manuscript(page),
  ).toBeVisible();
}
async function policy(page: Page, mode: string) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "General", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Autosave", exact: true })
    .selectOption(mode);
  await page
    .locator(".settings-dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
}
test("live outline keeps incomplete input quiet, blocks stale saves and dispatch, and corrects without losing identity or focus", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await view(page, "Outline");
  await openPanel(page, "AI assistant");
  const editor = outline(page),
    node = await editor.elementHandle();
  await editor.focus();
  await page.keyboard.type("#");
  await expect(
    page.locator('.notification[data-error-code="OUTLINE_INVALID"]'),
  ).toHaveCount(0);
  await page.waitForTimeout(900);
  await page.keyboard.type(" ");
  await expect(editor).toBeFocused();
  await expect(
    page.locator('.notification[data-error-code="OUTLINE_INVALID"]'),
  ).toHaveCount(0);
  await page.keyboard.type("Birds 🐦");
  await saved(page);
  const first = (await core.request("/planning")).content.nodes[0];
  await editor.press("End");
  await editor.press("Enter");
  await page.keyboard.type("unsupported paragraph");
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "error",
  );
  await expect(
    page.locator('.notification[data-error-code="OUTLINE_INVALID"]'),
  ).toBeVisible();
  await expect(editor).toBeFocused();
  await page.locator(".assistant-preferences > summary").click();
  await page
    .getByLabel("Topic", { exact: true })
    .fill("A brief changed while syntax is invalid");
  await page.getByLabel("Topic", { exact: true }).press("ControlOrMeta+s");
  expect((await core.request("/planning")).content.nodes[0].title).toBe(
    "Birds 🐦",
  );
  await expect(
    page.getByRole("button", {
      name: "Write draft from this outline",
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .locator(".save-feedback")
    .getByRole("button", { name: "Recover", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "Recover", exact: true })
      .getByRole("textbox"),
  ).toHaveValue(/unsupported paragraph/u);
  await page
    .getByRole("button", { name: "Keep local edits", exact: true })
    .click();
  await editor.fill("# Corrected birds\n- Observe carefully");
  await saved(page);
  const after = (await core.request("/planning")).content;
  expect(after.nodes[0].id).toBe(first.id);
  expect(after.brief.topic).toBe("A brief changed while syntax is invalid");
  expect(
    await editor.evaluate((current, original) => current === original, node),
  ).toBe(true);
  await expect(editor).toBeFocused();
  await expect(
    page.locator('.notification[data-error-code="OUTLINE_INVALID"]'),
  ).toHaveCount(0);
});
test("central outline reordering and all five project Undo/Redo transitions preserve the mounted editor", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await view(page, "Outline");
  await policy(page, "off");
  const editor = outline(page),
    original = await editor.elementHandle();
  for (let index = 0; index < 20; index++) {
    await editor.fill(`# Plan ${index}`);
    await editor.blur();
  }
  expect((await core.request("/planning")).content.nodes).toHaveLength(0);
  await editor.press("ControlOrMeta+s");
  await saved(page);
  for (let index = 0; index < 5; index++) {
    await editor.press("ControlOrMeta+z");
    await expect(editor).toHaveText(`# Plan ${18 - index}`);
  }
  for (let index = 0; index < 5; index++) {
    await editor.press("ControlOrMeta+Shift+z");
    await expect(editor).toHaveText(`# Plan ${15 + index}`);
  }
  await editor.fill("# First\n- point\n## Child\n# Second");
  await editor.press("ControlOrMeta+s");
  await saved(page);
  const nodes = (await core.request("/planning")).content.nodes;
  await editor.focus();
  await editor.press("ControlOrMeta+Home");
  await editor.press("Alt+ArrowDown");
  await expect(editor.locator("p").first()).toHaveText("# Second");
  await editor.press("ControlOrMeta+s");
  await saved(page);
  expect(
    (await core.request("/planning")).content.nodes.map((node: any) => node.id),
  ).toEqual([nodes[2].id, nodes[0].id, nodes[1].id]);
  // Native caret changes can precede the editor's selectionchange observer.
  await editor.evaluate((element) => {
    const paragraph = element.querySelector("p")!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(editor.locator("p").first()).toHaveText("# First");
  await editor.press("ControlOrMeta+s");
  await saved(page);
  expect(
    (await core.request("/planning")).content.nodes.map((node: any) => node.id),
  ).toEqual(nodes.map((node: any) => node.id));
  await editor.press("ControlOrMeta+a");
  await editor.evaluate((element) => {
    const data = new DataTransfer();
    data.setData("text/plain", "# First\n- point\n## Child\n# Second");
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect
    .poll(() =>
      editor
        .locator("p")
        .evaluateAll((paragraphs) =>
          paragraphs
            .filter((paragraph) =>
              /^#{1,4} /u.test(paragraph.textContent ?? ""),
            )
            .map((paragraph) => paragraph.getAttribute("data-outlineid")),
        ),
    )
    .toEqual(nodes.map((node: any) => node.id));
  await editor.press("ControlOrMeta+End");
  await page.keyboard.type(" revised");
  await editor.press("ControlOrMeta+s");
  await saved(page);
  const renamed = (await core.request("/planning")).content.nodes;
  expect(renamed[2].id).toBe(nodes[2].id);
  expect(renamed[2].title).toBe("Second revised");
  expect(
    await editor.evaluate((current, prior) => current === prior, original),
  ).toBe(true);
  await page.reload();
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("Second");
});
test("late outline receipts during composition retain the visible buffer and defer intermediate saves", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await view(page, "Outline");
  const editor = outline(page),
    original = await editor.elementHandle();
  let release = () => {},
    entered = () => {},
    hold = true;
  const gate = new Promise<void>((resolve) => (release = resolve)),
    seen = new Promise<void>((resolve) => (entered = resolve));
  const writes: any[] = [];
  core.intercept(async (_path, body, phase) => {
    if (body?.type === "SavePlanning" && phase === "after") {
      writes.push(body);
      if (hold) {
        hold = false;
        entered();
        await gate;
      }
    }
  });
  await editor.fill("# Earlier heading");
  await seen;
  await editor.dispatchEvent("compositionstart", { data: "中" });
  await editor.fill("# 输入中的大纲");
  release();
  await page.waitForTimeout(300);
  await expect(editor).toBeFocused();
  expect(writes).toHaveLength(1);
  await editor.dispatchEvent("compositionend", { data: "输入中的大纲" });
  await saved(page);
  expect((await core.request("/planning")).content.nodes[0].title).toBe(
    "输入中的大纲",
  );
  expect(
    await editor.evaluate((current, prior) => current === prior, original),
  ).toBe(true);
});
test("delayed planning startup cannot replace or hide already-started manual writing", async ({
  page,
  core,
}) => {
  let release = () => {},
    entered = () => {},
    hold = true;
  const gate = new Promise<void>((resolve) => (release = resolve)),
    seen = new Promise<void>((resolve) => (entered = resolve));
  core.intercept(async (path, _body, phase) => {
    if (hold && phase === "before" && path.endsWith("/planning")) {
      hold = false;
      entered();
      await gate;
    }
  });
  await openWorkbench(page);
  await seen;
  const editor = manuscript(page),
    original = await editor.elementHandle();
  await editor.fill("Manual writing before planning loads.");
  release();
  await saved(page);
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
  expect(
    await editor.evaluate((current, prior) => current === prior, original),
  ).toBe(true);
  await view(page, "Outline");
  await outline(page).fill("# Retained plan");
  await saved(page);
  await openPanel(page, "AI assistant");
  await expect(
    page.getByRole("button", {
      name: "Write draft from this outline",
      exact: true,
    }),
  ).toHaveCount(0);
  await view(page, "Manuscript");
  await expect(editor).toHaveText("Manual writing before planning loads.");
});
test("unsent review recovery returns from Outline to the owning assistant or Comments composer", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await manuscript(page).fill("Preserved manuscript for review recovery.");
  await saved(page);
  const original = (await core.request("/manuscript")).blocks;
  const notice = page.locator('.notification[data-error-code="UNSENT_REVIEW"]');
  for (const panel of ["AI assistant", "Comments"] as const) {
    await openPanel(page, panel);
    if (panel === "Comments") {
      await manuscript(page).focus();
      await manuscript(page).press("ControlOrMeta+Home");
      await page
        .getByRole("button", { name: "Review whole block", exact: true })
        .click();
    }
    const input = page.locator("#review-instruction");
    await input.fill(`Unsent ${panel} draft`);
    await view(page, "Outline");
    await outline(page).press("ControlOrMeta+z");
    await expect(notice).toBeVisible();
    await notice
      .getByRole("button", { name: "Review changes", exact: true })
      .click();
    await expect(manuscript(page)).toBeVisible();
    await expect(
      page.getByRole("tab", { name: panel, exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(input).toBeVisible();
    await expect(input).toHaveValue(`Unsent ${panel} draft`);
    await input.fill("");
    await expect(notice).toHaveCount(0);
  }
  expect((await core.request("/manuscript")).blocks).toEqual(original);
  await page
    .locator("#review-instruction")
    .fill("Explicitly cancelled comment");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#review-instruction")).toBeHidden();
  await view(page, "Outline");
  await outline(page).press("ControlOrMeta+z");
  await expect(notice).toHaveCount(0);
  await expect
    .poll(async () => (await core.request("/manuscript")).blocks.length)
    .toBe(0);
  await outline(page).press("ControlOrMeta+Shift+z");
  await expect
    .poll(async () =>
      (await core.request("/manuscript")).blocks.map((block: any) => block.id),
    )
    .toEqual(original.map((block: any) => block.id));
  expect((await core.request("/reviews")).cards).toHaveLength(0);
});
test("explicit whole manuscript scope rejects more than100 blocks with one localized top notice and no thread or AI start", async ({
  page,
  core,
}) => {
  let starts = 0;
  core.intercept(async (_path, body, phase) => {
    if (phase === "before" && body?.type === "StartReviewTask") starts++;
  });
  await openWorkbench(page);
  await manuscript(page).focus();
  await pasteMarkdown(
    page,
    Array.from({ length: 101 }, (_, index) => `Paragraph ${index}`).join(
      "\n\n",
    ),
  );
  await saved(page);
  await openPanel(page, "AI assistant");
  await page
    .getByRole("combobox", { name: "Scope", exact: true })
    .selectOption("whole");
  await page
    .getByLabel("Instruction", { exact: true })
    .fill("Explain the whole manuscript.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const notice = page.locator(
    '.notification[data-error-code="REVIEW_SCOPE_TOO_LARGE"]',
  );
  await expect(notice).toBeVisible();
  await expect(page.getByLabel("Instruction", { exact: true })).toHaveValue(
    "Explain the whole manuscript.",
  );
  expect((await core.request("/reviews")).cards).toHaveLength(0);
  expect(starts).toBe(0);
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh-CN");
  await expect(notice).toContainText("100");
});
