import { expect, type Page } from "@playwright/test";

export async function openWorkbench(
  page: Page,
  options: { defaultSavePolicy?: boolean; url?: string } = {},
) {
  // Browser workflow tests select the shortest supported user preference. Dedicated
  // preference tests leave the production ten-second default intact.
  if (!options.defaultSavePolicy)
    await page.addInitScript(() => {
      if (!localStorage.getItem("scenesparrow.application-preferences"))
        localStorage.setItem(
          "scenesparrow.application-preferences",
          JSON.stringify({
            version: 1,
            saveMode: "after_delay",
            saveDelaySeconds: 5,
          }),
        );
    });
  await page.goto(options.url ?? "/");
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
  await page
    .getByRole("button", { name: "Model services", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Model services", exact: true }),
  ).toBeVisible();
}

export async function openPanel(
  page: Page,
  name:
    | "Structure"
    | "Planning"
    | "Review"
    | "Sources"
    | "Contents"
    | "Create"
    | "Library"
    | "AI assistant"
    | "Comments",
) {
  // Viewport changes finish before React handles the media-query change event.
  // Wait for the current layout before deciding whether its opener is visible.
  const narrow = await page.evaluate(
    () => window.matchMedia("(max-width: 1050px)").matches,
  );
  await expect(page.locator(".editor-workspace-grid")).toHaveAttribute(
    "data-layout",
    narrow ? "drawer" : "split",
  );
  const label =
    (
      {
        Structure: "Contents",
        Planning: "AI assistant",
        Create: "AI assistant",
        Review: "Comments",
        Sources: "Library",
      } as Record<string, string>
    )[name] ?? name;
  const left = ["Contents", "Library"].includes(label);
  const closeOther = page.getByRole("button", {
    name: left ? "Close assistant" : "Close navigator",
    exact: true,
  });
  if (
    (await page.locator(".manuscript-main").getAttribute("inert")) !== null &&
    (await closeOther.isVisible())
  )
    await closeOther.click();
  const open = page.getByRole("button", {
    name: left ? "Open navigator" : "Open assistant",
    exact: true,
  });
  if (await open.isVisible()) await open.click();
  await page.getByRole("tab", { name: label, exact: true }).click();
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
      .getByRole("button", { name: /Close (assistant|navigator)/, exact: true })
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
  await page.getByRole("textbox", { name: "Manuscript", exact: true }).evaluate(
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
