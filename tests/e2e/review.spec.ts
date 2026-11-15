import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
// @ts-expect-error Counted local fixture is plain ESM.
import { planningProvider, configurePlanning } from "../fixtures/planning.mjs";
// @ts-expect-error Process fixture is plain ESM.
import { waitFor } from "../../scripts/processes.mjs";
test("Unicode cross-block review is explicit, bilingual and accepts only its selected change", async ({
  page,
}) => {
  const dir = await mkdtemp(join(tmpdir(), "scenesparrow-review-browser-")),
    provider = await planningProvider(),
    token = randomBytes(32).toString("hex");
  const socket = createServer();
  await new Promise<void>((r) => socket.listen(0, "127.0.0.1", r));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((r) => socket.close(() => r()));
  const base = `http://127.0.0.1:${port}/v1`;
  let logs = "";
  let blockPlanning = false,
    enterPlanning: () => void = () => {},
    releasePlanning: () => void = () => {};
  let planningGate: Promise<void> = Promise.resolve();
  const child = spawn("./target/debug/scenesparrow-service", [], {
    env: {
      ...process.env,
      SCENESPARROW_CORE_PORT: String(port),
      SCENESPARROW_SESSION_TOKEN: token,
      SCENESPARROW_PROJECT_DIR: join(dir, "project"),
      SCENESPARROW_APP_DATA_DIR: join(dir, "app"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (b) => (logs += b));
  const req = async (path: string, body?: unknown, method?: string) => {
    const r = await fetch(base + path, {
      method: method ?? (body ? "POST" : "GET"),
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: await r.json() };
  };
  provider.setHandler(
    async (
      _req: unknown,
      res: {
        setHeader: (n: string, v: string) => void;
        end: (v: string) => void;
      },
      body: {
        messages: Array<{
          role: string;
          content: string | Array<{ type: string; text: string }>;
        }>;
      },
    ) => {
      const user = body.messages.find((m) => m.role === "user")!.content;
      const input = JSON.parse(
        typeof user === "string"
          ? user
          : user.find((p) => p.type === "text")!.text,
      );
      const result =
        input.thread.kind === "question"
          ? {
              schemaVersion: 1,
              answer: "Answer 中文 🐦",
              evidenceReferences: [],
            }
          : {
              schemaVersion: 1,
              mode: "replace_ranges",
              explanation: "Clearer wording within the selected block.",
              replacements: input.thread.anchor.ranges.map(
                (_: unknown, rangeIndex: number) => ({
                  rangeIndex,
                  runs: [{ text: "Clearer 中文 🐦", marks: [] }],
                }),
              ),
            };
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: { content: JSON.stringify(result) },
              finish_reason: "stop",
            },
          ],
        }),
      );
    },
  );
  try {
    await waitFor(
      base + "/health",
      { Authorization: `Bearer ${token}` },
      child,
    );
    await configurePlanning(req, provider.root);
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/planning") && blockPlanning) {
        enterPlanning();
        await planningGate;
      }
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
    await page.getByLabel("Project name").fill("Review browser");
    await page
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Start writing", exact: true })
      .click();
    const editor = page.getByRole("textbox", {
      name: "Manuscript",
      exact: true,
    });
    await expect(editor).toBeVisible();
    await editor.fill("A 🇺🇸 é 中文");
    await editor.press("End");
    await editor.press("Shift+Enter");
    await page.keyboard.insertText("Second line");
    await editor.press("Enter");
    await page.keyboard.insertText("Repeat repeat");
    await editor.press("Control+Home");
    await editor.press("ArrowRight");
    await editor.press("ArrowRight");
    await editor.press("Control+Shift+End");
    await page
      .getByRole("complementary", { name: "Review", exact: true })
      .getByRole("toolbar", { name: "Review selection", exact: true })
      .last()
      .getByRole("button", { name: "Question", exact: true })
      .click();
    const panel = page.getByRole("complementary", {
      name: "Review",
      exact: true,
    });
    await panel
      .getByLabel("Your question or instruction")
      .fill("Explain this selected source");
    blockPlanning = true;
    planningGate = new Promise<void>((resolve) => {
      releasePlanning = resolve;
    });
    const enteredPlanning = new Promise<void>((resolve) => {
      enterPlanning = resolve;
    });
    await panel
      .getByRole("button", { name: "Save comment", exact: true })
      .click();
    await enteredPlanning;
    await panel
      .getByRole("button", { name: "Save comment", exact: true })
      .click();
    blockPlanning = false;
    releasePlanning();
    await expect(panel.locator(".review-card")).toHaveCount(1);
    assertNoCall();
    const question = panel.locator(".review-card").first();
    await expect(question.locator("blockquote")).toContainText("🇺🇸");
    await expect(question.locator("blockquote")).toContainText("Second line");
    await expect(question.locator("blockquote")).toContainText("Repeat repeat");
    await expect(editor.locator(".review-highlight")).not.toHaveCount(0);
    const original = await editor.innerText();
    await question.getByRole("button", { name: "Ask AI", exact: true }).click();
    await expect(question.locator(".review-answer")).toContainText(
      "Answer 中文 🐦",
    );
    expect(await editor.innerText()).toBe(original);
    expect(provider.calls).toHaveLength(1);
    await question
      .getByRole("button", { name: "Edit comment", exact: true })
      .click();
    await panel
      .getByLabel("Your question or instruction")
      .fill("Unsaved new question");
    await expect(
      question.getByRole("button", { name: "Ask AI", exact: true }),
    ).toBeDisabled();
    expect(provider.calls).toHaveLength(1);
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Language", exact: true })
      .selectOption("zh-CN");
    await expect(
      page.getByRole("complementary", { name: "审阅", exact: true }),
    ).toBeVisible();
    await mkdir(".artifacts", { recursive: true });
    await page.screenshot({
      path: ".artifacts/review-question-zh.png",
      fullPage: true,
    });
    await page
      .getByRole("combobox", { name: "语言", exact: true })
      .selectOption("en");
    await editor.click();
    await editor.press("Control+Home");
    await page
      .getByRole("button", { name: "Review whole block", exact: true })
      .click();
    await panel.getByLabel("Comment type").selectOption("revision_note");
    await panel
      .getByLabel("Your question or instruction")
      .fill("Improve this block only");
    await panel
      .getByRole("button", { name: "Save comment", exact: true })
      .click();
    await expect(panel.locator(".review-card")).toHaveCount(2);
    expect(provider.calls).toHaveLength(1);
    const note = panel.locator(".review-card").filter({
      has: page.getByRole("heading", { name: "Revision note", exact: true }),
    });
    await note
      .getByRole("button", { name: "Generate change", exact: true })
      .click();
    await expect(
      note.getByRole("button", { name: "Accept change", exact: true }),
    ).toBeEnabled();
    expect(await editor.innerText()).toBe(original);
    expect(provider.calls).toHaveLength(2);
    await page.screenshot({
      path: ".artifacts/review-candidate-en.png",
      fullPage: true,
    });
    await note
      .getByRole("button", { name: "Accept change", exact: true })
      .click();
    await expect(editor).toContainText("Clearer 中文 🐦");
    await expect(editor).toContainText("Repeat repeat");
    await expect(editor).not.toContainText("Second line");
    expect(provider.calls).toHaveLength(2);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(editor).toContainText("Second line");
    await expect(editor.locator(".review-highlight")).not.toHaveCount(0);
    await expect(
      editor.locator(".review-highlight").filter({ hasText: "🇺🇸" }),
    ).not.toHaveCount(0);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(editor).toContainText("Clearer 中文 🐦");
    const current = (await req("/manuscript")).data,
      project = (await req("/project")).data.project,
      parentId = randomUUID(),
      nestedId = randomUUID();
    expect(
      (
        await req("/manuscript/commands", {
          type: "ApplyDocumentEdit",
          requestId: randomUUID(),
          projectId: project.id,
          expectedWorkingRevision: current.workingRevision,
          payload: {
            operations: [
              {
                op: "insertBlock",
                after: current.blocks.at(-1).id,
                block: {
                  id: parentId,
                  kind: "list_item",
                  attrs: { listKind: "bullet", depth: 0 },
                  runs: [{ text: "Parent", marks: [] }],
                },
              },
              {
                op: "insertBlock",
                after: parentId,
                block: {
                  id: nestedId,
                  kind: "list_item",
                  attrs: { listKind: "bullet", depth: 1 },
                  runs: [{ text: "Nested 👩‍💻\nsoft", marks: [] }],
                },
              },
            ],
            expectedBlockRevisions: [],
            group: {
              groupId: randomUUID(),
              clientSessionId: randomUUID(),
              groupSequence: 1,
              kind: "discrete",
            },
          },
        })
      ).status,
    ).toBe(200);
    await page.reload();
    await expect(editor).toContainText("Nested 👩‍💻");
    await editor.locator("li > p").filter({ hasText: "Nested 👩‍💻" }).click();
    await page
      .getByRole("button", { name: "Review whole block", exact: true })
      .click();
    await panel
      .getByLabel("Your question or instruction")
      .fill("Nested question");
    await panel
      .getByRole("button", { name: "Save comment", exact: true })
      .click();
    await expect(
      panel.locator(".review-card").filter({ hasText: "Nested question" }),
    ).toBeVisible();
    const nestedCard = (await req("/reviews")).data.cards.find(
      (c: { thread: { text: string } }) => c.thread.text === "Nested question",
    );
    expect(nestedCard.thread.anchor.ranges[0].blockId).toBe(nestedId);
    expect(nestedCard.thread.anchor.ranges[0].quote).toBe("Nested 👩‍💻\nsoft");
    expect(provider.calls).toHaveLength(2);
    await page.setViewportSize({ width: 390, height: 900 });
    await expect(panel).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Review selection", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: ".artifacts/review-narrow.png",
      fullPage: true,
    });
    expect(logs).not.toContain("Bearer");
    function assertNoCall() {
      expect(provider.calls).toHaveLength(0);
    }
  } finally {
    if (child.exitCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGINT");
      await exit;
    }
    await provider.close();
    await rm(dir, { recursive: true, force: true });
  }
});
