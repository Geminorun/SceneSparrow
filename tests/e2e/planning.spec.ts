import { projectHistory, openDocumentMenu } from "./helpers/workbench";
import { openPanel, openWorkbench } from "./helpers/workbench";
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
// @ts-expect-error Self-authored runtime fixtures are plain ESM.
import {
  planningProvider,
  planningOutput,
  configurePlanning,
} from "../fixtures/planning.mjs";
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
    await configurePlanning(req, provider.root, { maxOutputTokens: 8192 });
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
    const operations: string[] = [];
    provider.setHandler(async (_request: unknown, res: any, body: any) => {
      const user = body.messages.find(
        (message: any) => message.role === "user",
      ).content;
      const value = JSON.parse(
        typeof user === "string"
          ? user
          : user.find((part: any) => part.type === "text").text,
      );
      operations.push(value.operation ?? value.thread.kind);
      let output: any;
      if (value.operation) {
        output = planningOutput(body);
        if (value.operation === "generate_initial_draft") {
          const paragraph =
            "清晨的麻雀站在树枝上练习鸣叫，幼鸟通过聆听和模仿学习声音。它们在熟悉的环境里反复尝试，把听到的节奏变成自己的表达。观察鸟鸣需要耐心，也需要尊重自然的生活。";
          const prose = Array.from(
            { length: 2000 },
            (_, index) => [...paragraph][index % [...paragraph].length],
          ).join("");
          output.sections.forEach(
            (section: any, index: number) =>
              (section.blocks[0].runs = [
                {
                  text: prose.slice(index * 1000, (index + 1) * 1000),
                  marks: [],
                },
              ]),
          );
        }
      } else
        output =
          value.thread.kind === "question"
            ? {
                schemaVersion: 1,
                answer: "Birds learn through listening and practice. 鸟鸣",
                evidenceReferences: [],
              }
            : {
                schemaVersion: 1,
                mode: "replace_ranges",
                explanation: "A concise opening.",
                replacements: value.thread.anchor.ranges.map(
                  (_: unknown, rangeIndex: number) => ({
                    rangeIndex,
                    runs: [{ text: "改写后的清晰段落。", marks: [] }],
                  }),
                ),
              };
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: { content: JSON.stringify(output) },
              finish_reason: "stop",
            },
          ],
        }),
      );
    });
    let blockPlanningReadback = false,
      armPlanningReadback = true,
      planningStarts = 0,
      reviewSaves = 0,
      reviewStarts = 0,
      blockReviewReadback = false;
    await page.route("**/api/v1/planning", async (route) => {
      if (blockPlanningReadback)
        await route.fulfill({
          status: 503,
          json: { code: "STORAGE_UNAVAILABLE" },
        });
      else await route.fallback();
    });
    await page.route("**/api/v1/reviews**", async (route) => {
      if (blockReviewReadback)
        await route.fulfill({
          status: 503,
          json: { code: "STORAGE_UNAVAILABLE" },
        });
      else await route.fallback();
    });
    await page.route("**/api/v1/manuscript/commands", async (route) => {
      const command = route.request().postDataJSON();
      if (command.type === "SaveReview") {
        reviewSaves++;
        if (reviewSaves === 1) blockReviewReadback = true;
      }
      if (command.type === "StartReviewTask") reviewStarts++;
      if (command.type !== "StartPlanningTask") {
        await route.fallback();
        return;
      }
      planningStarts++;
      const response = await route.fetch({
        url: base + "/manuscript/commands",
        headers: {
          ...route.request().headers(),
          Authorization: `Bearer ${token}`,
        },
      });
      if (armPlanningReadback) {
        armPlanningReadback = false;
        blockPlanningReadback = true;
      }
      await route.fulfill({ response });
    });
    await openWorkbench(page);
    const body = page.getByRole("textbox", { name: "Manuscript", exact: true });
    const originalBody = await body.elementHandle();
    await expect(body).toBeVisible();
    await openPanel(page, "AI assistant");
    await page
      .getByLabel("Your idea", { exact: true })
      .fill("Why do sparrows sing? 鸟鸣");
    await page
      .getByLabel("Manuscript language", { exact: true })
      .selectOption("zh-CN");
    await page
      .getByRole("button", { name: "Generate outline", exact: true })
      .click();
    const startRetry = page
      .locator(".notification")
      .getByRole("button", { name: "Try again", exact: true });
    await expect(startRetry).toBeVisible();
    await page.waitForTimeout(1100);
    expect(provider.calls).toHaveLength(1);
    expect(planningStarts).toBe(1);
    blockPlanningReadback = false;
    await startRetry.click();
    const outline = page.getByRole("textbox", { name: "Outline", exact: true });
    await expect(outline).toContainText("How sparrows learn 鸟鸣");
    expect(planningStarts).toBe(1);
    expect(provider.calls).toHaveLength(1);
    const before = (await req("/planning")).data.content.nodes;
    await outline.locator("p").first().click();
    await page.keyboard.press("Home");
    await page.keyboard.press("End");
    await page.keyboard.type(" revised");
    await expect(page.getByTestId("save-status")).toHaveAttribute(
      "data-state",
      "saved",
    );
    expect((await req("/planning")).data.content.nodes[0].id).toBe(
      before[0].id,
    );
    await page
      .getByLabel("Overall AI adjustment instruction", { exact: true })
      .fill("Keep the example and make the structure clear.");
    await page
      .getByRole("button", { name: "Adjust outline", exact: true })
      .click();
    await expect(outline).not.toContainText(" revised");
    expect(provider.calls).toHaveLength(2);
    const after = (await req("/planning")).data.content.nodes;
    expect(after[0].id).toBe(before[0].id);
    await page
      .getByRole("combobox", { name: "Language", exact: true })
      .selectOption("zh-CN");
    await expect(
      page.getByRole("textbox", { name: "大纲", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: ".artifacts/writing-outline-zh-desktop.png",
      fullPage: true,
    });
    await page
      .getByRole("combobox", { name: "语言", exact: true })
      .selectOption("en");
    await page
      .getByRole("button", {
        name: "Write draft from this outline",
        exact: true,
      })
      .click();
    await expect(body).toBeVisible();
    await expect(body).toContainText("清晨的麻雀");
    expect(provider.calls).toHaveLength(3);
    expect(planningStarts).toBe(3);
    expect(
      operations.filter((operation) => operation === "generate_initial_draft"),
    ).toHaveLength(1);
    const manuscript = (await req("/manuscript")).data;
    expect(
      manuscript.blocks
        .filter((block: any) => block.kind === "paragraph")
        .map((block: any) => block.runs.map((run: any) => run.text).join(""))
        .join(""),
    ).toHaveLength(2000);
    expect(
      await body.evaluate(
        (current, original) => current === original,
        originalBody,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Outline", exact: true }).click();
    await expect(outline).toContainText("How sparrows learn");
    await expect(page.locator(".lock-header-target")).toBeHidden();
    await expect(page.locator(".review-floating-selection")).toHaveCount(0);
    await page.reload();
    await expect(outline).toBeVisible();
    await page
      .locator(".writing-view-switch")
      .getByRole("button", { name: "Manuscript", exact: true })
      .click();
    await expect(body).toBeVisible();
    await openPanel(page, "AI assistant");
    await body
      .locator("p")
      .first()
      .evaluate((element) => {
        const range = document.createRange();
        range.setStart(element.firstChild!, 0);
        range.setEnd(element.firstChild!, 40);
        const selected = window.getSelection()!;
        selected.removeAllRanges();
        selected.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });
    await expect(
      page.getByRole("combobox", { name: "Scope", exact: true }),
    ).toHaveValue("selection");
    await page
      .getByLabel("Instruction", { exact: true })
      .fill("How does learning work here?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const reviewRetry = page
      .locator(".notification")
      .getByRole("button", { name: "Try again", exact: true });
    await expect(reviewRetry).toBeVisible();
    await page.waitForTimeout(1100);
    expect(reviewSaves).toBe(1);
    expect(reviewStarts).toBe(0);
    expect(provider.calls).toHaveLength(3);
    blockReviewReadback = false;
    await reviewRetry.click();
    await expect(
      page.getByText("Birds learn through listening and practice. 鸟鸣", {
        exact: true,
      }),
    ).toBeVisible();
    expect(provider.calls).toHaveLength(4);
    expect(reviewSaves).toBe(1);
    expect(reviewStarts).toBe(1);
    const question = (await req("/reviews")).data.cards.find(
      (card: any) => card.thread.kind === "question",
    ).thread;
    expect(question.anchor.ranges).toHaveLength(1);
    expect(question.anchor.ranges[0].quote).toHaveLength(40);
    await page.getByRole("button", { name: "Revise", exact: true }).click();
    await page.getByLabel("Scope", { exact: true }).selectOption("selection");
    await body
      .locator("p")
      .first()
      .evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selected = window.getSelection()!;
        selected.removeAllRanges();
        selected.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });
    await page
      .getByRole("button", { name: "Review selection", exact: true })
      .click();
    await page
      .getByLabel("Instruction", { exact: true })
      .fill("Make this opening concise.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.locator(".candidate-preview > summary").click();
    await expect(page.locator(".review-comparison ins")).toContainText(
      "改写后的清晰段落。",
    );
    await expect(body).not.toContainText("改写后的清晰段落。");
    await page
      .getByRole("button", { name: "Accept change", exact: true })
      .click();
    await expect(body).toContainText("改写后的清晰段落。");
    expect(provider.calls).toHaveLength(5);
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Scope", exact: true })
      .selectOption("whole");
    await page
      .getByLabel("Instruction", { exact: true })
      .fill("Explain the whole manuscript.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => provider.calls.length).toBe(6);
    const whole = (await req("/reviews")).data.cards.find(
      (card: any) => card.thread.text === "Explain the whole manuscript.",
    ).thread;
    expect(whole.anchor.ranges.map((range: any) => range.blockId)).toEqual(
      (await req("/manuscript")).data.blocks.map((block: any) => block.id),
    );
    await page.screenshot({
      path: ".artifacts/writing-manuscript-en-desktop.png",
      fullPage: true,
    });
    await expect(page.locator('.notification[data-tone="error"]')).toHaveCount(
      0,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await openPanel(page, "AI assistant");
    await page.screenshot({
      path: ".artifacts/writing-assistant-en-narrow.png",
      fullPage: true,
    });
    await page
      .getByRole("combobox", { name: "Language", exact: true })
      .selectOption("zh-CN");
    await page.screenshot({
      path: ".artifacts/writing-assistant-zh-narrow.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "收起助手栏", exact: true }).click();
    await page.screenshot({
      path: ".artifacts/writing-manuscript-zh-narrow.png",
      fullPage: true,
    });
    await page
      .getByRole("combobox", { name: "语言", exact: true })
      .selectOption("en");
    await page.reload();
    await expect(body).toBeVisible();
    expect((await req("/planning")).data.content.nodes).toHaveLength(2);
    expect(provider.calls).toHaveLength(6);
    await expect(
      page.locator(".planning-tasks,.planning-technical,.outline-node"),
    ).toHaveCount(0);
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
