import { projectHistory, openDocumentMenu } from "./helpers/workbench";
import { openPanel, openWorkbench } from "./helpers/workbench";
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
  test.setTimeout(90000);
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
  let holdLock = false,
    holdLockProjection = false,
    enterLock: () => void = () => {},
    releaseLock: () => void = () => {},
    releaseLockProjection: () => void = () => {};
  let lockGate: Promise<void> = Promise.resolve(),
    lockProjectionGate: Promise<void> = Promise.resolve();
  let holdUndo = false,
    enterUndo: () => void = () => {},
    releaseUndo: () => void = () => {},
    freezeReviews = false,
    releaseReviews: () => void = () => {};
  let undoGate: Promise<void> = Promise.resolve(),
    reviewsGate: Promise<void> = Promise.resolve();
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
      if (freezeReviews && url.pathname.endsWith("/reviews")) await reviewsGate;
      if (
        holdLockProjection &&
        url.pathname.endsWith("/manuscript/finalization")
      )
        await lockProjectionGate;
      const response = await route.fetch({
        url: base + url.pathname.replace("/api/v1", "") + url.search,
        headers: {
          ...route.request().headers(),
          Authorization: `Bearer ${token}`,
        },
      });
      const command =
        route.request().method() === "POST"
          ? route.request().postDataJSON()
          : null;
      if (holdUndo && command?.type === "UndoProject") {
        enterUndo();
        await undoGate;
      }
      if (
        holdLock &&
        command?.type === "SetUserLocks" &&
        command.payload.locked
      ) {
        enterLock();
        await lockGate;
      }
      await route.fulfill({ response });
    });
    await openWorkbench(page);

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
    await openPanel(page, "Review");
    await page
      .getByRole("complementary", { name: "Comments", exact: true })
      .getByRole("toolbar", { name: "Review selection", exact: true })
      .last()
      .getByRole("button", { name: "Question", exact: true })
      .click();
    const panel = page.getByRole("complementary", {
      name: "Comments",
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
      page.getByRole("complementary", { name: "批注", exact: true }),
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
    await page
      .getByRole("button", { name: "Lock entire manuscript", exact: true })
      .click();
    const pendingNotice = page.locator(
      '.notification[data-error-code="PENDING_CANDIDATE"]',
    );
    await expect(pendingNotice).toContainText("Resolve the candidate");
    await expect(page.locator(".lock-column [role=alert]")).toHaveCount(0);
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
    const undoEntered = new Promise<void>((r) => (enterUndo = r));
    undoGate = new Promise<void>((r) => (releaseUndo = r));
    reviewsGate = new Promise<void>((r) => (releaseReviews = r));
    holdUndo = true;
    await projectHistory(page, "Undo");
    await undoEntered;
    await expect(
      note.getByRole("button", { name: "Accept change", exact: true }),
    ).toBeEnabled();
    freezeReviews = true;
    holdUndo = false;
    releaseUndo();

    await expect(editor).toContainText("Second line");
    await expect(editor.locator(".review-highlight")).not.toHaveCount(0);
    await expect(
      editor.locator(".review-highlight").filter({ hasText: "🇺🇸" }),
    ).not.toHaveCount(0);
    freezeReviews = false;
    releaseReviews();
    await projectHistory(page, "Redo");
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
    const raceBlock = editor.locator(`[data-blockid="${nestedId}"]`);
    const nestedLock = page.locator(`[data-lock-block="${nestedId}"]`);
    await raceBlock.scrollIntoViewIfNeeded();
    await expect(nestedLock).toBeEnabled();
    // Hold both acknowledgment and projection so the fixture deterministically
    // enters private input before the committed lock becomes visible.
    const entering = new Promise<void>((r) => (enterLock = r));
    lockGate = new Promise<void>((r) => (releaseLock = r));
    lockProjectionGate = new Promise<void>((r) => (releaseLockProjection = r));
    holdLock = holdLockProjection = true;
    await nestedLock.click();
    await entering;
    await raceBlock.click();
    await page.keyboard.press("End");
    await page.keyboard.insertText("!");
    await expect(raceBlock).toContainText("!");
    holdLock = holdLockProjection = false;
    releaseLock();
    releaseLockProjection();
    await raceBlock.scrollIntoViewIfNeeded();
    await expect(nestedLock).toHaveAttribute("aria-pressed", "true");
    await expect(nestedLock).toBeEnabled();
    await nestedLock.click();
    await expect(raceBlock).not.toHaveAttribute("contenteditable", "false");
    await page.getByTestId("manuscript-title").click();
    await expect(page.getByTestId("save-status")).toHaveAttribute(
      "data-state",
      "saved",
    );
    expect(
      (await req("/manuscript")).data.blocks
        .find((b: { id: string }) => b.id === nestedId)
        .runs.map((r: { text: string }) => r.text)
        .join(""),
    ).toContain("!");
    await page
      .getByRole("button", { name: "Lock entire manuscript", exact: true })
      .click();
    await expect(page.locator(".lock-column-heading")).toContainText(
      "Finalized",
    );
    await expect(page.getByTestId("approval-status")).toHaveText("Finalized");
    await page.reload();
    await expect(page.getByTestId("approval-status")).toHaveText("Finalized");
    const lockedBody = (await req("/manuscript")).data;
    const lockState = (await req("/manuscript/finalization")).data;
    expect(lockState.locks).toHaveLength(lockedBody.blocks.length);
    const nestedBlock = editor.locator(`[data-blockid="${nestedId}"]`);
    await expect(nestedBlock).toHaveAttribute("contenteditable", "false");
    // Native DOM/IME edits remain rejected even when a browser inserts outside normal key handlers.
    await nestedBlock.evaluate((node) => {
      node.dispatchEvent(
        new CompositionEvent("compositionstart", {
          bubbles: true,
          data: "侵入",
        }),
      );
      node.textContent = "Forbidden native mutation";
      node.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertCompositionText",
          data: "侵入",
        }),
      );
      node.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: "侵入" }),
      );
    });
    await expect(nestedBlock).toContainText("Nested 👩‍💻");
    expect((await req("/manuscript")).data.blocks).toEqual(lockedBody.blocks);
    // A selected locked paragraph remains reviewable and exposes a keyboard-operable far-right control.
    await nestedBlock.click();
    await panel
      .getByRole("button", { name: "Review whole block", exact: true })
      .click();
    await panel
      .getByLabel("Your question or instruction")
      .fill("Unsent locked note");
    const historyBefore = (await req("/history")).data;
    await projectHistory(page, "Undo");
    await expect(panel.getByLabel("Your question or instruction")).toHaveValue(
      "Unsent locked note",
    );
    expect((await req("/history")).data).toEqual(historyBefore);
    await panel.getByLabel("Your question or instruction").fill("");
    const unlock = page.locator(`[data-lock-block="${nestedId}"]`);
    await unlock.focus();
    await page.keyboard.press("Enter");
    await expect(nestedBlock).not.toHaveAttribute("contenteditable", "false");
    await expect(page.locator(".lock-column-heading")).toContainText("Editing");
    await expect(page.getByTestId("approval-status")).toHaveText(
      "Awaiting review",
    );
    const nodeBox = await nestedBlock.boundingBox(),
      lockBox = await unlock.boundingBox();
    expect(Math.abs(nodeBox!.y - lockBox!.y)).toBeLessThan(3);
    expect(lockBox!.x).toBeGreaterThan(nodeBox!.x + nodeBox!.width);
    expect(lockBox!.x + lockBox!.width).toBeLessThanOrEqual(
      (await panel.boundingBox())!.x,
    );
    await page
      .getByRole("combobox", { name: "Language", exact: true })
      .selectOption("zh-CN");
    await expect(unlock).toHaveAttribute("aria-label", "锁定内容块");
    await page
      .getByRole("combobox", { name: "语言", exact: true })
      .selectOption("en");
    expect(provider.calls).toHaveLength(2);
    await editor.locator("[data-blockid]").first().scrollIntoViewIfNeeded();
    await expect(page.locator("[data-lock-block]").first()).toBeVisible();
    await page.screenshot({ path: ".artifacts/locks-wide.png" });
    await page.setViewportSize({ width: 390, height: 900 });
    await expect(page.locator(".editor-workspace-grid")).toHaveAttribute(
      "data-layout",
      "drawer",
    );
    const closeAssistant = page.getByRole("button", {
      name: "Close assistant",
    });
    if (await closeAssistant.isVisible()) await closeAssistant.click();
    await editor.locator("[data-blockid]").first().scrollIntoViewIfNeeded();
    const firstId = (await req("/manuscript")).data.blocks[0].id;
    await expect(page.locator(`[data-lock-block="${firstId}"]`)).toBeVisible();
    const allButton = page.getByRole("button", {
      name: "Lock entire manuscript",
      exact: true,
    });
    await allButton.scrollIntoViewIfNeeded();
    const allBox = await allButton.boundingBox(),
      documentBox = await page.locator(".document-layout").boundingBox();
    expect(allBox!.y + allBox!.height).toBeLessThanOrEqual(documentBox!.y);
    await expect(
      page.getByRole("toolbar", { name: "Text formatting" }),
    ).toHaveCount(0);
    expect(allBox!.width).toBeGreaterThanOrEqual(28);
    expect(allBox!.x + allBox!.width).toBeLessThanOrEqual(390);
    await editor.locator("[data-blockid]").first().scrollIntoViewIfNeeded();
    await editor.focus();
    await editor
      .locator("[data-blockid]")
      .first()
      .evaluate((node) => {
        const text = document
          .createTreeWalker(node, NodeFilter.SHOW_TEXT)
          .nextNode();
        if (!text?.textContent)
          throw Error("Missing selectable manuscript text");
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, text.textContent.length);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });
    const floating = page.locator(".review-floating-selection");
    await expect(floating).toBeVisible();
    await expect(floating.locator("button")).toHaveCount(2);
    for (const button of await floating.locator("button").all()) {
      const box = await button.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    }
    await page.screenshot({ path: ".artifacts/locks-narrow-first.png" });
    await nestedBlock.scrollIntoViewIfNeeded();
    await expect(unlock).toBeVisible();
    const narrowNode = await nestedBlock.boundingBox(),
      narrowLock = await unlock.boundingBox();
    expect(Math.abs(narrowNode!.y - narrowLock!.y)).toBeLessThan(3);
    expect(narrowLock!.x).toBeGreaterThan(narrowNode!.x + narrowNode!.width);
    await page.screenshot({ path: ".artifacts/locks-narrow-nested.png" });
    await openPanel(page, "Review");
    await expect(panel).toBeVisible();
    await page.screenshot({
      path: ".artifacts/review-narrow.png",
      fullPage: true,
    });
    // Joining two unlocked list parents must not reparent a locked descendant in the editor.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator(".editor-workspace-grid")).toHaveAttribute(
      "data-layout",
      "split",
    );
    await unlock.click();
    const parentLock = page.locator(`[data-lock-block="${parentId}"]`);
    await parentLock.click();
    const beforeJoin = (await req("/manuscript")).data,
      newParent = randomUUID(),
      parentIndex = beforeJoin.blocks.findIndex(
        (b: { id: string }) => b.id === parentId,
      );
    expect(
      (
        await req("/manuscript/commands", {
          type: "ApplyDocumentEdit",
          requestId: randomUUID(),
          projectId: project.id,
          expectedWorkingRevision: beforeJoin.workingRevision,
          payload: {
            operations: [
              {
                op: "insertBlock",
                after: beforeJoin.blocks[parentIndex - 1].id,
                block: {
                  id: newParent,
                  kind: "list_item",
                  attrs: { listKind: "bullet", depth: 0 },
                  runs: [{ text: "Independent A", marks: [] }],
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
    const aBlock = editor.locator(`[data-blockid="${newParent}"]`);
    await aBlock.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Delete");
    await expect(editor.locator(`[data-blockid="${parentId}"]`)).toContainText(
      "Parent",
    );
    await expect(page.getByTestId("save-status")).toHaveAttribute(
      "data-state",
      "saved",
    );
    const beforeSplit = (await req("/manuscript")).data;
    await aBlock.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("New sibling");
    await page.getByTestId("manuscript-title").click();
    await expect(page.getByTestId("save-status")).toHaveAttribute(
      "data-state",
      "saved",
    );
    const split = (await req("/manuscript")).data.blocks.find(
      (b: { id: string }) =>
        !beforeSplit.blocks.some((old: { id: string }) => old.id === b.id),
    );
    expect(split).toBeTruthy();
    await expect(page.locator(`[data-lock-block="${split.id}"]`)).toBeVisible();
    expect(logs).not.toContain("Bearer");
    function assertNoCall() {
      expect(provider.calls).toHaveLength(0);
    }
  } finally {
    blockPlanning =
      holdLock =
      holdLockProjection =
      holdUndo =
      freezeReviews =
        false;
    releasePlanning();
    releaseLock();
    releaseLockProjection();
    releaseUndo();
    releaseReviews();
    try {
      // Drain intercepted requests while their fixture core is still available.
      if (!page.isClosed()) {
        await page.unrouteAll({ behavior: "wait" });
        await page.goto("about:blank");
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGINT");
        await exit;
      }
      await provider.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});
