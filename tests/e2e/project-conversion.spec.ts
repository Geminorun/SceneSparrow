import { test, expect } from "./helpers/core";
import { openWorkbench } from "./helpers/workbench";
test("explicit legacy conversion prepares a verified new project and keeps the current legacy source active", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  const original = await core.request("/project");
  const editor = page.getByRole("textbox", { name: "Manuscript", exact: true });
  await editor.fill("Legacy conversion text");
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  const handle = await editor.elementHandle();
  await page.locator(".project-menu > summary").click();
  await page
    .getByRole("button", { name: "Convert legacy project", exact: true })
    .click();
  const modal = page.getByRole("dialog", {
    name: "Convert legacy project",
    exact: true,
  });
  await expect(modal).toContainText("normalized to Markdown");
  const targets: any[] = [],
    starts: any[] = [];
  let loseTargetAck = true;
  core.intercept(async (path, body, phase) => {
    if (path.endsWith("/project/migration-targets") && body) {
      if (phase === "before") targets.push(body);
      if (phase === "after" && loseTargetAck) {
        loseTargetAck = false;
        return "abort";
      }
    }
    if (path.endsWith("/project/migrations") && body && phase === "before")
      starts.push(body);
  });
  await modal
    .getByRole("button", { name: "Prepare converted project", exact: true })
    .click();
  await expect(
    modal.getByRole("button", {
      name: "Reconcile original request",
      exact: true,
    }),
  ).toBeEnabled();
  await modal
    .getByRole("button", { name: "Reconcile original request", exact: true })
    .click();
  await expect(modal).toContainText("New project prepared");
  const first = starts[0].requestId;
  const firstReady = await core.request(`/project/migrations/${first}`);
  expect(targets).toHaveLength(2);
  expect(targets[0]).toEqual(targets[1]);
  await modal
    .getByRole("button", { name: "Start another transfer", exact: true })
    .click();
  await modal
    .getByRole("button", { name: "Prepare converted project", exact: true })
    .click();
  await expect(modal).toContainText("New project prepared");
  expect(starts).toHaveLength(2);
  expect(starts[0].requestId).not.toBe(starts[1].requestId);
  expect(starts[0].targetId).not.toBe(starts[1].targetId);
  expect(targets[2].requestId).not.toBe(targets[0].requestId);
  expect(await core.request(`/project/migrations/${first}`)).toEqual(
    firstReady,
  );
  expect((await core.request("/project")).project.id).toBe(original.project.id);
  await page.screenshot({
    path: ".artifacts/op5c/legacy-conversion.png",
    fullPage: true,
  });
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator(".project-menu > summary")).toBeFocused();
  await expect(editor).toContainText("Legacy conversion text");
  expect(await handle?.evaluate((node) => node.isConnected)).toBe(true);
});
