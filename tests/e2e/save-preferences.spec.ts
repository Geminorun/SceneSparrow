import { test, expect } from "./helpers/core";
import {
  openWorkbench,
  openPanel,
  openDocumentMenu,
} from "./helpers/workbench";
import type { Page } from "@playwright/test";
const editor = (page: Page) =>
  page.getByRole("textbox", { name: "Manuscript", exact: true });
async function general(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "General", exact: true }).click();
}
async function close(page: Page) {
  await page
    .locator(".settings-dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
}
async function settle(page: Page) {
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
}
test("default ten-second policy resists selection, panel and idle paths; General persists globally without AI reads", async ({
  page,
  core,
  context,
}) => {
  await page.clock.install({ time: new Date("2026-11-17T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-11-17T12:00:01Z"));
  let writes = 0,
    aiReads = 0;
  core.intercept(async (path, body, phase) => {
    if (phase === "before" && body?.type === "ApplyDocumentEdit") writes++;
    if (phase === "before" && path.endsWith("/ai/settings")) aiReads++;
  });
  await openWorkbench(page, { defaultSavePolicy: true });
  const node = await editor(page).elementHandle();
  await editor(page).fill("Pending visible manuscript");
  await editor(page).press("Home");
  await openPanel(page, "Planning");
  await page.getByLabel("Topic", { exact: true }).fill("Pending plan");
  await general(page);
  await expect(
    page.getByRole("combobox", { name: "Autosave", exact: true }),
  ).toHaveValue("after_delay");
  await expect(
    page.getByRole("combobox", { name: "Save delay", exact: true }),
  ).toHaveValue("10");
  await expect(
    page
      .getByRole("combobox", { name: "Save delay", exact: true })
      .locator("option"),
  ).toHaveText(["5 seconds", "10 seconds", "30 seconds"]);
  await page.clock.fastForward(9999);
  expect(writes).toBe(0);
  await page.clock.fastForward(1);
  await settle(page);
  expect(writes).toBe(1);
  expect((await core.request("/planning")).content.brief.topic).toBe(
    "Pending plan",
  );
  expect(aiReads).toBe(0);
  await page
    .getByRole("combobox", { name: "Autosave", exact: true })
    .selectOption("off");
  await expect(
    page.getByRole("combobox", { name: "Save delay", exact: true }),
  ).toHaveCount(0);
  await close(page);
  await editor(page).fill("Kept local through settings");
  await page.clock.fastForward(120000);
  expect(writes).toBe(1);
  await openDocumentMenu(page);
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeEnabled();
  await general(page);
  await page
    .getByRole("combobox", { name: "Autosave", exact: true })
    .selectOption("after_delay");
  await page
    .getByRole("combobox", { name: "Save delay", exact: true })
    .selectOption("30");
  const second = await context.newPage();
  await openWorkbench(second, { defaultSavePolicy: true });
  await general(second);
  await expect(
    second.getByRole("combobox", { name: "Save delay", exact: true }),
  ).toHaveValue("30");
  await second
    .getByRole("combobox", { name: "Autosave", exact: true })
    .selectOption("off");
  await expect(
    page.getByRole("combobox", { name: "Autosave", exact: true }),
  ).toHaveValue("off");
  expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
  await page.screenshot({
    path: ".artifacts/save-preferences-general-desktop.png",
  });
  await page.setViewportSize({ width: 375, height: 820 });
  await page.screenshot({
    path: ".artifacts/save-preferences-general-mobile.png",
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    375,
  );
  await second.close();
  await close(page);
  await editor(page).press("ControlOrMeta+s");
  await settle(page);
});
test("off mode preserves native field undo, defers manual save during IME and flushes both buffers", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await general(page);
  await page
    .getByRole("combobox", { name: "Autosave", exact: true })
    .selectOption("off");
  await close(page);
  await editor(page).fill("Local body");
  await openPanel(page, "Planning");
  const topic = page.getByLabel("Topic", { exact: true });
  await topic.fill("Plan");
  await topic.press("End");
  await topic.pressSequentially(" change");
  await topic.press("ControlOrMeta+z");
  expect((await core.request("/manuscript")).blocks).toHaveLength(0);
  await topic.dispatchEvent("compositionstart", { data: "中" });
  await topic.fill("Plan 中文");
  await topic.press("ControlOrMeta+s");
  expect((await core.request("/manuscript")).blocks).toHaveLength(0);
  await topic.dispatchEvent("compositionend", { data: "中文" });
  await settle(page);
  expect((await core.request("/planning")).content.brief.topic).toBe(
    "Plan 中文",
  );
  expect((await core.request("/manuscript")).blocks[0].runs[0].text).toBe(
    "Local body",
  );
  await topic.fill("Still local");
  await general(page);
  await page
    .getByRole("combobox", { name: "Autosave", exact: true })
    .press("ControlOrMeta+s");
  expect((await core.request("/planning")).content.brief.topic).toBe(
    "Plan 中文",
  );
  await close(page);
  await topic.press("ControlOrMeta+s");
  await settle(page);
});
test("window-change policy ignores field and panel blur, saves on window blur; project settings preserve pending editors", async ({
  page,
  core,
}) => {
  await page.clock.install({ time: new Date("2026-11-17T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-11-17T12:00:01Z"));
  await openWorkbench(page);
  await general(page);
  await page
    .getByRole("combobox", { name: "Autosave", exact: true })
    .selectOption("on_window_change");
  await close(page);
  await editor(page).fill("Unsent body");
  const node = await editor(page).elementHandle();
  await openPanel(page, "Planning");
  const topic = page.getByLabel("Topic", { exact: true });
  await topic.fill("Unsent plan");
  await page.locator(".project-menu > summary").click();
  await page
    .getByRole("button", { name: "Project settings", exact: true })
    .click();
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Project preferences 中文");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await page.clock.fastForward(120000);
  expect((await core.request("/manuscript")).blocks).toHaveLength(0);
  expect((await core.request("/planning")).content.brief.topic).toBe("");
  expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(topic).toHaveValue("Unsent plan");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await settle(page);
  expect((await core.request("/manuscript")).blocks[0].runs[0].text).toBe(
    "Unsent body",
  );
  expect((await core.request("/planning")).content.brief.topic).toBe(
    "Unsent plan",
  );
  await general(page);
  await page
    .getByRole("combobox", { name: "Interface language", exact: true })
    .selectOption("zh-CN");
  await expect(
    page.getByRole("combobox", { name: "自动保存", exact: true }),
  ).toHaveValue("on_window_change");
});

test("many off-mode body and planning operations retain the latest five persistent Undo and Redo transitions", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await general(page);
  await page
    .getByRole("combobox", { name: "Autosave", exact: true })
    .selectOption("off");
  await close(page);
  for (let n = 0; n < 20; n++) {
    await editor(page).fill(`Operation ${n}`);
    await editor(page).blur();
  }
  await editor(page).press("ControlOrMeta+s");
  await settle(page);
  const revision = (await core.request("/manuscript")).workingRevision;
  for (let n = 0; n < 5; n++) {
    await editor(page).press("ControlOrMeta+z");
    await expect(editor(page)).toHaveText(`Operation ${18 - n}`);
  }
  await expect(editor(page)).toHaveText("Operation 14");
  expect((await core.request("/manuscript")).workingRevision).toBeGreaterThan(
    revision,
  );
  for (let n = 0; n < 5; n++) {
    await editor(page).press("ControlOrMeta+Shift+z");
    await expect(editor(page)).toHaveText(`Operation ${15 + n}`);
  }
  await openPanel(page, "Planning");
  const topic = page.getByLabel("Topic", { exact: true });
  for (let n = 0; n < 20; n++) {
    await topic.fill(`Plan ${n}`);
    await page.getByLabel("Manuscript language", { exact: true }).focus();
  }
  await topic.press("ControlOrMeta+s");
  await settle(page);
  for (let n = 0; n < 5; n++) {
    await openDocumentMenu(page);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(topic).toHaveValue(`Plan ${18 - n}`);
  }
  await expect(topic).toHaveValue("Plan 14");
  for (let n = 0; n < 5; n++) {
    await openDocumentMenu(page);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(topic).toHaveValue(`Plan ${15 + n}`);
  }
});
