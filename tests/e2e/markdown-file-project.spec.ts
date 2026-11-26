import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { zip, zipEntries } from "../fixtures/documents.mjs";

const editor = (page: Page) => page.locator("#markdown-editor");
const fileMenuButton = (page: Page) =>
  page.getByRole("button", { name: "File", exact: true });
const fileMenu = (page: Page) =>
  page.getByRole("menu", { name: "File", exact: true });
async function projectAction(page: Page, name: string) {
  await fileMenuButton(page).click();
  await fileMenu(page).getByRole("menuitem", { name, exact: true }).click();
}
async function openExportMenu(page: Page) {
  await projectAction(page, "Export");
  return page.getByRole("menu", { name: "Export", exact: true });
}
const save = (page: Page) => projectAction(page, "Save");
const projectId = (page: Page) =>
  new URL(page.url()).searchParams.get("project");
async function exported(page: Page) {
  const download = page.waitForEvent("download");
  const formats = await openExportMenu(page);
  await formats
    .getByRole("menuitem", { name: "Markdown", exact: true })
    .click();
  const file = await download;
  return readFile((await file.path())!);
}
async function importFile(page: Page, buffer: Buffer, name = "returned.md") {
  const selected = page.waitForEvent("filechooser");
  await projectAction(page, "Import file…");
  await (
    await selected
  ).setFiles({
    name,
    mimeType: name.endsWith(".zip") ? "application/zip" : "text/markdown",
    buffer,
  });
}

async function preferences(page: Page, mode: string, delay?: string) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "General", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Autosave", exact: true })
    .selectOption(mode);
  if (delay)
    await page
      .getByRole("combobox", { name: "Save delay", exact: true })
      .selectOption(delay);
  await page
    .getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
}
async function manuscript(page: Page) {
  await page
    .locator(".writing-view-switch")
    .getByRole("button", { name: "Manuscript", exact: true })
    .click();
}
async function source(page: Page) {
  await page.locator(".document-menu > summary").click();
  await page
    .locator(".document-menu")
    .getByRole("button", { name: "Edit Markdown source", exact: true })
    .click();
  return page
    .getByRole("dialog")
    .getByRole("textbox", { name: "Markdown source", exact: true });
}
async function closeSource(page: Page) {
  await page
    .getByRole("button", { name: "Close Markdown source", exact: true })
    .click();
}

test("@web-smoke MAW-AC01–02: restored chrome, panes, visual editing, local history and same-ID reopen", async ({
  page,
}) => {
  await page.goto("/");
  await expect(editor(page)).toBeFocused();
  const id = projectId(page);
  await preferences(page, "off");
  const raw = Buffer.from(
    "\ufeff# Title\r\n\r\nFirst **bold** paragraph.\r\n\r\n* untouched list\r\n* second item\r\n\r\nFinal paragraph.\r\n",
  );
  await importFile(page, raw);
  await expect(editor(page).locator("h1")).toHaveText("Title");
  const importedId = projectId(page);
  expect(importedId).not.toBe(id);
  expect(await exported(page)).toEqual(raw);
  await expect(page.locator(".workspace-ribbon")).toBeVisible();
  await expect(page.locator(".settings-trigger svg")).toBeVisible();
  await fileMenuButton(page).press("ArrowDown");
  await expect(fileMenu(page).getByRole("menuitem")).toHaveCount(4);
  await expect(
    fileMenu(page).getByRole("menuitem", { name: "New manuscript" }),
  ).toBeFocused();
  const menuBox = await fileMenu(page).boundingBox();
  expect(menuBox!.x).toBeGreaterThanOrEqual(0);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await page.keyboard.press("End");
  await expect(
    fileMenu(page).getByRole("menuitem", { name: "Export" }),
  ).toBeFocused();
  await page.keyboard.press("ArrowRight");
  const formats = page.getByRole("menu", { name: "Export", exact: true });
  await expect(
    formats.getByRole("menuitem", { name: "Markdown" }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    formats.getByRole("menuitem", { name: "Project ZIP" }),
  ).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(formats).toBeHidden();
  await expect(
    fileMenu(page).getByRole("menuitem", { name: "Export" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(fileMenuButton(page)).toBeFocused();
  await expect(fileMenu(page)).toBeHidden();
  await expect(
    page.getByRole("tab", { name: "Library", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "Comments", exact: true }),
  ).toHaveCount(1);
  const contents = page.getByRole("navigation", {
    name: "Contents",
    exact: true,
  });
  await expect(
    contents.getByRole("button", { name: "Title", exact: true }),
  ).toBeVisible();
  const originalEditor = await editor(page).evaluate((node) => {
    (window as any).__mawEditor = node;
    return true;
  });
  expect(originalEditor).toBe(true);
  const leftResize = page.getByRole("separator", {
    name: "Resize navigator",
    exact: true,
  });
  await leftResize.focus();
  await leftResize.press("End");
  await expect(leftResize).toHaveAttribute("aria-valuenow", "360");
  await page
    .getByRole("button", { name: "Close navigator", exact: true })
    .click();
  await expect(contents).toBeHidden();
  await page
    .getByRole("button", { name: "Open navigator", exact: true })
    .click();
  expect(
    await editor(page).evaluate((node) => node === (window as any).__mawEditor),
  ).toBe(true);
  await contents.getByRole("button", { name: "Title", exact: true }).click();
  await expect(editor(page)).toBeFocused();
  await editor(page).locator("p").last().click();
  await editor(page).press("End");
  await editor(page).pressSequentially(" Edited.");
  await fileMenuButton(page).press("ArrowDown");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  const expected = raw
    .toString()
    .replace("Final paragraph.", "Final paragraph. Edited.");
  expect((await savedFile(page)).text).toBe(expected);
  await editor(page).press("ControlOrMeta+z");
  await expect(editor(page)).not.toContainText("Edited.");
  await editor(page).press("ControlOrMeta+Shift+z");
  await expect(editor(page)).toContainText("Edited.");
  await page.reload();
  await expect(editor(page)).toContainText("Final paragraph. Edited.");
  expect(projectId(page)).toBe(importedId);
  expect(await exported(page)).toEqual(Buffer.from(expected));
  await expect(
    page.getByRole("separator", { name: "Resize navigator", exact: true }),
  ).toHaveAttribute("aria-valuenow", "360");
  await projectAction(page, "New manuscript");
  await expect(editor(page)).toHaveText("");
  await page.goto(`/?project=${importedId}`);
  await expect(editor(page)).toContainText("Final paragraph. Edited.");
  await page.goto("/");
  await expect(editor(page)).toContainText("Final paragraph. Edited.");
  expect(projectId(page)).toBe(importedId);
  await importFile(page, Buffer.from("unsupported"), "other.txt");
  await expect(
    page.getByRole("alert").filter({ hasText: "Choose one Markdown" }),
  ).toBeVisible();
  expect(projectId(page)).toBe(importedId);
  await page.setViewportSize({ width: 390, height: 700 });
  const narrowFormats = await openExportMenu(page);
  await expect(narrowFormats).toBeVisible();
  const narrowBox = (await narrowFormats.boundingBox())!;
  expect(narrowBox.x).toBeGreaterThanOrEqual(0);
  expect(narrowBox.x + narrowBox.width).toBeLessThanOrEqual(390);
  await page.getByRole("combobox", { name: "Language" }).click();
  await expect(fileMenu(page)).toBeHidden();
});

test("@web-smoke MAW-AC02: source fallback preserves unsupported Markdown bytes and source edits retain untouched mixed endings", async ({
  page,
}) => {
  await page.goto("/");
  await preferences(page, "off");
  const raw = Buffer.from(
    "\ufeff# 中文\r\n<!-- untouched -->\r[link](../source.md)\n",
  );
  await importFile(page, raw);
  await expect(page.locator(".source-fallback")).toBeVisible();
  expect(await exported(page)).toEqual(raw);
  const input = await source(page);
  await expect(input).toHaveValue(
    "# 中文\n<!-- untouched -->\n[link](../source.md)\n",
  );
  await closeSource(page);
  await save(page);
  expect(await exported(page)).toEqual(raw);
  await page.reload();
  const edit = page.locator(".source-fallback textarea");
  await expect(edit).toHaveValue(
    "# 中文\n<!-- untouched -->\n[link](../source.md)\n",
  );
  expect(await exported(page)).toEqual(raw);
  await edit.fill("# 中文\n<!-- untouched -->\n[link](../changed.md)\n");
  await save(page);
  expect(await exported(page)).toEqual(
    Buffer.from(raw.toString().replace("source.md", "changed.md")),
  );
  await importFile(page, Buffer.from([0xff, 0xfe]));
  await expect(
    page.getByRole("alert").filter({ hasText: "Choose one UTF-8" }),
  ).toBeVisible();
  expect(await exported(page)).toEqual(
    Buffer.from(raw.toString().replace("source.md", "changed.md")),
  );
});

test("MAW-AC02: structural visual edits do not merge paragraphs across original single-newline boundaries", async ({
  page,
}) => {
  await page.goto("/");
  await importFile(page, Buffer.from("# Title\nbody\n"));
  await editor(page).locator("h1").click();
  await editor(page).press("End");
  await editor(page).press("Enter");
  await editor(page).pressSequentially("Inserted paragraph");
  await save(page);
  await page.reload();
  await expect(editor(page).locator("p")).toHaveCount(2);
  await expect(editor(page).locator("p").nth(0)).toHaveText(
    "Inserted paragraph",
  );
  await expect(editor(page).locator("p").nth(1)).toHaveText("body");
});

test("MFP-AC03–05: held save and create acknowledgments retain newer typing, IME download settles, invalid reopen stays an error", async ({
  page,
}) => {
  await page.goto("/");
  await expect(editor(page)).toBeVisible();
  await preferences(page, "off");
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
    return document.getSelection()?.anchorOffset;
  });
  release();
  await expect(page.getByTestId("save-status")).toHaveText("Unsaved changes");
  await expect(editor(page)).toHaveText("captured newer");
  expect(
    await editor(page).evaluate(
      (element, selection) =>
        element === (window as any).__markdownEditor &&
        document.getSelection()?.anchorOffset === selection,
      identity,
    ),
  ).toBe(true);
  await page.unroute("**/api/v1/markdown-projects/*");
  await save(page);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
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
  await projectAction(page, "New manuscript");
  await createSeen;
  await editor(page).press("ControlOrMeta+End");
  await editor(page).pressSequentially(" while creating");
  releaseCreate();
  await expect(
    page.getByRole("alert").filter({ hasText: "Newer edits" }),
  ).toBeVisible();
  expect(projectId(page)).toBe(original);
  await expect(editor(page)).toHaveText("captured newer while creating");
  const formats = await openExportMenu(page);
  await editor(page).dispatchEvent("compositionstart");
  const download = page.waitForEvent("download");
  await formats
    .getByRole("menuitem", { name: "Markdown", exact: true })
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
  await preferences(page, "off");
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
    page.getByRole("alert").filter({ hasText: "saved document changed" }),
  ).toBeVisible();
  await expect(editor(page)).toHaveText("local draft");
  expect(await exported(page)).toEqual(Buffer.from("local draft"));
  await projectAction(page, "New manuscript");
  await fileMenuButton(page).click();
  await expect(
    fileMenu(page).getByRole("menuitem", {
      name: "New manuscript",
      exact: true,
    }),
  ).toBeEnabled();
  expect(projectId(page)).toBe(id);
  await expect(editor(page)).toHaveText("local draft");
  await editor(page).press("ControlOrMeta+z");
  await expect(editor(page)).not.toHaveText("local draft");
  await editor(page).press("ControlOrMeta+Shift+z");
  await expect(editor(page)).toHaveText("local draft");
  expect((await (await page.request.get(path)).json()).text).toBe(
    "external version",
  );
});

async function mockWriting(
  page: Page,
  reply: (kind: string) => Promise<string> | string,
) {
  const submitted: any[] = [];
  await page.route("**/api/v1/ai/configuration", (route) =>
    route.fulfill({
      json: { configuration: { fingerprint: "browser-fixture" } },
    }),
  );
  await page.route("**/api/v1/markdown-projects/*/writing", async (route) => {
    const body = route.request().postDataJSON();
    submitted.push(body);
    try {
      await route.fulfill({
        json: { actionId: body.actionId, text: await reply(body.kind) },
      });
    } catch {
      /* A project switch or navigation can close the requesting page. */
    }
  });
  return submitted;
}
async function beginWriting(page: Page) {
  await page
    .getByRole("textbox", { name: "Writing request", exact: true })
    .fill("Write a bilingual story");
  await page
    .getByRole("button", { name: "Generate Outline", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Editable outline", exact: true }),
  ).toHaveText("OutlineOpening");
}
async function savedFile(page: Page) {
  return page.evaluate(async () => {
    const id = new URL(location.href).searchParams.get("project");
    return (await fetch(`/api/v1/markdown-projects/${id}`)).json();
  });
}

test("@web-smoke WFW-AC03: generate directly into the outline and review drafts separately", async ({
  page,
}) => {
  const submitted = await mockWriting(page, (kind) =>
    kind === "outline"
      ? "# Outline\n\n- Opening"
      : "# Draft\n\nGenerated 中文.",
  );
  await page.goto("/");
  await editor(page).fill("Original saved manuscript");
  await save(page);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  await preferences(page, "off");
  await beginWriting(page);
  await expect(
    page.getByRole("button", { name: "Outline preview", exact: true }),
  ).toHaveCount(0);
  expect((await outlineFile(page)).text).toBe("# Outline\n\n- Opening");
  await manuscript(page);
  await outlineTab(page);
  const outline = page.getByRole("textbox", {
    name: "Editable outline",
    exact: true,
  });
  await outline.locator("li").click();
  await outline.press("End");
  await outline.pressSequentially(" user ending");
  await page
    .getByRole("button", { name: "Write Draft from Outline", exact: true })
    .click();
  const preview = page.getByRole("region", {
    name: "Draft preview",
    exact: true,
    includeHidden: true,
  });
  await expect(
    preview.getByRole("heading", { name: "Draft", exact: true }),
  ).toBeVisible();
  await expect(preview.locator("script")).toHaveCount(0);
  expect(submitted[1].outline).toContain("Opening user ending");
  expect((await savedFile(page)).text).toBe("Original saved manuscript");
  await manuscript(page);
  await expect(editor(page)).toHaveText("Original saved manuscript");
  await page
    .getByRole("button", { name: "Draft preview", exact: true })
    .click();
  await preview.getByRole("button", { name: "Close", exact: true }).click();
  expect((await savedFile(page)).text).toBe("Original saved manuscript");
  await page
    .getByRole("button", { name: "Write Draft from Outline", exact: true })
    .click();
  await preview.getByRole("button", { name: "Use Draft", exact: true }).click();
  await expect(editor(page)).toHaveText(/^Draft/);
  expect((await savedFile(page)).text).toMatch(/^# Draft/);
  await page.reload();
  await expect(editor(page)).toHaveText(/^Draft/);
  await expect(
    page.getByRole("region", { name: "Draft preview", exact: true }),
  ).toHaveCount(0);
  await outlineTab(page);
  await expect(
    page.getByRole("textbox", { name: "Writing request", exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("textbox", { name: "Editable outline", exact: true }),
  ).toContainText("Opening user ending");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await page
    .getByText("Advanced: direct API compatibility", { exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Default models", exact: true }),
  ).toBeVisible();
});

test("WFW-AC04: repeated clicks dispatch once, typing stays writable, conflicts retain both texts and switched projects ignore late drafts", async ({
  page,
}) => {
  let release!: (value: string) => void;
  let held = new Promise<string>((resolve) => {
    release = resolve;
  });
  const submitted = await mockWriting(page, (kind) =>
    kind === "outline" ? "# Outline\n\n- Opening" : held,
  );
  await page.goto("/");
  await preferences(page, "off");
  await editor(page).fill("Initial manuscript");
  await save(page);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  await beginWriting(page);
  await manuscript(page);
  const generate = page.getByRole("button", {
    name: "Write Draft from Outline",
    exact: true,
  });
  await generate.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect.poll(() => submitted.length).toBe(2);
  await expect(editor(page)).toBeEditable();
  await editor(page).fill("Newer local writing during generation");
  release("# Unapplied draft\n\nGenerated text");
  const preview = page.getByRole("region", {
    name: "Draft preview",
    exact: true,
    includeHidden: true,
  });
  await expect(preview).toContainText(
    "The manuscript or outline changed since generation began.",
  );
  await expect(
    preview.getByRole("button", { name: "Use Draft", exact: true }),
  ).toBeDisabled();
  await expect(editor(page)).toHaveText(
    "Newer local writing during generation",
  );
  expect((await savedFile(page)).text).toBe("Initial manuscript");
  await expect(preview).toContainText("Unapplied draft");
  held = new Promise<string>((resolve) => {
    release = resolve;
  });
  await generate.click();
  await expect.poll(() => submitted.length).toBe(3);
  await projectAction(page, "New manuscript");
  await expect(editor(page)).toHaveText("");
  release("# Late draft from previous project");
  await expect(
    page.getByRole("region", { name: "Draft preview", exact: true }),
  ).toHaveCount(0);
  await expect(editor(page)).toHaveText("");
});

test("WFW-AC03–04: in-flight adoption preserves newer input and pauses autosave until an explicit save", async ({
  page,
}) => {
  await mockWriting(page, (kind) =>
    kind === "outline"
      ? "# Outline\n\n- Opening"
      : "# Adopted draft\n\nSaved generation",
  );
  await page.goto("/");
  await editor(page).fill("Initial manuscript");
  await save(page);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  await preferences(page, "after_delay");
  await preferences(page, "after_delay", "5");
  await beginWriting(page);
  await manuscript(page);
  await page
    .getByRole("button", { name: "Write Draft from Outline", exact: true })
    .click();
  const preview = page.getByRole("region", {
    name: "Draft preview",
    exact: true,
    includeHidden: true,
  });
  await expect(preview).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let saved!: () => void;
  const arrived = new Promise<void>((resolve) => {
    saved = resolve;
  });
  await page.route(/\/api\/v1\/markdown-projects\/[^/]+$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    saved();
    await gate;
    await route.fulfill({ response });
  });
  await preview.getByRole("button", { name: "Use Draft", exact: true }).click();
  await arrived;
  await manuscript(page);
  await editor(page).fill("Newer local keystrokes while adopting");
  release();
  await expect(preview).toHaveCount(0);
  await expect(editor(page)).toHaveText(
    "Newer local keystrokes while adopting",
  );
  await expect(
    page.locator(".manuscript-main > .markdown-conflict"),
  ).toContainText("autosave is paused");
  await page.waitForTimeout(5500);
  expect((await savedFile(page)).text).toBe(
    "# Adopted draft\n\nSaved generation",
  );
  await save(page);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  expect((await savedFile(page)).text).toBe(
    "Newer local keystrokes while adopting",
  );
});

test("WFW-AC04: model errors use the selected locale and retain the manuscript and outline", async ({
  page,
}) => {
  await mockWriting(page, () => "# Outline\n\n- Opening");
  await page.goto("/");
  await editor(page).fill("Keep my manuscript");
  await beginWriting(page);
  await manuscript(page);
  await page.route("**/api/v1/markdown-projects/*/writing", (route) =>
    route.fulfill({ status: 422, json: { code: "PROVIDER_SERVER_FAILED" } }),
  );
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh-CN");
  await page
    .getByRole("button", { name: "根据大纲写草稿", exact: true })
    .click();
  await expect(
    page.getByText("上游服务返回服务器错误。请稍后重试。", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("#markdown-editor")).toHaveText(
    "Keep my manuscript",
  );
  await expect(page.locator("#markdown-outline-editor")).toHaveText(
    "OutlineOpening",
  );
});

test("WFW-AC03: adoption waits for an in-flight save of exactly the captured text and keeps its valid revision", async ({
  page,
}) => {
  await mockWriting(page, (kind) =>
    kind === "outline"
      ? "# Outline\n\n- Opening"
      : "# Draft after pending save",
  );
  await page.goto("/");
  await preferences(page, "off");
  await editor(page).fill("Saved baseline");
  await save(page);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  await beginWriting(page);
  await manuscript(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let saved!: () => void;
  const arrived = new Promise<void>((resolve) => {
    saved = resolve;
  });
  let writes = 0;
  await page.route(/\/api\/v1\/markdown-projects\/[^/]+$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    writes++;
    const response = await route.fetch();
    if (writes === 1) {
      saved();
      await gate;
    }
    await route.fulfill({ response });
  });
  await editor(page).fill("Captured buffered text");
  await save(page);
  await arrived;
  await page
    .getByRole("button", { name: "Write Draft from Outline", exact: true })
    .click();
  const preview = page.getByRole("region", {
    name: "Draft preview",
    exact: true,
    includeHidden: true,
  });
  await expect(preview).toBeVisible();
  await preview.getByRole("button", { name: "Use Draft", exact: true }).click();
  expect(writes).toBe(1);
  release();
  await expect(editor(page)).toHaveText("Draft after pending save");
  expect(writes).toBe(2);
  expect((await savedFile(page)).text).toBe("# Draft after pending save");
});

async function packageFrom(page: Page) {
  const downloaded = page.waitForEvent("download");
  const formats = await openExportMenu(page);
  await formats.getByRole("menuitem", { name: /^Project ZIP/ }).click();
  return zipEntries(await readFile((await (await downloaded).path())!));
}
async function importPackage(page: Page, bytes: Buffer) {
  await importFile(page, bytes, "returned.zip");
}

test("@web-smoke WFW-AC05–06: byte-preserving package review, guarded apply and independent returned project", async ({
  page,
}) => {
  await page.goto("/");
  await expect(editor(page)).toBeVisible();
  await preferences(page, "off");
  const raw = Buffer.from("\ufeff# Original 中文\r\nKeep\rline\n");
  await importFile(page, raw);
  await expect(editor(page)).toContainText("Original 中文");
  const id = projectId(page);
  const entries = await packageFrom(page);
  await expect(
    page.getByText("Project ZIP ready for your agent.", { exact: false }),
  ).toBeVisible();
  expect(entries["project/manuscript.md"]).toEqual(raw);
  expect(JSON.parse(entries["project/project.json"]).projectId).toBe(id);
  const returned = "\ufeff# Returned 中文\r\nAdded line\r\n";
  entries["project/manuscript.md"] = Buffer.from(returned);
  await importPackage(page, zip(entries));
  const preview = page.getByRole("region", {
    name: "Review imported changes",
    exact: true,
    includeHidden: true,
  });
  await expect(preview).toContainText("Original 中文");
  await expect(preview).toContainText("Returned 中文");
  expect((await savedFile(page)).text).toBe(raw.toString());
  await preview
    .getByRole("button", { name: "Apply Changes", exact: true })
    .click();
  await expect(preview).toHaveCount(0);
  expect(projectId(page)).toBe(id);
  expect(await exported(page)).toEqual(Buffer.from(returned));
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const manuscript = document.getElementById("markdown-editor");
      if (!manuscript) return;
      manuscript.dataset.focusedOnMount = String(
        document.activeElement === manuscript,
      );
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  await page.reload();
  await expect(editor(page)).toContainText("Returned 中文");
  expect(await editor(page).getAttribute("data-focused-on-mount")).toBe("true");
  // The exported base is now stale; the unsaved draft must survive a separate save.
  await editor(page).fill("Unsaved current draft");
  await importPackage(page, zip(entries));
  await expect(preview).toContainText("changed since export");
  await expect(
    preview.getByRole("button", { name: "Apply Changes", exact: true }),
  ).toBeDisabled();
  await preview
    .getByRole("button", {
      name: "Save Returned Text as New Project",
      exact: true,
    })
    .click();
  const separate = preview.getByRole("link", {
    name: "Open Saved Project in New Tab",
    exact: true,
  });
  await expect(separate).toBeVisible();
  const forkId = new URL(
    (await separate.getAttribute("href"))!,
  ).searchParams.get("project");
  expect(forkId).not.toBe(id);
  expect(
    (
      await (
        await page.request.get(`/api/v1/markdown-projects/${forkId}`)
      ).json()
    ).text,
  ).toBe(returned);
  await expect(editor(page)).toHaveText("Unsaved current draft");
  expect((await savedFile(page)).text).toBe(returned);
  await preview
    .getByRole("button", { name: "Keep Current Draft", exact: true })
    .click();
  await importPackage(page, Buffer.from("bad ZIP"));
  await expect(
    page.getByRole("alert").filter({ hasText: "valid project ZIP" }),
  ).toBeVisible();
  await expect(editor(page)).toHaveText("Unsaved current draft");
  const wrong = {
    ...entries,
    "project/project.json": JSON.stringify({
      ...JSON.parse(entries["project/project.json"]),
      projectId: crypto.randomUUID(),
    }),
  };
  await importPackage(page, zip(wrong));
  await expect(
    page.getByRole("alert").filter({ hasText: "another project" }),
  ).toBeVisible();
  await expect(editor(page)).toHaveText("Unsaved current draft");
});

test("WFW-AC06: local and stored changes after preview cannot overwrite, unchanged ZIP has no apply", async ({
  page,
}) => {
  await page.goto("/");
  await expect(editor(page)).toBeVisible();
  await preferences(page, "off");
  const entries = await packageFrom(page);
  const preview = page.getByRole("region", {
    name: "Review imported changes",
    exact: true,
    includeHidden: true,
  });
  await importPackage(page, zip(entries));
  await expect(preview).toContainText("no changes to apply");
  await expect(
    preview.getByRole("button", { name: "Apply Changes", exact: true }),
  ).toHaveCount(0);
  entries["project/manuscript.md"] = Buffer.from("Returned candidate");
  await importPackage(page, zip(entries));
  await manuscript(page);
  await editor(page).fill("Local intervening draft");
  await page
    .getByRole("button", { name: "Review imported changes", exact: true })
    .click();
  await expect(
    preview.getByRole("button", { name: "Apply Changes", exact: true }),
  ).toBeDisabled();
  await save(page);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  const fresh = await packageFrom(page);
  fresh["project/manuscript.md"] = Buffer.from("Fresh returned candidate");
  await importPackage(page, zip(fresh));
  const stored = await savedFile(page);
  await page.request.post(`/api/v1/markdown-projects/${projectId(page)}`, {
    data: { revision: stored.revision, text: "External intervening write" },
  });
  await preview
    .getByRole("button", { name: "Apply Changes", exact: true })
    .click();
  await expect(preview).toContainText("changed since export");
  await expect(preview).toContainText("Fresh returned candidate");
  await expect(editor(page)).toHaveText("Local intervening draft");
  expect((await savedFile(page)).text).toBe("External intervening write");
});

test("WFW-AC05–06: save-and-download settles IME, and held application keeps newer input", async ({
  page,
}) => {
  await page.goto("/");
  await expect(editor(page)).toBeVisible();
  await preferences(page, "off");
  await editor(page).fill("Before composition");
  const formats = await openExportMenu(page);
  await editor(page).dispatchEvent("compositionstart");
  const download = page.waitForEvent("download");
  await formats
    .getByRole("menuitem", { name: "Project ZIP (save first)", exact: true })
    .dispatchEvent("click");
  await editor(page).fill("Settled 中文");
  await editor(page).dispatchEvent("compositionend");
  const entries = zipEntries(await readFile((await (await download).path())!));
  expect(entries["project/manuscript.md"].toString()).toBe("Settled 中文");
  expect(JSON.parse(entries["exchange.json"]).baseRevision).toBe(
    (await savedFile(page)).revision,
  );
  entries["project/manuscript.md"] = Buffer.from("Accepted returned draft");
  await importPackage(page, zip(entries));
  const preview = page.getByRole("region", {
    name: "Review imported changes",
    exact: true,
    includeHidden: true,
  });
  await expect(preview).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived!: () => void;
  const saved = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await page.route(/\/api\/v1\/markdown-projects\/[^/]+$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    arrived();
    await held;
    await route.fulfill({ response });
  });
  await preview
    .getByRole("button", { name: "Apply Changes", exact: true })
    .click();
  await saved;
  await manuscript(page);
  await editor(page).fill("Newer input during acceptance");
  release();
  await expect(preview).toHaveCount(1);
  await page
    .getByRole("button", { name: "Review imported changes", exact: true })
    .click();
  await expect(preview).toContainText("Accepted returned draft");
  await expect(
    preview.getByRole("button", { name: "Apply Changes", exact: true }),
  ).toBeDisabled();
  await expect(editor(page)).toHaveText("Newer input during acceptance");
  await expect(
    page.locator(".manuscript-main > .markdown-conflict"),
  ).toContainText("autosave is paused");
  expect((await savedFile(page)).text).toBe("Accepted returned draft");
});

test("MAW-AC02: unsupported visual edits preserve the current manuscript", async ({
  page,
}) => {
  await page.goto("/");
  const manuscriptEditor = editor(page);
  await manuscriptEditor.fill("Keep this paragraph");
  await manuscriptEditor.press("ControlOrMeta+a");
  await manuscriptEditor.evaluate((element) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "List item\n\nSecond paragraph");
    clipboardData.setData(
      "text/html",
      "<ul><li><p>List item</p><p>Second paragraph</p></li></ul>",
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData, bubbles: true }),
    );
  });
  await expect(page.getByRole("alert")).toContainText(
    "This format needs Markdown source",
  );
  await expect(manuscriptEditor).toHaveText("Keep this paragraph");
  await save(page);
  expect((await savedFile(page)).text).toBe("Keep this paragraph");
});

test("MAW-AC02: source projection bounds and adjacency preserve bytes without unsafe visual projection", async () => {
  const { projectSource, sourceFromEditor } =
    await import("../../packages/editor-ui/src/markdown/source-projection");
  const raw = "\ufeff# Title\r\nbody\r\n\r\n* unchanged\r\n* list\r\n";
  const projected = projectSource(raw)!;
  expect(sourceFromEditor(projected, projected.document)).toBe(raw);
  expect(
    sourceFromEditor(projected, {
      type: "doc",
      content: [{ type: "paragraph" }],
    }),
  ).toBe("");
  const document = structuredClone(projected.document);
  document.content!.splice(1, 0, {
    type: "paragraph",
    attrs: { blockId: crypto.randomUUID() },
    content: [{ type: "text", text: "Inserted" }],
  });
  expect(sourceFromEditor(projected, document)).toBe(
    "\ufeff# Title\r\n\r\nInserted\r\n\r\nbody\r\n\r\n* unchanged\r\n* list\r\n",
  );
  expect(projectSource("```js\ncode\n```\n")).toBeNull();
  expect(projectSource("x".repeat(1200000))).toBeNull();
});

async function outlineFile(page: Page) {
  return (
    await page.request.get(
      `/api/v1/markdown-projects/${projectId(page)}/documents/outline`,
    )
  ).json();
}
const outlineEditor = (page: Page) => page.locator("#markdown-outline-editor");
async function outlineTab(page: Page) {
  await page
    .locator(".writing-view-switch")
    .getByRole("button", { name: "Outline", exact: true })
    .click();
}

test("@web-smoke MOR-AC01: optional outline, exact bytes, independent saves, reopen and empty outline", async ({
  page,
}) => {
  await page.goto("/");
  await expect(editor(page)).toBeVisible();
  await preferences(page, "off");
  expect((await outlineFile(page)).revision).toBeNull();
  await editor(page).fill("Manuscript stays independent");
  await save(page);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  const manuscriptSaved = await savedFile(page);
  const raw = "\ufeff# Saved outline 中文\r\n\r\n* Untouched\r\n";
  const response = await page.request.post(
    `/api/v1/markdown-projects/${projectId(page)}/documents/outline`,
    { data: { revision: null, text: raw } },
  );
  expect(response.ok()).toBe(true);
  await page.reload();
  await outlineTab(page);
  await expect(outlineEditor(page)).toContainText("Saved outline 中文");
  expect(await exported(page)).toEqual(Buffer.from(raw));
  const saved = await outlineFile(page);
  expect(saved.revision).toMatch(/^[a-f0-9]{64}$/);
  await outlineEditor(page).click();
  await outlineEditor(page).press("ControlOrMeta+a");
  await outlineEditor(page).press("Backspace");
  await outlineEditor(page).press("ControlOrMeta+s");
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  const empty = await outlineFile(page);
  expect(empty.text).toBe("");
  expect(empty.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(empty.revision).not.toBe(saved.revision);
  expect(await savedFile(page)).toEqual(manuscriptSaved);
  await page.reload();
  await outlineTab(page);
  await expect(outlineEditor(page)).toHaveText("");
  expect((await outlineFile(page)).revision).toBe(empty.revision);
  await manuscript(page);
  expect(await exported(page)).toEqual(Buffer.from(manuscriptSaved.text));
});

test("MOR-AC02: held outline save, active manuscript save and settled IME preserve independent buffers", async ({
  page,
}) => {
  await page.goto("/");
  await expect(editor(page)).toBeVisible();
  await preferences(page, "off");
  await outlineTab(page);
  await outlineEditor(page).fill("Captured outline");
  let release!: () => void;
  let arrived!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await page.route(
    "**/api/v1/markdown-projects/*/documents/outline",
    async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      arrived();
      await held;
      await route.fulfill({ response });
    },
  );
  await save(page);
  await seen;
  await outlineEditor(page).dispatchEvent("compositionstart");
  await outlineEditor(page).fill("Captured outline 中文 newer");
  await outlineEditor(page).dispatchEvent("compositionend");
  await manuscript(page);
  await editor(page).fill("Independent active manuscript");
  await save(page);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  expect((await savedFile(page)).text).toBe("Independent active manuscript");
  expect((await outlineFile(page)).text).toBe("Captured outline");
  await editor(page).click();
  release();
  await expect(editor(page)).toBeFocused();
  await outlineTab(page);
  await expect(page.getByTestId("save-status")).toHaveText("Unsaved changes");
  await expect(outlineEditor(page)).toHaveText("Captured outline 中文 newer");
  await fileMenuButton(page).click();
  await outlineEditor(page).dispatchEvent("compositionstart");
  await fileMenu(page)
    .getByRole("menuitem", { name: "Save", exact: true })
    .dispatchEvent("click");
  await outlineEditor(page).fill("Settled final 中文");
  await outlineEditor(page).dispatchEvent("compositionend");
  await expect
    .poll(async () => (await outlineFile(page)).text)
    .toBe("Settled final 中文");
  expect((await savedFile(page)).text).toBe("Independent active manuscript");
});

test("MOR-AC02: delayed autosave retains its document across a tab switch", async ({
  page,
}) => {
  await page.goto("/");
  await expect(editor(page)).toBeVisible();
  await preferences(page, "after_delay", "5");
  await outlineTab(page);
  await outlineEditor(page).fill("Delayed outline");
  await manuscript(page);
  await editor(page).fill("Independent delayed manuscript");
  await expect
    .poll(async () => (await outlineFile(page)).text, { timeout: 10000 })
    .toBe("Delayed outline");
  await expect
    .poll(async () => (await savedFile(page)).text, { timeout: 10000 })
    .toBe("Independent delayed manuscript");
});

test("MOR-AC03: blank brief, failed outline save prevents dispatch, stale draft remains for review", async ({
  page,
}) => {
  let release!: (text: string) => void;
  const held = new Promise<string>((resolve) => {
    release = resolve;
  });
  const submitted = await mockWriting(page, () => held);
  await page.goto("/");
  await expect(editor(page)).toBeVisible();
  await preferences(page, "off");
  await outlineTab(page);
  await outlineEditor(page).fill("# Saved outline\n\nUser plan");
  await page.route(
    "**/api/v1/markdown-projects/*/documents/outline",
    (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 409, json: { code: "MARKDOWN_CONFLICT" } })
        : route.continue(),
  );
  await page
    .getByRole("button", { name: "Write Draft from Outline", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(submitted).toHaveLength(0);
  await expect(outlineEditor(page)).toContainText("User plan");
  await page.unroute("**/api/v1/markdown-projects/*/documents/outline");
  await page
    .getByRole("button", { name: "Write Draft from Outline", exact: true })
    .click();
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0].brief).toBe("");
  expect(submitted[0].outlineRevision).toBe((await outlineFile(page)).revision);
  await outlineEditor(page).fill("Newer outline while generating");
  release("# Earlier draft\n\nKeep for review");
  const preview = page.getByRole("region", {
    name: "Draft preview",
    exact: true,
  });
  await expect(preview).toContainText("changed since generation began");
  await expect(
    preview.getByRole("button", { name: "Use Draft", exact: true }),
  ).toBeDisabled();
  await expect(preview).toContainText("Keep for review");
  expect((await savedFile(page)).text).toBe("");
  await outlineTab(page);
  await expect(outlineEditor(page)).toHaveText(
    "Newer outline while generating",
  );
});

test("MOR-AC03: an outline saved in another browser atomically rejects draft adoption and retains preview", async ({
  page,
}) => {
  await mockWriting(page, () => "# Retained draft\n\nEarlier saved outline");
  await page.goto("/");
  await expect(editor(page)).toBeVisible();
  await preferences(page, "off");
  await outlineTab(page);
  await outlineEditor(page).fill("Original outline");
  await page
    .getByRole("button", { name: "Write Draft from Outline", exact: true })
    .click();
  const preview = page.getByRole("region", {
    name: "Draft preview",
    exact: true,
  });
  await expect(preview).toBeVisible();
  const outline = await outlineFile(page);
  expect(
    (
      await page.request.post(
        `/api/v1/markdown-projects/${projectId(page)}/documents/outline`,
        {
          data: {
            revision: outline.revision,
            text: "Outline changed in another browser",
          },
        },
      )
    ).ok(),
  ).toBe(true);
  await preview.getByRole("button", { name: "Use Draft", exact: true }).click();
  await expect(preview).toContainText("changed since generation began");
  await expect(
    preview.getByRole("button", { name: "Use Draft", exact: true }),
  ).toBeDisabled();
  await expect(preview).toContainText("Retained draft");
  expect((await savedFile(page)).text).toBe("");
  expect((await outlineFile(page)).text).toBe(
    "Outline changed in another browser",
  );
});

test("MOR-AC01: unavailable outline retains independent manuscript access without becoming an absent outline", async ({
  page,
}) => {
  await page.goto("/");
  await expect(editor(page)).toBeVisible();
  await preferences(page, "off");
  await editor(page).fill("Readable manuscript");
  await save(page);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  await page.route("**/api/v1/markdown-projects/*/documents/outline", (route) =>
    route.fulfill({ status: 422, json: { code: "MARKDOWN_TEXT_INVALID" } }),
  );
  await page.reload();
  await expect(editor(page)).toHaveText("Readable manuscript");
  await editor(page).fill("Manuscript remains writable");
  await save(page);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  expect(await exported(page)).toEqual(
    Buffer.from("Manuscript remains writable"),
  );
  await outlineTab(page);
  await expect(outlineEditor(page)).toHaveCount(0);
  await expect(page.locator(".outline-surface")).toContainText(
    "Could not open the saved outline",
  );
  await fileMenuButton(page).click();
  await expect(
    fileMenu(page).getByRole("menuitem", { name: "Save", exact: true }),
  ).toBeDisabled();
});

test("MOR-AC03: regeneration confirms replacement and retains a result if the outline changed", async ({
  page,
}) => {
  let release!: (text: string) => void;
  const held = new Promise<string>((resolve) => {
    release = resolve;
  });
  const submitted = await mockWriting(page, () => held);
  await page.goto("/");
  await expect(editor(page)).toBeVisible();
  await preferences(page, "off");
  await outlineTab(page);
  await outlineEditor(page).fill("Keep this accepted outline");
  await save(page);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  await page
    .getByRole("textbox", { name: "Writing request", exact: true })
    .fill("Revise the outline");
  const regenerate = page.getByRole("button", {
    name: "Regenerate Outline",
    exact: true,
  });
  page.once("dialog", (dialog) => dialog.dismiss());
  await regenerate.click();
  await expect(regenerate).toBeEnabled();
  expect(submitted).toHaveLength(0);
  page.once("dialog", (dialog) => dialog.accept());
  await regenerate.click();
  await expect.poll(() => submitted.length).toBe(1);
  await outlineEditor(page).fill("Newer local outline");
  release("# Proposed earlier outline");
  const retained = page.getByText("Generated outline kept for reference", {
    exact: true,
  });
  await retained.click();
  await expect(page.locator(".markdown-retained-outline pre")).toHaveText(
    "# Proposed earlier outline",
  );
  expect((await outlineFile(page)).text).toBe("Keep this accepted outline");
  await expect(outlineEditor(page)).toHaveText("Newer local outline");
});

async function selectBlocks(
  target: ReturnType<typeof editor>,
  selector: string,
  first: number,
  last: number,
) {
  await target.evaluate(
    (node, { selector, first, last }) => {
      const blocks = node.querySelectorAll(selector);
      const range = document.createRange();
      range.setStart(blocks[first]!, 0);
      range.setEnd(blocks[last]!, blocks[last]!.childNodes.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      (node as HTMLElement).focus();
      document.dispatchEvent(new Event("selectionchange"));
    },
    { selector, first, last },
  );
}
async function annotationsFile(page: Page, kind = "outline") {
  return (
    await page.request.get(
      `/api/v1/markdown-projects/${projectId(page)}/documents/${kind}/annotations`,
    )
  ).json();
}

test("@web-smoke MOR-AC04: shared block locks survive reload, guard source and visual edits, preserve unlocked list siblings", async ({
  page,
}) => {
  await page.goto("/");
  await preferences(page, "off");
  await editor(page).fill("Protected manuscript paragraph");
  await save(page);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  await editor(page).locator("p").click();
  await page
    .locator(".markdown-editor-shell")
    .filter({ has: editor(page) })
    .getByRole("button", { name: "Lock selected blocks", exact: true })
    .click();
  await expect
    .poll(async () => (await annotationsFile(page, "manuscript")).locks.length)
    .toBe(1);
  const raw =
    "\ufeff# Plan 中文\r\n\r\n* first **locked**\r\n* second locked\r\n* editable sibling\r\n";
  await page.request.post(
    `/api/v1/markdown-projects/${projectId(page)}/documents/outline`,
    { data: { revision: null, text: raw } },
  );
  await page.reload();
  await outlineTab(page);
  await expect(outlineEditor(page)).toContainText("Plan 中文");
  await selectBlocks(outlineEditor(page), "h1, li", 0, 2);
  await page
    .locator(".outline-surface")
    .getByRole("button", { name: "Lock selected blocks", exact: true })
    .click();
  await expect
    .poll(async () => (await annotationsFile(page)).locks[0]?.anchors.length)
    .toBe(3);
  await page.reload();
  await outlineTab(page);
  await expect(
    page.locator(".outline-surface .markdown-lock-marker"),
  ).toHaveCount(3);
  await expect
    .poll(async () =>
      page
        .locator(".outline-surface .markdown-lock-marker")
        .evaluateAll(
          (nodes) =>
            new Set(nodes.map((node) => (node as HTMLElement).style.top)).size,
        ),
    )
    .toBe(3);
  await outlineEditor(page).locator("li").last().click();
  await outlineEditor(page).press("End");
  await outlineEditor(page).pressSequentially(" edited");
  await save(page);
  await expect
    .poll(async () => (await outlineFile(page)).text)
    .toBe(raw.replace("* editable sibling", "- editable sibling edited"));
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  await selectBlocks(outlineEditor(page), "li p", 0, 0);
  await page.keyboard.type(" forbidden");
  await expect(outlineEditor(page)).not.toContainText("forbidden");
  const input = await source(page);
  await input.fill("Deleted protected source");
  await expect(input).not.toHaveValue("Deleted protected source");
  await closeSource(page);
  await manuscript(page);
  await expect(
    page.locator(".document-layout .markdown-lock-marker"),
  ).toHaveCount(1);
  await editor(page).fill("forbidden manuscript rewrite");
  await expect(editor(page)).toHaveText("Protected manuscript paragraph");
});

test("@web-smoke MOR-AC04–05: a generated outline with unsupported syntax is editable, lockable, and commentable", async ({
  page,
}) => {
  const raw = "\ufeff# 大纲\r\n\r\n---\r\n\r\n- 中文目标\r\n- Unlocked\r\n";
  await mockWriting(page, () => raw);
  await page.goto("/");
  await preferences(page, "off");
  await page.getByRole("textbox", { name: "Writing request" }).fill("Write");
  await page
    .getByRole("button", { name: "Generate Outline", exact: true })
    .click();
  const fallback = page.locator(".outline-surface .source-fallback");
  const input = fallback.getByRole("textbox", { name: "Editable outline" });
  const visible = "# 大纲\n\n---\n\n- 中文目标\n- Unlocked\n";
  await expect(input).toHaveValue(visible);
  expect((await outlineFile(page)).text).toBe(raw);
  async function selectText(field: typeof input, quote: string) {
    await field.focus();
    await field.evaluate((node: HTMLTextAreaElement, text) => {
      const start = node.value.indexOf(text);
      node.setSelectionRange(start, start + text.length);
      document.dispatchEvent(new Event("selectionchange"));
    }, quote);
  }
  await selectText(input, "中文目标");
  await fallback.getByRole("button", { name: "Lock selected blocks" }).click();
  await expect(
    fallback.getByRole("button", { name: "Unlock", exact: true }),
  ).toBeVisible();
  expect((await annotationsFile(page)).locks[0].anchors[0].quote).toBe(
    "- 中文目标",
  );
  await fallback.getByRole("button", { name: "Comment on selection" }).click();
  await page.locator("#markdown-comment-composer").fill("Clarify");
  await page
    .locator(".markdown-review")
    .getByRole("button", { name: "Comment on selection" })
    .click();
  await expect(page.locator(".markdown-comment")).toContainText("Clarify");
  expect((await annotationsFile(page)).comments[0].anchor.quote).toBe(
    "中文目标",
  );
  await input.fill(visible.replace("中文目标", "Blocked"));
  await expect(input).toHaveValue(visible);
  const updated = visible
    .replace("---", "---\n\nExtra paragraph before the locked block")
    .replace("Unlocked", "Edited");
  await input.fill(updated);
  await selectText(input, "中文目标");
  await expect(
    fallback.getByRole("button", { name: "Unlock", exact: true }),
  ).toBeEnabled();
  await save(page);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  expect((await outlineFile(page)).text).toBe(
    `\ufeff${updated.replaceAll("\n", "\r\n")}`,
  );
  const modalSource = await source(page);
  await modalSource.fill(updated.replace("---\n\n", ""));
  await selectText(modalSource, "Edited");
  await page
    .getByRole("dialog", { name: "Markdown source" })
    .getByRole("button", { name: "Comment on selection" })
    .click();
  await page.locator("#markdown-comment-composer").fill("Keep this word");
  await page
    .locator(".markdown-review")
    .getByRole("button", { name: "Comment on selection" })
    .click();
  await expect(page.locator(".markdown-comment").last()).toContainText(
    "Keep this word",
  );
  expect((await annotationsFile(page)).comments[1].anchor.quote).toBe("Edited");
});

test("MOR-AC01: the copy icon copies unsaved Markdown from the current document", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await preferences(page, "off");
  await importFile(page, Buffer.from("# 文稿\n\n[原始链接](./notes.md)\n"));
  const manuscriptSource = page.locator(
    ".document-layout .source-fallback textarea",
  );
  await expect(manuscriptSource).toBeVisible();
  await manuscriptSource.fill("# 文稿\n\n[尚未保存](./notes.md)\n");
  const copy = page.getByRole("button", { name: "Copy Markdown", exact: true });
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  await copy.click();
  await expect.poll(clipboard).toBe("# 文稿\n\n[尚未保存](./notes.md)\n");
  expect((await savedFile(page)).text).toContain("[原始链接]");
  await outlineTab(page);
  await outlineEditor(page).fill("未保存的大纲");
  await copy.click();
  await expect.poll(clipboard).toBe("未保存的大纲");
  expect((await outlineFile(page)).revision).toBeNull();
});

test("@web-smoke MOR-AC05: multi-block comments follow outline, survive edits and keep detached quote for resolution", async ({
  page,
}) => {
  await page.goto("/");
  await preferences(page, "off");
  const raw =
    "# Comment span\n\n- First target\n- Second target\n\nUnrelated tail";
  await page.request.post(
    `/api/v1/markdown-projects/${projectId(page)}/documents/outline`,
    { data: { revision: null, text: raw } },
  );
  await page.reload();
  await outlineTab(page);
  await expect(outlineEditor(page)).toContainText("Comment span");
  await selectBlocks(outlineEditor(page), "h1, li", 0, 2);
  await page
    .locator(".outline-surface")
    .getByRole("button", { name: "Comment on selection", exact: true })
    .click();
  await expect(page.locator("#markdown-comment-composer")).toBeFocused();
  await page.locator("#markdown-comment-composer").fill("Clarify these beats");
  await page
    .locator(".markdown-review")
    .getByRole("button", { name: "Comment on selection", exact: true })
    .click();
  await expect(page.locator(".markdown-comment")).toContainText(
    "Clarify these beats",
  );
  const state = await annotationsFile(page);
  expect(state.comments[0].anchor.quote).toBe(
    "# Comment span\n\n- First target\n- Second target",
  );
  await manuscript(page);
  await expect(page.locator(".markdown-comment")).toHaveCount(0);
  await page.reload();
  await outlineTab(page);
  await page.getByRole("tab", { name: "Comments", exact: true }).click();
  await expect(page.locator(".markdown-comment")).toContainText(
    "Clarify these beats",
  );
  await outlineEditor(page).locator("p").last().click();
  await outlineEditor(page).press("End");
  await outlineEditor(page).pressSequentially(" changed");
  await save(page);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  await page
    .locator(".markdown-comment")
    .getByRole("button", { name: "Show anchor", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("textbox")).toHaveValue(
    raw + " changed",
  );
  await closeSource(page);
  const input = await source(page);
  await input.fill("Only unrelated tail remains");
  await closeSource(page);
  await save(page);
  await expect(page.locator(".markdown-comment")).toContainText(
    "Anchor needs repositioning",
  );
  await expect(page.locator(".markdown-comment blockquote")).toHaveText(
    "# Comment span\n\n- First target\n- Second target",
  );
  await page.reload();
  await outlineTab(page);
  await page.getByRole("tab", { name: "Comments", exact: true }).click();
  await page
    .locator(".markdown-comment")
    .getByRole("button", { name: "Resolve", exact: true })
    .click();
  await expect(page.locator(".markdown-comment")).toHaveAttribute(
    "data-comment-status",
    "resolved",
  );
});

test("@web-smoke MOR-AC06: comment proposal previews only its scope and a hidden live lock blocks adoption", async ({
  page,
}) => {
  await mockWriting(page, () => "unused");
  await page.goto("/");
  await preferences(page, "off");
  const raw = "# Scope\n\nTarget paragraph 中文\n\nUntouched tail";
  await page.request.post(
    `/api/v1/markdown-projects/${projectId(page)}/documents/outline`,
    { data: { revision: null, text: raw } },
  );
  await page.reload();
  await outlineTab(page);
  await expect(outlineEditor(page)).toContainText("Target paragraph 中文");
  await selectBlocks(outlineEditor(page), "p", 0, 0);
  await page
    .locator(".outline-surface")
    .getByRole("button", { name: "Comment on selection", exact: true })
    .click();
  await page
    .locator("#markdown-comment-composer")
    .fill("Improve this paragraph");
  await page
    .locator(".markdown-review")
    .getByRole("button", { name: "Comment on selection", exact: true })
    .click();
  await expect(page.locator(".markdown-comment")).toContainText(
    "Improve this paragraph",
  );
  const before = await outlineFile(page);
  const comment = (await annotationsFile(page)).comments[0];
  let calls = 0;
  const actionIds: string[] = [];
  await page.route(
    "**/api/v1/markdown-projects/*/documents/outline/scoped",
    (route) => {
      calls++;
      const body = route.request().postDataJSON();
      actionIds.push(body.actionId);
      if (calls === 1) return route.abort("failed");
      return route.fulfill({
        json: {
          actionId: body.actionId,
          text: "Revised selected paragraph",
          range: {
            start: comment.anchor.resolvedStart,
            end: comment.anchor.resolvedEnd,
          },
          fingerprint: createHash("sha256")
            .update(comment.anchor.quote)
            .digest("hex"),
        },
      });
    },
  );
  await page
    .locator(".markdown-comment")
    .getByRole("button", { name: "Propose AI revision", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page
    .locator(".markdown-comment")
    .getByRole("button", { name: "Propose AI revision", exact: true })
    .click();
  const preview = page.getByRole("region", {
    name: "Selected scope preview",
    exact: true,
  });
  await expect(preview).toContainText("Revised selected paragraph");
  expect(await outlineFile(page)).toEqual(before);
  expect(calls).toBe(2);
  expect(actionIds[0]).toBe(actionIds[1]);
  const annotationPath = `/api/v1/markdown-projects/${projectId(page)}/documents/outline/annotations`;
  const locked = await (
    await page.request.post(annotationPath, {
      data: {
        action: "lock",
        revision: before.revision,
        ranges: [
          {
            start: comment.anchor.resolvedStart,
            end: comment.anchor.resolvedEnd,
          },
        ],
      },
    })
  ).json();
  await preview
    .getByRole("button", { name: "Apply Changes", exact: true })
    .click();
  await expect(
    page.locator('[data-error-code="MARKDOWN_LOCKED"]'),
  ).toContainText("Unlock protected blocks");
  await expect(preview).toContainText("Revised selected paragraph");
  expect(await outlineFile(page)).toEqual(before);
  await page.request.post(annotationPath, {
    data: { action: "unlock", id: locked.locks[0].id },
  });
  await preview
    .getByRole("button", { name: "Apply Changes", exact: true })
    .click();
  await expect
    .poll(async () => (await outlineFile(page)).text)
    .toBe(raw.replace("Target paragraph 中文", "Revised selected paragraph"));
  await expect(outlineEditor(page)).toContainText("Revised selected paragraph");
});

test("MOR-AC07: export flushes both captured buffers through an outstanding save", async ({
  page,
}) => {
  await page.goto("/");
  await preferences(page, "off");
  await outlineTab(page);
  await outlineEditor(page).fill("Earlier outline");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived!: () => void;
  const pending = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let first = true;
  await page.route(/\/documents\/outline$/, async (route) => {
    if (route.request().method() !== "POST" || !first) return route.continue();
    first = false;
    const response = await route.fetch();
    arrived();
    await held;
    await route.fulfill({ response });
  });
  await save(page);
  await pending;
  await outlineEditor(page).fill("Captured outline 中文");
  await manuscript(page);
  await editor(page).fill("Captured manuscript");
  const formats = await openExportMenu(page);
  const downloaded = page.waitForEvent("download");
  await formats.getByRole("menuitem", { name: /^Project ZIP/ }).click();
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  expect((await outlineFile(page)).text).toBe("Earlier outline");
  release();
  const entries = zipEntries(
    await readFile((await (await downloaded).path())!),
  );
  expect(entries["project/outline.md"].toString()).toBe(
    "Captured outline 中文",
  );
  expect(entries["project/manuscript.md"].toString()).toBe(
    "Captured manuscript",
  );
  expect(JSON.parse(entries["exchange.json"]).outlineBaseRevision).toBe(
    (await outlineFile(page)).revision,
  );
  await expect(editor(page)).toHaveText("Captured manuscript");
  await outlineTab(page);
  await expect(outlineEditor(page)).toHaveText("Captured outline 中文");
});

test("@web-smoke MOR-AC07–08: independent document review, separate confirmations and live locks", async ({
  page,
}) => {
  await page.goto("/");
  await preferences(page, "off");
  await editor(page).fill("Original manuscript");
  await outlineTab(page);
  await outlineEditor(page).fill("Original outline");
  const entries = await packageFrom(page);
  entries["project/outline.md"] = Buffer.from("Returned outline");
  await manuscript(page);
  await editor(page).fill("Local manuscript draft");
  const exportedManuscript = await savedFile(page);
  await page.request.post(`/api/v1/markdown-projects/${projectId(page)}`, {
    data: {
      revision: exportedManuscript.revision,
      text: "Stored concurrent manuscript",
    },
  });
  await importPackage(page, zip(entries));
  const preview = page.getByRole("region", {
    name: "Review imported changes",
    exact: true,
  });
  const outlineReview = preview.getByRole("region", {
    name: "Outline",
    exact: true,
  });
  await expect(
    preview.getByRole("region", { name: "Manuscript", exact: true }),
  ).toHaveCount(0);
  await outlineReview
    .getByRole("button", { name: "Apply Changes", exact: true })
    .click();
  await expect(outlineEditor(page)).toBeVisible();
  expect((await outlineFile(page)).text).toBe("Returned outline");
  expect((await savedFile(page)).text).toBe("Stored concurrent manuscript");
  await manuscript(page);
  await expect(editor(page)).toHaveText("Local manuscript draft");
  // Reopen the stored snapshots for two independently confirmed returns.
  await page.reload();
  const both = await packageFrom(page);
  both["project/manuscript.md"] = Buffer.from("Returned manuscript");
  both["project/outline.md"] = Buffer.from("Second returned outline");
  both["project/locks.json"] = Buffer.from('{"locks":["untrusted"]}');
  both["project/comments.json"] = Buffer.from('{"comments":["untrusted"]}');
  await importPackage(page, zip(both));
  await preview
    .getByRole("region", { name: "Outline", exact: true })
    .getByRole("button", { name: "Apply Changes", exact: true })
    .click();
  await expect(
    preview.getByRole("region", { name: "Outline", exact: true }),
  ).toHaveCount(0);
  await expect(preview).toBeVisible();
  expect((await outlineFile(page)).text).toBe("Second returned outline");
  expect((await savedFile(page)).text).toBe("Stored concurrent manuscript");
  await preview
    .getByRole("region", { name: "Manuscript", exact: true })
    .getByRole("button", { name: "Apply Changes", exact: true })
    .click();
  await expect(preview).toHaveCount(0);
  expect((await savedFile(page)).text).toBe("Returned manuscript");
  expect((await annotationsFile(page, "manuscript")).locks).toEqual([]);
  expect((await annotationsFile(page)).comments).toEqual([]);
  // A lock added after preview blocks only its document and keeps both candidates.
  const locked = await packageFrom(page);
  locked["project/manuscript.md"] = Buffer.from("Blocked return");
  locked["project/outline.md"] = Buffer.from("Independent third outline");
  await importPackage(page, zip(locked));
  const manuscriptSnapshot = await savedFile(page);
  const lock = await page.request.post(
    `/api/v1/markdown-projects/${projectId(page)}/documents/manuscript/annotations`,
    {
      data: {
        action: "lock",
        revision: manuscriptSnapshot.revision,
        ranges: [{ start: 0, end: Buffer.byteLength(manuscriptSnapshot.text) }],
      },
    },
  );
  expect(lock.ok()).toBe(true);
  const manuscriptReview = preview.getByRole("region", {
    name: "Manuscript",
    exact: true,
  });
  await manuscriptReview
    .getByRole("button", { name: "Apply Changes", exact: true })
    .click();
  await expect(manuscriptReview).toContainText("locked");
  await expect(manuscriptReview).toContainText("Blocked return");
  await preview
    .getByRole("region", { name: "Outline", exact: true })
    .getByRole("button", { name: "Apply Changes", exact: true })
    .click();
  await expect(
    preview.getByRole("region", { name: "Outline", exact: true }),
  ).toHaveCount(0);
  expect((await outlineFile(page)).text).toBe("Independent third outline");
  expect((await savedFile(page)).text).toBe("Returned manuscript");
  await expect(
    manuscriptReview.getByRole("button", {
      name: "Apply Changes",
      exact: true,
    }),
  ).toBeDisabled();
});

test("MOR-AC07: export aborts on a failed save or intervening edit and retains both buffers", async ({
  page,
}) => {
  await page.goto("/");
  await preferences(page, "off");
  await editor(page).fill("Retained manuscript");
  await outlineTab(page);
  await outlineEditor(page).fill("Retained outline");
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.route(/\/documents\/outline$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ status: 409, json: { code: "MARKDOWN_CONFLICT" } });
  });
  let formats = await openExportMenu(page);
  await formats.getByRole("menuitem", { name: /^Project ZIP/ }).click();
  await expect(
    page.locator('[data-error-code="MARKDOWN_CONFLICT"]'),
  ).toBeVisible();
  expect(downloads).toBe(0);
  await expect(outlineEditor(page)).toHaveText("Retained outline");
  await manuscript(page);
  await expect(editor(page)).toHaveText("Retained manuscript");
  await page.unroute(/\/documents\/outline$/);
  await editor(page).fill("Captured before wait");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived!: () => void;
  const pending = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await page.route(/\/api\/v1\/markdown-projects\/[^/]+$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    arrived();
    await held;
    await route.fulfill({ response });
  });
  formats = await openExportMenu(page);
  await formats.getByRole("menuitem", { name: /^Project ZIP/ }).click();
  await pending;
  await outlineTab(page);
  await outlineEditor(page).fill("Newer outline while exporting");
  release();
  await expect(
    page.locator('[data-error-code="MARKDOWN_EXCHANGE_EXPORT_CHANGED"]'),
  ).toBeVisible();
  await expect(outlineEditor(page)).toHaveText("Newer outline while exporting");
  await manuscript(page);
  await expect(editor(page)).toHaveText("Captured before wait");
  expect(downloads).toBe(0);
});

test("@web-smoke MOR-AC09: null outline base adds a saved empty file and legacy return preserves it", async ({
  page,
}) => {
  await page.goto("/");
  await preferences(page, "off");
  const entries = await packageFrom(page);
  expect(JSON.parse(entries["exchange.json"]).outlineBaseRevision).toBeNull();
  expect(entries["project/outline.md"]).toBeUndefined();
  expect((await outlineFile(page)).revision).toBeNull();
  entries["project/outline.md"] = Buffer.from("");
  await importPackage(page, zip(entries));
  const preview = page.getByRole("region", {
    name: "Review imported changes",
    exact: true,
  });
  await preview
    .getByRole("region", { name: "Outline", exact: true })
    .getByRole("button", { name: "Apply Changes", exact: true })
    .click();
  await expect(outlineEditor(page)).toBeVisible();
  const empty = await outlineFile(page);
  expect(empty.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(empty.text).toBe("");
  const legacy = {
    "exchange.json": Buffer.from(
      JSON.stringify({
        baseRevision: JSON.parse(entries["exchange.json"]).baseRevision,
      }),
    ),
    "project/project.json": entries["project/project.json"],
    "project/manuscript.md": Buffer.from("Legacy manuscript return"),
  };
  await importPackage(page, zip(legacy));
  await expect(
    preview.getByRole("region", { name: "Outline", exact: true }),
  ).toHaveCount(0);
  await preview
    .getByRole("region", { name: "Manuscript", exact: true })
    .getByRole("button", { name: "Apply Changes", exact: true })
    .click();
  await expect(preview).toHaveCount(0);
  expect((await savedFile(page)).text).toBe("Legacy manuscript return");
  expect(await outlineFile(page)).toEqual(empty);
});
