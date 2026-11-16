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
  await page.locator(".export-menu > summary").click();
}
