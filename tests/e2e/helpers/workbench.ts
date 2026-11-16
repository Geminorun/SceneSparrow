import { expect, type Page } from "@playwright/test";

export async function openWorkbench(page: Page) {
  await page.goto("/");
  await page
    .getByRole("combobox", { name: /^(Language|语言)$/ })
    .selectOption("en");
  await expect(
    page.locator(".project-workbench[data-project-id]"),
  ).toBeVisible();
  await expect(page.getByTestId("save-status")).toBeVisible();
}

export async function startManualDraft(page: Page) {
  const editor = page.getByRole("textbox", { name: "Manuscript", exact: true });
  await expect(editor).toBeVisible();
}

export async function openAiSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "AI & models", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "AI & models", exact: true }),
  ).toBeVisible();
}

export async function openPanel(
  page: Page,
  name: "Structure" | "Planning" | "Review" | "Sources",
) {
  const open = page.getByRole("button", {
    name: "Open auxiliary panel",
    exact: true,
  });
  if (await open.isVisible()) await open.click();
  await page.getByRole("tab", { name, exact: true }).click();
}
export async function openExports(page: Page) {
  await openDocumentMenu(page);
  const menu = page.locator(".export-menu");
  if (!(await menu.evaluate((element: HTMLDetailsElement) => element.open)))
    await menu.locator(":scope > summary").click();
}

export async function openDocumentMenu(page: Page) {
  const main = page.locator(".manuscript-main");
  if ((await main.getAttribute("inert")) !== null) {
    await page
      .getByRole("button", { name: "Close auxiliary panel", exact: true })
      .click();
    await expect(main).not.toHaveAttribute("inert");
  }
  const menu = page.locator(".document-menu");
  if (!(await menu.evaluate((element: HTMLDetailsElement) => element.open)))
    await menu.locator(":scope > summary").click();
}
export async function projectHistory(page: Page, direction: "Undo" | "Redo") {
  await openDocumentMenu(page);
  await page.getByRole("button", { name: direction, exact: true }).click();
}
export async function pasteMarkdown(page: Page, source: string, html = "") {
  await page.locator(".tiptap").evaluate(
    (element, data) => {
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", data.source);
      if (data.html) clipboard.setData("text/html", data.html);
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: clipboard,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { source, html },
  );
}
