import { test, expect } from "../e2e/helpers/source-core";
import { openWorkbench, projectHistory } from "../e2e/helpers/workbench";
const editor = (page: any) => page.locator(".cm-content");
const dialog = (page: any) =>
  page.getByRole("dialog", { name: "Changes", exact: true });
async function work(page: any) {
  await page.locator(".project-menu > summary").click();
  await page
    .getByRole("button", { name: "External Agent work", exact: true })
    .click();
  await expect(page.getByTestId("external-work")).toHaveCount(1);
  await expect(page.getByTestId("external-work")).toBeVisible();
}
async function register(page: any) {
  await work(page);
  await page
    .getByRole("button", { name: "Register creative files", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Create work item", exact: true }),
  ).toBeVisible();
}
async function create(page: any, core: any) {
  const before = new Set(
    (await core.request("/project/work-items")).records.map(
      (item: any) => item.workItemId,
    ),
  );
  await page
    .getByRole("button", { name: "Create work item", exact: true })
    .click();
  await page.getByLabel("Whole creative tree", { exact: true }).check();
  await page
    .getByRole("combobox", { name: "Manuscript permission", exact: true })
    .selectOption("all");
  await page
    .locator(".external-work-setup")
    .getByRole("button", { name: "Create work item", exact: true })
    .click();
  await expect(
    page.locator(".external-work .external-work-items"),
  ).toContainText("Ready");
  await expect(page.locator(".external-work-items:visible")).toHaveCount(1);
  await expect
    .poll(
      async () =>
        (await core.request("/project/work-items")).records.find(
          (item: any) => !before.has(item.workItemId),
        )?.state,
    )
    .toBe("ready");
  return (await core.request("/project/work-items")).records.find(
    (item: any) => !before.has(item.workItemId),
  );
}
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};
test("recorded external copy shows actual prepared diff and accepts one batch with shared source/history", async ({
  page,
  core,
}) => {
  await core.seed("Original source\n");
  await openWorkbench(page);
  const node = await editor(page).elementHandle();
  await register(page);
  const item = await create(page, core);
  await core.workFile(
    item.workItemId,
    "manuscript.md",
    (await core.workSource(item.workItemId)) + "\nExternal added paragraph\n",
  );
  await page
    .getByRole("button", { name: "Inspect changes", exact: true })
    .click();
  await expect(
    page.locator(".external-work-detail .external-work-files"),
  ).toContainText("manuscript.md");
  await expect(page.locator(".external-work-detail")).toContainText(
    "External added paragraph",
  );
  await expect(page.locator(".external-work-detail")).toContainText(
    "Prepared block identities: 1",
  );
  await expect(
    page.getByRole("button", { name: "Accept inspected batch", exact: true }),
  ).toBeEnabled();
  const before = await core.request("/history");
  await page.screenshot({ path: ".artifacts/op4b/browser-work-diff.png" });
  await page
    .getByRole("button", { name: "Accept inspected batch", exact: true })
    .click();
  await expect(
    page.locator(".external-work .external-work-items"),
  ).toContainText("Accepted");
  expect((await core.request("/history")).undoCount).toBe(
    Math.min(5, before.undoCount + 1),
  );
  await dialog(page)
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(editor(page)).toContainText("External added paragraph");
  expect(await node?.evaluate((node) => node.isConnected)).toBe(true);
  await projectHistory(page, "Undo");
  await expect(editor(page)).not.toContainText("External added paragraph");
  await projectHistory(page, "Redo");
  await expect(editor(page)).toContainText("External added paragraph");
  await page.screenshot({ path: ".artifacts/op4b/browser-work-accepted.png" });
});
test("held accepted media ACK with newer IME input keeps original action/editor/caret and does not flush input", async ({
  page,
  core,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "scenesparrow.application-preferences",
      JSON.stringify({ version: 1, saveMode: "off", saveDelaySeconds: 10 }),
    ),
  );
  await core.seed("Accepted prose\n");
  await core.creative("public/a.bin", new Uint8Array([0, 255]));
  await openWorkbench(page);
  await register(page);
  const item = await create(page, core);
  await core.workFile(
    item.workItemId,
    "public/a.bin",
    new Uint8Array([1, 255, 7]),
  );
  await page
    .getByRole("button", { name: "Inspect changes", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Accept inspected batch", exact: true }),
  ).toBeEnabled();
  const held = gate(),
    entered = gate();
  let accepts = 0,
    saves = 0;
  core.intercept(async (path, body, phase) => {
    if (path.endsWith("/accept") && phase === "after") {
      accepts++;
      entered.resolve();
      await held.promise;
    }
    if (path.endsWith("/manuscript/source") && body && phase === "before")
      saves++;
  });
  const node = await editor(page).elementHandle();
  await page
    .getByRole("button", { name: "Accept inspected batch", exact: true })
    .click();
  await entered.promise;
  await dialog(page)
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await editor(page).click();
  await page.keyboard.press("Control+End");
  await editor(page).dispatchEvent("compositionstart", { data: "中" });
  await page.keyboard.insertText(" 中😀");
  held.resolve();
  await expect(editor(page)).toContainText("中😀");
  await editor(page).dispatchEvent("compositionend", { data: "中😀" });
  await expect(editor(page)).toBeFocused();
  expect(await node?.evaluate((node) => node.isConnected)).toBe(true);
  expect(accepts).toBe(1);
  expect(saves).toBe(0);
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "pending",
  );
  expect((await core.request("/manuscript/source")).source).not.toContain(
    "中😀",
  );
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
  expect((await core.request("/manuscript/source")).source).toContain("中😀");
  expect(accepts).toBe(1);
});
test("registered normal rename settles captured pending input and held readback retains later composition", async ({
  page,
  core,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "scenesparrow.application-preferences",
      JSON.stringify({ version: 1, saveMode: "off", saveDelaySeconds: 10 }),
    ),
  );
  await core.seed("Before rename\n");
  await openWorkbench(page);
  await register(page);
  await dialog(page)
    .getByRole("button", { name: "Close", exact: true })
    .click();
  const node = await editor(page).elementHandle();
  await editor(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(" captured");
  await page.locator(".project-menu > summary").click();
  await page
    .getByRole("button", { name: "Project settings", exact: true })
    .click();
  await page.getByLabel("Project name", { exact: true }).fill("新名称");
  const held = gate(),
    entered = gate();
  let renames = 0,
    saves = 0;
  core.intercept(async (path, body, phase) => {
    if (path.endsWith("/project/rename") && phase === "after") {
      renames++;
      entered.resolve();
      await held.promise;
    }
    if (path.endsWith("/manuscript/source") && body && phase === "before")
      saves++;
  });
  await page
    .locator(".rename-dialog")
    .getByRole("button", { name: "Save name", exact: true })
    .click();
  await entered.promise;
  await page
    .locator(".rename-dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await editor(page).click();
  await page.keyboard.press("Control+End");
  await editor(page).dispatchEvent("compositionstart", { data: "后" });
  await page.keyboard.insertText(" 后来");
  held.resolve();
  await expect(page.getByTestId("project-title")).toHaveText("新名称");
  await editor(page).dispatchEvent("compositionend", { data: "后来" });
  await expect(editor(page)).toBeFocused();
  expect(await node?.evaluate((node) => node.isConnected)).toBe(true);
  expect(renames).toBe(1);
  expect(saves).toBe(1);
  await expect(editor(page)).toContainText("后来");
  expect((await core.request("/manuscript/source")).source).toContain(
    "captured",
  );
  expect((await core.request("/manuscript/source")).source).not.toContain(
    "后来",
  );
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
});

test("v3 preserve explicitly captures graph evidence and a held inspection cannot settle a later recovery choice", async ({
  page,
  core,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "scenesparrow.application-preferences",
      JSON.stringify({ version: 1, saveMode: "off", saveDelaySeconds: 10 }),
    ),
  );
  await core.seed("Recovery source\n");
  await core.creative("public/recovery.bin", new Uint8Array([0, 255, 0]));
  await openWorkbench(page);
  await register(page);
  const item = await create(page, core);
  await core.workFile(
    item.workItemId,
    "public/recovery.bin",
    new Uint8Array([1, 255, 1]),
  );
  await page
    .getByRole("button", { name: "Inspect changes", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Accept inspected batch", exact: true }),
  ).toBeEnabled();
  const held = gate(),
    entered = gate();
  let failed = false,
    holdInspection = true,
    recoveries = 0;
  const accepts: string[] = [];
  core.intercept(async (path, body, phase) => {
    if (path.endsWith("/accept") && phase === "before") {
      accepts.push(body.requestId);
      if (!failed) core.receiptFailure(body.requestId);
    }
    if (path.endsWith("/accept") && phase === "after" && !failed) {
      failed = true;
      core.receiptFailure(null);
      await core.creative("public/recovery.bin", new Uint8Array([2, 255, 2]));
    }
    if (
      /\/project\/file-recoveries\/[0-9a-f]{64}$/.test(path) &&
      phase === "after" &&
      holdInspection
    ) {
      holdInspection = false;
      entered.resolve();
      await held.promise;
    }
    if (path.endsWith("/manuscript/source/recover") && phase === "before")
      recoveries++;
  });
  await page
    .getByRole("button", { name: "Accept inspected batch", exact: true })
    .click();
  await expect(page.locator(".external-work .compact-recovery")).toBeVisible();
  await expect
    .poll(
      async () =>
        (await core.request("/manuscript/source/status")).pendingIntent
          ?.version,
    )
    .toBe(3);
  await dialog(page)
    .getByRole("button", { name: "Manuscript", exact: true })
    .click();
  const preserve = dialog(page).getByRole("button", {
    name: "Preserve unexpected files and clear write fence",
    exact: true,
  });
  await expect(preserve).toBeEnabled();
  await preserve.click();
  await entered.promise;
  await dialog(page)
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await editor(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(" Later recovery input");
  held.resolve();
  await expect(editor(page)).toContainText("Later recovery input");
  expect(recoveries).toBe(0);
  await page.getByTestId("source-changes").click();
  await dialog(page)
    .getByRole("button", { name: "Manuscript", exact: true })
    .click();
  await preserve.click();
  await expect(page.locator(".graph-recovery")).toContainText(
    "public/recovery.bin",
  );
  expect(recoveries).toBe(1);
  await page.screenshot({ path: ".artifacts/op4b/browser-v3-recovery.png" });
  await dialog(page)
    .getByRole("button", { name: "External Agent work", exact: true })
    .click();
  await page
    .locator(".external-work .compact-recovery")
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await expect(page.locator(".external-work .compact-recovery")).toHaveCount(0);
  expect(accepts).toEqual([accepts[0], accepts[0]]);
  await dialog(page)
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await editor(page).click();
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
  expect((await core.request("/manuscript/source")).source).toContain(
    "Later recovery input",
  );
});

test("recovery page and selection read failures retain rows, offer owned retry and ignore late failures", async ({
  page,
  core,
}) => {
  await core.seed("Read ownership\n");
  const one = "a".repeat(64),
    two = "b".repeat(64);
  let failMore = true,
    failOperations = true,
    holdTwo = true;
  const entered = gate(),
    release = gate();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/v1/project/file-recoveries**", async (route) => {
    const url = new URL(route.request().url());
    const json = (value: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (url.pathname.endsWith("/file-recoveries")) {
      if (url.search && failOperations) {
        failOperations = false;
        await json({ code: "STORAGE_UNAVAILABLE" }, 503);
        return;
      }
      await json({
        records: [{ intentHash: url.search ? two : one, memberCount: 2 }],
        continuation: url.search ? null : "operations-next",
      });
      return;
    }
    if (url.pathname.includes(two) && holdTwo) {
      entered.resolve();
      await release.promise;
      await json({ code: "SOURCE_RECOVERY_STALE" }, 409);
      return;
    }
    if (url.search && failMore) {
      failMore = false;
      await json({ code: "STORAGE_UNAVAILABLE" }, 503);
      return;
    }
    await json({
      records: [
        {
          memberId: url.search ? "member2" : "member1",
          path: url.search ? "public/two.bin" : "public/one.bin",
          role: "original",
          size: 3,
          hash: "c".repeat(64),
        },
      ],
      continuation: url.search ? null : "members-next",
    });
  });
  await openWorkbench(page);
  await page.getByTestId("source-changes").click();
  const recovery = page.locator(".graph-recovery");
  await recovery.locator("summary").click();
  const operations = recovery.locator(".external-work-items");
  await operations.getByRole("button").click();
  await expect(recovery.locator(".external-work-files")).toContainText(
    "public/one.bin",
  );
  await recovery
    .getByRole("button", { name: "Load more", exact: true })
    .last()
    .click();
  await expect(recovery.locator(".compact-read-recovery")).toBeVisible();
  await operations.getByRole("button").nth(0).click();
  await expect(recovery.locator(".compact-read-recovery")).toBeVisible();
  await expect(page.locator(".notification[data-tone=error]")).toHaveCount(1);
  await expect(recovery.locator(".external-work-files")).toContainText(
    "public/one.bin",
  );
  await recovery
    .locator(".compact-read-recovery")
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await expect(recovery.locator(".external-work-files")).toContainText(
    "public/two.bin",
  );
  await recovery
    .getByRole("button", { name: "Load more", exact: true })
    .click();
  await expect(recovery.locator(".compact-read-recovery")).toBeVisible();
  await expect(operations.getByRole("button")).toHaveCount(1);
  await recovery
    .locator(".compact-read-recovery")
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await expect(operations.getByRole("button")).toHaveCount(2);
  await operations.getByRole("button").nth(1).click();
  await entered.promise;
  await operations.getByRole("button").nth(0).click();
  await expect(recovery.locator(".external-work-files")).toContainText(
    "public/one.bin",
  );
  release.resolve();
  await page.waitForTimeout(200);
  await expect(recovery.locator(".compact-read-recovery")).toHaveCount(0);
  await expect(recovery).not.toContainText("SOURCE_RECOVERY_STALE");
  expect(errors).toEqual([]);
  holdTwo = false;
});

test("selected external work diff read failure has explicit localized retry and late errors cannot replace a newer selection", async ({
  page,
  core,
}) => {
  await core.seed("Diff read ownership\n");
  await openWorkbench(page);
  await register(page);
  const first = await create(page, core);
  await core.workFile(
    first.workItemId,
    "public/clip.bin",
    new Uint8Array([9, 255]),
  );
  let fail = true;
  await page.route(
    "**/api/v1/project/work-items/*/candidates/*/changes*",
    async (route) => {
      if (fail) {
        fail = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ code: "STORAGE_UNAVAILABLE" }),
        });
        return;
      }
      await route.fallback();
    },
  );
  await page
    .getByRole("button", { name: "Inspect changes", exact: true })
    .click();
  const work = page.getByTestId("external-work");
  await expect(work.locator(".compact-read-recovery")).toBeVisible();
  await work.locator(".external-work-items button").nth(0).click();
  await expect(work.locator(".compact-read-recovery")).toBeVisible();
  await expect(page.locator(".notification[data-tone=error]")).toHaveCount(1);
  await work
    .locator(".compact-read-recovery")
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await expect(
    work.locator(".external-work-detail .external-work-files"),
  ).toContainText("public/clip.bin");
  const second = await create(page, core);
  const rows = work.locator(".external-work-items button");
  await rows.nth(1).click();
  const entered = gate(),
    release = gate();
  await page.route(
    "**/api/v1/project/work-items/*/candidates/*/changes*",
    async (route) => {
      if (route.request().url().includes(first.workItemId)) {
        entered.resolve();
        await release.promise;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ code: "WORK_ITEM_STALE" }),
        });
        return;
      }
      await route.fallback();
    },
  );
  await rows.nth(0).click();
  await entered.promise;
  await rows.nth(1).click();
  release.resolve();
  await page.waitForTimeout(200);
  await expect(work.locator(".compact-read-recovery")).toHaveCount(0);
  await expect(rows.nth(1)).toHaveAttribute("aria-pressed", "true");
  const closedEntered = gate(),
    closedRelease = gate();
  await page.route(
    "**/api/v1/project/work-items/*/candidates/*/changes*",
    async (route) => {
      if (route.request().url().includes(first.workItemId)) {
        closedEntered.resolve();
        await closedRelease.promise;
        await route.fulfill({ status: 409, json: { code: "WORK_ITEM_STALE" } });
        return;
      }
      await route.fallback();
    },
  );
  await rows.nth(0).click();
  await closedEntered.promise;
  await dialog(page)
    .getByRole("button", { name: "Close", exact: true })
    .click();
  closedRelease.resolve();
  await page.waitForTimeout(200);
  await expect(page.locator(".notification[data-tone=error]")).toHaveCount(0);
  expect(second.workItemId).not.toBe(first.workItemId);
});

test("registered original rename outcome cannot roll current project title back after a later accepted rename", async ({
  page,
  core,
}) => {
  await core.seed("Metadata ownership\n");
  await openWorkbench(page);
  await register(page);
  await dialog(page)
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.locator(".project-menu > summary").click();
  await page
    .getByRole("button", { name: "Project settings", exact: true })
    .click();
  await page.getByLabel("Project name", { exact: true }).fill("Earlier");
  let advanced = false;
  core.intercept(async (path, _body, phase) => {
    if (path.endsWith("/project/rename") && phase === "after" && !advanced) {
      advanced = true;
      const project = (await core.request("/project")).project;
      await core.request("/project/rename", {
        requestId: crypto.randomUUID(),
        projectId: project.id,
        previousTitle: project.title,
        title: "Later",
      });
    }
  });
  await page
    .locator(".rename-dialog")
    .getByRole("button", { name: "Save name", exact: true })
    .click();
  await expect(page.getByTestId("project-title")).toHaveText("Later");
  expect((await core.request("/project")).project.title).toBe("Later");
});

test("unregistered normal rename and manifest-name choice recover from definite original conflicts", async ({
  page,
  core,
}) => {
  await core.seed("Unregistered metadata ownership\n");
  await openWorkbench(page);
  const original = (await core.request("/project")).project;
  await page.locator(".project-menu > summary").click();
  await page
    .getByRole("button", { name: "Project settings", exact: true })
    .click();
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Proposed display");
  let reject = true;
  const ids: string[] = [];
  await page.route("**/api/v1/project/rename", async (route) => {
    ids.push(route.request().postDataJSON().requestId);
    if (reject) {
      reject = false;
      await route.fulfill({ status: 409, json: { code: "PROJECT_CONFLICT" } });
      return;
    }
    await route.fallback();
  });
  const submit = page
    .locator(".rename-dialog")
    .getByRole("button", { name: "Save name", exact: true });
  await submit.click();
  await expect(
    page.locator(".notification[data-error-code=renameConflict]"),
  ).toBeVisible();
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    "Proposed display",
  );
  await submit.click();
  await expect(page.getByTestId("project-title")).toHaveText(
    "Proposed display",
  );
  expect(ids[0]).not.toBe(ids[1]);
  await work(page);
  await page
    .getByRole("button", { name: "Register creative files", exact: true })
    .click();
  const choose = page.getByRole("button", {
    name: "Use the manifest name for display",
    exact: true,
  });
  await expect(choose).toBeVisible();
  reject = true;
  await choose.click();
  await expect(
    page.getByTestId("external-work").getByRole("alert"),
  ).toBeVisible();
  await expect(page.locator(".external-work .compact-recovery")).toHaveCount(0);
  await choose.click();
  await expect(page.getByTestId("project-title")).toHaveText(original.title);
  expect(ids[2]).not.toBe(ids[3]);
  await page
    .getByRole("button", { name: "Register creative files", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Create work item", exact: true }),
  ).toBeVisible();
});

test("known-applied text ACK preserves newer IME raw input and resolves through guarded reload and a new manual combination", async ({
  page,
  core,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "scenesparrow.application-preferences",
      JSON.stringify({ version: 1, saveMode: "off", saveDelaySeconds: 10 }),
    ),
  );
  await core.seed("\uFEFFOriginal text\r\n");
  const before = await core.request("/manuscript/source");
  await openWorkbench(page);
  await register(page);
  const item = await create(page, core);
  await core.workFile(
    item.workItemId,
    "manuscript.md",
    (await core.workSource(item.workItemId)).replace(
      "Original text",
      "External rewritten text",
    ),
  );
  await page
    .getByRole("button", { name: "Inspect changes", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Accept inspected batch", exact: true }),
  ).toBeEnabled();
  const ack = gate(),
    accepted = gate(),
    readHeld = gate(),
    readEntered = gate();
  let holdReload = false;
  const accepts: string[] = [],
    saves: any[] = [];
  core.intercept(async (path, body, phase) => {
    if (path.endsWith("/accept") && phase === "after") {
      accepts.push(body.requestId);
      accepted.resolve();
      await ack.promise;
    }
    if (path.endsWith("/manuscript/source") && body && phase === "before")
      saves.push(body);
    if (
      path.endsWith("/manuscript/source") &&
      !body &&
      phase === "after" &&
      holdReload
    ) {
      holdReload = false;
      readEntered.resolve();
      await readHeld.promise;
    }
  });
  await page
    .getByRole("button", { name: "Accept inspected batch", exact: true })
    .click();
  await accepted.promise;
  await dialog(page)
    .getByRole("button", { name: "Close", exact: true })
    .click();
  const node = await editor(page).elementHandle();
  await editor(page).click();
  await page.keyboard.press("Control+End");
  await editor(page).dispatchEvent("compositionstart", { data: "中" });
  await page.keyboard.insertText(" Later local 中😀");
  const caret = await page.evaluate(() => ({
    text: window.getSelection()?.anchorNode?.textContent,
    offset: window.getSelection()?.anchorOffset,
  }));
  const localText = await editor(page).innerText();
  ack.resolve();
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "conflict",
  );
  await expect(editor(page)).toBeFocused();
  expect(await node?.evaluate((node) => node.isConnected)).toBe(true);
  expect(await editor(page).innerText()).toBe(localText);
  expect(
    await page.evaluate(() => ({
      text: window.getSelection()?.anchorNode?.textContent,
      offset: window.getSelection()?.anchorOffset,
    })),
  ).toEqual(caret);
  await editor(page).dispatchEvent("compositionend", { data: "中" });
  await page.keyboard.press("Control+s");
  expect(saves).toHaveLength(0);
  expect(accepts).toHaveLength(1);
  await page.getByTestId("source-changes").click();
  await expect(page.getByTestId("source-applied-conflict")).toBeVisible();
  await expect(
    dialog(page).getByRole("button", { name: "Try again", exact: true }),
  ).toHaveCount(0);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", {
      name: "Download exact local source",
      exact: true,
    })
    .click();
  const savedDownload = await download;
  const { readFile } = await import("node:fs/promises");
  expect(await readFile((await savedDownload.path())!, "utf8")).toBe(
    before.source + " Later local 中😀",
  );
  holdReload = true;
  await page
    .getByRole("button", {
      name: "Discard local input and reload saved source",
      exact: true,
    })
    .click();
  await readEntered.promise;
  await dialog(page)
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await editor(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(" More after reload click");
  readHeld.resolve();
  await expect(editor(page)).toContainText("More after reload click");
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "conflict",
  );
  await page.getByTestId("source-changes").click();
  await expect(page.getByTestId("source-applied-conflict")).toBeVisible();
  await page.locator(".source-full-versions > summary").click();
  await page.screenshot({
    path: ".artifacts/op4b/review-two/browser-applied-text-conflict.png",
  });
  await expect(
    dialog(page).getByRole("textbox", { name: "Saved source", exact: true }),
  ).toHaveValue(/External rewritten text/);
  const proposal = dialog(page).getByRole("textbox", {
    name: "Combined proposal",
    exact: true,
  });
  await dialog(page)
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "Combined proposal" }) })
    .locator("summary")
    .click();
  const current = await proposal.inputValue();
  await proposal.fill(
    current.replace("Original text", "External rewritten text") +
      "\nCombined user action",
  );
  const history = await core.request("/history");
  await page
    .getByRole("button", { name: "Save edited proposal", exact: true })
    .click();
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
  const after = await core.request("/manuscript/source");
  expect(after.source).toContain("External rewritten text");
  expect(after.source).toContain("Later local 中😀");
  expect(after.source).toContain("More after reload click");
  expect(after.source).toContain("Combined user action");
  expect((await core.request("/history")).undoCount).toBe(
    Math.min(5, history.undoCount + 1),
  );
  expect(saves).toHaveLength(1);
  expect(saves[0].requestId).not.toBe(accepts[0]);
  expect(accepts).toHaveLength(1);
});
