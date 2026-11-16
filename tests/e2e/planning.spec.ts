import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
// @ts-expect-error Self-authored runtime fixtures are plain ESM.
import { planningProvider, configurePlanning } from "../fixtures/planning.mjs";
// @ts-expect-error Existing process fixture is plain ESM.
import { waitFor } from "../../scripts/processes.mjs";
test("plans a bilingual outline and complete draft through counted SDK; manual alternative remains free", async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "scenesparrow-plan-browser-"));
  const provider = await planningProvider();
  const token = randomBytes(32).toString("hex");
  const socket = createServer();
  await new Promise<void>((r) => socket.listen(0, "127.0.0.1", r));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((r) => socket.close(() => r()));
  const base = `http://127.0.0.1:${port}/v1`;
  const child = spawn("./target/debug/scenesparrow-service", [], {
    env: {
      ...process.env,
      SCENESPARROW_CORE_PORT: String(port),
      SCENESPARROW_SESSION_TOKEN: token,
      SCENESPARROW_PROJECT_DIR: join(directory, "project"),
      SCENESPARROW_APP_DATA_DIR: join(directory, "app"),
    },
    stdio: "ignore",
  });
  const req = async (path: string, body?: unknown, method?: string) => {
    const response = await fetch(base + path, {
      method: method ?? (body ? "POST" : "GET"),
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    await waitFor(
      base + "/health",
      { Authorization: `Bearer ${token}` },
      child,
    );
    await configurePlanning(req, provider.root);
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/project/events")) {
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: "event: resync_required\ndata: {}\n\n",
        });
        return;
      }
      const response = await route.fetch({
        url: base + url.pathname.replace("/api/v1", "") + url.search,
        headers: {
          ...route.request().headers(),
          Authorization: `Bearer ${token}`,
        },
      });
      await route.fulfill({ response });
    });
    await page.goto("/");
    await page
      .getByRole("combobox", { name: "Language", exact: true })
      .selectOption("en");
    await page.getByLabel("Project name").fill("Planning browser fixture");
    await page
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Plan your manuscript", exact: true }),
    ).toBeVisible();
    await page.getByText("Evidence sent to AI", { exact: true }).click();
    await expect(
      page.getByText(
        "Source discovery is unavailable. Add links or files manually below.",
        { exact: true },
      ),
    ).toBeVisible();
    await page
      .getByLabel("Topic", { exact: true })
      .fill("Why do sparrows sing? 鸟鸣");
    await page.getByLabel("Manuscript language", { exact: true }).fill("zh-CN");
    await page
      .getByRole("button", { name: "Generate outline", exact: true })
      .click();
    await expect(page.getByLabel("Outline 1", { exact: true })).toHaveValue(
      "How sparrows learn 鸟鸣",
    );
    expect(provider.calls).toHaveLength(1);
    await page
      .getByLabel("Key points, one per line")
      .first()
      .fill("First key point\n第二条要点 🐦");
    await page
      .getByRole("button", { name: "Add section", exact: true })
      .click();
    await expect(page.getByLabel("Outline 3", { exact: true })).toBeVisible();
    await page
      .getByRole("combobox", { name: "Language", exact: true })
      .selectOption("zh-CN");
    await expect(
      page.getByRole("heading", { name: "规划文稿", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("文稿语言", { exact: true })).toHaveValue(
      "zh-CN",
    );
    await page.screenshot({
      path: ".artifacts/planning-outline-zh.png",
      fullPage: true,
    });
    await page
      .getByRole("combobox", { name: "语言", exact: true })
      .selectOption("en");
    await page
      .getByRole("button", {
        name: "Confirm outline and generate draft",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Manuscript", exact: true }),
    ).toContainText("完整初稿");
    expect(provider.calls).toHaveLength(2);
    await expect(
      page.getByText("Generated claims need independent verification.", {
        exact: true,
      }),
    ).not.toBeVisible();
    await page
      .getByText("Inspect result and evidence", { exact: true })
      .click();
    await expect(
      page.getByText("Generated claims need independent verification.", {
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: ".artifacts/planning-draft.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Plan your manuscript", exact: true }),
    ).toBeVisible();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    let dispatched: () => void = () => {};
    const seen = new Promise<void>((r) => (dispatched = r));
    await page.route("**/api/v1/manuscript/commands", async (route) => {
      const body = route.request().postDataJSON();
      if (body.type === "StartManualDraft") {
        dispatched();
        await held;
      }
      const response = await route.fetch({
        url: base + "/manuscript/commands",
        headers: {
          ...route.request().headers(),
          Authorization: `Bearer ${token}`,
        },
      });
      await route.fulfill({ response });
    });
    await page
      .getByRole("button", { name: "Start writing", exact: true })
      .click();
    await seen;
    await expect(page.getByLabel("Topic", { exact: true })).toBeDisabled();
    await expect(
      page.getByLabel("Overall AI adjustment instruction", { exact: true }),
    ).toBeDisabled();
    release();
    await expect(
      page.getByRole("textbox", { name: "Manuscript", exact: true }),
    ).toBeVisible();
    expect(provider.calls).toHaveLength(2);
  } finally {
    await page.close();
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGINT");
      await exited;
    }
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});
