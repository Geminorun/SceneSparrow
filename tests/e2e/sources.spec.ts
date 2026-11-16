import { openWorkbench, startManualDraft } from "./helpers/workbench";
import { test, expect, type Page } from "@playwright/test";
import { docx, pdf } from "../fixtures/documents.mjs";
async function workspace(page: Page) {
  await openWorkbench(page);
  await startManualDraft(page);
}
const state = async (page: Page) =>
  (await page.request.get("/api/v1/manuscript")).json();
test.describe.configure({ mode: "serial" });
test("references retain copied files, link-only metadata and source membership history without body insertion", async ({
  page,
}) => {
  await workspace(page);
  const before = await state(page);
  await page
    .getByLabel("Reference URL")
    .fill("https://example.com/reference-only");
  await page.getByLabel("Reference title").fill("Link evidence");
  await page.getByRole("button", { name: "Add link reference" }).click();
  await expect(
    page.getByTestId("source-item").filter({ hasText: "Link evidence" }),
  ).toContainText("page content has not been fetched");
  await page.getByLabel("Add file reference", { exact: true }).setInputFiles({
    name: "reference.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Reference heading\n\nReference-only text 中文 🐦"),
  });
  const file = page
    .getByTestId("source-item")
    .filter({ hasText: "reference.md" });
  await expect(file).toContainText("Text ready");
  expect((await state(page)).blocks).toEqual(before.blocks);
  await file.getByRole("button", { name: "View extracted text" }).click();
  await expect(
    page.getByRole("dialog", { name: "Extracted text", exact: true }),
  ).toContainText("Reference-only text 中文 🐦");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await file.getByRole("button", { name: "Remove reference" }).click();
  await expect(file).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(file).toContainText("Text ready");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(file).toHaveCount(0);
  expect((await state(page)).blocks).toEqual(before.blocks);
});
test("real DOCX preview cancels unchanged, replaces atomically, appends once and shares undo", async ({
  page,
}) => {
  await workspace(page);
  const before = await state(page);
  const h = (await page.request.get("/api/v1/history")).json();
  await page
    .getByRole("button", { name: "Import manuscript", exact: true })
    .click();
  let dialog = page.getByRole("dialog", {
    name: "Import manuscript",
    exact: true,
  });
  await dialog
    .getByLabel("Import document file", { exact: true })
    .setInputFiles({
      name: "manuscript.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: docx(
        '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Imported DOCX heading</w:t></w:r></w:p><w:p><w:r><w:t>Imported paragraph</w:t></w:r></w:p>',
      ),
    });
  await expect(dialog.getByTestId("import-preview")).toContainText(
    "Imported DOCX heading",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await state(page)).blocks).toEqual(before.blocks);
  expect(await (await page.request.get("/api/v1/history")).json()).toEqual(
    await h,
  );
  await page
    .getByRole("button", { name: "Import manuscript", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Import manuscript", exact: true });
  await dialog
    .getByLabel("Paste manuscript text")
    .fill("Replacement 中文 🐦\n\nSecond paragraph");
  await dialog.getByRole("button", { name: "Prepare preview" }).click();
  await expect(
    dialog.getByRole("button", { name: "Replace manuscript", exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Replace manuscript", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Manuscript", exact: true }),
  ).toContainText("Replacement 中文 🐦");
  const replaced = await state(page);
  expect(replaced.blocks.length).toBe(2);
  await page
    .getByRole("button", { name: "Import manuscript", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Import manuscript", exact: true });
  await dialog.getByLabel("Paste manuscript text").fill("Appended once");
  await dialog.getByRole("button", { name: "Prepare preview" }).click();
  await dialog.getByRole("button", { name: "Append", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await state(page)).blocks.length).toBe(3);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await state(page)).blocks.map((b: any) => b.id)).toEqual(
    replaced.blocks.map((b: any) => b.id),
  );
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect((await state(page)).blocks.length).toBe(3);
});
test("stale preview rejects after visible editing and scanned PDFs never offer a destructive commit", async ({
  page,
}) => {
  await workspace(page);
  await page
    .getByRole("button", { name: "Import manuscript", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Import manuscript",
    exact: true,
  });
  await dialog
    .getByLabel("Paste manuscript text")
    .fill("Stale preview must not overwrite");
  await dialog.getByRole("button", { name: "Prepare preview" }).click();
  await expect(
    dialog.getByRole("button", { name: "Replace manuscript", exact: true }),
  ).toBeVisible();
  const current = await state(page);
  const sourceId = crypto.randomUUID();
  const project = (await (await page.request.get("/api/v1/project")).json())
    .project;
  const response = await page.request.post("/api/v1/manuscript/commands", {
    data: {
      type: "AddSourceLink",
      requestId: crypto.randomUUID(),
      projectId: project.id,
      expectedWorkingRevision: current.workingRevision,
      payload: {
        sourceId,
        url: "https://example.com/stale",
        title: "Concurrent reference",
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  await dialog
    .getByRole("button", { name: "Replace manuscript", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toHaveAttribute(
    "data-error-code",
    /IMPORT_STALE|REVISION_CONFLICT/,
  );
  expect((await state(page)).blocks).toEqual(current.blocks);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Import manuscript", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Import manuscript", exact: true })
    .click();
  const scanned = page.getByRole("dialog", {
    name: "Import manuscript",
    exact: true,
  });
  await scanned
    .getByLabel("Import document file", { exact: true })
    .setInputFiles({
      name: "scan.pdf",
      mimeType: "application/pdf",
      buffer: pdf([{ image: true }]),
    });
  await expect(scanned.getByRole("alert")).toHaveAttribute(
    "data-error-code",
    "SOURCE_TEXT_UNAVAILABLE",
  );
  await expect(
    scanned.getByRole("button", { name: "Replace manuscript", exact: true }),
  ).toHaveCount(0);
  expect((await state(page)).blocks).toEqual(current.blocks);
  await scanned.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh-CN");
  await expect(
    page.getByRole("heading", { name: "参考资料", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: ".artifacts/step-03-sources.png",
    fullPage: true,
  });
});
test("cancelled file reference queued behind autosave creates no membership or extraction", async ({
  page,
}) => {
  await workspace(page);
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let held = false;
  await page.route("**/v1/manuscript/commands", async (route) => {
    if (!held && route.request().postDataJSON()?.type === "ApplyDocumentEdit") {
      held = true;
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    await route.continue();
  });
  const before = (
    await (await page.request.get("/api/v1/sources")).json()
  ).items.map((s: any) => s.source.id);
  await page
    .getByRole("textbox", { name: "Manuscript", exact: true })
    .fill("Autosave before cancelled reference");
  await waiting;
  const uploaded = page.waitForResponse(
    (r) => r.url().endsWith("/v1/intakes") && r.request().method() === "POST",
  );
  await page.getByLabel("Add file reference", { exact: true }).setInputFiles({
    name: "cancel-queued.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Must not attach"),
  });
  expect((await uploaded).ok()).toBeTruthy();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Waiting for manuscript to save…" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  release();
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
  await expect(
    page.getByTestId("source-item").filter({ hasText: "cancel-queued.txt" }),
  ).toHaveCount(0);
  expect(
    (await (await page.request.get("/api/v1/sources")).json()).items.map(
      (s: any) => s.source.id,
    ),
  ).toEqual(before);
  await page.unroute("**/v1/manuscript/commands");
});
test("uncertain file membership retains its intake and retries the original request before extraction", async ({
  page,
}) => {
  await workspace(page);
  let failed = false;
  const commands: any[] = [];
  let cancelled = 0;
  page.on("request", (r) => {
    if (r.method() === "DELETE" && r.url().includes("/v1/intakes/"))
      cancelled++;
  });
  await page.route("**/v1/manuscript/commands", async (route) => {
    const body = route.request().postDataJSON();
    if (body?.type === "AddSourceFile") {
      commands.push(body);
      if (!failed) {
        failed = true;
        await route.abort("connectionrefused");
        return;
      }
    }
    await route.continue();
  });
  await page.route("**/v1/commands/*", (route) =>
    route.abort("connectionrefused"),
  );
  await page.getByLabel("Add file reference", { exact: true }).setInputFiles({
    name: "uncertain-reference.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Retain input until original command resolves"),
  });
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "error",
  );
  expect(cancelled).toBe(0);
  await expect(
    page
      .getByTestId("source-item")
      .filter({ hasText: "uncertain-reference.txt" }),
  ).toHaveCount(0);
  await page.unroute("**/v1/commands/*");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
  const source = page
    .getByTestId("source-item")
    .filter({ hasText: "uncertain-reference.txt" });
  await expect(source).toContainText("Processing interrupted");
  expect(commands.length).toBe(2);
  expect(commands[1]).toEqual(commands[0]);
  await source
    .getByRole("button", { name: "Retry extraction", exact: true })
    .click();
  await expect(source).toContainText("Text ready");
  await page.unroute("**/v1/manuscript/commands");
});
