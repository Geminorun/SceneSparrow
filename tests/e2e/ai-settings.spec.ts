import { openWorkbench, openAiSettings } from "./helpers/workbench";
import { test, expect } from "./helpers/core";
import type { Page } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

async function fixture(list = false) {
  const targets: Array<{
    path: string | undefined;
    body: string;
    auth: string | undefined;
  }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    targets.push({
      path: request.url,
      body,
      auth: request.headers.authorization,
    });
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/models")) {
      response.statusCode = list ? 200 : 405;
      response.end(
        list
          ? JSON.stringify({
              data: [{ id: "catalog-one" }, { id: "catalog-two" }],
            })
          : '{"error":{"message":"No list"}}',
      );
    } else
      response.end(
        JSON.stringify({
          choices: [
            { message: { content: "OK" }, finish_reason: "stop", index: 0 },
          ],
        }),
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    root: `http://127.0.0.1:${(server.address() as { port: number }).port}/custom`,
    targets,
    calls: () => targets.filter((target) => !target.path?.endsWith("/models")),
    lists: () => targets.filter((target) => target.path?.endsWith("/models")),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
async function configure(
  page: Page,
  root: string,
  key = "SYNTHETIC_UI_KEY_CANARY",
) {
  await page.getByLabel("API root", { exact: true }).fill(root);
  await page.getByLabel("New API key", { exact: true }).fill(key);
  await page
    .getByRole("button", { name: "Save configuration", exact: true })
    .click();
  await expect(
    page.getByText("Configuration saved.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("New API key", { exact: true })).toHaveValue("");
}
async function addModel(page: Page, id: string) {
  await page.getByRole("button", { name: "Add model", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Add model", exact: true });
  await modal
    .getByLabel("Model ID (manual entry supported)", { exact: true })
    .fill(id);
  await modal.getByRole("button", { name: "Add model", exact: true }).click();
  await expect(modal).not.toBeVisible();
}
const modelRow = (page: Page, id: string) =>
  page
    .locator(".ai-model-row")
    .filter({ has: page.getByText(id, { exact: true }) });
async function openModel(page: Page, id: string) {
  const row = modelRow(page, id);
  await row.locator(":scope > details > summary").click();
  return row;
}
async function selectService(page: Page, label: string) {
  const back = page.getByRole("button", {
    name: "Back to services",
    exact: true,
  });
  if (await back.isVisible()) await back.click();
  await page
    .locator(".ai-service-list > button")
    .filter({ hasText: label })
    .click();
}

test("two bilingual services support manual models after discovery failure and explicit inference without silently changing defaults", async ({
  page,
  core,
}) => {
  const provider = await fixture();
  try {
    await openWorkbench(page);
    await openAiSettings(page);
    await expect(page.locator(".ai-service-list > button")).toHaveCount(3);
    await expect(
      page.getByText(
        "Keys are kept in memory for this app session only. Restarting loses them.",
      ),
    ).toBeVisible();
    await configure(page, provider.root);
    await expect(
      page.getByText("Key saved ••••", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Discover models", exact: true })
      .click();
    const discovery = page.getByRole("dialog", {
      name: "Discover models",
      exact: true,
    });
    await expect(discovery.getByRole("alert")).toBeVisible();
    await discovery.getByRole("button", { name: "Close", exact: true }).click();
    await addModel(page, "manual-fixture");
    expect((await core.request("/ai/settings")).settings.bindings).toEqual([]);
    expect(provider.lists()).toHaveLength(1);
    expect(provider.calls()).toHaveLength(0);
    const row = await openModel(page, "manual-fixture");
    await row
      .getByRole("button", { name: "Set as manuscript model", exact: true })
      .click();
    await expect(
      row.getByText("Manuscript default", { exact: true }),
    ).toBeVisible();
    const bindingBefore = (await core.request("/ai/settings")).settings
      .bindings;
    expect(bindingBefore[0].parameters.maxOutputTokens).toBe(4096);
    let loseTestResponse = true;
    const actions: unknown[] = [];
    core.intercept(async (path, body, phase) => {
      if (path.endsWith("/connection-tests") && phase === "before")
        actions.push(body);
      if (
        path.endsWith("/connection-tests") &&
        phase === "after" &&
        loseTestResponse
      ) {
        loseTestResponse = false;
        return "abort";
      }
    });
    await row
      .getByRole("button", { name: "Run a new inference test", exact: true })
      .click();
    await expect(
      row.getByRole("button", { name: "Resolve submitted test", exact: true }),
    ).toBeEnabled();
    await page.keyboard.press("Escape");
    await openAiSettings(page);
    await row
      .getByRole("button", { name: "Resolve submitted test", exact: true })
      .click();
    await expect(
      row.getByText(
        "Text test succeeded. Other capabilities remain unverified.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(provider.calls()).toHaveLength(1);
    expect(actions).toHaveLength(2);
    expect(actions[0]).toEqual(actions[1]);
    await selectService(page, "DeepSeek");
    await configure(
      page,
      provider.root.replace("/custom", "/second"),
      "SYNTHETIC_UI_B_KEY",
    );
    await addModel(page, "manual-model-B");
    const second = await openModel(page, "manual-model-B");
    await second
      .getByRole("button", { name: "Run a new inference test", exact: true })
      .click();
    await expect(
      second.getByText(
        "Text test succeeded. Other capabilities remain unverified.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(provider.calls()).toHaveLength(2);
    expect(provider.calls().at(-1)?.path).toBe("/second/chat/completions");
    expect(JSON.parse(provider.calls().at(-1)!.body).model).toBe(
      "manual-model-B",
    );
    expect(provider.calls().at(-1)?.auth).toBe("Bearer SYNTHETIC_UI_B_KEY");
    expect((await core.request("/ai/settings")).settings.bindings).toEqual(
      bindingBefore,
    );
    await expect(
      second.getByText(
        `Submitted test: manual-model-B · ${provider.root.replace("/custom", "/second")}`,
        { exact: true },
      ),
    ).toBeVisible();
    await second
      .getByRole("button", { name: "Remove model", exact: true })
      .click();
    await expect(second).toHaveCount(0);
    await selectService(page, "OpenAI");
    await openModel(page, "manual-fixture");
    await expect(
      row.getByRole("button", { name: "Remove model", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Default models", exact: true })
      .click();
    await expect(
      page.getByLabel("Manuscript model", { exact: true }),
    ).toHaveValue(
      JSON.stringify([bindingBefore[0].providerId, "manual-fixture"]),
    );
    await page.getByLabel("Manuscript model", { exact: true }).selectOption("");
    await expect
      .poll(
        async () =>
          (await core.request("/ai/settings")).settings.bindings.length,
      )
      .toBe(0);
    const exposure = await page.evaluate(() =>
      JSON.stringify({
        text: document.body.textContent,
        storage: { ...localStorage, ...sessionStorage },
      }),
    );
    expect(exposure).not.toContain("SYNTHETIC_UI_KEY_CANARY");
    expect(exposure).not.toContain("SYNTHETIC_UI_B_KEY");
    await page.keyboard.press("Escape");
    await page
      .getByRole("combobox", { name: "Language", exact: true })
      .selectOption("zh-CN");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "模型服务", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "管理已存配置", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("音频 — 预留，尚不可用", { exact: true }),
    ).toHaveCount(0);
    expect(provider.calls()).toHaveLength(2);
    await page.screenshot({ path: ".artifacts/model-services-zh.png" });
  } finally {
    await provider.close();
  }
});

test("a second explicit test replaces a receipt; resolving its ambiguous action keeps the original ID and repeated clicks dispatch once", async ({
  page,
  core,
}) => {
  const provider = await fixture();
  try {
    await openWorkbench(page);
    await openAiSettings(page);
    await configure(page, provider.root);
    await addModel(page, "same-model");
    const row = await openModel(page, "same-model"),
      fresh = row.getByRole("button", {
        name: "Run a new inference test",
        exact: true,
      });
    const success = row.getByText(
      "Text test succeeded. Other capabilities remain unverified.",
      { exact: true },
    );
    await fresh.click();
    await expect(success).toBeVisible();
    let lose = true;
    const actions: unknown[] = [];
    core.intercept(async (path, body, phase) => {
      if (path.endsWith("/connection-tests") && phase === "before")
        actions.push(body);
      if (path.endsWith("/connection-tests") && phase === "after" && lose) {
        lose = false;
        return "abort";
      }
    });
    // Dispatch both DOM clicks in the same task, before React's busy render.
    await fresh.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect(
      row.getByRole("button", { name: "Resolve submitted test", exact: true }),
    ).toBeEnabled();
    await expect(success).not.toBeVisible();
    expect(provider.calls()).toHaveLength(2);
    await page.keyboard.press("Escape");
    await openAiSettings(page);
    await expect(success).not.toBeVisible();
    await row
      .getByRole("button", { name: "Resolve submitted test", exact: true })
      .click();
    await expect(success).toBeVisible();
    expect(actions).toHaveLength(2);
    expect(actions[0]).toEqual(actions[1]);
    expect(provider.calls()).toHaveLength(2);
    await page
      .getByLabel("API root", { exact: true })
      .fill(provider.root + "/edited");
    await expect(success).not.toBeVisible();
    await expect(fresh).toBeDisabled();
    expect(provider.calls()).toHaveLength(2);
  } finally {
    await provider.close();
  }
});

test("catalog selection persists only added models; service switching isolates delayed results, drafts and secrets with modal focus", async ({
  page,
  core,
}) => {
  const provider = await fixture(true);
  let release: () => void = () => {};
  try {
    await openWorkbench(page);
    await openAiSettings(page);
    await configure(page, provider.root);
    await page
      .getByRole("button", { name: "Discover models", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Discover models",
      exact: true,
    });
    await expect(
      dialog.getByLabel("catalog-two", { exact: true }),
    ).toBeVisible();
    await dialog.getByLabel("Search models", { exact: true }).fill("one");
    await expect(dialog.getByLabel("catalog-two", { exact: true })).toHaveCount(
      0,
    );
    await dialog.getByLabel("catalog-one", { exact: true }).check();
    await dialog
      .getByRole("button", { name: "Add selected models", exact: true })
      .click();
    await expect
      .poll(async () =>
        (await core.request("/ai/settings")).settings.models.map(
          (model: { id: string }) => model.id,
        ),
      )
      .toEqual(["catalog-one"]);
    await dialog.getByRole("button", { name: "Close", exact: true }).focus();
    await page.keyboard.press("Shift+Tab");
    expect(
      await page.evaluate(
        () => !!document.activeElement?.closest(".ai-picker-dialog"),
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Discover models", exact: true }),
    ).toBeFocused();
    const row = await openModel(page, "catalog-one");
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    core.intercept(async (path, _body, phase) => {
      if (path.endsWith("/connection-tests") && phase === "after") {
        entered();
        await held;
      }
    });
    await row
      .getByRole("button", { name: "Run a new inference test", exact: true })
      .click();
    await started;
    await selectService(page, "DeepSeek");
    await expect(page.getByLabel("API root", { exact: true })).toHaveValue(
      "https://api.deepseek.com/v1",
    );
    await page
      .getByLabel("New API key", { exact: true })
      .fill("UNSAVED_DEEPSEEK_CANARY");
    await page
      .getByLabel("API root", { exact: true })
      .fill("https://proxy.example/v1");
    release();
    await expect(
      page.getByText(
        "Text test succeeded. Other capabilities remain unverified.",
        { exact: true },
      ),
    ).not.toBeVisible();
    await selectService(page, "OpenAI");
    await openModel(page, "catalog-one");
    await expect(
      row.getByText(
        "Text test succeeded. Other capabilities remain unverified.",
        { exact: true },
      ),
    ).toBeVisible();
    await selectService(page, "DeepSeek");
    await expect(page.getByLabel("New API key", { exact: true })).toHaveValue(
      "UNSAVED_DEEPSEEK_CANARY",
    );
    await expect(page.getByLabel("API root", { exact: true })).toHaveValue(
      "https://proxy.example/v1",
    );
    await page.keyboard.press("Escape");
    await openAiSettings(page);
    await expect(page.getByLabel("New API key", { exact: true })).toHaveValue(
      "",
    );
    await expect(page.getByLabel("API root", { exact: true })).toHaveValue(
      "https://proxy.example/v1",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", { name: "Back to services", exact: true })
      .click();
    await expect(
      page.getByLabel("API root", { exact: true }),
    ).not.toBeVisible();
    await selectService(page, "OpenAI");
    await expect(page.getByLabel("API root", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(390);
    await page.screenshot({ path: ".artifacts/model-services-narrow.png" });
    expect(provider.calls()).toHaveLength(1);
  } finally {
    release();
    await provider.close();
  }
});

test("legacy configurations stay readable and usable; explicit assignment preserves IDs, authentication and default models", async ({
  page,
  core,
}) => {
  const view = await core.request("/ai/settings"),
    first = randomUUID(),
    second = randomUUID();
  const evidence = {
    state: "unknown",
    source: "unknown",
    scope: "",
    observedAt: null,
  };
  const parameters = {
    temperatureMilli: 700,
    maxOutputTokens: 512,
    requestStreaming: false,
    requestNativeJson: false,
  };
  view.settings.providers = [first, second].map((id, index) => ({
    id,
    label: index ? "Legacy local" : "Old OpenAI",
    adapter: "openai_compatible",
    baseUrl: index ? "http://localhost:11434/v1" : "https://api.openai.com/v1",
    authMode: "none",
    credentialRevision: null,
    revision: 1,
  }));
  view.settings.models = [
    {
      providerId: second,
      id: "legacy-model",
      label: "Legacy model",
      capabilities: {
        images: evidence,
        streaming: evidence,
        nativeJson: evidence,
      },
      contextTokens: null,
      outputTokens: null,
      tokenField: "max_tokens",
    },
  ];
  view.settings.bindings = [
    {
      category: "text",
      providerId: second,
      modelId: "legacy-model",
      parameters,
      revision: 1,
    },
  ];
  const saved = await core.request(
    "/ai/settings",
    { expectedRevision: view.settings.revision, settings: view.settings },
    "PUT",
  );
  await openWorkbench(page);
  await openAiSettings(page);
  expect((await core.request("/ai/settings")).settings).toEqual(saved.settings);
  await page
    .getByRole("button", { name: "Default models", exact: true })
    .click();
  await expect(
    page.getByLabel("Manuscript model", { exact: true }),
  ).toHaveValue(JSON.stringify([second, "legacy-model"]));
  await page
    .getByRole("button", { name: "Model services", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Manage saved configurations", exact: true })
    .click();
  const manager = page.getByRole("dialog", {
    name: "Manage saved configurations",
    exact: true,
  });
  const legacy = manager.locator("article").filter({ hasText: "Legacy local" });
  await legacy
    .getByRole("button", { name: "Assign to OpenAI", exact: true })
    .click();
  await expect(
    legacy.getByRole("button", { name: "Assign to OpenAI", exact: true }),
  ).toBeDisabled();
  await manager.getByRole("button", { name: "Close", exact: true }).click();
  const assigned = (await core.request("/ai/settings")).settings;
  expect(assigned.providers).toHaveLength(2);
  expect(
    assigned.providers.find(
      (provider: { id: string }) => provider.id === second,
    ),
  ).toMatchObject({
    servicePreset: "openai",
    id: second,
    authMode: "none",
    baseUrl: "http://localhost:11434/v1",
  });
  expect(assigned.models).toEqual(saved.settings.models);
  expect(assigned.bindings).toEqual(saved.settings.bindings);
  await expect(
    page.getByText("This saved configuration uses no authentication.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("New API key", { exact: true })).toHaveCount(0);
  const row = await openModel(page, "Legacy model");
  await row.locator(".ai-advanced > summary").click();
  await expect(
    row.getByLabel("Maximum output tokens", { exact: true }),
  ).toHaveValue("512");
  await row.getByLabel("Maximum output tokens", { exact: true }).fill("1024");
  await row
    .getByRole("button", { name: "Save model preferences", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await core.request("/ai/settings")).settings.bindings[0].parameters
          .maxOutputTokens,
    )
    .toBe(1024);
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.screenshot({ path: ".artifacts/model-services-legacy.png" });
});

test("reassigning a newly created service retires its creation alias and keeps later service drafts independent", async ({
  page,
  core,
}) => {
  const provider = await fixture();
  try {
    await openWorkbench(page);
    await openAiSettings(page);
    await configure(page, provider.root);
    const original = (await core.request("/ai/settings")).settings.providers[0];
    await page
      .getByRole("button", { name: "Manage saved configurations", exact: true })
      .click();
    const manager = page.getByRole("dialog", {
      name: "Manage saved configurations",
      exact: true,
    });
    await manager
      .getByRole("button", { name: "Assign to DeepSeek", exact: true })
      .click();
    await expect(
      manager.getByRole("button", { name: "Assign to DeepSeek", exact: true }),
    ).toBeDisabled();
    await manager.getByRole("button", { name: "Close", exact: true }).click();
    await selectService(page, "DeepSeek");
    await page
      .getByLabel("New API key", { exact: true })
      .fill("UNSAVED_REASSIGNED_SERVICE_CANARY");
    await page
      .getByLabel("API root", { exact: true })
      .fill("https://unsaved-deepseek.example/v1");
    await selectService(page, "OpenAI");
    await expect(page.getByLabel("API root", { exact: true })).toHaveValue(
      "https://api.openai.com/v1",
    );
    await expect(page.getByLabel("New API key", { exact: true })).toHaveValue(
      "",
    );
    await configure(page, `${provider.root}/new`, "NEW_SERVICE_KEY_CANARY");
    const settings = (await core.request("/ai/settings")).settings;
    expect(settings.providers).toHaveLength(2);
    expect(
      settings.providers.find(
        (profile: { id: string }) => profile.id === original.id,
      ),
    ).toMatchObject({
      servicePreset: "deepseek",
      baseUrl: original.baseUrl,
      credentialRevision: original.credentialRevision,
    });
    expect(
      settings.providers.find(
        (profile: { servicePreset: string }) =>
          profile.servicePreset === "openai",
      ).id,
    ).not.toBe(original.id);
    await selectService(page, "DeepSeek");
    await expect(page.getByLabel("New API key", { exact: true })).toHaveValue(
      "UNSAVED_REASSIGNED_SERVICE_CANARY",
    );
    await expect(page.getByLabel("API root", { exact: true })).toHaveValue(
      "https://unsaved-deepseek.example/v1",
    );
    expect(provider.calls()).toHaveLength(0);
  } finally {
    await provider.close();
  }
});

test("credential response loss refreshes saved status without retry and reopening refreshes clean drafts", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await openAiSettings(page);
  let writes = 0,
    lose = true;
  core.intercept(async (path, _body, phase) => {
    if (path.endsWith("/credentials") && phase === "before") writes++;
    if (path.endsWith("/credentials") && phase === "after" && lose) {
      lose = false;
      return "abort";
    }
  });
  await page
    .getByLabel("New API key", { exact: true })
    .fill("AMBIGUOUS_SYNTHETIC_KEY");
  await page
    .getByRole("button", { name: "Save configuration", exact: true })
    .click();
  await expect(
    page.getByText(
      "Configuration saved. The key could not be confirmed; check its saved status before trying again.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText("Key saved ••••", { exact: true })).toBeVisible();
  await expect(page.getByLabel("New API key", { exact: true })).toHaveValue("");
  expect(writes).toBe(1);
  await page.keyboard.press("Escape");
  const view = await core.request("/ai/settings");
  view.settings.providers[0].baseUrl = "https://changed.example/v1";
  await core.request(
    "/ai/settings",
    { expectedRevision: view.settings.revision, settings: view.settings },
    "PUT",
  );
  await openAiSettings(page);
  await expect(page.getByLabel("API root", { exact: true })).toHaveValue(
    "https://changed.example/v1",
  );
  expect(writes).toBe(1);
});
