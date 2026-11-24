import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { zip, zipEntries } from "../fixtures/documents.mjs";

const editor = (page: Page) => page.locator("#markdown-editor");
async function projectAction(page: Page, name: string) {
  await page.locator(".project-menu > summary").click();
  await page
    .locator(".project-menu nav")
    .getByRole("button", { name, exact: true })
    .click();
}
const save = (page: Page) => projectAction(page, "Save");
const projectId = (page: Page) =>
  new URL(page.url()).searchParams.get("project");
async function exported(page: Page) {
  const download = page.waitForEvent("download");
  await projectAction(page, "Download .md");
  const file = await download;
  return readFile((await file.path())!);
}
async function importFile(page: Page, buffer: Buffer, name = "returned.md") {
  await page
    .locator('input[accept=".md,text/markdown"]')
    .setInputFiles({ name, mimeType: "text/markdown", buffer });
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
    .getByRole("button", { name: "View Markdown source", exact: true })
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
  await page.locator(".project-menu > summary").click();
  const menuBox = await page.locator(".project-menu nav").boundingBox();
  expect(menuBox!.x).toBeGreaterThanOrEqual(0);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await page.locator(".project-menu > summary").click();
  await expect(
    page.getByRole("tab", { name: "Library", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "Comments", exact: true }),
  ).toHaveCount(0);
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
  await save(page);
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
  await expect(page.locator(".source-fallback")).toBeVisible();
  expect(await exported(page)).toEqual(raw);
  const dialog = page.getByRole("dialog", { name: "Markdown source" });
  const edit = dialog.getByRole("textbox", { name: "Markdown source" });
  const openSource = page
    .locator(".source-fallback")
    .getByRole("button", { name: "View Markdown source" });
  expect(
    await openSource.evaluate((button: HTMLButtonElement) => {
      button.click();
      const input = document.activeElement;
      return input instanceof HTMLTextAreaElement && input.selectionStart === 0;
    }),
  ).toBe(true);
  await edit.fill("# 中文\n<!-- untouched -->\n[link](../changed.md)\n");
  await closeSource(page);
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
  await expect(page.getByRole("status")).toHaveText("Unsaved changes");
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
  await editor(page).dispatchEvent("compositionstart");
  const download = page.waitForEvent("download");
  await page.locator(".project-menu > summary").dispatchEvent("click");
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
    page.getByRole("alert").filter({ hasText: "saved manuscript changed" }),
  ).toBeVisible();
  await expect(editor(page)).toHaveText("local draft");
  expect(await exported(page)).toEqual(Buffer.from("local draft"));
  await projectAction(page, "New manuscript");
  await page.locator(".project-menu > summary").click();
  await expect(
    page.getByRole("button", { name: "New manuscript", exact: true }),
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
  await page.getByRole("button", { name: "Outline", exact: true }).click();
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

test("@web-smoke WFW-AC03: edit outline, preview without writing, close or explicitly adopt, and reload only the manuscript", async ({
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
  await expect(page.getByRole("status")).toHaveText("Saved");
  await preferences(page, "off");
  await beginWriting(page);
  await manuscript(page);
  await page.getByRole("button", { name: "Outline", exact: true }).click();
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
  await page.getByRole("button", { name: "Outline", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Writing request", exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("textbox", { name: "Editable outline", exact: true }),
  ).toHaveText("");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  ).toBeVisible();
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
  await expect(page.getByRole("status")).toHaveText("Saved");
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
    "The manuscript changed since generation began.",
  );
  await preview.getByRole("button", { name: "Use Draft", exact: true }).click();
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
  await expect(page.getByRole("status")).toHaveText("Saved");
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
  await expect(page.getByRole("status")).toHaveText("Saved");
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
  await expect(page.getByRole("status")).toHaveText("Saved");
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
  await projectAction(page, "Download Project");
  return zipEntries(await readFile((await (await downloaded).path())!));
}
async function importPackage(page: Page, bytes: Buffer) {
  await page.locator('input[accept=".zip,application/zip"]').setInputFiles({
    name: "returned.zip",
    mimeType: "application/zip",
    buffer: bytes,
  });
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
  await page.reload();
  await expect(editor(page)).toContainText("Returned 中文");
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
  ).toBeDisabled();
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
  await expect(page.getByRole("status")).toHaveText("Saved");
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
  await editor(page).dispatchEvent("compositionstart");
  const download = page.waitForEvent("download");
  await page.locator(".project-menu > summary").dispatchEvent("click");
  await page
    .getByRole("button", { name: "Save and Download", exact: true })
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
  await expect(preview).toHaveCount(0);
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
