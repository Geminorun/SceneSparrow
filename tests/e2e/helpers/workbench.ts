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
  const start = page.getByRole("button", {
    name: "Start writing",
    exact: true,
  });
  const editor = page.getByRole("textbox", { name: "Manuscript", exact: true });
  await expect(start.or(editor)).toBeVisible();
  if (await start.isVisible()) await start.click();
  await expect(editor).toBeVisible();
}

export async function openAiSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "AI & models", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "AI & models", exact: true }),
  ).toBeVisible();
}
