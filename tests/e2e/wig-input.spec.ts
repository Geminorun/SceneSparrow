import { test, expect } from "./helpers/core";
import {
  openWorkbench,
  openPanel,
  openDocumentMenu,
  openAiSettings,
} from "./helpers/workbench";
import type { Locator } from "@playwright/test";
// @ts-expect-error Counted local fixture is plain ESM.
import { planningProvider, configurePlanning } from "../fixtures/planning.mjs";
const commit = (input: Locator, text: string) =>
  input.evaluate((node: HTMLTextAreaElement, text) => {
    node.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: text }),
    );
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(node, text);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
const clickWithoutBlur = (button: Locator) =>
  button.evaluate((node: HTMLButtonElement) => node.click());

test("continuous planning composition keeps navigation, Library, history and actions enabled; one click uses the final committed text once", async ({
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
    const starts: any[] = [],
      saves: any[] = [];
    core.intercept(async (_path, body, phase) => {
      if (phase !== "before") return;
      if (body?.type === "StartPlanningTask") starts.push(body);
      if (body?.type === "SavePlanning") saves.push(body);
    });
    await openWorkbench(page);
    await openPanel(page, "Planning");
    const input = page.getByLabel("Your idea", { exact: true });
    await input.fill("A pending topic");
    const original = await input.elementHandle();
    await openPanel(page, "Library");
    await page.getByText("Add link reference", { exact: true }).first().click();
    const add = page.getByRole("button", {
      name: "Add link reference",
      exact: true,
    });
    await openDocumentMenu(page);
    const undo = page.getByRole("button", { name: "Undo", exact: true });
    await input.focus();
    await input.dispatchEvent("compositionstart", { data: "中" });
    await input.fill("持续输入");
    const generate = page.getByRole("button", {
      name: "Generate outline",
      exact: true,
    });
    await expect(generate).toBeEnabled();
    await expect(add).toBeEnabled();
    await expect(undo).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Settings", exact: true }),
    ).toBeEnabled();
    await expect(
      page
        .locator(".writing-view-switch")
        .getByRole("button", { name: "Outline", exact: true }),
    ).toBeEnabled();
    await page.waitForTimeout(5200);
    expect(saves).toHaveLength(0);
    await clickWithoutBlur(generate);
    await clickWithoutBlur(generate);
    expect(starts).toHaveLength(0);
    await input.evaluate((node) => {
      node.blur();
      node.focus();
      node.dispatchEvent(
        new CompositionEvent("compositionstart", {
          bubbles: true,
          data: "第二次输入",
        }),
      );
    });
    await page.waitForTimeout(50);
    expect(starts).toHaveLength(0);
    expect(saves).toHaveLength(0);
    await commit(input, "最终中文 topic with committed characters");
    await expect.poll(() => starts.length).toBe(1);
    await expect.poll(() => provider.calls.length).toBe(1);
    expect((await core.request("/planning")).content.brief.topic).toBe(
      "最终中文 topic with committed characters",
    );
    expect(saves.at(-1).payload.content.brief.topic).toBe(
      "最终中文 topic with committed characters",
    );
    expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
  } finally {
    await provider.close();
  }
});

test("changing writing context cancels a deferred generation and blur finalizes composition without a stale start", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  await openPanel(page, "Planning");
  let starts = 0,
    preparations = 0;
  core.intercept(async (path, body, phase) => {
    if (phase === "before" && body?.type === "StartPlanningTask") starts++;
    if (phase === "before" && path.endsWith("/planning/prepare"))
      preparations++;
  });
  const input = page.getByLabel("Your idea", { exact: true });
  await input.fill("Pending topic");
  await input.dispatchEvent("compositionstart", { data: "中" });
  await clickWithoutBlur(
    page.getByRole("button", { name: "Generate outline", exact: true }),
  );
  await clickWithoutBlur(
    page
      .locator(".writing-view-switch")
      .getByRole("button", { name: "Outline", exact: true }),
  );
  await input.fill("保留最终输入");
  await input.blur(); // Browser composition cancellation/blur need not emit compositionend.
  await expect(
    page.getByRole("textbox", { name: "Outline", exact: true }),
  ).toBeVisible();
  expect((await core.request("/planning")).content.brief.topic).toBe(
    "保留最终输入",
  );
  expect(starts).toBe(0);
  expect(preparations).toBe(0);
});

test("Review Send defers through final IME input and retains one saved thread/start identity", async ({
  page,
  core,
}) => {
  const provider = await planningProvider();
  provider.setHandler(async (_request: unknown, response: any) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: {
              content: JSON.stringify({
                schemaVersion: 1,
                answer: "Fixture answer",
                evidenceReferences: [],
              }),
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  try {
    await configurePlanning(
      async (path: string, body?: unknown, method?: string) => ({
        status: 200,
        data: await core.request(path, body, method),
      }),
      provider.root,
    );
    const writes: any[] = [];
    core.intercept(async (_path, body, phase) => {
      if (
        phase === "before" &&
        ["SaveReview", "StartReviewTask"].includes(body?.type)
      )
        writes.push(body);
    });
    await openWorkbench(page);
    const body = page.getByRole("textbox", { name: "Manuscript", exact: true });
    await body.fill("A manual manuscript for an explicit question.");
    await body.press("ControlOrMeta+s");
    await expect(page.getByTestId("save-status")).toHaveAttribute(
      "data-state",
      "saved",
    );
    await openPanel(page, "AI assistant");
    const input = page.getByLabel("Instruction", { exact: true });
    await input.fill("Partial question");
    await input.dispatchEvent("compositionstart", { data: "中" });
    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeEnabled();
    await clickWithoutBlur(send);
    await clickWithoutBlur(send);
    expect(writes).toHaveLength(0);
    await input.evaluate((node) => {
      node.blur();
      node.focus();
      node.dispatchEvent(
        new CompositionEvent("compositionstart", {
          bubbles: true,
          data: "第二个问题",
        }),
      );
    });
    await page.waitForTimeout(50);
    expect(writes).toHaveLength(0);
    await commit(input, "最终问题 with committed text?");
    await expect
      .poll(
        () => writes.filter((write) => write.type === "StartReviewTask").length,
      )
      .toBe(1);
    await expect.poll(() => provider.calls.length).toBe(1);
    expect(writes.filter((write) => write.type === "SaveReview")).toHaveLength(
      1,
    );
    expect(writes[0].payload.thread.text).toBe("最终问题 with committed text?");
    expect(writes[1].payload.threadId).toBe(writes[0].payload.thread.id);
    await expect(input).toHaveValue("");
  } finally {
    await provider.close();
  }
});

test("error and success notices last three seconds plus fade, with hover/focus pausing the remaining lifetime above native nested dialogs", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-11-18T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-11-18T12:00:01Z"));
  await openWorkbench(page);
  await openAiSettings(page);
  await page
    .getByRole("button", { name: "Save configuration", exact: true })
    .click();
  const success = page.locator('.notification[data-tone="success"]');
  await expect(success).toBeVisible();
  await page.mouse.move(1, 600);
  await page.clock.runFor(2999);
  await expect(success).not.toHaveAttribute("data-fading", "true");
  await page.clock.runFor(1);
  await expect(success).toHaveAttribute("data-fading", "true");
  await expect(success).toHaveAttribute("inert", "");
  await page.clock.runFor(189);
  await expect(success).toHaveCount(1);
  await page.clock.runFor(1);
  await expect(success).toHaveCount(0);
  await page
    .getByRole("button", { name: "Discover models", exact: true })
    .click();
  const picker = page.getByRole("dialog", {
    name: "Discover models",
    exact: true,
  });
  const notice = picker.locator(
    '.notification[data-error-code="CREDENTIAL_UNAVAILABLE"]',
  );
  await expect(notice).toBeVisible();
  expect(
    await notice.evaluate((node) => {
      const r = node.getBoundingClientRect();
      return node.contains(
        document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2),
      );
    }),
  ).toBe(true);
  await page.clock.runFor(1000);
  await notice.hover();
  await page.clock.runFor(10000);
  await expect(notice).not.toHaveAttribute("data-fading", "true");
  await notice.getByRole("button", { name: "Dismiss", exact: true }).focus();
  await picker.getByLabel("Search models", { exact: true }).hover();
  await page.clock.runFor(10000);
  await expect(notice).not.toHaveAttribute("data-fading", "true");
  await picker.getByLabel("Search models", { exact: true }).focus();
  await page.clock.runFor(1999);
  await expect(notice).not.toHaveAttribute("data-fading", "true");
  await page.clock.runFor(1);
  await expect(notice).toHaveAttribute("data-fading", "true");
  await page.clock.runFor(190);
  await expect(notice).toHaveCount(0);
  await expect(
    picker.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
});

test("planning load recovery survives toast expiry and typing/polling cannot replay a Review error episode", async ({
  page,
  core,
}) => {
  let failPlanning = true,
    failReviews = false;
  core.intercept(async (path, _body, phase) => {
    if (
      phase === "after" &&
      ((failPlanning && path.endsWith("/planning")) ||
        (failReviews && path.endsWith("/reviews")))
    )
      return "abort";
  });
  await page.clock.install({ time: new Date("2026-11-18T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-11-18T12:00:01Z"));
  await openWorkbench(page);
  await openPanel(page, "Planning");
  await expect(page.locator(".notification")).toBeVisible();
  await page.mouse.move(1, 600);
  await page.clock.runFor(3190);
  await expect(page.locator(".notification")).toHaveCount(0);
  failPlanning = false;
  await page
    .locator("#auxiliary-planning")
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await expect(page.getByLabel("Your idea", { exact: true })).toBeVisible();
  const body = page.getByRole("textbox", { name: "Manuscript", exact: true });
  await body.fill("Manual body for Review failure recovery.");
  await body.press("ControlOrMeta+s");
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
  failReviews = true;
  // Reload owns a new load failure, then repeated renders must retain its expiry.
  await page.reload();
  await openPanel(page, "AI assistant");
  const input = page.getByLabel("Instruction", { exact: true });
  const notice = page.locator(
    '.notification[data-error-code="REVIEW_UNAVAILABLE"]',
  );
  await expect(notice).toBeVisible();
  await page.mouse.move(1, 600);
  for (let index = 0; index < 8; index++) {
    await input.fill(`Retained question ${index}`);
    await page.clock.runFor(500);
  }
  await expect(notice).toHaveCount(0);
  await page.clock.runFor(60000);
  await expect(notice).toHaveCount(0);
  await expect(input).toHaveValue("Retained question 7");
  failReviews = false;
  await page
    .locator(".review-panel")
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await expect(
    page
      .locator(".review-panel")
      .getByRole("button", { name: "Try again", exact: true }),
  ).toHaveCount(0);
});

test("compact Review recovery after toast expiry resumes saved-thread/start receipts without duplicate inference", async ({
  page,
  core,
}) => {
  const provider = await planningProvider();
  provider.setHandler(async (_request: unknown, response: any) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: {
              content: JSON.stringify({
                schemaVersion: 1,
                answer: "Recovered fixture answer",
                evidenceReferences: [],
              }),
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  try {
    await configurePlanning(
      async (path: string, body?: unknown, method?: string) => ({
        status: 200,
        data: await core.request(path, body, method),
      }),
      provider.root,
    );
    let loss: "SaveReview" | "StartReviewTask" | null = "SaveReview";
    const writes: any[] = [],
      ids = new Map<string, string>(),
      lookups: string[] = [];
    core.intercept(async (path, body, phase) => {
      if (
        phase === "before" &&
        ["SaveReview", "StartReviewTask"].includes(body?.type)
      ) {
        writes.push(body);
        ids.set(body.type, body.requestId);
      }
      if (phase === "before" && path.includes("/commands/"))
        lookups.push(path.split("/").at(-1)!);
      if (
        phase === "after" &&
        loss &&
        (body?.type === loss || path.endsWith(`/commands/${ids.get(loss)}`))
      )
        return "abort";
    });
    await openWorkbench(page);
    const body = page.getByRole("textbox", { name: "Manuscript", exact: true });
    await body.fill(
      "A manuscript whose review request must retain its receipt identity.",
    );
    await body.press("ControlOrMeta+s");
    await expect(page.getByTestId("save-status")).toHaveAttribute(
      "data-state",
      "saved",
    );
    await openPanel(page, "AI assistant");
    const input = page.getByLabel("Instruction", { exact: true });
    await input.fill("保留请求身份的问题?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const retry = page
      .locator(".review-panel")
      .getByRole("button", { name: "Try again", exact: true });
    await expect(retry).toBeVisible();
    await page.mouse.move(1, 600);
    await page.waitForTimeout(3300);
    await expect(page.locator(".notification")).toHaveCount(0);
    expect(provider.calls).toHaveLength(0);
    await expect(input).toHaveValue("保留请求身份的问题?");
    loss = "StartReviewTask";
    await retry.click();
    await expect
      .poll(
        () => writes.filter((write) => write.type === "StartReviewTask").length,
      )
      .toBe(1);
    await expect.poll(() => provider.calls.length).toBe(1);
    await expect(retry).toBeVisible();
    await page.mouse.move(1, 600);
    await page.waitForTimeout(3300);
    await expect(page.locator(".notification")).toHaveCount(0);
    loss = null;
    await retry.click();
    await expect(input).toHaveValue("");
    expect(writes.filter((write) => write.type === "SaveReview")).toHaveLength(
      1,
    );
    expect(
      writes.filter((write) => write.type === "StartReviewTask"),
    ).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
    expect(lookups).toContain(ids.get("SaveReview"));
    expect(lookups).toContain(ids.get("StartReviewTask"));
  } finally {
    await provider.close();
  }
});

test("user outline edits cancel Redo queued behind an acknowledged but unread Undo", async ({
  page,
  core,
}) => {
  await openWorkbench(page);
  const manuscript = page.getByRole("textbox", {
    name: "Manuscript",
    exact: true,
  });
  await manuscript.fill("Original manuscript before held Undo.");
  await manuscript.press("ControlOrMeta+s");
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
  await page
    .locator(".writing-view-switch")
    .getByRole("button", { name: "Outline", exact: true })
    .click();
  const outline = page.getByRole("textbox", { name: "Outline", exact: true });
  let releaseUndo = () => {},
    enterUndo = () => {},
    redos = 0;
  const gate = new Promise<void>((resolve) => {
    releaseUndo = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enterUndo = resolve;
  });
  core.intercept(async (_path, body, phase) => {
    if (phase === "before" && body?.type === "RedoProject") redos++;
    if (phase === "after" && body?.type === "UndoProject") {
      enterUndo();
      await gate;
    }
  });
  try {
    await outline.press("ControlOrMeta+z");
    await entered;
    expect((await core.request("/manuscript")).blocks).toHaveLength(0);
    await outline.press("ControlOrMeta+Shift+z");
    await outline.fill("# User input after the queued Redo");
    releaseUndo();
    await outline.press("ControlOrMeta+s");
    await expect(page.getByTestId("save-status")).toHaveAttribute(
      "data-state",
      "saved",
    );
    expect(redos).toBe(0);
    await expect(outline).toContainText("User input after the queued Redo");
    expect((await core.request("/manuscript")).blocks).toHaveLength(0);
  } finally {
    releaseUndo();
  }
});

for (const change of ["text", "scope", "history"] as const) {
  test(`Review retry after saved-thread read failure cannot submit changed ${change} context during held input flush`, async ({
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
      await openWorkbench(page);
      const body = page.getByRole("textbox", {
        name: "Manuscript",
        exact: true,
      });
      await body.fill(
        "Original manuscript for saved Review readback recovery.",
      );
      await body.press("ControlOrMeta+s");
      await expect(page.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "saved",
      );
      await openPanel(page, "AI assistant");
      const input = page.getByLabel("Instruction", { exact: true });
      await input.fill("Original saved question?");
      let failReads = false,
        holdBody = false,
        entered = () => {};
      const writes: any[] = [];
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const seen = new Promise<void>((resolve) => {
        entered = resolve;
      });
      core.intercept(async (path, command, phase) => {
        if (
          phase === "before" &&
          ["SaveReview", "StartReviewTask"].includes(command?.type)
        )
          writes.push(command);
        if (phase === "after" && command?.type === "SaveReview")
          failReads = true;
        if (phase === "after" && failReads && path.endsWith("/reviews"))
          return "abort";
        if (
          phase === "after" &&
          holdBody &&
          command?.type === "ApplyDocumentEdit"
        ) {
          entered();
          await gate;
        }
      });
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const retry = page
        .locator(".review-panel")
        .getByRole("button", { name: "Try again", exact: true });
      await expect(retry).toBeVisible();
      await page.mouse.move(1, 600);
      await page.waitForTimeout(3300);
      await expect(page.locator(".notification")).toHaveCount(0);
      expect(
        writes.filter((write) => write.type === "SaveReview"),
      ).toHaveLength(1);
      expect(provider.calls).toHaveLength(0);
      failReads = false;
      holdBody = true;
      await body.fill(
        "New manuscript edit whose receipt is held during explicit Review retry.",
      );
      await retry.click();
      await seen;
      if (change === "text")
        await input.fill("New unsent question during the retry flush?");
      else if (change === "scope")
        await page
          .getByRole("combobox", { name: "Scope", exact: true })
          .selectOption("selection");
      else
        await page
          .getByRole("button", { name: "Generation history", exact: true })
          .click();
      release();
      await expect(page.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "saved",
      );
      if (change === "history")
        await page
          .getByRole("button", { name: "Back to assistant", exact: false })
          .click();
      await expect(input).toHaveValue(
        change === "text"
          ? "New unsent question during the retry flush?"
          : "Original saved question?",
      );
      await page.waitForTimeout(150);
      expect(
        writes.filter((write) => write.type === "SaveReview"),
      ).toHaveLength(1);
      expect(
        writes.filter((write) => write.type === "StartReviewTask"),
      ).toHaveLength(0);
      expect(provider.calls).toHaveLength(0);
      const cards = (await core.request("/reviews")).cards;
      expect(cards).toHaveLength(1);
      expect(cards[0].thread.text).toBe("Original saved question?");
      expect(cards[0].thread.id).toBe(writes[0].payload.thread.id);
    } finally {
      release();
      await provider.close();
    }
  });
}
