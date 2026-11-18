import { test, expect } from "./helpers/core";
import { openWorkbench, openPanel, projectHistory } from "./helpers/workbench";
// @ts-expect-error Counted local fixture is plain ESM.
import { planningProvider, configurePlanning } from "../fixtures/planning.mjs";

test("compact Library retains exact links, explicit consent and rename history at narrow widths; read recovery survives notices", async ({
  page,
  core,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWorkbench(page);
  await openPanel(page, "Library");
  const panel = page.getByRole("region", { name: "References", exact: true });
  const linkForm = page.locator(".library-link-form");
  await linkForm.locator("summary").click();
  await expect(page.getByLabel("Reference URL", { exact: true })).toBeFocused();
  const exact = `https://example.org/research/${"a-very-long-path/".repeat(20)}?keep=Exact%2FValue#fragment`;
  const title = "Long reference title 关于鸟类学习鸣叫的研究与证据 ".repeat(7);
  await page.getByLabel("Reference URL", { exact: true }).fill(exact);
  await page.getByLabel("Reference title", { exact: true }).fill(title);
  await page
    .getByRole("button", { name: "Add link reference", exact: true })
    .click();
  await expect(linkForm).not.toHaveAttribute("open");
  const row = page.getByTestId("source-item").first();
  await expect(row.locator(".source-title strong")).toHaveText(title);
  const saved = (await core.request("/sources")).items[0].source;
  expect(saved.url).toBe(exact);
  await expect(row.getByRole("checkbox")).not.toBeChecked();
  await row.getByRole("checkbox").click();
  await expect(row.getByRole("checkbox")).toBeChecked();
  await expect
    .poll(async () => (await core.request("/planning")).content.evidence.length)
    .toBe(1);
  const separator = page.locator(".left-resizer");
  for (const width of [200, 240, 360]) {
    await separator.focus();
    await separator.press("Home");
    for (let value = 200; value < width; value += 16)
      await separator.press("ArrowRight");
    if (width === 360) await separator.press("End");
    const layout = await row.evaluate((node) => {
      const title = node.querySelector(".source-title")!;
      const text = title.querySelector("strong")!;
      return {
        row: node.getBoundingClientRect().width,
        title: title.getBoundingClientRect().width,
        height: text.getBoundingClientRect().height,
        line: parseFloat(getComputedStyle(text).lineHeight),
        overflow: node.scrollWidth > node.clientWidth + 1,
      };
    });
    expect(layout.title).toBeGreaterThan(85);
    expect(layout.height).toBeLessThanOrEqual(layout.line * 2 + 1);
    expect(layout.overflow).toBe(false);
  }
  await row.locator(".source-title > summary").focus();
  await page.keyboard.press("Enter");
  expect(
    await row
      .locator(".source-title strong")
      .evaluate((node) => node.getBoundingClientRect().height),
  ).toBeGreaterThan(50);
  await row.locator(".source-title > summary").click();
  await row.locator(".source-actions").click();
  await expect(row.locator(".reference-url")).toHaveText(exact);
  const urlArea = row.getByRole("region", {
    name: "Full reference URL",
    exact: true,
  });
  const dimensions = await urlArea.evaluate((node) => ({
    height: node.getBoundingClientRect().height,
    scroll: node.scrollHeight,
    client: node.clientHeight,
  }));
  expect(dimensions.height).toBeLessThanOrEqual(110);
  expect(dimensions.scroll).toBeGreaterThan(dimensions.client);
  await urlArea.focus();
  await expect(urlArea).toBeFocused();
  await urlArea.press("ArrowDown");
  await expect
    .poll(() => urlArea.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);

  expect(
    await row
      .locator(".source-action-body")
      .evaluate(
        (node) =>
          node.getBoundingClientRect().width /
          node.parentElement!.getBoundingClientRect().width,
      ),
  ).toBeGreaterThan(0.9);
  await row.getByRole("button", { name: "Rename link", exact: true }).click();
  await row
    .getByLabel("Rename link", { exact: true })
    .fill("Renamed research · 鸟鸣证据");
  await row.getByRole("button", { name: "Save title", exact: true }).click();
  await expect(row.locator(".source-title strong")).toHaveText(
    "Renamed research · 鸟鸣证据",
  );
  const renamed = (await core.request("/sources")).items[0].source;
  expect(renamed.id).toBe(saved.id);
  expect(renamed.url).toBe(exact);
  expect(renamed.revision).toBeGreaterThan(saved.revision);
  await expect(row.getByRole("checkbox")).toBeChecked();
  await projectHistory(page, "Undo");
  await expect(row.locator(".source-title strong")).toHaveText(title);
  await projectHistory(page, "Redo");
  await expect(row.locator(".source-title strong")).toHaveText(
    "Renamed research · 鸟鸣证据",
  );
  await expect(row.getByRole("checkbox")).toBeChecked();
  const state = await core.request("/manuscript");
  await core.request("/manuscript/commands", {
    type: "AddSourceLink",
    requestId: crypto.randomUUID(),
    projectId: await page
      .locator(".project-workbench")
      .getAttribute("data-project-id"),
    expectedWorkingRevision: state.workingRevision,
    payload: {
      sourceId: crypto.randomUUID(),
      url: "https://journal.example.net/" + "extended-path/".repeat(12),
      title,
    },
  });
  await page.reload();
  await openPanel(page, "Library");
  const selectedRow = page
    .getByTestId("source-item")
    .filter({ hasText: "Renamed research · 鸟鸣证据" });
  await expect(selectedRow.getByRole("checkbox")).toBeChecked();
  await selectedRow.locator(".source-actions").click();
  await page.screenshot({ path: ".artifacts/wig-ui-library-en.png" });
  await separator.press("Home");
  await page.screenshot({ path: ".artifacts/wig-ui-library-min-en.png" });
  expect(
    await selectedRow
      .locator(".source-action-body")
      .evaluate(
        (node) =>
          node.getBoundingClientRect().width /
          node.parentElement!.getBoundingClientRect().width,
      ),
  ).toBeGreaterThan(0.9);
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh-CN");
  await page.screenshot({ path: ".artifacts/wig-ui-library-min-zh-CN.png" });
  await separator.press("End");
  await page.screenshot({ path: ".artifacts/wig-ui-library-zh-CN.png" });
  await page
    .getByRole("combobox", { name: "语言", exact: true })
    .selectOption("en");
  let failRead = true;
  core.intercept(async (path, _body, phase) => {
    if (failRead && phase === "after" && path.endsWith("/sources"))
      return "abort";
  });
  await page
    .getByRole("button", { name: "Reload references", exact: true })
    .click();
  await expect(
    page
      .locator(".library-read-status")
      .getByText("Could not reload references. Your existing items are kept."),
  ).toBeVisible();
  await page.mouse.move(1, 900);
  await page.waitForTimeout(3300);
  await expect(row).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reload references", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Reload references", exact: true })
    .click();
  await expect(
    page.locator('.notification[data-error-code="SOURCE_READ_FAILED"]'),
  ).toBeVisible();
  failRead = false;
  await page
    .getByRole("button", { name: "Reload references", exact: true })
    .click();
  await expect(
    page
      .locator(".library-read-status")
      .getByText("Could not reload references. Your existing items are kept."),
  ).toHaveCount(0);
  failRead = true;
  await page
    .getByRole("button", { name: "Reload references", exact: true })
    .click();
  await expect(
    page.locator('.notification[data-error-code="SOURCE_READ_FAILED"]'),
  ).toBeVisible();
  await page.mouse.move(1, 900);
  await page.waitForTimeout(3300);
  await expect(
    page.locator('.notification[data-error-code="SOURCE_READ_FAILED"]'),
  ).toHaveCount(0);
  failRead = false;
  await page
    .getByRole("button", { name: "Reload references", exact: true })
    .click();
  await page.setViewportSize({ width: 760, height: 900 });
  await openPanel(page, "Library");
  expect(
    await row.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1.5";
  });
  expect(
    await row.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
});

test("closing Add link cancels deferred IME intents while failed saves retain the focused form", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await openPanel(page, "Library");
  const form = page.locator(".library-link-form");
  await form.locator("summary").click();
  const url = page.getByLabel("Reference URL", { exact: true });
  await url.fill("https://example.org/final");
  const title = page.getByLabel("Reference title", { exact: true });
  await title.fill("Pending");
  await title.dispatchEvent("compositionstart");
  await page
    .getByRole("button", { name: "Add link reference", exact: true })
    .evaluate((node: HTMLButtonElement) => node.click());
  await form
    .getByRole("button", { name: "Cancel", exact: true })
    .evaluate((node: HTMLButtonElement) => node.click());
  await title.dispatchEvent("compositionend");
  await page.waitForTimeout(100);
  expect((await core.request("/sources")).items).toHaveLength(0);
  await form.locator("summary").click();
  await title.fill("界".repeat(342));
  await page
    .getByRole("button", { name: "Add link reference", exact: true })
    .click();
  await expect(form).toHaveAttribute("open", "");
  await expect(title).toHaveValue("界".repeat(342));
  await expect(
    page.locator('.notification[data-error-code="SOURCE_LINK_INVALID"]'),
  ).toContainText("Could not save this reference. Check its title and URL.");
  await title.fill("");
  await page
    .getByRole("button", { name: "Add link reference", exact: true })
    .click();
  await expect(form).not.toHaveAttribute("open");
  await expect(
    page.getByTestId("source-item").locator(".source-title strong"),
  ).toHaveText("example.org");
  await page.mouse.move(1, 900);
  await page.waitForTimeout(3300);
  await form.locator("summary").click();
  await page
    .getByLabel("Reference URL", { exact: true })
    .fill("https://example.org/second-failure");
  await title.fill("界".repeat(342));
  await page
    .getByRole("button", { name: "Add link reference", exact: true })
    .click();
  await expect(
    page.locator('.notification[data-error-code="SOURCE_LINK_INVALID"]'),
  ).toBeVisible();
});

test("generation history stays in the auxiliary pane, cancels deferred starts and retains both composers after failure", async ({
  page,
  core,
}) => {
  const provider = await planningProvider();
  try {
    await configurePlanning(
      async (path: string, body?: unknown, method?: string) => ({
        status: 200,
        data: await core.request(path, body, method),
      }),
      provider.root,
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openWorkbench(page);
    await openPanel(page, "Planning");
    const body = page.getByRole("textbox", { name: "Manuscript", exact: true });
    const original = await body.elementHandle();
    await page
      .getByLabel("Your idea", { exact: true })
      .fill("How birds learn song");
    await page
      .getByRole("button", { name: "Generate outline", exact: true })
      .click();
    await expect
      .poll(async () => (await core.request("/planning")).tasks[0]?.application)
      .toBe("applied");
    const input = page.getByLabel("Overall AI adjustment instruction", {
      exact: true,
    });
    await expect(input).toBeVisible();
    await input.fill("保留未发送的大纲调整");
    const inputNode = await input.elementHandle();
    await input.dispatchEvent("compositionstart");
    await page
      .getByRole("button", { name: "Adjust outline", exact: true })
      .evaluate((node: HTMLButtonElement) => node.click());
    await page
      .getByRole("button", { name: "Generation history", exact: true })
      .evaluate((node: HTMLButtonElement) => node.click());
    await input.dispatchEvent("compositionend");
    const history = page.getByRole("region", {
      name: "Generation history",
      exact: true,
    });
    await expect(history).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Outline", exact: true }),
    ).toBeVisible();
    expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(history.getByText("Completed", { exact: true })).toBeVisible();
    expect(provider.calls).toHaveLength(1);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.screenshot({ path: ".artifacts/wig-ui-history-en.png" });
    await page
      .getByRole("combobox", { name: "Language", exact: true })
      .selectOption("zh-CN");
    await page.screenshot({ path: ".artifacts/wig-ui-history-zh-CN.png" });
    await page
      .getByRole("combobox", { name: "语言", exact: true })
      .selectOption("en");
    await history
      .getByRole("button", { name: "Back to assistant", exact: false })
      .click();
    await expect(input).toHaveValue("保留未发送的大纲调整");
    expect(await inputNode!.evaluate((node) => node.isConnected)).toBe(true);
    provider.setHandler(async (_request: unknown, response: any) => {
      response.statusCode = 500;
      response.end("fixture failure");
    });
    await page
      .getByRole("button", { name: "Adjust outline", exact: true })
      .click();
    await expect
      .poll(async () =>
        (await core.request("/planning")).tasks.some(
          (task: any) => task.run.status === "failed",
        ),
      )
      .toBe(true);
    await page.setViewportSize({ width: 760, height: 900 });
    await openPanel(page, "Library");
    await page
      .locator(".notification")
      .getByRole("button", { name: "Recover", exact: true })
      .click();
    await expect(
      page.getByRole("tab", { name: "AI assistant", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      history.getByText("Could not complete", { exact: true }),
    ).toBeVisible();
    await expect(history.getByText("Completed", { exact: true })).toBeVisible();
    await expect(
      history.getByRole("button", {
        name: "View current outline",
        exact: true,
      }),
    ).toBeVisible();
    await history
      .getByRole("button", { name: "Back to assistant", exact: false })
      .click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openPanel(page, "AI assistant");
    await page
      .locator(".writing-view-switch")
      .getByRole("button", { name: "Manuscript", exact: true })
      .click();
    await body.fill(
      "Manual writing remains available after failed AI generation.",
    );
    await body.press("ControlOrMeta+s");
    await expect(page.getByTestId("save-status")).toHaveAttribute(
      "data-state",
      "saved",
    );
    const review = page.getByLabel("Instruction", { exact: true });
    await expect(review).toBeVisible();
    await review.fill("Unsent manuscript question");
    const reviewNode = await review.elementHandle();
    await page
      .getByRole("button", { name: "Generation history", exact: true })
      .click();
    await expect(body).toBeVisible();
    await expect(
      history.getByRole("button", {
        name: "Write draft from this outline",
        exact: true,
      }),
    ).toHaveCount(0);
    await history
      .getByRole("button", { name: "Back to assistant", exact: false })
      .click();
    await expect(review).toHaveValue("Unsent manuscript question");
    expect(await reviewNode!.evaluate((node) => node.isConnected)).toBe(true);
    expect(provider.calls).toHaveLength(2);
  } finally {
    await provider.close();
  }
});

test("late Add and Rename acknowledgments retain newer form input", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await openPanel(page, "Library");
  let kind = "AddSourceLink",
    entered = () => {},
    release = () => {};
  let gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  core.intercept(async (_path, body, phase) => {
    if (phase === "after" && body?.type === kind) {
      entered();
      await gate;
    }
  });
  const form = page.locator(".library-link-form");
  await form.locator("summary").click();
  const url = page.getByLabel("Reference URL", { exact: true }),
    title = page.getByLabel("Reference title", { exact: true });
  await url.fill("https://example.org/original");
  await title.fill("Original title");
  await page
    .getByRole("button", { name: "Add link reference", exact: true })
    .click();
  await seen;
  await url.fill("https://example.org/new-draft");
  await title.fill("New unsent title");
  release();
  const row = page.getByTestId("source-item");
  await expect(row.locator(".source-title strong")).toHaveText(
    "Original title",
  );
  await expect(form).toHaveAttribute("open", "");
  await expect(url).toHaveValue("https://example.org/new-draft");
  await expect(title).toHaveValue("New unsent title");
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  const menu = row.locator(".source-actions");
  const before = await menu.boundingBox();
  await menu.click();
  expect((await menu.boundingBox())!.y).toBe(before!.y);
  await row.getByRole("button", { name: "Rename link", exact: true }).click();
  const rename = row.getByLabel("Rename link", { exact: true });
  await rename.fill("Saved rename");
  kind = "RenameSourceLink";
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await row.getByRole("button", { name: "Save title", exact: true }).click();
  await seen;
  await rename.fill("New unsent rename");
  release();
  await expect(row.locator(".source-title strong")).toHaveText("Saved rename");
  await expect(rename).toHaveValue("New unsent rename");
  expect((await core.request("/sources")).items).toHaveLength(1);
});

test("a failed manuscript save stays owned by the editor when Add link cannot dispatch", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await openPanel(page, "Library");
  const form = page.locator(".library-link-form");
  await form.locator("summary").click();
  await page
    .getByLabel("Reference URL", { exact: true })
    .fill("https://example.org/retained");
  let rejectBody = true,
    sources = 0;
  await page.route("**/api/v1/manuscript/commands", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type === "AddSourceLink") sources++;
    if (rejectBody && command.type === "ApplyDocumentEdit")
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ code: "DOCUMENT_INVALID" }),
      });
    else await route.fallback();
  });
  const body = page.getByRole("textbox", { name: "Manuscript", exact: true });
  await body.fill("Unsaved body that must retain its own failure.");
  await body.press("ControlOrMeta+s");
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "error",
  );
  await page.mouse.move(1, 900);
  await page.waitForTimeout(3300);
  await expect(
    page.locator('.notification[data-error-code="DOCUMENT_INVALID"]'),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Add link reference", exact: true })
    .click();
  await expect(
    page.locator('.notification[data-error-code="DOCUMENT_INVALID"]'),
  ).toBeVisible();
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "error",
  );
  expect(sources).toBe(0);
  expect((await core.request("/sources")).items).toHaveLength(0);
  await expect(form).toHaveAttribute("open", "");
  await expect(body).toHaveText(
    "Unsaved body that must retain its own failure.",
  );
  rejectBody = false;
  await page
    .locator(".save-feedback")
    .getByRole("button", { name: "Recover", exact: true })
    .click();
  const recovery = page.getByRole("dialog", {
    name: "Recover local edits",
    exact: true,
  });
  const close = recovery.getByRole("button", { name: "Close", exact: true });
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  expect(
    await recovery.evaluate((node) => node.contains(document.activeElement)),
  ).toBe(true);
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(recovery).toHaveCount(0);
  await expect(
    page
      .locator(".save-feedback")
      .getByRole("button", { name: "Recover", exact: true }),
  ).toBeFocused();
  await page
    .locator(".save-feedback")
    .getByRole("button", { name: "Recover", exact: true })
    .click();
  await recovery
    .locator(".writing-dialog-body")
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
});

test("a retained unapplied outline can be used from history without another inference", async ({
  page,
  core,
}) => {
  const provider = await planningProvider();
  let release = () => {};
  try {
    await configurePlanning(
      async (path: string, body?: unknown, method?: string) => ({
        status: 200,
        data: await core.request(path, body, method),
      }),
      provider.root,
    );
    let entered = () => {};
    const seen = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.setHandler(
      async (_request: unknown, response: any, request: any) => {
        entered();
        await gate;
        const { planningOutput } = await import("../fixtures/planning.mjs");
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: { content: JSON.stringify(planningOutput(request)) },
                finish_reason: "stop",
              },
            ],
          }),
        );
      },
    );
    await openWorkbench(page);
    await openPanel(page, "AI assistant");
    await page
      .getByLabel("Your idea", { exact: true })
      .fill("A retained outline after unrelated history changes");
    await page
      .getByRole("button", { name: "Generate outline", exact: true })
      .click();
    await seen;
    await openPanel(page, "Library");
    await page.locator(".library-link-form > summary").click();
    await page
      .getByLabel("Reference URL", { exact: true })
      .fill("https://example.org/unselected");
    await page
      .getByRole("button", { name: "Add link reference", exact: true })
      .click();
    await expect(page.locator(".library-link-form")).not.toHaveAttribute(
      "open",
    );
    await projectHistory(page, "Undo");
    await expect
      .poll(async () => (await core.request("/history")).redoCount)
      .toBeGreaterThan(0);
    release();
    await expect
      .poll(async () => (await core.request("/planning")).tasks[0]?.application)
      .toBe("not_applied");
    await openPanel(page, "AI assistant");
    await page.mouse.move(1, 900);
    await page.waitForTimeout(3300);
    await page
      .getByRole("button", { name: "Generation history", exact: true })
      .click();
    const history = page.getByRole("region", {
      name: "Generation history",
      exact: true,
    });
    await expect(
      history.getByText("Ready to use", { exact: true }),
    ).toBeVisible();
    await history
      .getByRole("button", { name: "Use saved result locally", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Outline", exact: true }),
    ).toContainText("How sparrows learn 鸟鸣");
    expect(provider.calls).toHaveLength(1);
    expect((await core.request("/planning")).tasks[0].application).toBe(
      "applied",
    );
  } finally {
    release();
    await provider.close();
  }
});

test("an older recovery Retry cannot dismiss a newer desktop close decision", async ({
  page,
  core,
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
      readExports: () => request("/manuscript/exports"),
      prepareCopy: (body: unknown) => request("/manuscript/copies", body),
      onCloseAborted: () => () => {},
      health: () => request("/health"),
      readProject: () => request("/project"),
      ensureProject: (command: unknown) => request("/project/ensure", command),
      renameProject: (command: unknown) => request("/project/rename", command),
      readAiSettings: () => request("/ai/settings"),
      createProject: (command: unknown) => request("/project", command),
      readManuscript: () => request("/manuscript"),
      readPlanning: () => request("/planning"),
      readFinalization: () => request("/manuscript/finalization"),
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

  await openWorkbench(page);
  const body = page.getByRole("textbox", { name: "Manuscript", exact: true });
  await body.fill("Original saved body before recovery and native close.");
  await body.press("ControlOrMeta+s");
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
  await openPanel(page, "AI assistant");
  const input = page.getByLabel("Instruction", { exact: true });
  await input.fill("Retain this unsent Review draft through close recovery.");
  let rejectBody = true,
    holdBody = false,
    entered = () => {},
    release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const writes: any[] = [];
  core.intercept(async (_path, command, phase) => {
    if (phase === "before" && command) writes.push(command);
    if (
      phase === "after" &&
      holdBody &&
      command?.type === "ApplyDocumentEdit"
    ) {
      entered();
      await gate;
    }
  });
  await page.route("**/api/v1/manuscript/commands", async (route) => {
    const command = route.request().postDataJSON();
    if (rejectBody && command.type === "ApplyDocumentEdit")
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ code: "DOCUMENT_INVALID" }),
      });
    else await route.fallback();
  });
  try {
    await body.fill("New body input whose retry acknowledgment is held.");
    await body.press("ControlOrMeta+s");
    await expect(page.getByTestId("save-status")).toHaveAttribute(
      "data-state",
      "error",
    );
    await page
      .locator(".save-feedback")
      .getByRole("button", { name: "Recover", exact: true })
      .click();
    const recovery = page.getByRole("dialog", {
      name: "Recover local edits",
      exact: true,
    });
    rejectBody = false;
    holdBody = true;
    await recovery
      .locator(".writing-dialog-body")
      .getByRole("button", { name: "Try again", exact: true })
      .click();
    await seen;
    await page.evaluate(() => {
      (window as any).__requestClose();
    });
    await expect(
      recovery.getByRole("button", {
        name: "Retry save and close",
        exact: true,
      }),
    ).toBeVisible();
    expect(await page.evaluate(() => (window as any).__closeResults)).toEqual(
      [],
    );
    release();
    await expect(page.getByTestId("save-status")).toHaveAttribute(
      "data-state",
      "saved",
    );
    await expect(recovery).toBeVisible();
    await expect(
      recovery.getByRole("button", {
        name: "Retry save and close",
        exact: true,
      }),
    ).toBeVisible();
    expect(await page.evaluate(() => (window as any).__closeResults)).toEqual(
      [],
    );
    await recovery
      .getByRole("button", { name: "Keep local edits", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => (window as any).__closeResults))
      .toEqual([false]);
    await expect(input).toHaveValue(
      "Retain this unsent Review draft through close recovery.",
    );
    await expect(body).toHaveText(
      "New body input whose retry acknowledgment is held.",
    );
    expect(
      writes.filter((command) =>
        ["SaveReview", "StartReviewTask"].includes(command.type),
      ),
    ).toHaveLength(0);
    expect((await core.request("/reviews")).cards).toHaveLength(0);
  } finally {
    release();
  }
});

test("double-submit then Cancel aborts the owned Add link while its prerequisite save is held", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await openPanel(page, "Library");
  const form = page.locator(".library-link-form");
  await form.locator("summary").click();
  await page
    .getByLabel("Reference URL", { exact: true })
    .fill("https://example.org/cancel-owned-submit");
  const body = page.getByRole("textbox", { name: "Manuscript", exact: true });
  await body.fill(
    "Prerequisite input that must settle before adding the link.",
  );
  let entered = () => {},
    release = () => {},
    adds = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  core.intercept(async (_path, command, phase) => {
    if (phase === "before" && command?.type === "AddSourceLink") adds++;
    if (phase === "after" && command?.type === "ApplyDocumentEdit") {
      entered();
      await gate;
    }
  });
  try {
    const add = page.getByRole("button", {
      name: "Add link reference",
      exact: true,
    });
    await add.evaluate((node: HTMLButtonElement) => node.click());
    await seen;
    await add.evaluate((node: HTMLButtonElement) => node.click());
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    release();
    await expect(page.getByTestId("save-status")).toHaveAttribute(
      "data-state",
      "saved",
    );
    await expect(form).not.toHaveAttribute("open");
    await page.waitForTimeout(150);
    expect(adds).toBe(0);
    expect((await core.request("/sources")).items).toHaveLength(0);
  } finally {
    release();
  }
});
