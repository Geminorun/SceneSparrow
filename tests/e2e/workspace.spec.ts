import { test, expect } from "./helpers/core";
import {
  openWorkbench,
  openPanel,
  startManualDraft,
  openAiSettings,
} from "./helpers/workbench";

test("fresh storage opens one persisted workspace across tabs and reload, with settings closed", async ({
  page,
  context,
  core,
}) => {
  expect((await core.request("/project")).project).toBeNull();
  let settingsReads = 0;
  context.on("request", (request) => {
    if (request.url().endsWith("/ai/settings")) settingsReads++;
  });
  const second = await context.newPage();
  await Promise.all([openWorkbench(page), openWorkbench(second)]);
  const project = (await core.request("/project")).project;
  expect(project.title).toBe("Untitled project");
  await expect(page.getByTestId("project-title")).toHaveText(
    "Untitled project",
  );
  await expect(second.locator("[data-project-id]")).toHaveAttribute(
    "data-project-id",
    project.id,
  );
  await expect(
    page.getByRole("textbox", { name: "Manuscript", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(settingsReads).toBe(0);
  await page.reload();
  await expect(page.locator("[data-project-id]")).toHaveAttribute(
    "data-project-id",
    project.id,
  );
  expect((await core.request("/project")).project.id).toBe(project.id);
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.screenshot({
    path: ".artifacts/workbench-normal.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 820 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    375,
  );
  await page.screenshot({
    path: ".artifacts/workbench-narrow.png",
    fullPage: true,
  });
  await second.close();
});

test("Unicode rename preserves identity, manuscript, history and editor through locale changes", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await openPanel(page, "Planning");
  await startManualDraft(page);
  const editor = page.getByRole("textbox", { name: "Manuscript", exact: true });
  const closedGroup = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/manuscript/commands") &&
      response.request().method() === "POST" &&
      response.ok() &&
      response.request().postDataJSON().type === "CloseEditGroup",
  );
  await editor.fill("A manuscript 中文 🐦");
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
  const node = await editor.elementHandle();
  await page.locator(".project-menu > summary").click();
  await page
    .getByRole("button", { name: "Project settings", exact: true })
    .click();
  expect(await (await closedGroup).finished()).toBeNull();
  // The timed save publishes the locally closed typing group. Metadata settings
  // preserve that history and do not create another manuscript transition.
  const before = await core.request("/project"),
    manuscript = await core.request("/manuscript"),
    history = await core.request("/history");
  await page
    .getByLabel("Project name", { exact: true })
    .fill("鸟鸣 / Scene 🐦");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(page.getByTestId("project-title")).toHaveText("鸟鸣 / Scene 🐦");
  expect((await core.request("/project")).project.id).toBe(before.project.id);
  expect(await core.request("/manuscript")).toEqual(manuscript);
  expect(await core.request("/history")).toEqual(history);
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh-CN");
  expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(page.getByTestId("project-title")).toHaveText("鸟鸣 / Scene 🐦");
  await page.reload();
  await expect(page.getByTestId("project-title")).toHaveText("鸟鸣 / Scene 🐦");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(
    page.getByRole("textbox", { name: "文稿", exact: true }),
  ).toContainText("A manuscript 中文 🐦");
});

test("settings trap focus, preserve local failed saves, clear unsaved keys and exclude modal undo", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await openPanel(page, "Planning");
  await startManualDraft(page);
  const editor = page.getByRole("textbox", { name: "Manuscript", exact: true });
  const closedGroup = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/manuscript/commands") &&
      response.request().method() === "POST" &&
      response.ok() &&
      response.request().postDataJSON().type === "CloseEditGroup",
  );
  await editor.fill("Saved body");
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
  // The saved document has an available project undo. A modal button must not
  // route its shortcut to that history even when no pending save blocks it.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  expect(await (await closedGroup).finished()).toBeNull();
  const saved = await core.request("/manuscript"),
    history = await core.request("/history");
  await page
    .getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .focus();
  await page.keyboard.press("ControlOrMeta+z");
  expect(await core.request("/history")).toEqual(history);
  await page.keyboard.press("Escape");
  await expect(editor).toHaveText("Saved body");
  const node = await editor.elementHandle();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await page.route("**/api/v1/manuscript/commands", async (route) => {
    entered();
    await held;
    await route.abort("failed");
  });
  await editor.fill("Local unsaved 中文 🐦");
  await started;
  await openAiSettings(page);
  await expect(
    page.getByRole("button", {
      name: "Manage saved configurations",
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByLabel("API root", { exact: true })
    .fill("http://localhost:11434/v1");
  await page
    .getByRole("button", { name: "Save configuration", exact: true })
    .click();
  await page.getByRole("button", { name: "Add model", exact: true }).click();
  const addModel = page.getByRole("dialog", { name: "Add model", exact: true });
  await addModel
    .getByLabel("Model ID (manual entry supported)", { exact: true })
    .fill("local-fixture");
  await addModel
    .getByRole("button", { name: "Add model", exact: true })
    .click();
  await expect(addModel).not.toBeVisible();
  const advanced = page.locator(".ai-advanced");
  await expect(advanced).not.toHaveAttribute("open", "");
  await expect(
    page.getByLabel("Maximum output tokens", { exact: true }),
  ).not.toBeVisible();
  await page
    .getByLabel("New API key", { exact: true })
    .fill("UNSAVED_SYNTHETIC_KEY");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("button", { name: "Close", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(
        () => !!document.activeElement?.closest("dialog[open]"),
      ),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeFocused();
  expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(editor).toHaveText("Local unsaved 中文 🐦");
  release();
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "error",
  );
  await openAiSettings(page);
  await expect(page.getByLabel("New API key", { exact: true })).toHaveValue("");
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.screenshot({ path: ".artifacts/workbench-settings.png" });
  await page.keyboard.press("Escape");
  expect(await core.request("/manuscript")).toEqual(saved);
  expect(await core.request("/history")).toEqual(history);
  expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(editor).toHaveText("Local unsaved 中文 🐦");
});

test("read errors never create a project; ambiguous bootstrap retries reuse the command", async ({
  page,
  core,
}) => {
  let readsFail = true,
    ensures = 0;
  const commands: unknown[] = [];
  await page.route("**/api/v1/project", async (route) => {
    if (readsFail)
      await route.fulfill({ status: 503, json: { code: "UNAVAILABLE" } });
    else await route.fulfill({ json: { project: null } });
  });
  await page.route("**/api/v1/project/ensure", async (route) => {
    const command = route.request().postDataJSON();
    commands.push(command);
    ensures++;
    const response = await core.request("/project/ensure", command);
    if (ensures === 1) await route.abort("failed");
    else await route.fulfill({ json: response });
  });
  await page.goto("/");
  await expect(page.getByTestId("workspace-skeleton")).toBeVisible();
  await expect(page.locator("#workbench > .error[role=alert]")).toHaveCount(0);
  await expect(page.locator("[contenteditable=true]")).toHaveCount(0);
  await expect(page.getByTestId("transport-failure")).toBeVisible();
  expect(ensures).toBe(0);
  expect((await core.request("/project")).project).toBeNull();
  readsFail = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect.poll(() => ensures).toBe(1);
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator("[data-project-id]")).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[0]).toEqual(commands[1]);
});

test("rename retries retain command identity, refresh stale titles and never reduce a concurrent manuscript revision", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await openPanel(page, "Planning");
  await startManualDraft(page);
  const editor = page.getByRole("textbox", { name: "Manuscript", exact: true });
  await editor.fill("Before rename");
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
  let release: () => void = () => {},
    entered: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let attempt = 0,
    allowProjection = false;
  const commands: any[] = [];
  await page.route("**/api/v1/project/rename", async (route) => {
    const command = route.request().postDataJSON();
    commands.push(command);
    attempt++;
    if (attempt <= 3) {
      const response = await core.request("/project/rename", command);
      if (attempt === 1) {
        entered();
        await gate;
      }
      if (attempt === 2) await route.abort("failed");
      else await route.fulfill({ json: response });
    } else {
      allowProjection = true;
      await route.fallback();
    }
  });
  await page.locator(".project-menu > summary").click();
  await page
    .getByRole("button", { name: "Project settings", exact: true })
    .click();
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Delayed metadata");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await started;
  await page.keyboard.press("Escape");
  await editor.fill("Saved while metadata response is held");
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
  const revision = (await core.request("/project")).project.workingRevision;
  release();
  await expect(page.getByTestId("project-title")).toHaveText(
    "Delayed metadata",
  );
  await expect(page.locator(".project-meta")).toHaveText(
    `Working revision ${revision}`,
  );
  await page.locator(".project-menu > summary").click();
  await page
    .getByRole("button", { name: "Project settings", exact: true })
    .click();
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Receipt retry 🐦");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Project settings", exact: true })
      .locator(".notification[data-tone=error]"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page
      .locator(".notification")
      .getByRole("button", { name: "Review changes", exact: true }),
  ).toHaveCount(0);
  await page.locator(".project-menu > summary").click();
  await page
    .getByRole("button", { name: "Project settings", exact: true })
    .click();
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    "Receipt retry 🐦",
  );
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(page.getByTestId("project-title")).toHaveText(
    "Receipt retry 🐦",
  );
  expect(commands[1]).toEqual(commands[2]);
  const project = (await core.request("/project")).project;
  // Hold the old projection until submission so an SSE resync cannot turn the
  // intended stale-CAS scenario into a valid rename before the user clicks Save.
  await page.route("**/api/v1/project", async (route) => {
    if (allowProjection) await route.fallback();
    else await route.fulfill({ json: { project } });
  });
  await core.request("/project/rename", {
    requestId: crypto.randomUUID(),
    projectId: project.id,
    previousTitle: project.title,
    title: "External title",
  });
  await page.locator(".project-menu > summary").click();
  await page
    .getByRole("button", { name: "Project settings", exact: true })
    .click();
  await page
    .getByLabel("Project name", { exact: true })
    .fill("My preserved proposal");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(page.getByTestId("project-title")).toHaveText("External title");
  await expect(
    page.locator('.notification[data-error-code="renameConflict"]'),
  ).toBeVisible();
  await expect(
    page.getByLabel("Project name", { exact: true }),
  ).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator(".rename-dialog form [role=alert]")).toHaveCount(0);
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    "My preserved proposal",
  );
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(page.getByTestId("project-title")).toHaveText(
    "My preserved proposal",
  );
  await expect(editor).toContainText("Saved while metadata response is held");
  const oldProjection = await core.request("/project");
  let readEntered: () => void = () => {},
    releaseRead: () => void = () => {},
    delivered: () => void = () => {};
  const pendingRead = new Promise<void>((resolve) => {
    readEntered = resolve;
  });
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const readDelivered = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  let holdRead = true;
  await page.route("**/api/v1/project", async (route) => {
    if (!holdRead) {
      await route.fallback();
      return;
    }
    holdRead = false;
    readEntered();
    await readGate;
    await route.fulfill({ json: oldProjection });
    delivered();
  });
  // The isolated event stream reconnects with resync_required, starting this
  // read before the next metadata command without mutating the manuscript.
  await pendingRead;
  await page.locator(".project-menu > summary").click();
  await page
    .getByRole("button", { name: "Project settings", exact: true })
    .click();
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Newer title survives old read");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(page.getByTestId("project-title")).toHaveText(
    "Newer title survives old read",
  );
  releaseRead();
  await readDelivered;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.getByTestId("project-title")).toHaveText(
    "Newer title survives old read",
  );
});

test("desktop recent navigation renders safe titles and preserves the editor on cancel or switch failure", async ({
  page,
  core,
}) => {
  await page.addInitScript(() => {
    const host = window as any;
    host.__recentOpened = [];
    host.__pickCount = 0;
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(`/api/v1${path}`, {
        method: body ? "POST" : "GET",
        headers: { "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      return response.ok ? { ok: true, data } : { ok: false, code: data.code };
    };
    const reads = {
      readProject: "/project",
      readManuscript: "/manuscript",
      readPlanning: "/planning",
      readHistory: "/history",
      readSources: "/sources",
      readReviews: "/reviews",
      readFinalization: "/manuscript/finalization",
      readExports: "/manuscript/exports",
      readAiSettings: "/ai/settings",
    };
    host.sceneSparrow = {
      ...Object.fromEntries(
        Object.entries(reads).map(([method, path]) => [
          method,
          () => request(path),
        ]),
      ),
      ensureProject: (command: unknown) => request("/project/ensure", command),
      renameProject: (command: unknown) => request("/project/rename", command),
      executeManuscript: (command: unknown) =>
        request("/manuscript/commands", command),
      commandReceipt: (id: string) => request(`/commands/${id}`),
      subscribeEvents: () => () => {},
      onCloseRequested: () => () => {},
      onCloseAborted: () => () => {},
      onFileIntakeProgress: () => () => {},
      readRecentProjects: async () => ({
        ok: true,
        data: [
          {
            id: "opaque-host-locator",
            title: "<img src=x onerror=alert(1)> 中文",
          },
        ],
      }),
      pickProject: async () => {
        host.__pickCount++;
        return { ok: true, data: null };
      },
      openRecentProject: async (id: string) => {
        host.__recentOpened.push(id);
        return { ok: false, code: "PROJECT_OPEN_FAILED" };
      },
    };
  });
  await openWorkbench(page);
  await openPanel(page, "Planning");
  await startManualDraft(page);
  const editor = page.getByRole("textbox", { name: "Manuscript", exact: true });
  await editor.fill("Original project remains available");
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
  const node = await editor.elementHandle(),
    project = (await core.request("/project")).project;
  await page.getByText("Application menu", { exact: true }).click();
  const files = page.getByRole("navigation", {
    name: "Application menu",
    exact: true,
  });
  await files
    .getByRole("button", { name: "Open project…", exact: true })
    .click();
  expect(await page.evaluate(() => (window as any).__pickCount)).toBe(1);
  await files
    .getByRole("button", {
      name: "<img src=x onerror=alert(1)> 中文",
      exact: true,
    })
    .click();
  await expect(files.getByRole("status")).toContainText(
    "The project could not be opened",
  );
  expect(await page.evaluate(() => (window as any).__recentOpened)).toEqual([
    "opaque-host-locator",
  ]);
  await expect(files.locator("img")).toHaveCount(0);
  await expect(files).not.toContainText("opaque-host-locator");
  expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(editor).toContainText("Original project remains available");
  expect((await core.request("/project")).project.id).toBe(project.id);
});

test("a long project name stays compact at desktop and narrow widths with the full name available", async ({
  page,
}) => {
  await openWorkbench(page);
  await openPanel(page, "Planning");
  await startManualDraft(page);
  const editor = page.getByRole("textbox", { name: "Manuscript", exact: true });
  await editor.fill(
    "A quiet place to shape an idea.\n把想法写成清晰的文稿。\nThe manuscript stays at the center of the workbench.",
  );
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
  const title = "鸟鸣与城市的故事 🐦 ".repeat(8);
  await page.locator(".project-menu > summary").click();
  await page
    .getByRole("button", { name: "Project settings", exact: true })
    .click();
  await page.getByLabel("Project name", { exact: true }).fill(title);
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(page.getByTestId("project-title")).toHaveText(title.trim());
  for (const width of [1200, 768, 375]) {
    await page.setViewportSize({ width, height: 820 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    const menu = page.locator(".project-menu");
    if (!(await menu.evaluate((node: HTMLDetailsElement) => node.open)))
      await menu.locator(":scope > summary").click();
    const heading = page.getByTestId("project-title");
    await expect(heading).toHaveAttribute("title", title.trim());
    expect((await heading.boundingBox())!.width).toBeLessThanOrEqual(
      width - 40,
    );
    await menu.locator(":scope > summary").click();
    await expect(page.locator(".project-heading")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Lock block", exact: true }).first(),
    ).toBeVisible();
    await page.screenshot({
      path: `.artifacts/workbench-draft-${width}.png`,
      fullPage: true,
    });
  }
});

test("a fresh Chinese workspace keeps its name when the interface language changes", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("scenesparrow.locale", "zh-CN"),
  );
  await page.goto("/");
  await expect(page.getByTestId("project-title")).toHaveText("未命名项目");
  await page
    .getByRole("combobox", { name: "语言", exact: true })
    .selectOption("en");
  await expect(page.getByTestId("project-title")).toHaveText("未命名项目");
});

test("planning retains the same local input through settings, rename and language changes after a failed save", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await openPanel(page, "Planning");
  const topic = page.getByLabel("Your idea", { exact: true });
  const node = await topic.elementHandle();
  const saved = await core.request("/planning");
  await page.route("**/api/v1/manuscript/commands", async (route) => {
    if (route.request().postDataJSON().type === "SavePlanning")
      await route.abort("failed");
    else await route.fallback();
  });
  await topic.fill("Local planning 中文 🐦");
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "error",
  );
  await openAiSettings(page);
  await page.keyboard.press("Escape");
  await page.locator(".project-menu > summary").click();
  await page
    .getByRole("button", { name: "Project settings", exact: true })
    .click();
  await page.getByLabel("Project name", { exact: true }).fill("Planning title");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(page.getByTestId("project-title")).toHaveText("Planning title");
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh-CN");
  expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
  expect(await node!.inputValue()).toBe("Local planning 中文 🐦");
  expect(await core.request("/planning")).toEqual(saved);
});

test("startup keeps normal pane geometry while project and manuscript reads wait, with top-layer manuscript retry", async ({
  page,
  core,
}) => {
  let release: () => void = () => {},
    readStarted: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  let manuscriptFails = true,
    settingsReads = 0,
    ensures = 0;
  core.intercept(async (path, _body, phase) => {
    if (phase !== "before") return;
    if (path.endsWith("/ai/settings")) settingsReads++;
    if (path.endsWith("/project/ensure")) ensures++;
    if (path.endsWith("/project")) {
      readStarted();
      await gate;
    }
  });
  await page.route("**/api/v1/manuscript", async (route) => {
    if (manuscriptFails)
      await route.fulfill({ status: 503, json: { code: "UNAVAILABLE" } });
    else await route.fallback();
  });
  try {
    await page.goto("/");
    await started;
    const skeleton = page.getByTestId("workspace-skeleton");
    await expect(skeleton).toHaveAttribute("aria-busy", "true");
    await expect(page.locator(".workspace-header")).toBeVisible();
    await expect(page.locator(".editor-workspace-grid")).toBeVisible();
    await expect(page.locator("[contenteditable=true]")).toHaveCount(0);
    const pendingBox = await page.locator(".manuscript-main").boundingBox();
    await page.screenshot({
      path: ".artifacts/workspace-startup-skeleton.png",
    });
    release();
    const notice = page.locator('.notification[data-tone="error"]').filter({
      has: page.getByRole("button", { name: "Try again", exact: true }),
    });
    await expect(notice).toBeVisible();
    await expect(skeleton).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("[contenteditable=true]")).toHaveCount(0);
    expect(ensures).toBe(1);
    manuscriptFails = false;
    await notice
      .getByRole("button", { name: "Try again", exact: true })
      .click();
    await expect(page.getByTestId("save-status")).toBeVisible();
    await expect(skeleton).toHaveCount(0);
    const loadedBox = await page.locator(".manuscript-main").boundingBox();
    expect(loadedBox!.x).toBeCloseTo(pendingBox!.x, 0);
    expect(loadedBox!.width).toBeCloseTo(pendingBox!.width, 0);
    expect(settingsReads).toBe(0);
    expect(ensures).toBe(1);
  } finally {
    release();
  }
});

test("planning save retry waits for settlement and reports a repeated failure with retained local input", async ({
  page,
  core,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "scenesparrow.application-preferences",
      JSON.stringify({ version: 1, saveMode: "off", saveDelaySeconds: 10 }),
    ),
  );
  await openWorkbench(page);
  await openPanel(page, "Planning");
  let attempts = 0,
    release: () => void = () => {},
    retryEntered: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    retryEntered = resolve;
  });
  await page.route("**/api/v1/manuscript/commands", async (route) => {
    if (route.request().postDataJSON().type !== "SavePlanning") {
      await route.fallback();
      return;
    }
    attempts++;
    if (attempts === 2) {
      retryEntered();
      await gate;
    }
    if (attempts < 3)
      await route.fulfill({
        status: 422,
        json: { code: "BRIEF_INVALID" },
      });
    else await route.fallback();
  });
  try {
    const topic = page.getByLabel("Your idea", { exact: true });
    await topic.fill("Local planning survives repeated failure 中文");
    await topic.press("ControlOrMeta+s");
    const retry = page
      .locator(".notification")
      .getByRole("button", { name: "Try again", exact: true });
    await expect(retry).toBeVisible();
    await expect(page.getByTestId("save-status")).toHaveAttribute(
      "data-owner",
      "planning",
    );
    await retry.click();
    await entered;
    await expect(retry).toHaveCount(0);
    await expect(topic).toHaveValue(
      "Local planning survives repeated failure 中文",
    );
    release();
    await expect(retry).toBeVisible();
    await expect(page.getByTestId("save-status")).toHaveAttribute(
      "data-state",
      "error",
    );
    expect(attempts).toBe(2);
    await retry.click();
    await expect(page.getByTestId("save-status")).toHaveAttribute(
      "data-state",
      "saved",
    );
    expect(attempts).toBe(3);
    expect((await core.request("/planning")).content.brief.topic).toBe(
      "Local planning survives repeated failure 中文",
    );
    await expect(retry).toHaveCount(0);
  } finally {
    release();
  }
});
