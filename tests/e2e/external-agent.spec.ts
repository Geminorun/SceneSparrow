import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

const visual = (page: Page) => page.locator("#markdown-editor");
const composer = (page: Page) =>
  page.getByRole("textbox", { name: "Message to Agent" });
async function setup(page: Page, fixture = true) {
  await page.addInitScript(() =>
    localStorage.setItem(
      "scenesparrow.application-preferences",
      JSON.stringify({ version: 1, saveMode: "off", saveDelaySeconds: 10 }),
    ),
  );
  if (fixture)
    await page.route(/\/src\/main\.tsx(?:\?.*)?$/, (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `import ${JSON.stringify(`/@fs/${resolve("tests/fixtures/external-agent-ui.tsx")}`)};`,
      }),
    );
  await page.goto("/");
  await expect(visual(page)).toBeVisible();
}
async function seed(page: Page) {
  await visual(page).fill("First paragraph.\n\nSecond paragraph.");
  await visual(page).press("Control+s");
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
}
async function selectFirst(page: Page) {
  await page.evaluate(() => {
    (window as any).agentFixture.explicitSelection = true;
  });
  await visual(page).locator("p").first().click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page
    .getByRole("toolbar", { name: "Selection actions" })
    .getByRole("button", { name: "Ask", exact: true })
    .click();
  await expect(page.locator(".agent-context-chip")).toContainText(
    "Selected text",
  );
}
async function agent(page: Page) {
  await page.getByRole("tab", { name: "Agent", exact: true }).click();
}
async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
async function calls(page: Page, type: string) {
  return page.evaluate(
    (type) =>
      (window as any).agentFixture.calls.filter((c: any) => c.type === type),
    type,
  );
}
async function hold(page: Page, key: string, value = true) {
  await page.evaluate(
    ({ key, value }) => {
      (window as any).agentFixture[key] = value;
    },
    { key, value },
  );
}
async function release(page: Page, key = "release") {
  await page.evaluate((key) => (window as any).agentFixture[key]?.(), key);
}

test("@web-smoke EWA-AC04–05 unavailable catalog, bilingual settings and built-in writing entry", async ({
  page,
}) => {
  await setup(page, false);
  await expect(
    page.getByRole("tab", { name: "Agent", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await agent(page);
  await expect(
    page
      .locator(".agent-composer")
      .getByText(
        "Agent is unavailable. Check its connection in Settings → Agent.",
      ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Open settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(
    dialog.getByRole("heading", { name: "Agent", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Check connection" }).click();
  await expect(
    dialog.getByText(
      "Codex is not configured. Ask the server operator to connect an isolated writing runner, then check again.",
    ),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh-CN");
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeDisabled();
  await expect(
    page
      .locator(".agent-composer")
      .getByText("Agent 暂不可用。请在“设置 → Agent”中检查连接。"),
  ).toBeVisible();
});

test("EWA-AC01/04 selection proposal keeps its target across tabs and applies one exact diff", async ({
  page,
}) => {
  await setup(page);
  await seed(page);
  await selectFirst(page);
  await agent(page);
  await expect(page.locator(".agent-context-chip")).toContainText(
    "Selected text",
  );
  await hold(page, "hold");
  await send(page, "Revise this paragraph");
  await expect(page.getByText("Partial reply", { exact: true })).toBeVisible();
  await page
    .locator(".writing-view-switch")
    .getByRole("button", { name: "Outline", exact: true })
    .click();
  await release(page);
  await expect(
    page.getByText("Authoritative final reply", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Partial reply", { exact: true })).toHaveCount(0);
  await Promise.all([
    page
      .getByRole("button", { name: "Apply", exact: true })
      .dispatchEvent("click"),
    page
      .getByRole("button", { name: "Apply", exact: true })
      .dispatchEvent("click"),
  ]);
  await expect(page.getByText("Applied", { exact: true })).toBeVisible();
  await page
    .locator(".writing-view-switch")
    .getByRole("button", { name: "Manuscript", exact: true })
    .click();
  await expect(visual(page)).toContainText("Revised 中文 paragraph.");
  await expect(visual(page)).toContainText("Second paragraph.");
  expect((await calls(page, "send"))[0].body.attachment.selection.quote).toBe(
    "First paragraph.",
  );
  expect((await calls(page, "apply")).length).toBe(1);
});

test("EWA-AC02 local edits and late apply preserve input", async ({ page }) => {
  await setup(page);
  await seed(page);
  await selectFirst(page);
  await agent(page);
  await send(page, "Revise");
  await expect(
    page.getByRole("button", { name: "Apply", exact: true }),
  ).toBeVisible();
  await visual(page).locator("p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Local change");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator(".agent-turn")).toContainText(
    "The target document changed.",
  );
  await expect(visual(page)).toContainText("Local change");
  expect(await calls(page, "apply")).toHaveLength(0);
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await visual(page).press("Control+s");
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  await selectFirst(page);
  await send(page, "Revise again");
  await hold(page, "holdApply");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => !!(window as any).agentFixture.releaseApply),
    )
    .toBe(true);
  await visual(page).locator("p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Newer typing");
  await release(page, "releaseApply");
  await expect(visual(page)).toContainText("Newer typing");
  await expect(visual(page)).toContainText("First paragraph.");
  await expect(page.getByText("Applied", { exact: true })).toBeVisible();
  await expect(page.locator(".markdown-conflict")).toContainText(
    "Newer local edits are preserved",
  );
});

test("EWA-AC03 stopped streams ignore late proposals; caret questions and explicit fresh retry", async ({
  page,
}) => {
  await setup(page);
  await seed(page);
  await agent(page);
  await hold(page, "hold");
  await send(page, "What is this about?");
  await expect(page.getByText("Partial reply", { exact: true })).toBeVisible();
  expect((await calls(page, "send"))[0].body.attachment.selection).toBeNull();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await release(page);
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Apply", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Authoritative final reply", { exact: true }),
  ).toHaveCount(0);
  await hold(page, "hold", false);
  await page.getByRole("button", { name: "Retry as a new turn" }).click();
  await expect(
    page.getByText("Authoritative final reply", { exact: true }),
  ).toBeVisible();
  const sends = await calls(page, "send");
  expect(sends).toHaveLength(2);
  expect(sends[0].body.requestId).not.toBe(sends[1].body.requestId);
});

test("EWA-AC05 global defaults, conversation model and changing engine start fresh sessions", async ({
  page,
}) => {
  await setup(page);
  await agent(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Agent", exact: true }).click();
  await settings
    .getByRole("combobox", { name: "Default Agent", exact: true })
    .selectOption("claude");
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(
    page.getByRole("combobox", { name: "Agent engine" }),
  ).toHaveValue("claude");
  await send(page, "Question");
  await expect(
    page.getByText("Authoritative final reply", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Agent engine" })
    .selectOption("codex");
  await expect(page.locator(".agent-turn")).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Conversation model" })
    .selectOption("openai.gpt-5.4-mini");
  await send(page, "New model question");
  await expect(
    page.getByText("Authoritative final reply", { exact: true }),
  ).toBeVisible();
  const created = await calls(page, "create");
  expect(created.map((c) => [c.body.engineId, c.body.modelId])).toEqual([
    ["claude", "sonnet"],
    ["codex", "openai.gpt-5.4-mini"],
  ]);
  expect(await calls(page, "close")).toHaveLength(0);
});

test("EWA-AC02 a failed selected preflight save preserves local text and never sends", async ({
  page,
}) => {
  await setup(page);
  await seed(page);
  await visual(page).locator("p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" unsaved");
  await selectFirst(page);
  await agent(page);
  await page.route("**/api/v1/markdown-projects/*", async (route) => {
    if (route.request().method() === "POST")
      await route.fulfill({ status: 409, json: { code: "MARKDOWN_CONFLICT" } });
    else await route.continue();
  });
  await send(page, "Revise unsaved text");
  await expect(page.locator(".agent-turn")).toHaveAttribute(
    "data-agent-status",
    "failed",
  );
  expect(await calls(page, "send")).toHaveLength(0);
  expect(await calls(page, "create")).toHaveLength(0);
  await expect(visual(page)).toContainText("unsaved");
  await expect(composer(page)).toHaveValue("Revise unsaved text");
  await expect(page.getByTestId("save-status")).toHaveText(
    "Save failed — local edits retained",
  );
});

test("EWA-AC02 live locks reject Apply while keeping the proposal", async ({
  page,
}) => {
  await setup(page);
  await seed(page);
  await selectFirst(page);
  await agent(page);
  await send(page, "Revise");
  await expect(
    page.getByRole("button", { name: "Apply", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Lock selected blocks", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Unlock", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator(".agent-turn")).toContainText(
    "Unlock protected blocks",
  );
  await expect(
    page.getByRole("button", { name: "Discard", exact: true }),
  ).toBeVisible();
  await expect(visual(page)).toContainText("First paragraph.");
});

test("EWA-AC03 pending create can stop and a fresh send does not wait for its acknowledgment", async ({
  page,
}) => {
  await setup(page);
  await agent(page);
  await hold(page, "holdCreate");
  await send(page, "First request");
  await expect.poll(() => calls(page, "create")).toHaveLength(1);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await hold(page, "holdCreate", false);
  await send(page, "Fresh request");
  await expect(
    page.getByText("Authoritative final reply", { exact: true }),
  ).toBeVisible();
  await release(page, "releaseCreate");
  await expect.poll(() => calls(page, "close")).toHaveLength(1);
  expect(await calls(page, "send")).toHaveLength(1);
});

test("EWA-AC03 changing projects preserves the conversation and fences a late stream", async ({
  page,
}) => {
  await setup(page);
  await seed(page);
  await selectFirst(page);
  await agent(page);
  await hold(page, "hold");
  await send(page, "Revise old project");
  await expect(page.getByText("Partial reply", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "New manuscript", exact: true })
    .click();
  await expect(visual(page)).toHaveText("");
  await release(page);
  await expect(page.locator(".agent-turn")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Apply", exact: true }),
  ).toHaveCount(0);
  expect(await calls(page, "close")).toHaveLength(0);
});

test("EWA-AC04 IME Send waits, pins the original tab and keeps newer composer input", async ({
  page,
}) => {
  await setup(page);
  await seed(page);
  await selectFirst(page);
  await agent(page);
  await composer(page).fill("修改");
  await composer(page).dispatchEvent("compositionstart");
  await page
    .getByRole("button", { name: "Send", exact: true })
    .dispatchEvent("click");
  await page
    .locator(".writing-view-switch")
    .getByRole("button", { name: "Outline", exact: true })
    .dispatchEvent("click");
  expect(await calls(page, "send")).toHaveLength(0);
  await composer(page).fill("修改所选文字");
  await hold(page, "holdCreate");
  await composer(page).dispatchEvent("compositionend");
  await expect.poll(() => calls(page, "create")).toHaveLength(1);
  await composer(page).fill("A newer unsent question");
  await release(page, "releaseCreate");
  await expect(
    page.getByText("Authoritative final reply", { exact: true }),
  ).toBeVisible();
  const sent = (await calls(page, "send"))[0];
  expect(sent.body.instruction).toBe("修改所选文字");
  expect(sent.body.attachment.kind).toBe("manuscript");
  expect(sent.body.attachment.selection.quote).toBe("First paragraph.");
  await expect(composer(page)).toHaveValue("A newer unsent question");
});

test("EWA-AC05 checking repaired availability in Settings updates the visible composer", async ({
  page,
}) => {
  await setup(page);
  await hold(page, "available", false);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const initialSettings = page.getByRole("dialog", {
    name: "Settings",
    exact: true,
  });
  await initialSettings
    .getByRole("button", { name: "Agent", exact: true })
    .click();
  await initialSettings
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await initialSettings
    .getByRole("button", { name: "Close", exact: true })
    .click();

  await agent(page);
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Open settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await hold(page, "available", true);
  await settings.getByRole("button", { name: "Check connection" }).click();
  await expect(settings.getByText("Connected", { exact: true })).toHaveCount(1);
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await composer(page).fill("Question after repair");
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  expect(await calls(page, "send")).toHaveLength(0);
});

test("EWA-AC03 stopping a later turn does not strand an earlier Apply acknowledgment", async ({
  page,
}) => {
  await setup(page);
  await seed(page);
  await selectFirst(page);
  await agent(page);
  await send(page, "Revise selected text");
  await expect(
    page.getByRole("button", { name: "Apply", exact: true }),
  ).toBeVisible();
  await hold(page, "holdApply");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => !!(window as any).agentFixture.releaseApply),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Remove quote", exact: true }).click();
  await visual(page).locator("p").last().click();
  await page.keyboard.press("End");
  await expect(page.locator(".agent-context-chip")).toContainText(
    "Displayed document",
  );
  await hold(page, "hold");
  await send(page, "Question while Apply settles");
  await expect(page.getByText("Partial reply", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await release(page, "releaseApply");
  await release(page);
  await expect(page.getByText("Applied", { exact: true })).toBeVisible();
  await expect(visual(page)).toContainText("Revised 中文 paragraph.");
  expect(await calls(page, "close")).toHaveLength(0);
});

test("EWA-AC03 stopped ambiguous sends retain earlier cards' original session identity", async ({
  page,
}) => {
  await setup(page);
  await seed(page);
  await selectFirst(page);
  await agent(page);
  await send(page, "Initial proposal");
  await expect(
    page.getByRole("button", { name: "Apply", exact: true }),
  ).toBeVisible();
  await hold(page, "holdSend");
  await send(page, "Unacknowledged turn");
  await expect
    .poll(() => page.evaluate(() => !!(window as any).agentFixture.releaseSend))
    .toBe(true);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await hold(page, "holdSend", false);
  await send(page, "Fresh question");
  await expect(
    page.getByText("Authoritative final reply", { exact: true }),
  ).toHaveCount(2);
  await release(page, "releaseSend");
  await page
    .getByRole("button", { name: "Apply", exact: true })
    .first()
    .click();
  await expect(page.locator(".agent-turn").first()).toContainText(
    "This conversation is closed",
  );
  const applied = await calls(page, "apply"),
    closed = await calls(page, "close");
  expect(applied[0].body).toBe(closed[0].body);
  await expect(visual(page)).toContainText("First paragraph.");
});

test("EWA-AC02 source changes while the selected save is pending abort dispatch", async ({
  page,
}) => {
  await setup(page);
  await seed(page);
  await visual(page).locator("p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" unsaved");
  await selectFirst(page);
  await agent(page);
  let releaseSave!: () => void,
    saving = false;
  await page.route("**/api/v1/markdown-projects/*", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    saving = true;
    await new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    await route.fulfill({ response });
  });
  await send(page, "Revise selected text");
  await expect.poll(() => saving).toBe(true);
  await visual(page).locator("p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Newer text");
  releaseSave();
  await expect(page.locator(".agent-turn")).toHaveAttribute(
    "data-agent-status",
    "failed",
  );
  await expect(visual(page)).toContainText("Newer text");
  expect(await calls(page, "send")).toHaveLength(0);
});

test("EWA-AC01/04 source selections preserve surrounding raw Markdown bytes", async ({
  page,
}) => {
  await setup(page);
  const raw =
    "\ufeff# 标题\r\n\r\n```text\r\nOriginal 中文.\r\n```\r\n\r\nTail 😀\r\n";
  const response = await page.request.post("/api/v1/markdown-projects", {
    data: { text: raw },
  });
  expect(response.ok()).toBe(true);
  const project = await response.json();
  await page.goto(`/?project=${project.projectId}`);
  await expect(visual(page)).toHaveJSProperty("tagName", "TEXTAREA");
  await visual(page).focus();
  await visual(page).press("ControlOrMeta+Home");
  await visual(page).press("ArrowDown");
  await visual(page).press("ArrowDown");
  await visual(page).press("ArrowDown");
  await visual(page).press("Home");
  await visual(page).press("Shift+End");
  await page
    .locator(".source-fallback .markdown-source-actions")
    .getByRole("button", { name: "Ask", exact: true })
    .click();
  await agent(page);
  await expect(page.locator(".agent-context-chip")).toContainText(
    "Original 中文.",
  );
  await send(page, "Revise this source selection");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText("Applied", { exact: true })).toBeVisible();
  const saved = await (
    await page.request.get(`/api/v1/markdown-projects/${project.projectId}`)
  ).json();
  expect(saved.text).toBe(
    raw.replace("Original 中文.", "Revised 中文 paragraph."),
  );
});

test("AWR-AC02 ordinary selection keeps the explicitly attached Agent quote", async ({
  page,
}) => {
  await setup(page);
  await seed(page);
  await selectFirst(page);
  await visual(page).locator("p").last().click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await expect(page.locator(".agent-context-chip")).toContainText(
    "First paragraph.",
  );
  await send(page, "Revise the attached passage");
  await expect.poll(() => calls(page, "send")).toHaveLength(1);
  expect((await calls(page, "send"))[0].body.attachment.selection.quote).toBe(
    "First paragraph.",
  );
});

test("EWA-AC04 transcript scroll keeps the composer visible and keyboard focus in desktop and narrow panes", async ({
  page,
}) => {
  await setup(page);
  await agent(page);
  for (let index = 0; index < 7; index++) {
    await composer(page).fill(`Question ${index}: ${"Context ".repeat(30)}`);
    await composer(page).press("Control+Enter");
    await expect(page.locator(".agent-turn")).toHaveCount(index + 1);
    await expect(page.locator(".agent-turn").last()).toHaveAttribute(
      "data-agent-status",
      "completed",
    );
    await expect(composer(page)).toBeFocused();
  }
  expect(
    await page
      .locator(".agent-transcript")
      .evaluate((node) => node.scrollHeight > node.clientHeight),
  ).toBe(true);
  await hold(page, "hold");
  await send(page, "A long answer while I read earlier turns");
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  const transcript = page.locator(".agent-transcript");
  await transcript.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect(
    page.getByRole("button", { name: "Latest reply ↓", exact: true }),
  ).toBeVisible();
  await release(page);
  await expect(page.locator(".agent-turn").last()).toHaveAttribute(
    "data-agent-status",
    "completed",
  );
  expect(await transcript.evaluate((node) => node.scrollTop)).toBeLessThan(4);
  await page
    .getByRole("button", { name: "Latest reply ↓", exact: true })
    .click();
  await expect(composer(page)).toBeInViewport();
  await page.setViewportSize({ width: 760, height: 800 });
  await page
    .getByRole("button", { name: "Open assistant", exact: true })
    .click();
  await agent(page);
  await expect(composer(page)).toBeInViewport();
  const box = await page.locator(".agent-composer").boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(800);
  await page.screenshot({ path: ".artifacts/ewa-agent-narrow.png" });
});

for (const installation of [
  "fresh",
  "proxy",
  "unsupported",
  "misassigned",
] as const) {
  test(`DSH-AC08 ${installation}: one key and model configure writing, while conversation preferences stay independent`, async ({
    page,
  }) => {
    const view = await (await page.request.get("/api/v1/ai/settings")).json();
    view.settings.providers = [];
    view.settings.models = [];
    view.settings.bindings = [];
    view.presentCredentialRevisions = [];
    const parameters = {
      temperatureMilli: null,
      requestStreaming: false,
      requestNativeJson: false,
    };
    if (installation !== "fresh") {
      const provider = {
        id: crypto.randomUUID(),
        label: installation === "proxy" ? "DeepSeek proxy" : "Saved provider",
        adapter: "openai_compatible",
        baseUrl:
          installation === "proxy"
            ? "https://proxy.example/v1"
            : "https://api.deepseek.com/v1",
        authMode: "bearer",
        credentialRevision: "saved-key",
        revision: 1,
        ...(installation === "misassigned" ? { servicePreset: "openai" } : {}),
      };
      view.settings.providers.push(provider);
      view.presentCredentialRevisions.push("saved-key");
      view.settings.models.push({
        providerId: provider.id,
        id: "saved-unsupported-model",
        label: "Saved model",
        capabilities: Object.fromEntries(
          ["images", "streaming", "nativeJson"].map((kind) => [
            kind,
            {
              state: "unknown",
              source: "unknown",
              scope: "",
              observedAt: null,
            },
          ]),
        ),
        contextTokens: null,
        outputTokens: null,
      });
      view.settings.bindings.push({
        category: "text",
        providerId: provider.id,
        modelId: "saved-unsupported-model",
        parameters,
        revision: 1,
      });
    }
    const original = structuredClone(view.settings.bindings);
    let credentialWrites = 0;
    await page.route("**/api/v1/ai/settings", async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        expect(body.expectedRevision).toBe(view.settings.revision);
        view.settings = body.settings;
        view.settings.revision++;
      }
      await route.fulfill({ json: view });
    });
    await page.route("**/api/v1/ai/credentials", async (route) => {
      const body = route.request().postDataJSON();
      expect(body.expectedRevision).toBe(view.settings.revision);
      expect(body.secret).toBe("SYNTHETIC_SETTINGS_KEY");
      credentialWrites++;
      view.settings.providers.find(
        (p: any) => p.id === body.providerId,
      ).credentialRevision = "new-key";
      view.presentCredentialRevisions.push("new-key");
      view.settings.revision++;
      await route.fulfill({ json: view });
    });
    await page.route("**/api/v1/agent/catalog", async (route) =>
      route.fulfill({
        json: [
          {
            id: "deepseek",
            label: "DeepSeek Harness",
            available: !!view.presentCredentialRevisions.length,
            status: view.presentCredentialRevisions.length
              ? "available"
              : "not_authenticated",
            models: [
              { id: "deepseek-flash", label: "DeepSeek Flash" },
              { id: "deepseek-v4-pro", label: "DeepSeek Pro" },
            ],
          },
          {
            id: "codex",
            label: "Codex",
            available: true,
            models: [{ id: "codex-model", label: "Codex model" }],
          },
        ],
      }),
    );
    await setup(page, false);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await expect(
      settings.locator(".settings-layout > nav > button"),
    ).toHaveText(["General", "Agent"]);
    await settings.getByRole("button", { name: "Agent", exact: true }).click();
    const writing = settings.getByRole("combobox", {
      name: "Harness model for writing actions",
      exact: true,
    });
    await expect(writing).toBeVisible();
    if (installation === "unsupported" || installation === "misassigned") {
      await expect(writing).toHaveValue("saved-unsupported-model");
      await expect(writing.locator("option:checked")).toHaveText(
        "saved-unsupported-model",
      );
    } else {
      await settings
        .getByRole("textbox", { name: "New API key", exact: true })
        .fill("SYNTHETIC_SETTINGS_KEY");
      await settings
        .getByRole("button", { name: "Save new key", exact: true })
        .click();
      await expect.poll(() => credentialWrites).toBe(1);
      await expect(
        settings.getByRole("textbox", { name: "New API key", exact: true }),
      ).toHaveValue("");
    }
    expect(view.settings.bindings).toEqual(original);
    await writing.selectOption("deepseek-flash");
    await expect
      .poll(() => view.settings.bindings[0]?.modelId)
      .toBe("deepseek-flash");
    await expect(
      settings.getByRole("combobox", {
        name: "Default Agent model",
        exact: true,
      }),
    ).toHaveCount(0);
    await writing.selectOption("deepseek-v4-pro");
    await expect
      .poll(() => view.settings.bindings[0]?.modelId)
      .toBe("deepseek-v4-pro");
    if (installation === "fresh") {
      await expect(page.locator(".notifications > *")).toHaveCount(0);
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.screenshot({
        path: ".artifacts/awr-provider-settings-1280.png",
      });
    }
    await settings
      .getByRole("combobox", { name: "Default Agent", exact: true })
      .selectOption("codex");
    await expect(
      settings.getByRole("combobox", { name: "Default Agent", exact: true }),
    ).toHaveValue("codex");
    await expect(settings.locator(".agent-settings > article")).toHaveCount(1);
    await expect(
      settings.getByRole("button", { name: "Test model", exact: true }),
    ).toHaveCount(0);
    expect(credentialWrites).toBe(
      installation === "unsupported" || installation === "misassigned" ? 0 : 1,
    );
    await settings
      .getByText("Advanced: direct API compatibility", { exact: true })
      .click();
    await settings
      .getByRole("button", { name: "Default models", exact: true })
      .click();
    await expect(
      settings.getByLabel("Manuscript model", { exact: true }),
    ).toHaveValue("harness");
    await expect(
      settings
        .getByLabel("Manuscript model", { exact: true })
        .locator("option")
        .filter({ hasText: "DeepSeek Pro" }),
    ).toHaveCount(0);
    if (installation === "proxy") {
      await settings
        .getByLabel("Manuscript model", { exact: true })
        .selectOption(
          JSON.stringify([original[0].providerId, original[0].modelId]),
        );
      await expect
        .poll(() => view.settings.bindings[0]?.providerId)
        .toBe(original[0].providerId);
    }
    await settings
      .getByRole("button", { name: "Model services", exact: true })
      .click();
    const services = settings.locator(".ai-service-list");
    await expect(
      services.getByRole("button", { name: /^DeepSeek/ }),
    ).toHaveCount(installation === "proxy" ? 1 : 0);
    if (installation === "misassigned") {
      await expect(
        settings.getByRole("textbox", { name: "API root", exact: true }),
      ).toHaveCount(0);
    }
    if (installation === "proxy") {
      await services.getByRole("button", { name: /DeepSeek proxy/ }).click();
      await expect(
        settings.getByRole("textbox", { name: "API root", exact: true }),
      ).toHaveValue("https://proxy.example/v1");
    }
  });
}
