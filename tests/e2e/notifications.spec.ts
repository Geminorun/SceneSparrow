import { test, expect } from "./helpers/core";
import { openWorkbench, openAiSettings, openPanel } from "./helpers/workbench";
import { createServer } from "node:http";
import type { Locator } from "@playwright/test";

async function hitTest(notice: Locator) {
  await expect(notice).toBeVisible();
  const result = await notice.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      top: rect.top,
      hit: node.contains(
        document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        ),
      ),
    };
  });
  expect(result.top).toBeLessThan(120);
  expect(result.hit).toBe(true);
}

test("missing-default preflight is localized above a scrolled pane and routes directly to the global default without eager reads", async ({
  page,
  core,
}) => {
  let settingsReads = 0,
    starts = 0;
  core.intercept(async (path, body, phase) => {
    if (phase === "before" && path.endsWith("/ai/settings")) settingsReads++;
    if (phase === "before" && body?.type === "StartPlanningTask") starts++;
  });
  await openWorkbench(page);
  expect(settingsReads).toBe(0);
  await openPanel(page, "Planning");
  await page
    .getByLabel("Your idea", { exact: true })
    .fill("A local preflight topic");
  await page
    .locator(".right-pane .auxiliary-content:visible")
    .evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
  await page
    .getByRole("button", { name: "Generate outline", exact: true })
    .click();
  const notice = page.locator(
    '.notification[data-error-code="CONFIGURATION_UNAVAILABLE"]',
  );
  await hitTest(notice);
  await expect(notice).toContainText(
    "Choose a manuscript model in global settings.",
  );
  await page
    .getByRole("button", { name: "Generate outline", exact: true })
    .click();
  await expect(
    page.locator('.notification[data-error-code="CONFIGURATION_UNAVAILABLE"]'),
  ).toHaveCount(1);
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh-CN");
  await expect(notice).toContainText("请在全局设置中选择文稿模型。");
  await hitTest(notice);
  await notice.getByRole("button", { name: "打开设置", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "默认模型", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByLabel("文稿模型", { exact: true })).toBeVisible();
  expect(starts).toBe(0);
});

test("notification actions stay interactive in the latest native picker and closing restores its trigger", async ({
  page,
}) => {
  await openWorkbench(page);
  await openAiSettings(page);
  await page
    .getByRole("button", { name: "Save configuration", exact: true })
    .click();
  const discover = page.getByRole("button", {
    name: "Discover models",
    exact: true,
  });
  await expect(discover).toBeEnabled();
  await discover.click();
  const picker = page.getByRole("dialog", {
    name: "Discover models",
    exact: true,
  });
  const notice = picker.locator(
    '.notification[data-error-code="CREDENTIAL_UNAVAILABLE"]',
  );
  await hitTest(notice);
  const search = picker.getByLabel("Search models", { exact: true });
  await search.focus();
  await expect(search).toBeFocused();
  const dismiss = picker
    .locator(".notifications")
    .getByRole("button", { name: "Dismiss", exact: true })
    .last();
  await dismiss.focus();
  await page.keyboard.press("Tab");
  await expect(
    picker.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dismiss).toBeFocused();
  await search.focus();
  await page.screenshot({ path: ".artifacts/notification-nested-modal.png" });
  await notice
    .getByRole("button", { name: "Open settings", exact: true })
    .click();
  await expect(picker).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Model services", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(discover).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeFocused();
});

test("saved discovery target reports upstream classes and failed HTTP200 test receipts without clearing manual models or making automatic inference", async ({
  page,
  core,
}) => {
  let status = 401;
  let lists = 0,
    calls = 0;
  const paths: string[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* consume explicit test input */
    }
    paths.push(request.url ?? "");
    if (request.url?.endsWith("/models")) lists++;
    else calls++;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: {
          code: status === 429 ? "insufficient_quota" : null,
          message: "SECRET_VENDOR_BODY_AND_KEY_CANARY",
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}/exact-root`;
  try {
    await openWorkbench(page);
    await openAiSettings(page);
    await page.getByLabel("API root", { exact: true }).fill(root);
    await page
      .getByLabel("New API key", { exact: true })
      .fill("SYNTHETIC_STORED_KEY");
    await page
      .getByRole("button", { name: "Save configuration", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Replace key", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("New API key", { exact: true })).toHaveCount(
      0,
    );
    for (const [nextStatus, code] of [
      [401, "AUTH_REJECTED"],
      [403, "ACCESS_REJECTED"],
      [404, "MODEL_LIST_NOT_FOUND"],
      [405, "MODEL_LIST_UNSUPPORTED"],
      [429, "QUOTA_EXCEEDED"],
      [503, "PROVIDER_SERVER_FAILED"],
    ] as const) {
      status = nextStatus;
      await page
        .getByRole("button", { name: "Discover models", exact: true })
        .click();
      const picker = page.getByRole("dialog", {
        name: "Discover models",
        exact: true,
      });
      await expect(picker.locator(".ai-discovery-target")).toContainText(
        `GET ${root}/models`,
      );
      const notice = picker.locator(`.notification[data-error-code="${code}"]`);
      await hitTest(notice);
      await notice.getByText("Details", { exact: true }).click();
      await expect(notice).toContainText("Core HTTP 422");
      await expect(picker.locator(".ai-operation-error")).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText(
        "SECRET_VENDOR_BODY_AND_KEY_CANARY",
      );
      await picker.getByRole("button", { name: "Close", exact: true }).click();
    }
    expect(lists).toBe(6);
    expect(calls).toBe(0);
    expect(paths.every((path) => path === "/exact-root/models")).toBe(true);
    await page.getByRole("button", { name: "Add model", exact: true }).click();
    const manual = page.getByRole("dialog", { name: "Add model", exact: true });
    await manual
      .getByLabel("Model ID (manual entry supported)", { exact: true })
      .fill("manual-after-failure");
    await manual
      .getByRole("button", { name: "Add model", exact: true })
      .click();
    await expect(manual).not.toBeVisible();
    expect((await core.request("/ai/settings")).settings.bindings).toEqual([]);
    const row = page.locator(".ai-model-row");
    await row.locator(":scope > details > summary").click();
    status = 403;
    await row
      .getByRole("button", { name: "Run a new inference test", exact: true })
      .click();
    await expect(row).toContainText("Test failed");
    await expect(
      page.locator('.notification[data-error-code="ACCESS_REJECTED"]'),
    ).toBeVisible();
    expect(calls).toBe(1);
    await expect(page.locator(".ai-key-mask")).toHaveText("••••••••");
    await page.screenshot({
      path: ".artifacts/notification-provider-error.png",
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an ambiguous replacement keeps a constant mask, exposes unknown status and never resends a key on root-only save", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await openAiSettings(page);
  await page
    .getByLabel("New API key", { exact: true })
    .fill("OLD_SYNTHETIC_KEY");
  await page
    .getByRole("button", { name: "Save configuration", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Replace key", exact: true }),
  ).toBeVisible();
  let writes = 0;
  core.intercept(async (path, _body, phase) => {
    if (path.endsWith("/credentials") && phase === "before") writes++;
    if (path.endsWith("/credentials") && phase === "after") return "abort";
  });
  await page.getByRole("button", { name: "Replace key", exact: true }).click();
  await page
    .getByLabel("New API key", { exact: true })
    .fill("NEW_AMBIGUOUS_SYNTHETIC_KEY");
  await page
    .getByRole("button", { name: "Save configuration", exact: true })
    .click();
  await expect(page.locator(".ai-key-status")).toContainText(
    "The key write could not be confirmed.",
  );
  await expect(page.getByLabel("New API key", { exact: true })).toHaveCount(0);
  await expect(page.locator(".ai-key-mask")).toHaveText("••••••••");
  await page
    .getByLabel("API root", { exact: true })
    .fill("https://saved-root.example/custom");
  await page
    .getByRole("button", { name: "Save configuration", exact: true })
    .click();
  await expect(page.locator(".ai-service-detail")).toContainText(
    "Configuration saved.",
  );
  expect(writes).toBe(1);
  await expect(page.locator(".ai-key-status")).toContainText(
    "The key write could not be confirmed.",
  );
  const exposure = await page.evaluate(() =>
    JSON.stringify({
      text: document.body.textContent,
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  expect(exposure).not.toContain("NEW_AMBIGUOUS_SYNTHETIC_KEY");
  expect(exposure).not.toContain("OLD_SYNTHETIC_KEY");
});
