import { test, expect } from "../e2e/helpers/source-core";
import { openWorkbench } from "../e2e/helpers/workbench";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
const execute = promisify(execFile);
const editor = (page: any) => page.locator(".cm-content");
const gate = () => {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((r) => (resolve = r)),
    resolve: () => resolve(),
  };
};
async function menu(page: any, name: string) {
  await page.locator(".project-menu > summary").click();
  await page
    .locator(".project-menu")
    .getByRole("button", { name, exact: true })
    .click();
  return page.getByRole("dialog", { name, exact: true });
}
async function register(core: any) {
  const source = await core.request("/manuscript/source");
  await core.request("/project/file-graph/register", {
    requestId: crypto.randomUUID(),
    projectId: source.projectId,
    expectedWorkingRevision: source.workingRevision,
    expectedSourceHash: source.acceptedHash,
    expectedSourceGeneration: source.generation,
  });
}
async function off(page: any) {
  await page.addInitScript(() =>
    localStorage.setItem(
      "scenesparrow.application-preferences",
      JSON.stringify({ version: 1, saveMode: "off", saveDelaySeconds: 10 }),
    ),
  );
}
async function change(page: any, before: string, after: string) {
  await expect(editor(page)).toBeVisible();
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  await editor(page).click();
  await editor(page).evaluate((node: HTMLElement, before: string) => {
    node.focus();
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
      const at = text.textContent?.indexOf(before) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(text, at);
      range.setEnd(text, at + before.length);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return;
    }
    throw Error("text not found");
  }, before);
  await page.keyboard.insertText(after);
}
async function exportPackage(page: any) {
  const modal = await menu(page, "Export project");
  await modal
    .getByRole("button", { name: "Create package", exact: true })
    .click();
  await expect(
    modal.getByRole("button", { name: "Download package", exact: true }),
  ).toBeEnabled();
  const downloading = page.waitForEvent("download");
  await modal
    .getByRole("button", { name: "Download package", exact: true })
    .click();
  const file = await (await downloading).path();
  await expect(modal).toContainText("Download started");
  return { modal, file };
}
async function inspect(page: any, bytes: Buffer, name = "project.zip") {
  const modal = await menu(page, "Import project package");
  await modal
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: "application/zip", buffer: bytes });
  await modal
    .getByRole("button", { name: "Inspect package", exact: true })
    .click();
  return modal;
}
test("fixed package captures hidden planning and original source while held ACKs retain newer IME, focus and pending input", async ({
  page,
  core,
}) => {
  await off(page);
  await core.seed("Initial source\n");
  await register(core);
  await openWorkbench(page, { url: core.browserUrl });
  await page.getByRole("button", { name: "Outline", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Outline", exact: true })
    .fill("# Captured hidden outline");
  await page
    .locator(".writing-view-switch")
    .getByRole("button", { name: "Manuscript", exact: true })
    .click();
  await change(page, "Initial source", "Captured source");
  const handle = await editor(page).elementHandle(),
    heldSave = gate(),
    saveStarted = gate(),
    heldCapture = gate(),
    captureStarted = gate();
  const saves: any[] = [],
    captures: any[] = [];
  core.intercept(async (path, body, phase) => {
    if (path.endsWith("/manuscript/source") && body && phase === "after") {
      saves.push(body);
      if (saves.length === 1) {
        saveStarted.resolve();
        await heldSave.promise;
      }
    }
    if (path.endsWith("/packages/exports") && body && phase === "after") {
      captures.push(body);
      captureStarted.resolve();
      await heldCapture.promise;
    }
  });
  const modal = await menu(page, "Export project");
  await modal
    .getByRole("button", { name: "Create package", exact: true })
    .click();
  await expect.poll(() => saves.length).toBe(1);
  await saveStarted.promise;
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator(".project-menu > summary")).toBeFocused();
  await editor(page).click();
  await page.keyboard.press("End");
  await editor(page).dispatchEvent("compositionstart");
  await page.keyboard.insertText(" 后续中文");
  const caret = await page.evaluate(
    () => document.getSelection()?.anchorOffset,
  );
  await expect(
    page.getByRole("button", { name: "Outline", exact: true }),
  ).toBeEnabled();
  heldSave.resolve();
  await expect.poll(() => captures.length).toBe(1);
  await captureStarted.promise;
  await expect(editor(page)).toBeFocused();
  expect(await page.evaluate(() => document.getSelection()?.anchorOffset)).toBe(
    caret,
  );
  expect(await handle?.evaluate((node) => node.isConnected)).toBe(true);
  expect(saves).toHaveLength(1);
  expect(captures).toHaveLength(1);
  heldCapture.resolve();
  await editor(page).dispatchEvent("compositionend");
  await page.waitForTimeout(800);
  expect(saves).toHaveLength(1);
  await expect(page.getByTestId("save-status")).toHaveText("Unsaved changes");
  await expect(editor(page)).toContainText("后续中文");
  const status = await menu(page, "Export project");
  const refresh = status.getByRole("button", {
    name: "Refresh status",
    exact: true,
  });
  if (await refresh.isVisible()) await refresh.click();
  await expect(
    status.getByRole("button", { name: "Download package", exact: true }),
  ).toBeEnabled();
  const downloading = page.waitForEvent("download");
  await status
    .getByRole("button", { name: "Download package", exact: true })
    .click();
  const file = await (await downloading).path();
  const source = await execute("python3", [
    "-c",
    "import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).read('manuscript.md').decode())",
    file!,
  ]);
  expect(source.stdout).toContain("Captured source");
  expect(source.stdout).not.toContain("后续中文");
  const plan = await execute("python3", [
    "-c",
    "import zipfile,sys,tempfile,sqlite3; f=tempfile.NamedTemporaryFile(); f.write(zipfile.ZipFile(sys.argv[1]).read('.scenesparrow/project.sqlite')); f.flush(); print(sqlite3.connect(f.name).execute('SELECT content_json FROM planning_state').fetchone()[0])",
    file!,
  ]);
  expect(plan.stdout).toContain("Captured hidden outline");
  await page.screenshot({
    path: ".artifacts/op5c/package-export-normal.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".artifacts/op5c/package-export-narrow.png",
    fullPage: true,
  });
  await status.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator(".project-menu > summary")).toBeFocused();
});
test("complete package inspection and independent restore leave dirty source mounted; unsafe ZIP reports localized fading notice", async ({
  page,
  core,
}) => {
  await off(page);
  await core.seed("Original project\n");
  await register(core);
  await openWorkbench(page, { url: core.browserUrl });
  const exported = await exportPackage(page),
    bytes = await readFile(exported.file!);
  await exported.modal
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await change(page, "Original project", "Unsaved private input");
  const handle = await editor(page).elementHandle();
  const restoreTargets: any[] = [],
    restores: any[] = [];
  let inspectedId = "";
  core.intercept(async (path, body, phase) => {
    if (phase !== "before" || !body) return;
    if (path.endsWith("/packages/inspections")) inspectedId = body.requestId;
    if (path.endsWith("/packages/restore-targets")) restoreTargets.push(body);
    if (path.endsWith("/packages/restores")) restores.push(body);
  });
  const modal = await inspect(page, bytes, "项目👩‍💻".repeat(30) + '".zip');
  await expect(modal).toContainText("Verified project management");
  await modal
    .getByRole("button", { name: "Prepare independent project", exact: true })
    .click();
  await expect(modal).toContainText("New project prepared");
  const firstRestore = restores[0].requestId;
  const firstReady = await core.request(
    `/project/packages/operations/${firstRestore}`,
  );
  await modal
    .getByRole("combobox", { name: "Recent operation", exact: true })
    .selectOption(inspectedId);
  await modal
    .getByRole("button", { name: "Prepare independent project", exact: true })
    .click();
  await expect(modal).toContainText("New project prepared");
  expect(restores).toHaveLength(2);
  expect(restores[1].requestId).not.toBe(restores[0].requestId);
  expect(restores[1].targetId).not.toBe(restores[0].targetId);
  expect(restoreTargets[1].requestId).not.toBe(restoreTargets[0].requestId);
  expect(
    await core.request(`/project/packages/operations/${firstRestore}`),
  ).toEqual(firstReady);
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await expect(editor(page)).toContainText("Unsaved private input");
  expect(await handle?.evaluate((node) => node.isConnected)).toBe(true);
  await expect(page.getByTestId("save-status")).toHaveText("Unsaved changes");
  const controls: any[] = [];
  core.intercept(async (path, body, phase) => {
    if (phase !== "before" || !body) return;
    if (path.endsWith("/packages/inspections")) inspectedId = body.requestId;
    if (path.endsWith("/control")) controls.push(body);
  });
  const next = await menu(page, "Import project package");
  await next.locator('input[type="file"]').setInputFiles({
    name: "unsafe.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(
      (
        await execute("python3", [
          "-c",
          "import io,zipfile,base64; f=io.BytesIO(); z=zipfile.ZipFile(f,'w'); z.writestr('../escape.txt','unsafe'); z.close(); print(base64.b64encode(f.getvalue()).decode())",
        ])
      ).stdout.trim(),
      "base64",
    ),
  });
  await next
    .getByRole("button", { name: "Inspect package", exact: true })
    .click();
  await expect(next).toContainText(
    /unsafe file path|unsafe or failed verification/,
  );
  await expect(page.locator(".notification")).toBeVisible();
  await page.waitForTimeout(3400);
  await expect(page.locator(".notification")).toHaveCount(0);
  await expect(next).toContainText(
    /unsafe file path|unsafe or failed verification/,
  );
  await next.getByRole("button", { name: "Close", exact: true }).click();
  await expect(editor(page)).toContainText("Unsaved private input");
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh-CN");
  const localized = await menu(page, "导入项目包");
  const failedBeforeRetry = await core.request(
    `/project/packages/operations/${inspectedId}`,
  );
  await localized.getByRole("button", { name: "重试", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await core.request(`/project/packages/operations/${inspectedId}`))
          .operationRevision,
    )
    .toBeGreaterThan(failedBeforeRetry.operationRevision);
  await expect(page.locator(".notification")).toContainText(/不安全|验证失败/);
  await page.waitForTimeout(3400);
  await expect(page.locator(".notification")).toHaveCount(0);
  await expect(localized).toContainText(/不安全|验证失败/);
  const firstRetry = await core.request(
    `/project/packages/operations/${inspectedId}`,
  );
  // A later explicit episode dispatches a fresh control against current status.
  await localized.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator(".notification")).toContainText(/不安全|验证失败/);
  await page.waitForTimeout(3400);
  await expect(page.locator(".notification")).toHaveCount(0);
  await expect(localized).toContainText(/不安全|验证失败/);
  await expect
    .poll(
      async () =>
        (await core.request(`/project/packages/operations/${inspectedId}`))
          .operationRevision,
    )
    .toBeGreaterThan(firstRetry.operationRevision);
  expect(controls).toHaveLength(2);
  expect(controls[0].requestId).not.toBe(controls[1].requestId);
  expect(controls[1].expectedOperationRevision).toBe(
    firstRetry.operationRevision,
  );
  let conflictOnce = true,
    conflictStatus: any;
  core.intercept(async (path, body, phase) => {
    if (!path.endsWith("/control") || !body || phase !== "before") return;
    controls.push(body);
    if (conflictOnce) {
      conflictOnce = false;
      const current = await core.request(
        `/project/packages/operations/${inspectedId}`,
      );
      await core.request(
        `/project/packages/operations/${inspectedId}/control`,
        {
          ...body,
          requestId: crypto.randomUUID(),
          expectedOperationRevision: current.operationRevision,
        },
      );
      await expect
        .poll(
          async () =>
            (await core.request(`/project/packages/operations/${inspectedId}`))
              .state,
        )
        .toBe("failed");
      conflictStatus = await core.request(
        `/project/packages/operations/${inspectedId}`,
      );
    }
  });
  await localized.getByRole("button", { name: "重试", exact: true }).click();
  await expect(
    page.locator('.notification[data-error-code="PACKAGE_REVISION_CONFLICT"]'),
  ).toBeVisible();
  await localized.getByRole("button", { name: "重试", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await core.request(`/project/packages/operations/${inspectedId}`))
          .operationRevision,
    )
    .toBeGreaterThan(conflictStatus.operationRevision);
  expect(controls).toHaveLength(4);
  expect(new Set(controls.map((row) => row.requestId)).size).toBe(4);
  expect(controls[3].expectedOperationRevision).toBe(
    conflictStatus.operationRevision,
  );
});
test("unavailable package download preserves dirty editor document and original export identity after unknown ACK", async ({
  page,
  core,
}) => {
  await off(page);
  await core.seed("Snapshot\n");
  await register(core);
  await openWorkbench(page, { url: core.browserUrl });
  let original: any,
    starts = 0;
  core.intercept(async (path, body, phase) => {
    if (path.endsWith("/packages/exports") && body && phase === "after") {
      original = body;
      starts++;
      return "abort";
    }
  });
  const modal = await menu(page, "Export project");
  await modal
    .getByRole("button", { name: "Create package", exact: true })
    .click();
  await expect(
    modal.getByRole("button", { name: "Refresh status", exact: true }),
  ).toBeEnabled();
  core.intercept(async (path, _body, phase) => {
    if (path.includes("/packages/archives/") && phase === "after")
      return "abort";
  });
  await modal
    .getByRole("button", { name: "Refresh status", exact: true })
    .click();
  await expect(
    modal.getByRole("button", { name: "Download package", exact: true }),
  ).toBeEnabled();
  expect(starts).toBe(1);
  const operation = await core.request(
    `/project/packages/operations/${original.requestId}`,
  );
  expect(operation.requestId).toBe(original.requestId);
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await change(page, "Snapshot", "Unsaved after snapshot");
  const handle = await editor(page).elementHandle();
  const status = await menu(page, "Export project");
  await status
    .getByRole("button", { name: "Download package", exact: true })
    .click();
  await expect(page.locator(".notification")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
  await status.getByRole("button", { name: "Close", exact: true }).click();
  await expect(editor(page)).toContainText("Unsaved after snapshot");
  expect(await handle?.evaluate((node) => node.isConnected)).toBe(true);
});

test("older off-page work package returns its exact candidate and late lookup cannot replace manual selection", async ({
  page,
  core,
}) => {
  await off(page);
  await core.seed("Original work\n");
  await register(core);
  const graph = await core.request("/project/file-graph"),
    project = (await core.request("/project")).project;
  const grant = {
    wholeTree: true,
    files: [],
    directories: [],
    manuscriptScope: { kind: "all", blockIds: [] },
  };
  const created = await core.request("/project/work-items", {
    requestId: crypto.randomUUID(),
    projectId: project.id,
    expectedWorkingRevision: project.workingRevision,
    expectedGraphHash: graph.graphHash,
    expectedGraphGeneration: graph.generation,
    origin: "copy",
    grant,
    referenceIds: [],
  });
  await expect
    .poll(
      async () => (await core.request("/project/work-items")).records[0]?.state,
    )
    .toBe("ready");
  const older = (await core.request("/project/work-items")).records[0];
  const newerGraph = await core.request("/project/file-graph");
  const newerProject = (await core.request("/project")).project;
  await core.request("/project/work-items", {
    requestId: crypto.randomUUID(),
    projectId: newerProject.id,
    expectedWorkingRevision: newerProject.workingRevision,
    expectedGraphHash: newerGraph.graphHash,
    expectedGraphGeneration: newerGraph.generation,
    origin: "copy",
    grant,
    referenceIds: [],
  });
  await expect
    .poll(async () =>
      (await core.request("/project/work-items")).records.every(
        (row: any) => row.state === "ready",
      ),
    )
    .toBe(true);
  const newer = (await core.request("/project/work-items")).records.find(
    (row: any) => row.workItemId !== older.workItemId,
  );
  await openWorkbench(page, { url: core.browserUrl });
  await menu(page, "External Agent work");
  await page.locator(`[data-work-item-id="${older.workItemId}"]`).click();
  await expect(
    page.getByRole("button", { name: "Export work copy", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Export work copy", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Download package", exact: true }),
  ).toBeVisible();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download package", exact: true })
    .click();
  const archive = await (await downloading).path(),
    returned = archive + "-returned.zip";
  await execute("python3", [
    "-c",
    "import zipfile,sys; a=zipfile.ZipFile(sys.argv[1]); b=zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED); [(b.writestr(i,a.read(i.filename).replace(b'Original work',b'Returned work') if i.filename=='project/manuscript.md' else a.read(i.filename))) for i in a.infolist()]; b.close()",
    archive!,
    returned,
  ]);
  await page
    .getByRole("dialog", { name: "Changes", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  const imported = await inspect(page, await readFile(returned));
  await expect(imported).toContainText("Recorded work copy");
  await imported
    .getByRole("button", { name: "Return as edits", exact: true })
    .click();
  await expect(
    imported.getByRole("button", { name: "Review in Changes", exact: true }),
  ).toBeVisible();
  const returnedCandidate = (
    await core.request(`/project/work-items/${older.workItemId}`)
  ).latestCandidate;
  const lookupEntered = gate(),
    lookupRelease = gate();
  let holdLookup = true;
  core.intercept(async (path, body, phase) => {
    if (
      path.endsWith(`/work-items/${older.workItemId}`) &&
      !body &&
      phase === "after" &&
      holdLookup
    ) {
      holdLookup = false;
      lookupEntered.resolve();
      await lookupRelease.promise;
    }
  });
  // The ordinary first page intentionally excludes the returned item.
  await page.route("**/api/v1/project/work-items", async (route) => {
    const result = await core.request("/project/work-items");
    await route.fulfill({
      json: {
        ...result,
        records: result.records.filter(
          (row: any) => row.workItemId === newer.workItemId,
        ),
        continuation: null,
      },
    });
  });
  await imported
    .getByRole("button", { name: "Review in Changes", exact: true })
    .click();
  await lookupEntered.promise;
  await page.locator(`[data-work-item-id="${newer.workItemId}"]`).click();
  lookupRelease.resolve();
  await expect(
    page.locator(`[data-work-item-id="${newer.workItemId}"]`),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Accept inspected batch", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("dialog", { name: "Changes", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  const reopened = await menu(page, "Import project package");
  await reopened
    .getByRole("button", { name: "Review in Changes", exact: true })
    .click();
  await expect(
    page.locator(`[data-work-item-id="${older.workItemId}"]`),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".external-work-detail")).toContainText(
    "Returned work",
  );
  const before = await core.request("/history");
  let accepts = 0;
  core.intercept(async (path, body, phase) => {
    if (path.endsWith("/accept") && body && phase === "before") {
      expect(body.workItemId).toBe(older.workItemId);
      expect(body.candidateId).toBe(returnedCandidate.candidateId);
      accepts++;
    }
  });
  await page
    .getByRole("button", { name: "Accept inspected batch", exact: true })
    .click();
  await expect(page.locator(".external-work-items:visible")).toContainText(
    "Accepted",
  );
  expect(accepts).toBe(1);
  expect(
    (await core.request(`/project/work-items/${newer.workItemId}`)).state,
  ).toBe("ready");
  expect((await core.request("/history")).undoCount).toBe(
    Math.min(5, before.undoCount + 1),
  );
  await page.screenshot({
    path: ".artifacts/op5c/work-package-return-accepted.png",
    fullPage: true,
  });
  await page
    .getByRole("dialog", { name: "Changes", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(editor(page)).toContainText("Returned work");
});
test("late package base read cannot dispatch after a later import selection or replace its dialog", async ({
  page,
  core,
}) => {
  await off(page);
  await core.seed("Current source\n");
  await register(core);
  await openWorkbench(page, { url: core.browserUrl });
  const entered = gate(),
    held = gate();
  let exports = 0;
  core.intercept(async (path, body, phase) => {
    if (path.endsWith("/packages/base") && phase === "after") {
      entered.resolve();
      await held.promise;
    }
    if (path.endsWith("/packages/exports") && body && phase === "before")
      exports++;
  });
  const exporting = await menu(page, "Export project");
  await exporting
    .getByRole("button", { name: "Create package", exact: true })
    .click();
  await entered.promise;
  await exporting.getByRole("button", { name: "Close", exact: true }).click();
  const imported = await menu(page, "Import project package");
  await imported.locator('input[type="file"]').setInputFiles({
    name: "later.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("later selection"),
  });
  held.resolve();
  await page.waitForTimeout(300);
  expect(exports).toBe(0);
  await expect(imported).toBeVisible();
  await expect(imported).toContainText("later.zip");
  await expect(
    imported.getByRole("button", { name: "Inspect package", exact: true }),
  ).toBeEnabled();
});

test("refresh recovers the original export by lookup only and downloads without another start; foreign hints are harmless", async ({
  page,
  core,
}) => {
  await off(page);
  await core.seed("Reload snapshot\n");
  await register(core);
  await openWorkbench(page, { url: core.browserUrl });
  let starts = 0,
    original: any;
  core.intercept(async (path, body, phase) => {
    if (path.endsWith("/packages/exports") && body && phase === "before") {
      starts++;
      original = body;
    }
  });
  const exporting = await menu(page, "Export project");
  await exporting
    .getByRole("button", { name: "Create package", exact: true })
    .click();
  await expect(
    exporting.getByRole("button", { name: "Download package", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const rows = JSON.parse(
      localStorage.getItem("scenesparrow.transfer-hints") ?? "[]",
    );
    rows.push({
      version: 1,
      id: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      kind: "convert",
      createdAt: Date.now(),
    });
    localStorage.setItem("scenesparrow.transfer-hints", JSON.stringify(rows));
  });
  await page.reload();
  await expect(page.getByTestId("save-status")).toBeVisible();
  const recovered = await menu(page, "Export project");
  await expect(recovered).toContainText("saved operation can be checked");
  await expect(
    recovered.getByRole("button", {
      name: "Reconcile original request",
      exact: true,
    }),
  ).toHaveCount(0);
  await recovered
    .getByRole("button", { name: "Refresh status", exact: true })
    .click();
  await expect(
    recovered.getByRole("button", { name: "Download package", exact: true }),
  ).toBeVisible();
  const downloading = page.waitForEvent("download");
  await recovered
    .getByRole("button", { name: "Download package", exact: true })
    .click();
  const file = await (await downloading).path();
  expect((await readFile(file!)).length).toBeGreaterThan(100);
  expect(starts).toBe(1);
  expect(
    (await core.request(`/project/packages/operations/${original.requestId}`))
      .requestId,
  ).toBe(original.requestId);
});

test("work package terminal failure view reports once per explicit refresh and passive polling stays quiet", async ({
  page,
  core,
}) => {
  await off(page);
  await core.seed("Work failure presentation\n");
  await register(core);
  const graph = await core.request("/project/file-graph"),
    project = (await core.request("/project")).project;
  await core.request("/project/work-items", {
    requestId: crypto.randomUUID(),
    projectId: project.id,
    expectedWorkingRevision: project.workingRevision,
    expectedGraphHash: graph.graphHash,
    expectedGraphGeneration: graph.generation,
    origin: "copy",
    grant: {
      wholeTree: true,
      files: [],
      directories: [],
      manuscriptScope: { kind: "all", blockIds: [] },
    },
    referenceIds: [],
  });
  await expect
    .poll(
      async () => (await core.request("/project/work-items")).records[0]?.state,
    )
    .toBe("ready");
  await openWorkbench(page, { url: core.browserUrl });
  // The actual core creates/captures the work package. This response fixture
  // supplies a terminal worker failure solely to exercise notice episodes.
  let reads = 0;
  await page.route("**/api/v1/project/packages/operations/*", async (route) => {
    const response = await route.fetch(),
      operation = await response.json();
    reads++;
    await route.fulfill({
      response,
      json: {
        ...operation,
        archive: undefined,
        state: "failed",
        phase: "archive",
        failureCode: "PACKAGE_SIZE_LIMIT",
      },
    });
  });
  await menu(page, "External Agent work");
  await page
    .getByRole("button", { name: "Export work copy", exact: true })
    .click();
  await expect(page.locator(".notification")).toContainText(
    "exceeds supported size",
  );
  await page.waitForTimeout(3400);
  await expect(page.locator(".notification")).toHaveCount(0);
  expect(reads).toBe(1);
  await page
    .getByRole("button", { name: "Refresh status", exact: true })
    .click();
  await expect(page.locator(".notification")).toContainText(
    "exceeds supported size",
  );
  await page.waitForTimeout(3400);
  await expect(page.locator(".notification")).toHaveCount(0);
  expect(reads).toBe(2);
});

test("twenty recovery hints use one compact entry and retain a visible mounted editor", async ({
  page,
  core,
}) => {
  await off(page);
  await core.seed("Editor stays visible\n");
  const projectId = (await core.request("/project")).project.id;
  await page.addInitScript((projectId) => {
    localStorage.setItem(
      "scenesparrow.transfer-hints",
      JSON.stringify(
        Array.from({ length: 20 }, (_, index) => ({
          version: 1,
          id: crypto.randomUUID(),
          projectId,
          kind: index % 2 ? "import" : "export",
          createdAt: Date.now() - index,
        })),
      ),
    );
  }, projectId);
  await openWorkbench(page, { url: core.browserUrl });
  const handle = await editor(page).elementHandle();
  await expect(editor(page)).toBeVisible();
  await expect(editor(page)).toContainText("Editor stays visible");
  await expect(page.getByTestId("transfer-recovery")).toHaveCount(1);
  await expect(page.getByTestId("transfer-recovery")).toContainText(
    "Recent transfers (20)",
  );
  expect((await editor(page).boundingBox())!.y).toBeLessThan(250);
  await page.getByTestId("transfer-recovery").getByRole("button").click();
  const dialog = page.getByRole("dialog", {
    name: "Export project",
    exact: true,
  });
  await expect(
    dialog
      .getByRole("combobox", { name: "Recent operation", exact: true })
      .locator("option"),
  ).toHaveCount(21);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  expect(await handle?.evaluate((node) => node.isConnected)).toBe(true);
  await page.screenshot({
    path: ".artifacts/op5c/recent-transfers-normal.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(editor(page)).toBeVisible();
  await expect(page.getByTestId("transfer-recovery")).toHaveCount(1);
  await page.screenshot({
    path: ".artifacts/op5c/recent-transfers-narrow.png",
    fullPage: true,
  });
});
test("a late cancelled upload failure cannot replace a later selected File, dialog or controller", async ({
  page,
  core,
}) => {
  await off(page);
  await core.seed("Cancellation owner\n");
  await register(core);
  await openWorkbench(page, { url: core.browserUrl });
  const exported = await exportPackage(page),
    bytes = await readFile(exported.file!);
  await exported.modal
    .getByRole("button", { name: "Close", exact: true })
    .click();
  const chunkEntered = gate(),
    chunkHold = gate(),
    cancelEntered = gate(),
    cancelHold = gate();
  let cancelled: any[] = [];
  core.intercept(async (path, body, phase) => {
    if (path.endsWith("/chunks") && phase === "after") {
      chunkEntered.resolve();
      await chunkHold.promise;
    }
    if (
      path.includes("/package-intakes/") &&
      path.endsWith("/control") &&
      body &&
      phase === "after"
    ) {
      cancelled.push(body);
      cancelEntered.resolve();
      await cancelHold.promise;
      return "abort";
    }
  });
  const imported = await menu(page, "Import project package");
  await imported.locator('input[type="file"]').setInputFiles({
    name: "original.zip",
    mimeType: "application/zip",
    buffer: bytes,
  });
  await imported
    .getByRole("button", { name: "Inspect package", exact: true })
    .click();
  await chunkEntered.promise;
  await imported.getByRole("button", { name: "Cancel", exact: true }).click();
  await imported.getByRole("button", { name: "Cancel", exact: true }).click();
  await cancelEntered.promise;
  await imported.locator('input[type="file"]').setInputFiles({
    name: "later.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("later selection"),
  });
  cancelHold.resolve();
  chunkHold.resolve();
  await page.waitForTimeout(500);
  expect(cancelled).toHaveLength(1);
  await expect(imported).toBeVisible();
  await expect(imported).toContainText("later.zip");
  await expect(
    imported.getByRole("button", { name: "Inspect package", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".notification")).toHaveCount(0);
});

test("native delivery presentation creates new explicit chooser identities after known outcomes and only looks up unknown delivery", async ({
  page,
  core,
}) => {
  await off(page);
  await core.seed("Native delivery presentation\n");
  await register(core);
  // Trusted App/client fixture exercises native presentation while the real core
  // captures the package. OS chooser and physical delivery are covered separately.
  await page.route("**/", async (route) => {
    if (!route.request().isNavigationRequest()) return route.continue();
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div>
      <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script>
      <script type="module" src="/@vite/client"></script><script type="module">
      import React from '/node_modules/.vite/deps/react.js'; import ReactDOMClient from '/node_modules/.vite/deps/react-dom_client.js'; const {createRoot}=ReactDOMClient;
      import {App} from '/@fs/workspace/SceneSparrow/packages/editor-ui/src/app/App.tsx';
      import {createHttpClient} from '/@fs/workspace/SceneSparrow/packages/platform-client/src/http.ts';
      import {ApiError} from '/@fs/workspace/SceneSparrow/packages/platform-client/src/errors.ts';
      import '/@fs/workspace/SceneSparrow/packages/editor-ui/src/styles.css';
      window.nativeFixture={requests:[],lookups:[],lookupReplies:['PACKAGE_NOT_FOUND','saved'],replies:['PACKAGE_SAVE_NOT_STARTED','cancelled','exists','SOURCE_PATH_UNSAFE','PACKAGE_NOT_FOUND','PACKAGE_BUSY','unknown']}; const client=createHttpClient();
      client.savePackageArchive=async request=>{window.nativeFixture.requests.push(request);const outcome=window.nativeFixture.replies.shift()??'saved';if(outcome==='SOURCE_PATH_UNSAFE'||outcome.startsWith('PACKAGE_'))throw new ApiError(outcome);return {requestId:request.requestId,outcome,filename:'safe.zip'};};
      client.readNativePackageSave=async request=>{window.nativeFixture.lookups.push(request);const outcome=window.nativeFixture.lookupReplies.shift()??'saved';if(outcome.startsWith('PACKAGE_'))throw new ApiError(outcome);return {requestId:request.requestId,outcome,filename:'safe.zip'};};
      createRoot(document.getElementById('root')).render(React.createElement(App,{client}));</script></body></html>`,
    });
  });
  await openWorkbench(page, { url: core.browserUrl });
  let modal = await menu(page, "Export project");
  await modal
    .getByRole("button", { name: "Create package", exact: true })
    .click();
  const save = () =>
    modal.getByRole("button", {
      name: "Save package as new file",
      exact: true,
    });
  await expect(save()).toBeEnabled();
  await save().click();
  await expect(
    page.locator('.notification[data-error-code="PACKAGE_SAVE_NOT_STARTED"]'),
  ).toBeVisible();
  await expect(save()).toBeEnabled();
  await save().click();
  await expect(modal).toContainText("Save cancelled.");
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  modal = await menu(page, "Export project");
  await save().click();
  await expect(modal).toContainText("Destination already exists");
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  modal = await menu(page, "Export project");
  await save().click();
  await expect(page.locator(".notification")).toBeVisible();
  for (let n = 0; n < 2; n++) {
    await save().click();
    await expect(page.locator(".notification")).toBeVisible();
    await expect(save()).toBeEnabled();
  }
  await save().click();
  await expect(save()).toBeDisabled();
  await expect(modal).toContainText("Delivery status unknown");
  const requests = await page.evaluate(
    () => (window as any).nativeFixture.requests,
  );
  expect(requests).toHaveLength(7);
  expect(new Set(requests.map((request: any) => request.requestId)).size).toBe(
    7,
  );
  await modal
    .getByRole("button", { name: "Check original delivery", exact: true })
    .click();
  await expect(save()).toBeDisabled();
  await expect(
    modal.getByRole("button", { name: "Check original delivery", exact: true }),
  ).toBeEnabled();
  await modal
    .getByRole("button", { name: "Check original delivery", exact: true })
    .click();
  await expect(modal).toContainText("Package saved.");
  await expect(save()).toBeEnabled();
  const lookups = await page.evaluate(
    () => (window as any).nativeFixture.lookups,
  );
  expect(lookups).toEqual([requests[6], requests[6]]);
  expect(
    await page.evaluate(() => (window as any).nativeFixture.requests.length),
  ).toBe(7);
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  const graph = await core.request("/project/file-graph"),
    project = (await core.request("/project")).project;
  await core.request("/project/work-items", {
    requestId: crypto.randomUUID(),
    projectId: project.id,
    expectedWorkingRevision: project.workingRevision,
    expectedGraphHash: graph.graphHash,
    expectedGraphGeneration: graph.generation,
    origin: "copy",
    grant: {
      wholeTree: true,
      files: [],
      directories: [],
      manuscriptScope: { kind: "all", blockIds: [] },
    },
    referenceIds: [],
  });
  await expect
    .poll(
      async () => (await core.request("/project/work-items")).records[0]?.state,
    )
    .toBe("ready");
  await page.evaluate(() => {
    (window as any).nativeFixture.replies = [
      "PACKAGE_SAVE_NOT_STARTED",
      "PACKAGE_NOT_FOUND",
      "PACKAGE_BUSY",
      "unknown",
    ];
    (window as any).nativeFixture.lookupReplies = [
      "PACKAGE_NOT_FOUND",
      "saved",
    ];
  });
  await menu(page, "External Agent work");
  const work = page.locator(".external-work-detail");
  await work
    .getByRole("button", { name: "Export work copy", exact: true })
    .click();
  const workSave = work.getByRole("button", {
    name: "Save package as new file",
    exact: true,
  });
  for (let n = 0; n < 3; n++) {
    await workSave.click();
    await expect(page.locator(".notification")).toBeVisible();
    await expect(workSave).toBeEnabled();
  }
  await workSave.click();
  await expect(workSave).toBeDisabled();
  await work
    .getByRole("button", { name: "Check original delivery", exact: true })
    .click();
  await expect(workSave).toBeDisabled();
  await work
    .getByRole("button", { name: "Check original delivery", exact: true })
    .click();
  await expect(work).toContainText("Package saved.");
  const all = await page.evaluate(() => (window as any).nativeFixture.requests);
  expect(all).toHaveLength(11);
  expect(new Set(all.map((r: any) => r.requestId)).size).toBe(11);
  expect(
    await page.evaluate(() => (window as any).nativeFixture.lookups),
  ).toEqual([requests[6], requests[6], all[10], all[10]]);
});

test("a source save predecessor cannot export an independently accepted foreign leaf while its captured action waits", async ({
  page,
  core,
}) => {
  await off(page);
  await core.seed("Original leaf\n\nIndependent leaf\n");
  await register(core);
  await openWorkbench(page, { url: core.browserUrl });
  const entered = gate(),
    held = gate();
  let heldOnce = false,
    starts = 0;
  core.intercept(async (path, body, phase) => {
    if (
      path.endsWith("/manuscript/source") &&
      body &&
      phase === "after" &&
      !heldOnce
    ) {
      heldOnce = true;
      entered.resolve();
      await held.promise;
    }
    if (path.endsWith("/packages/exports") && body && phase === "before")
      starts++;
  });
  await change(page, "Original leaf", "A predecessor");
  await page.keyboard.press("Control+s");
  await entered.promise;
  await change(page, "A predecessor", "B captured");
  const modal = await menu(page, "Export project");
  await modal
    .getByRole("button", { name: "Create package", exact: true })
    .click();
  const current = await core.request("/manuscript/source");
  await core.request("/manuscript/source", {
    requestId: crypto.randomUUID(),
    projectId: current.projectId,
    expectedWorkingRevision: current.workingRevision,
    expectedGeneration: current.generation,
    expectedHash: current.acceptedHash,
    source: current.source.replace(
      "Independent leaf",
      "Foreign independent leaf",
    ),
    group: {
      clientSessionId: crypto.randomUUID(),
      groupId: crypto.randomUUID(),
      groupSequence: 1,
      kind: "discrete",
    },
  });
  held.resolve();
  await expect(
    page.locator('.notification[data-error-code="REVISION_CONFLICT"]').first(),
  ).toBeVisible();
  await expect(
    modal.getByRole("button", { name: "Create package", exact: true }),
  ).toBeEnabled();
  expect(starts).toBe(0);
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await expect(editor(page)).toContainText("B captured");
  await expect(editor(page)).toContainText("Independent leaf");
  await expect(editor(page)).not.toContainText("Foreign independent leaf");
});

async function unsafeControlPackage() {
  return Buffer.from(
    (
      await execute("python3", [
        "-c",
        "import io,zipfile,base64; f=io.BytesIO(); z=zipfile.ZipFile(f,'w'); z.writestr('../control.txt','unsafe'); z.close(); print(base64.b64encode(f.getvalue()).decode())",
      ])
    ).stdout.trim(),
    "base64",
  );
}
test("unknown controls keep their exact original DTO across another operation and late selection changes", async ({
  page,
  core,
}) => {
  await off(page);
  await core.seed("Control custody\n");
  await register(core);
  await openWorkbench(page, { url: core.browserUrl });
  const ids: string[] = [],
    controls: any[] = [];
  const entered = gate(),
    held = gate();
  let loseFirst = true,
    replay = false;
  core.intercept(async (path, body, phase) => {
    if (path.endsWith("/packages/inspections") && body && phase === "before")
      ids.push(body.requestId);
    if (path.endsWith("/control") && body) {
      if (phase === "before") controls.push(body);
      if (phase === "after" && body.operationId === ids[0]) {
        if (loseFirst) {
          loseFirst = false;
          return "abort";
        }
        if (replay) {
          replay = false;
          entered.resolve();
          await held.promise;
        }
      }
    }
  });
  const bytes = await unsafeControlPackage();
  let modal = await inspect(page, bytes, "a.zip");
  await expect(modal).toContainText(
    /unsafe file path|unsafe or failed verification/,
  );
  await modal.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    modal.getByRole("button", { name: "Try again", exact: true }),
  ).toBeEnabled();
  const original = controls[0];
  await modal
    .getByRole("button", { name: "Start another transfer", exact: true })
    .click();
  await modal.locator('input[type="file"]').setInputFiles({
    name: "b.zip",
    mimeType: "application/zip",
    buffer: bytes,
  });
  await modal
    .getByRole("button", { name: "Inspect package", exact: true })
    .click();
  await expect(modal).toContainText(
    /unsafe file path|unsafe or failed verification/,
  );
  await modal.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    modal.getByRole("button", { name: "Try again", exact: true }),
  ).toBeEnabled();
  const bBefore = await core.request(`/project/packages/operations/${ids[1]}`);
  const selection = modal.getByRole("combobox", {
    name: "Recent operation",
    exact: true,
  });
  await selection.selectOption(ids[0]);
  replay = true;
  await modal.getByRole("button", { name: "Try again", exact: true }).click();
  await expect
    .poll(() => controls.filter((row) => row.operationId === ids[0]).length)
    .toBe(2);
  await entered.promise;
  await selection.selectOption(ids[1]);
  held.resolve();
  await expect(selection).toHaveValue(ids[1]);
  await modal
    .getByRole("button", { name: "Refresh status", exact: true })
    .click();
  expect(await core.request(`/project/packages/operations/${ids[1]}`)).toEqual(
    bBefore,
  );
  const aControls = controls.filter((row) => row.operationId === ids[0]);
  expect(aControls).toHaveLength(2);
  expect(aControls[1]).toEqual(original);
  await selection.selectOption(ids[0]);
  await modal
    .getByRole("button", { name: "Refresh status", exact: true })
    .click();
  const aBefore = await core.request(`/project/packages/operations/${ids[0]}`);
  await modal.getByRole("button", { name: "Try again", exact: true }).click();
  await expect
    .poll(() => controls.filter((row) => row.operationId === ids[0]).length)
    .toBe(3);
  const latest = controls.filter((row) => row.operationId === ids[0])[2];
  expect(latest.requestId).not.toBe(original.requestId);
  expect(latest.expectedOperationRevision).toBe(aBefore.operationRevision);
});
test("transfer retention refuses new admission rather than evicting an unresolved original control", async ({
  page,
  core,
}) => {
  await off(page);
  await core.seed("Bounded control custody\n");
  await register(core);
  const projectId = (await core.request("/project")).project.id;
  await page.addInitScript(
    ({ projectId }) => {
      localStorage.setItem(
        "scenesparrow.transfer-hints",
        JSON.stringify(
          Array.from({ length: 19 }, (_, n) => ({
            version: 1,
            id: crypto.randomUUID(),
            projectId,
            kind: "export",
            createdAt: Date.now() - n,
          })),
        ),
      );
    },
    { projectId },
  );
  await openWorkbench(page, { url: core.browserUrl });
  const ids: string[] = [],
    controls: any[] = [];
  let lose = true;
  core.intercept(async (path, body, phase) => {
    if (path.endsWith("/packages/inspections") && body && phase === "before")
      ids.push(body.requestId);
    if (path.endsWith("/control") && body) {
      if (phase === "before") controls.push(body);
      if (phase === "after" && lose) {
        lose = false;
        return "abort";
      }
    }
  });
  const bytes = await unsafeControlPackage();
  const modal = await inspect(page, bytes, "bounded-a.zip");
  await expect(modal).toContainText(
    /unsafe file path|unsafe or failed verification/,
  );
  await modal.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    modal.getByRole("button", { name: "Try again", exact: true }),
  ).toBeEnabled();
  await modal
    .getByRole("button", { name: "Start another transfer", exact: true })
    .click();
  await modal.locator('input[type="file"]').setInputFiles({
    name: "blocked-b.zip",
    mimeType: "application/zip",
    buffer: bytes,
  });
  await modal
    .getByRole("button", { name: "Inspect package", exact: true })
    .click();
  await expect(
    page.locator('.notification[data-error-code="TRANSFER_BUSY"]'),
  ).toBeVisible();
  expect(ids).toHaveLength(1);
  const selection = modal.getByRole("combobox", {
    name: "Recent operation",
    exact: true,
  });
  expect(await selection.locator("option").count()).toBe(21);
  await selection.selectOption(ids[0]);
  await modal.getByRole("button", { name: "Try again", exact: true }).click();
  await expect.poll(() => controls.length).toBe(2);
  expect(controls[1]).toEqual(controls[0]);
});
