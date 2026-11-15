import { test, expect } from "@playwright/test";

test("creates a persistent project and switches the shared UI language", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page
      .getByLabel("Project name")
      .or(page.getByRole("heading", { name: "幕雀 project", exact: true })),
  ).toBeVisible();
  if (await page.getByLabel("Project name").isVisible()) {
    await page.getByLabel("Project name").fill("幕雀 project");
    await page.getByRole("button", { name: "Create project" }).click();
  }
  await expect(
    page.getByRole("heading", { name: "幕雀 project" }),
  ).toBeVisible();
  await expect(page.getByText("Saved on this device")).toBeVisible();
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh-CN");
  await expect(page.getByText("已保存到本机")).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "幕雀 project" }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByText("待评审", { exact: true })).toBeVisible();
  await page.screenshot({ path: ".artifacts/workspace.png", fullPage: true });
  expect(errors).toEqual([]);
});
