import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
test("global bilingual settings allow manual model after discovery failure, clear key and make inference explicit", async ({
  page,
}) => {
  let calls = 0,
    lists = 0;
  const targets: Array<{
    path: string | undefined;
    body: string;
    auth: string | undefined;
  }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const b of req) body += b;
    targets.push({ path: req.url, body, auth: req.headers.authorization });
    if (req.url?.endsWith("/models")) {
      lists++;
      res.statusCode = 405;
      res.setHeader("content-type", "application/json");
      res.end('{"error":{"message":"No list"}}');
      return;
    }
    calls++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          { message: { content: "OK" }, finish_reason: "stop", index: 0 },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}/custom`;
  try {
    await page.goto("/");
    await page
      .getByRole("combobox", { name: "Language", exact: true })
      .selectOption("en");
    await page.getByText("AI settings", { exact: true }).click();
    await expect(
      page.getByText(
        "Keys are kept in memory for this app session only. Restarting loses them.",
      ),
    ).toBeVisible();
    await page
      .getByLabel("Profile name", { exact: true })
      .fill("Local endpoint fixture");
    await page.getByLabel("API root", { exact: true }).fill(root);
    await page
      .getByRole("button", { name: "Save provider", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Discover models", exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("New API key", { exact: true })
      .fill("SYNTHETIC_UI_KEY_CANARY");
    await page
      .getByRole("button", { name: "Save new key", exact: true })
      .click();
    await expect(page.getByLabel("New API key", { exact: true })).toHaveValue(
      "",
    );
    await expect(
      page.getByText("Key saved ••••", { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Model ID (manual entry supported)", { exact: true })
      .fill("manual-fixture");
    await page
      .getByRole("button", { name: "Discover models", exact: true })
      .click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(
      page.getByLabel("Model ID (manual entry supported)", { exact: true }),
    ).toHaveValue("manual-fixture");
    expect(lists).toBe(1);
    expect(calls).toBe(0);
    await page
      .getByRole("button", { name: "Use this model for text", exact: true })
      .click();
    await expect(
      page.getByText(
        "Connection test runs inference and may consume your provider quota. Each new test is an explicit action.",
      ),
    ).toBeVisible();
    expect(calls).toBe(0);
    await page
      .getByRole("button", { name: "Run a new inference test", exact: true })
      .click();
    await expect(
      page.getByText(
        "Text test succeeded. Other capabilities remain unverified.",
      ),
    ).toBeVisible();
    expect(calls).toBe(1);
    const bindingBefore = (
      await (await page.request.get("/api/v1/ai/settings")).json()
    ).settings.bindings;
    await page
      .getByRole("combobox", { name: "Provider profile", exact: true })
      .selectOption("");
    await page
      .getByLabel("Profile name", { exact: true })
      .fill("Second selected provider");
    await page
      .getByLabel("API root", { exact: true })
      .fill(root.replace("/custom", "/second"));
    await page
      .getByRole("button", { name: "Save provider", exact: true })
      .click();
    await page
      .getByLabel("New API key", { exact: true })
      .fill("SYNTHETIC_UI_B_KEY");
    await page
      .getByRole("button", { name: "Save new key", exact: true })
      .click();
    await expect(page.getByLabel("New API key", { exact: true })).toHaveValue(
      "",
    );
    await page
      .getByLabel("Model ID (manual entry supported)", { exact: true })
      .fill("manual-model-B");
    await page
      .getByRole("button", { name: "Discover models", exact: true })
      .click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(
      page.getByLabel("Model ID (manual entry supported)", { exact: true }),
    ).toHaveValue("manual-model-B");
    await page
      .getByRole("button", { name: "Run a new inference test", exact: true })
      .click();
    await expect(
      page.getByText(
        "Text test succeeded. Other capabilities remain unverified.",
      ),
    ).toBeVisible();
    expect(calls).toBe(2);
    expect(lists).toBe(2);
    expect(targets.at(-1)?.path).toBe("/second/chat/completions");
    expect(JSON.parse(targets.at(-1)!.body).model).toBe("manual-model-B");
    expect(targets.at(-1)?.auth).toBe("Bearer SYNTHETIC_UI_B_KEY");
    expect(
      (await (await page.request.get("/api/v1/ai/settings")).json()).settings
        .bindings,
    ).toEqual(bindingBefore);
    await expect(
      page.getByText(
        `Submitted test: manual-model-B · ${root.replace("/custom", "/second")}`,
        { exact: true },
      ),
    ).toBeVisible();
    const keyExposure = await page.evaluate(() => ({
      text: document.body.textContent,
      storage: JSON.stringify({ ...localStorage }),
    }));
    expect(JSON.stringify(keyExposure)).not.toContain(
      "SYNTHETIC_UI_KEY_CANARY",
    );
    await page
      .getByRole("combobox", { name: "Language", exact: true })
      .selectOption("zh-CN");
    await expect(
      page.getByText("音频 — 预留，尚不可用", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("视频 — 预留，尚不可用", { exact: true }),
    ).toBeVisible();
    expect(calls).toBe(2);
    await page.screenshot({
      path: ".artifacts/step-04-ai-settings.png",
      fullPage: true,
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
