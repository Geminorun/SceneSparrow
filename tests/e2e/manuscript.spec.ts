import { test, expect, type Page } from "@playwright/test";
async function draft(page: Page) {
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
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("en");
  const start = page.getByRole("button", {
    name: "Start writing",
    exact: true,
  });
  await expect(start.or(editor(page))).toBeVisible();
  if (await start.isVisible()) await start.click();
  await expect(
    page.getByRole("textbox", { name: "Manuscript", exact: true }),
  ).toBeVisible();
}
const editor = (page: Page) =>
  page.getByRole("textbox", { name: "Manuscript", exact: true });
const saved = (page: Page) =>
  expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
test.describe.configure({ mode: "serial" });
test("writes Unicode, formatting, headings and nested lists and reopens without a no-op save", async ({
  page,
}) => {
  await draft(page);
  const input = editor(page);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start writing", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(input).toBeVisible();
  await input.fill("中文 English 🐦");
  await input.press("ControlOrMeta+a");
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await page.getByLabel("Block style").selectOption("2");
  await input.press("End");
  await input.press("Enter");
  await input.pressSequentially("Second paragraph");
  await input.press("Enter");
  await page.getByRole("button", { name: "Bullet list", exact: true }).click();
  await input.pressSequentially("Parent item");
  await input.press("Enter");
  await input.press("Tab");
  await input.pressSequentially("Nested item");
  await saved(page);
  const state = await (await page.request.get("/api/v1/manuscript")).json();
  expect(
    state.blocks.some((b: any) => b.kind === "heading" && b.attrs.level === 2),
  ).toBeTruthy();
  expect(
    state.blocks.some(
      (b: any) => b.kind === "list_item" && b.attrs.depth === 1,
    ),
  ).toBeTruthy();
  expect(
    state.blocks.some((b: any) =>
      b.runs.some((r: any) => r.marks.some((m: any) => m.type === "bold")),
    ),
  ).toBeTruthy();
  await page.reload();
  await expect(input).toContainText("中文 English 🐦");
  await expect(input).toContainText("Nested item");
  await saved(page);
  let writes = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/manuscript/commands")) writes++;
  });
  await input.click();
  await page.getByRole("heading", { name: "Manuscript", exact: true }).click();
  await page.waitForTimeout(700);
  expect(writes).toBe(0);
  const after = await (await page.request.get("/api/v1/manuscript")).json();
  expect(after).toEqual(state);
});
test("composition remains local until completion", async ({ page }) => {
  await draft(page);
  let writes = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/manuscript/commands")) writes++;
  });
  const input = editor(page);
  await input.click();
  await input.dispatchEvent("compositionstart", { data: "中" });
  await input.press("End");
  await input.pressSequentially(" 输入法");
  await page.waitForTimeout(2300);
  expect(writes).toBe(0);
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "pending",
  );
  await input.dispatchEvent("compositionend", { data: "输入法" });
  await saved(page);
  expect(writes).toBeGreaterThan(0);
  await page.reload();
  await expect(input).toContainText("输入法");
});
test("late receipt cannot mark newer visible input saved and writes stay serialized", async ({
  page,
}) => {
  await draft(page);
  const input = editor(page);
  let intercepted = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/api/v1/manuscript/commands", async (route) => {
    intercepted++;
    const response = await route.fetch();
    if (intercepted === 1) await gate;
    await route.fulfill({ response });
  });
  await input.click();
  await input.press("End");
  await input.pressSequentially(" first delayed");
  await expect.poll(() => intercepted).toBe(1);
  await input.pressSequentially(" newer buffer");
  await page.waitForTimeout(500);
  expect(intercepted).toBe(1);
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saving",
  );
  release();
  await saved(page);
  expect(intercepted).toBe(2);
  await page.reload();
  await expect(input).toContainText("first delayed newer buffer");
});
test("uncertain commit resolves original receipt once", async ({ page }) => {
  await draft(page);
  let writes = 0;
  let receipts = 0;
  await page.route("**/api/v1/manuscript/commands", async (route) => {
    if (route.request().postDataJSON().type !== "ApplyDocumentEdit")
      return route.continue();
    writes++;
    await route.fetch();
    await route.abort("failed");
  });
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/commands/")) receipts++;
  });
  const input = editor(page);
  await input.click();
  await input.press("End");
  await input.pressSequentially(" ambiguous receipt");
  await saved(page);
  expect(writes).toBe(1);
  expect(receipts).toBe(1);
  await page.unroute("**/api/v1/manuscript/commands");
  await page.reload();
  await expect(input).toContainText("ambiguous receipt");
});
test("failure retains local input for retry and conflict offers explicit discard", async ({
  page,
}) => {
  await draft(page);
  const input = editor(page);
  await page.route("**/api/v1/manuscript/commands", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ code: "STORAGE_UNAVAILABLE" }),
    }),
  );
  await input.click();
  await input.press("End");
  await input.pressSequentially(" disk failure retained");
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "error",
  );
  await expect(input).toContainText("disk failure retained");
  await input.pressSequentially(" more local");
  await page.unroute("**/api/v1/manuscript/commands");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await saved(page);
  await expect(input).toContainText("disk failure retained more local");
  const current = await (await page.request.get("/api/v1/manuscript")).json();
  const project = (await (await page.request.get("/api/v1/project")).json())
    .project;
  const other = await page.request.post("/api/v1/manuscript/commands", {
    data: {
      type: "ApplyDocumentEdit",
      requestId: crypto.randomUUID(),
      projectId: project.id,
      expectedWorkingRevision: current.workingRevision,
      payload: {
        operations: [
          {
            op: "insertBlock",
            block: {
              id: crypto.randomUUID(),
              kind: "paragraph",
              attrs: {},
              runs: [{ text: "Other writer saved", marks: [] }],
            },
            after: current.blocks.at(-1)?.id ?? null,
          },
        ],
        expectedBlockRevisions: [],
        group: {
          clientSessionId: crypto.randomUUID(),
          groupId: crypto.randomUUID(),
          groupSequence: 1,
          kind: "discrete",
        },
      },
    },
  });
  expect(other.ok()).toBeTruthy();
  await input.pressSequentially(" conflict kept");
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "conflict",
  );
  await expect(input).toContainText("conflict kept");
  await page
    .getByRole("button", { name: "Recover local edits", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Local text to copy" }),
  ).toContainText("conflict kept");
  await page
    .getByRole("button", { name: "Keep local edits", exact: true })
    .click();
  await expect(input).toContainText("conflict kept");
  await page
    .getByRole("button", { name: "Recover local edits", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Discard local edits and reload saved document",
      exact: true,
    })
    .click();
  await saved(page);
  await expect(input).not.toContainText("conflict kept");
  await expect(input).toContainText("Other writer saved");
});
test("canonical combined marks and soft breaks survive the actual editor schema and editing", async ({
  page,
}) => {
  await draft(page);
  const state = await (await page.request.get("/api/v1/manuscript")).json();
  const project = (await (await page.request.get("/api/v1/project")).json())
    .project;
  const blockId = crypto.randomUUID();
  const marks = [
    { type: "bold" },
    { type: "italic" },
    { type: "code" },
    { type: "link", href: "https://example.com/path" },
  ];
  const response = await page.request.post("/api/v1/manuscript/commands", {
    data: {
      type: "ApplyDocumentEdit",
      requestId: crypto.randomUUID(),
      projectId: project.id,
      expectedWorkingRevision: state.workingRevision,
      payload: {
        operations: [
          {
            op: "insertBlock",
            block: {
              id: blockId,
              kind: "paragraph",
              attrs: {},
              runs: [{ text: "Combined 中文\nsoft break", marks }],
            },
            after: state.blocks.at(-1)?.id ?? null,
          },
        ],
        expectedBlockRevisions: [],
        group: {
          clientSessionId: crypto.randomUUID(),
          groupId: crypto.randomUUID(),
          groupSequence: 1,
          kind: "discrete",
        },
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  await page.reload();
  const input = editor(page);
  await expect(
    input.locator("code").filter({ hasText: "Combined 中文" }),
  ).toBeVisible();
  await input.click();
  await input.press("ControlOrMeta+End");
  await input.pressSequentially(" appended");
  await saved(page);
  const after = await (await page.request.get("/api/v1/manuscript")).json();
  const rich = after.blocks.find((b: any) => b.id === blockId);
  expect(rich.runs[0].marks).toEqual(marks);
  expect(rich.runs.map((r: any) => r.text).join("")).toContain(
    "Combined 中文\nsoft break",
  );
  const ids = after.blocks.map((b: any) => b.id);
  await input.press("ControlOrMeta+End");
  await page.getByRole("button", { name: "Bullet list", exact: true }).click();
  await saved(page);
  const list = await (await page.request.get("/api/v1/manuscript")).json();
  expect(list.blocks.at(-1).id).toBe(blockId);
  expect(list.blocks.map((b: any) => b.id)).toEqual(ids);
  await page.getByRole("button", { name: "Ordered list", exact: true }).click();
  await saved(page);
  const ordered = await (await page.request.get("/api/v1/manuscript")).json();
  expect(ordered.blocks.at(-1).id).toBe(blockId);
  expect(ordered.blocks.at(-1).attrs.listKind).toBe("ordered");
  await page.reload();
  await expect(editor(page)).toContainText("Combined 中文");
});
test("split at the start keeps the first identity across paragraph/list merge and pasted duplicate IDs", async ({
  page,
}) => {
  await draft(page);
  const input = editor(page);
  await input.fill("Identity boundary text");
  await page.getByLabel("Block style").selectOption("paragraph");
  await saved(page);
  const read = async () =>
    (await page.request.get("/api/v1/manuscript")).json();
  const before = await read();
  const original = before.blocks[0].id;
  expect(before.blocks).toHaveLength(1);
  await input.press("ControlOrMeta+Home");
  await input.press("Enter");
  await saved(page);
  const split = await read();
  expect(split.blocks).toHaveLength(2);
  expect(split.blocks[0].id).toBe(original);
  expect(split.blocks[0].runs).toEqual([]);
  expect(split.blocks[1].id).not.toBe(original);
  expect(split.blocks[1].runs.map((r: any) => r.text).join("")).toBe(
    "Identity boundary text",
  );
  const second = split.blocks[1].id;
  await page.reload();
  await expect(input).toContainText("Identity boundary text");
  expect((await read()).blocks.map((b: any) => b.id)).toEqual([
    original,
    second,
  ]);
  await input.press("ControlOrMeta+End");
  await input.press("Home");
  await input.press("Backspace");
  await saved(page);
  const merged = await read();
  expect(merged.blocks).toHaveLength(1);
  expect(merged.blocks[0].id).toBe(original);
  await page.getByRole("button", { name: "Bullet list", exact: true }).click();
  await saved(page);
  await input.press("ControlOrMeta+Home");
  await input.press("Enter");
  await saved(page);
  const listSplit = await read();
  expect(listSplit.blocks).toHaveLength(2);
  expect(listSplit.blocks[0].id).toBe(original);
  expect(listSplit.blocks[1].id).not.toBe(original);
  expect(
    listSplit.blocks.every((b: any) => b.kind === "list_item"),
  ).toBeTruthy();
  await input.press("ControlOrMeta+End");
  await input.press("Home");
  await input.press("Backspace");
  await saved(page);
  const lifted = await read();
  expect(lifted.blocks).toHaveLength(2);
  expect(lifted.blocks[0].id).toBe(original);
  expect(lifted.blocks[1].id).toBe(listSplit.blocks[1].id);
  expect(lifted.blocks[1].kind).toBe("paragraph");
  await input.press("Backspace");
  await saved(page);
  const listMerged = await read();
  expect(listMerged.blocks).toHaveLength(1);
  expect(listMerged.blocks[0].id).toBe(original);
  expect(listMerged.blocks[0].runs.map((run: any) => run.text).join("")).toBe(
    "Identity boundary text",
  );
  await page.getByRole("button", { name: "Bullet list", exact: true }).click();
  await saved(page);
  await input.press("ControlOrMeta+End");
  await input.evaluate((element, tombstone) => {
    const data = new DataTransfer();
    data.setData(
      "text/html",
      `<p data-blockid="${tombstone}">Pasted first</p><p data-blockid="${tombstone}">Pasted second</p>`,
    );
    data.setData("text/plain", "Pasted first\nPasted second");
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, second);
  await expect(input).toContainText("Pasted second");
  await saved(page);
  const pasted = await read();
  const ids = pasted.blocks.map((b: any) => b.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).not.toContain(second);
  expect(ids.filter((id: string) => id === original)).toHaveLength(1);
});
test("invalid visible structure blocks retry/close and discard reload completes the desktop bridge decision", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const host = window as any;
    host.__closeResults = [];
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(`/api/v1${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json();
      return response.ok ? { ok: true, data } : { ok: false, code: data.code };
    };
    host.sceneSparrow = {
      health: () => request("/health"),
      readProject: () => request("/project"),
      createProject: (command: unknown) => request("/project", command),
      readManuscript: () => request("/manuscript"),
      readPlanning: () => request("/planning"),
      readReviews: () => request("/reviews"),
      readHistory: () => request("/history"),
      executeManuscript: (command: unknown) =>
        request("/manuscript/commands", command),
      commandReceipt: (id: string) => request(`/commands/${id}`),
      readSources: () => request("/sources"),
      subscribeEvents: () => () => {},
      pickFileIntake: async () => ({ ok: true, data: null }),
      cancelFileSelection: async () => ({ ok: true, data: null }),
      onFileIntakeProgress: () => () => {},
      cancelIntake: async () => ({ ok: true, data: null }),
      documentAction: (action: unknown) => request("/document-jobs", action),
      documentJob: (id: string) => request(`/document-jobs/${id}`),
      extractionPage: (id: string, offset: number) =>
        request(`/source-extractions/${id}?offset=${offset}`),
      openExternalLink: async () => ({ ok: true, data: null }),
      onCloseRequested: (handler: () => Promise<boolean>) => {
        host.__requestClose = () => {
          void handler().then((result) => host.__closeResults.push(result));
        };
        return () => {
          delete host.__requestClose;
        };
      },
    };
  });
  await draft(page);
  const input = editor(page);
  await input.fill("Recovery parent");
  await page.getByLabel("Block style").selectOption("paragraph");
  await saved(page);
  await input.press("ControlOrMeta+End");
  await page.getByRole("button", { name: "Bullet list", exact: true }).click();
  for (let depth = 1; depth <= 4; depth++) {
    await input.press("Enter");
    await input.press("Tab");
    await input.pressSequentially(
      depth === 4 ? "Invalid depth four" : `Child depth ${depth}`,
    );
  }
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "error",
  );
  await expect(page.getByTestId("save-error-code")).toHaveAttribute(
    "data-error-code",
    "DOCUMENT_INVALID",
  );
  let writes = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/manuscript/commands")) writes++;
  });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "error",
  );
  expect(writes).toBe(0);
  await expect(input).toContainText("Invalid depth four");
  await page.evaluate(() => {
    (window as any).__requestClose();
  });
  await expect(
    page.getByRole("dialog", { name: "Recover local edits" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Local text to copy" }),
  ).toContainText("Invalid depth four");
  await page
    .getByRole("button", { name: "Retry save and close", exact: true })
    .click();
  expect(await page.evaluate(() => (window as any).__closeResults)).toEqual([]);
  await page
    .getByRole("button", {
      name: "Discard local edits and reload saved document",
      exact: true,
    })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__closeResults))
    .toEqual([true]);
  await expect(
    page.getByRole("dialog", { name: "Recover local edits" }),
  ).toHaveCount(0);
  await saved(page);
  await expect(input).not.toContainText("Invalid depth four");
  await page.evaluate(() => {
    (window as any).__requestClose();
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).__closeResults))
    .toEqual([true, true]);
});

test("five retained operations share toolbar and shortcuts, preserve redo on navigation, and branch on a real edit", async ({
  page,
}) => {
  await draft(page);
  const input = editor(page);
  await input.fill("History 0");
  await page.getByLabel("Block style").selectOption("paragraph");
  await saved(page);
  await page.waitForTimeout(800);
  for (let n = 1; n <= 6; n++) {
    await input.fill(`History ${n}`);
    await saved(page);
    await page.waitForTimeout(800);
  }
  const history = async () =>
    (await page.request.get("/api/v1/history")).json();
  expect((await history()).undoCount).toBe(5);
  let documentWrites = 0;
  page.on("request", (r) => {
    if (
      r.url().endsWith("/manuscript/commands") &&
      r.postDataJSON().type === "ApplyDocumentEdit"
    )
      documentWrites++;
  });
  for (let n = 5; n >= 1; n--) {
    if (n % 2)
      await page.getByRole("button", { name: "Undo", exact: true }).click();
    else await input.press("ControlOrMeta+z");
    await expect(input).toHaveText(`History ${n}`);
  }
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeDisabled();
  for (let n = 2; n <= 6; n++) {
    if (n % 2) await input.press("Control+y");
    else await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(input).toHaveText(`History ${n}`);
  }
  expect(documentWrites).toBe(0);
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveText("History 5");
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveText("History 4");
  const before = await history();
  await input.press("Home");
  await input.press("ArrowRight");
  await page.getByRole("heading", { name: "Manuscript", exact: true }).click();
  await page.waitForTimeout(850);
  expect(await history()).toEqual(before);
  expect(documentWrites).toBe(0);
  await input.fill("Branched history");
  await saved(page);
  expect((await history()).redoCount).toBe(0);
  await expect(
    page.getByRole("button", { name: "Redo", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(input).toHaveText("Branched history");
  expect((await history()).redoCount).toBe(0);
});
test("continuous typing spans saved batches while selection and idle create new groups", async ({
  page,
}) => {
  await draft(page);
  const input = editor(page);
  await input.fill("Typing base");
  await page.getByLabel("Block style").selectOption("paragraph");
  await saved(page);
  await page.waitForTimeout(800);
  const groups: any[] = [];
  page.on("request", (r) => {
    if (
      r.url().endsWith("/manuscript/commands") &&
      r.postDataJSON().type === "ApplyDocumentEdit"
    )
      groups.push(r.postDataJSON().payload.group);
  });
  await input.press("End");
  await input.pressSequentially(" continuous typing batches", { delay: 180 });
  await saved(page);
  expect(groups.length).toBeGreaterThanOrEqual(2);
  expect(new Set(groups.map((g) => g.groupId)).size).toBe(1);
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveText("Typing base");
  await input.press("ControlOrMeta+Shift+z");
  await expect(input).toHaveText("Typing base continuous typing batches");
  await input.press("End");
  await input.pressSequentially(" selected tail");
  await saved(page);
  await input.press("Home");
  await input.pressSequentially("prefix ");
  await saved(page);
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveText(
    "Typing base continuous typing batches selected tail",
  );
  await input.press("End");
  await input.pressSequentially(" idle first");
  await saved(page);
  await page.waitForTimeout(800);
  await input.pressSequentially(" idle second");
  await saved(page);
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveText(
    "Typing base continuous typing batches selected tail idle first",
  );
});
test("native unsubmitted dialog input keeps local undo and IME shortcuts issue no project history", async ({
  page,
}) => {
  await draft(page);
  const input = editor(page);
  let historyWrites = 0;
  page.on("request", (r) => {
    if (
      r.url().endsWith("/manuscript/commands") &&
      ["UndoProject", "RedoProject"].includes(r.postDataJSON().type)
    )
      historyWrites++;
  });
  const before = await (await page.request.get("/api/v1/manuscript")).json();
  await page.getByRole("button", { name: "Link", exact: true }).click();
  const url = page.getByLabel("Link URL");
  await url.fill("");
  await url.pressSequentially("https://example.com/local-input");
  await url.press("ControlOrMeta+z");
  await expect(url).not.toHaveValue("https://example.com/local-input");
  expect(historyWrites).toBe(0);
  expect(await (await page.request.get("/api/v1/manuscript")).json()).toEqual(
    before,
  );
  await page.getByRole("button", { name: "Link", exact: true }).click();
  await input.click();
  await input.dispatchEvent("compositionstart", { data: "中" });
  await input.pressSequentially(" composition text");
  await input.dispatchEvent("keydown", {
    key: "z",
    code: "KeyZ",
    ctrlKey: true,
    isComposing: true,
  });
  await input.dispatchEvent("keydown", {
    key: "y",
    code: "KeyY",
    ctrlKey: true,
    isComposing: true,
  });
  await page.waitForTimeout(850);
  expect(historyWrites).toBe(0);
  expect(await (await page.request.get("/api/v1/manuscript")).json()).toEqual(
    before,
  );
  await input.dispatchEvent("compositionend", { data: "输入" });
  await saved(page);
  await input.press("Tab");
  await expect(input).not.toBeFocused();
});
test("invalid list depth can be corrected locally with ShiftTab before explicit retry", async ({
  page,
}) => {
  await draft(page);
  const input = editor(page);
  await input.fill("Correctable parent");
  await page.getByLabel("Block style").selectOption("paragraph");
  await saved(page);
  await input.press("ControlOrMeta+End");
  await page.getByRole("button", { name: "Bullet list", exact: true }).click();
  for (let depth = 1; depth <= 4; depth++) {
    await input.press("Enter");
    await input.press("Tab");
    await input.pressSequentially(`Preserved child ${depth}`);
  }
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "error",
  );
  await expect(input).toContainText("Preserved child 4");
  await input.press("Shift+Tab");
  await expect(input).toContainText("Preserved child 4");
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "error",
  );
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await saved(page);
  const state = await (await page.request.get("/api/v1/manuscript")).json();
  expect(state.blocks.at(-1).attrs.depth).toBe(3);
  await page.reload();
  await expect(input).toContainText("Preserved child 4");
  await saved(page);
});
