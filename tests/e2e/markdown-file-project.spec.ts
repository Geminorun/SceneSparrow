import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const editor = (page: Page) =>
  page.getByRole("textbox", { name: "Markdown manuscript", exact: true });
const save = (page: Page) =>
  page.getByRole("button", { name: "Save", exact: true }).click();
const projectId = (page: Page) =>
  new URL(page.url()).searchParams.get("project");
async function exported(page: Page) {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download .md", exact: true }).click();
  const file = await download;
  return readFile((await file.path())!);
}
async function importFile(page: Page, buffer: Buffer, name = "returned.md") {
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: "text/markdown", buffer });
}

test("MFP-AC01–06: new, save, refresh, fresh lossless imports, invalid input, download and external return", async ({
  page,
}) => {
  await page.goto("/");
  await expect(editor(page)).toBeVisible();
  const original = projectId(page);
  expect(original).toMatch(/^[a-f0-9-]{36}$/);
  await editor(page).pressSequentially("# First manuscript");
  await save(page);
  await expect(page.getByRole("status")).toHaveText("Saved");
  await page.reload();
  await expect(editor(page)).toHaveValue("# First manuscript");
  expect(projectId(page)).toBe(original);
  const raw = Buffer.from(
    "\ufeff# 中文\r\n<!-- untouched -->\r[link](../source.md)\n",
  );
  await importFile(page, raw);
  await expect(editor(page)).toHaveValue(
    "# 中文\n<!-- untouched -->\n[link](../source.md)\n",
  );
  const imported = projectId(page);
  expect(imported).not.toBe(original);
  await editor(page).focus();
  await editor(page).dispatchEvent("compositionstart");
  await editor(page).blur();
  await expect
    .poll(async () => (await exported(page)).toString("hex"))
    .toBe(raw.toString("hex"));
  await page.reload();
  await expect(editor(page)).toBeVisible();
  expect(await exported(page)).toEqual(raw);
  await importFile(page, Buffer.from([0xff, 0xfe]));
  const importError = page
    .getByRole("alert")
    .filter({ hasText: "Choose one UTF-8" });
  await expect(importError).toBeVisible();
  expect(projectId(page)).toBe(imported);
  expect(await exported(page)).toEqual(raw);
  // An import error must not disable following autosave.
  await page
    .getByRole("combobox", { name: "Save delay", exact: true })
    .selectOption("5");
  await editor(page).fill("newer after failed import");
  await expect(page.getByRole("status")).toHaveText("Saved", {
    timeout: 10_000,
  });
  await expect(importError).toHaveCount(0);
  await page.reload();
  await expect(editor(page)).toHaveValue("newer after failed import");
  expect(await exported(page)).toEqual(
    Buffer.from("\ufeffnewer after failed import"),
  );
  const returned = Buffer.from("\ufeff# Returned by external Agent\r\n");
  await importFile(page, returned);
  await expect(editor(page)).toHaveValue("# Returned by external Agent\n");
  expect(projectId(page)).not.toBe(imported);
  expect(await exported(page)).toEqual(returned);
  await page.goto(`/?project=${original}`);
  await expect(editor(page)).toHaveValue("# First manuscript");
  await editor(page).press("ControlOrMeta+End");
  await editor(page).pressSequentially(" local draft");
  await page
    .getByRole("button", { name: "New manuscript", exact: true })
    .click();
  await expect(editor(page)).toHaveValue("");
  await page.goto(`/?project=${original}`);
  await expect(editor(page)).toHaveValue("# First manuscript local draft");
});

test("MFP-AC03–05: held save and create acknowledgments retain newer typing, IME download settles, invalid reopen stays an error", async ({
  page,
}) => {
  await page.goto("/");
  await expect(editor(page)).toBeVisible();
  await page
    .getByRole("combobox", { name: "Autosave", exact: true })
    .selectOption("off");
  const original = projectId(page);
  await editor(page).fill("captured");
  let release!: () => void;
  let captured!: () => void;
  const seen = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/markdown-projects/*", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    captured();
    await held;
    await route.fulfill({ response });
  });
  await save(page);
  await seen;
  await editor(page).press("ControlOrMeta+End");
  await editor(page).pressSequentially(" newer");
  const identity = await editor(page).evaluate((element) => {
    (window as any).__markdownEditor = element;
    return (element as HTMLTextAreaElement).selectionStart;
  });
  release();
  await expect(page.getByRole("status")).toHaveText("Unsaved changes");
  await expect(editor(page)).toHaveValue("captured newer");
  expect(
    await editor(page).evaluate(
      (element, selection) =>
        element === (window as any).__markdownEditor &&
        (element as HTMLTextAreaElement).selectionStart === selection,
      identity,
    ),
  ).toBe(true);
  await page.unroute("**/api/v1/markdown-projects/*");
  await save(page);
  await expect(page.getByRole("status")).toHaveText("Saved");
  let releaseCreate!: () => void;
  let creating!: () => void;
  const createSeen = new Promise<void>((resolve) => {
    creating = resolve;
  });
  const createHeld = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  await page.route("**/api/v1/markdown-projects", async (route) => {
    const response = await route.fetch();
    creating();
    await createHeld;
    await route.fulfill({ response });
  });
  await page
    .getByRole("button", { name: "New manuscript", exact: true })
    .click();
  await createSeen;
  await editor(page).press("ControlOrMeta+End");
  await editor(page).pressSequentially(" while creating");
  releaseCreate();
  await expect(
    page.getByRole("alert").filter({ hasText: "Newer edits" }),
  ).toBeVisible();
  expect(projectId(page)).toBe(original);
  await expect(editor(page)).toHaveValue("captured newer while creating");
  await editor(page).dispatchEvent("compositionstart");
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download .md", exact: true })
    .dispatchEvent("click");
  await editor(page).fill("settled IME 中文");
  await editor(page).dispatchEvent("compositionend");
  expect(await readFile((await (await download).path())!)).toEqual(
    Buffer.from("settled IME 中文"),
  );
  await page.unrouteAll();
  await page.goto("/?project=not-a-project");
  await expect(
    page.getByRole("alert").filter({ hasText: "project is incomplete" }),
  ).toBeVisible();
  await expect(editor(page)).toHaveCount(0);
  expect(projectId(page)).toBe("not-a-project");
});

test("MFP-AC04: a real stale save retains local text and prevents project switching", async ({
  page,
}) => {
  await page.goto("/");
  await expect(editor(page)).toBeVisible();
  await page
    .getByRole("combobox", { name: "Autosave", exact: true })
    .selectOption("off");
  const id = projectId(page);
  const path = `/api/v1/markdown-projects/${id}`;
  const initial = await (await page.request.get(path)).json();
  const external = await page.request.post(path, {
    data: { text: "external version", revision: initial.revision },
  });
  expect(external.ok()).toBe(true);
  await editor(page).pressSequentially("local draft");
  await save(page);
  await expect(
    page.getByRole("alert").filter({ hasText: "saved manuscript changed" }),
  ).toBeVisible();
  await expect(editor(page)).toHaveValue("local draft");
  expect(await exported(page)).toEqual(Buffer.from("local draft"));
  await page
    .getByRole("button", { name: "New manuscript", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "New manuscript", exact: true }),
  ).toBeEnabled();
  expect(projectId(page)).toBe(id);
  await expect(editor(page)).toHaveValue("local draft");
  await editor(page).press("ControlOrMeta+z");
  await expect(editor(page)).not.toHaveValue("local draft");
  await editor(page).press("ControlOrMeta+Shift+z");
  await expect(editor(page)).toHaveValue("local draft");
  expect((await (await page.request.get(path)).json()).text).toBe(
    "external version",
  );
});
