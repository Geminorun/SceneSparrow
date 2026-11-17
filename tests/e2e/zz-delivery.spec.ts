import {
  openWorkbench,
  startManualDraft,
  openExports,
} from "./helpers/workbench";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
test("offline export flushes visible input, copy permission fallback and uncertain format receipts remain explicit", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw Error("denied");
        },
      },
      configurable: true,
    });
  });
  await openWorkbench(page);
  await startManualDraft(page);
  const project = (await (await page.request.get("/api/v1/project")).json())
    .project;
  const command = async (type: string, payload: unknown) => {
    const current = await (await page.request.get("/api/v1/manuscript")).json();
    const response = await page.request.post("/api/v1/manuscript/commands", {
      data: {
        type,
        requestId: crypto.randomUUID(),
        projectId: project.id,
        expectedWorkingRevision: current.workingRevision,
        payload,
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  };
  const cards = [];
  let after: string | undefined;
  do {
    const result = await (
      await page.request.get(`/api/v1/reviews${after ? `?after=${after}` : ""}`)
    ).json();
    cards.push(...result.cards);
    after = result.nextCursor ?? undefined;
  } while (after);
  for (const card of cards) {
    if (card.task && ["queued", "running"].includes(card.task.run.status))
      await command("CancelReviewTask", {
        threadId: card.thread.id,
        requestVersion: card.thread.requestVersion,
      });
    await command("DeleteReviewThread", {
      threadId: card.thread.id,
      requestVersion: card.thread.requestVersion,
      discardCandidate: true,
    });
  }
  const current = await (await page.request.get("/api/v1/manuscript")).json();
  if (current.blocks.length)
    await command("SetUserLocks", {
      locked: false,
      all: false,
      blockIds: current.blocks.map((b: { id: string }) => b.id),
    });
  const reset = await (await page.request.get("/api/v1/manuscript")).json();
  await command("ApplyDocumentEdit", {
    operations: [
      ...reset.blocks.map((b: { id: string }) => ({
        op: "deleteBlock",
        id: b.id,
      })),
      {
        op: "insertBlock",
        after: null,
        block: {
          id: crypto.randomUUID(),
          kind: "paragraph",
          attrs: {},
          runs: [{ text: "Delivery fixture", marks: [] }],
        },
      },
    ],
    expectedBlockRevisions: reset.blocks.map(
      (b: { id: string; revision: number }) => ({
        id: b.id,
        revision: b.revision,
      }),
    ),
    group: {
      clientSessionId: crypto.randomUUID(),
      groupId: crypto.randomUUID(),
      groupSequence: 1,
      kind: "discrete",
    },
  });
  await page.reload();
  const editor = page.getByRole("textbox", { name: "Manuscript", exact: true });
  await expect(editor).toBeVisible();
  await openExports(page);
  await editor.fill("Visible unsaved 中文 👩‍💻 é 🔒 comment");
  const exports = page.getByRole("region", {
    name: "Export manuscript",
    exact: true,
  });
  let capturesBeforeSave = 0;
  const countEarly = (request: import("@playwright/test").Request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/manuscript/exports")
    )
      capturesBeforeSave++;
  };
  page.on("request", countEarly);
  await page.route("**/api/v1/manuscript/commands", (route) => route.abort());
  await exports
    .getByRole("button", { name: "Export manuscript", exact: true })
    .click();
  await expect(
    exports
      .getByRole("status")
      .filter({ hasText: "The operation could not finish" }),
  ).toBeVisible();
  await expect(editor).toContainText("Visible unsaved 中文");
  expect(capturesBeforeSave).toBe(0);
  page.off("request", countEarly);
  await page.unroute("**/api/v1/manuscript/commands");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
  await page.getByLabel("Export format", { exact: true }).selectOption("md");
  let lost = false;
  await page.route("**/api/v1/manuscript/exports", async (route) => {
    if (route.request().method() === "POST" && !lost) {
      lost = true;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await exports
    .getByRole("button", { name: "Export manuscript", exact: true })
    .click();
  await expect(
    exports.getByRole("button", {
      name: "Resolve previous export request",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    exports.getByRole("button", { name: "Copy manuscript", exact: true }),
  ).toBeDisabled();
  await exports
    .getByRole("button", {
      name: "Resolve previous export request",
      exact: true,
    })
    .click();
  await expect(
    exports.getByRole("status").filter({ hasText: "File generated" }),
  ).toBeVisible();
  await expect(exports.getByText("Copied", { exact: true })).toHaveCount(0);
  const downloadEvent = page.waitForEvent("download");
  await exports
    .getByRole("button", { name: "Download file", exact: true })
    .click();
  const download = await downloadEvent;
  const text = await readFile((await download.path())!, "utf8");
  expect(text).toContain("Visible unsaved 中文 👩‍💻 é 🔒 comment");
  await expect(
    exports.getByText("Download requested", { exact: true }),
  ).toBeVisible();
  const jobsBefore = await (
    await page.request.get("/api/v1/manuscript/exports")
  ).json();
  await exports
    .getByRole("button", { name: "Copy manuscript", exact: true })
    .click();
  await expect(
    exports.getByText(/Clipboard access was unavailable/),
  ).toBeVisible();
  await expect(
    exports.getByRole("textbox", {
      name: "Prepared manuscript for manual copy",
    }),
  ).toHaveValue("Visible unsaved 中文 👩‍💻 é 🔒 comment\n");
  await exports.screenshot({ path: ".artifacts/export-wide.png" });
  expect(
    await (await page.request.get("/api/v1/manuscript/exports")).json(),
  ).toHaveLength(jobsBefore.length);
  // Copy has its own uncertain identity and cannot be repurposed by Export.
  let lostCopy = false;
  const copies: unknown[] = [];
  await page.route("**/api/v1/manuscript/copies", async (route) => {
    if (route.request().method() === "POST") {
      copies.push(route.request().postDataJSON());
      if (!lostCopy) {
        lostCopy = true;
        await route.fetch();
        await route.abort();
        return;
      }
    }
    await route.continue();
  });
  await exports
    .getByRole("button", { name: "Copy manuscript", exact: true })
    .click();
  await exports
    .getByRole("button", {
      name: "Resolve previous export request",
      exact: true,
    })
    .click();
  expect(copies).toHaveLength(2);
  expect(copies[1]).toEqual(copies[0]);
  expect(
    await (await page.request.get("/api/v1/manuscript/exports")).json(),
  ).toHaveLength(jobsBefore.length);
  await page.unroute("**/api/v1/manuscript/copies");
  // A rejected artifact download must not claim a requested or saved delivery.
  await page.route("**/api/v1/manuscript/exports/*/artifact", (route) =>
    route.abort(),
  );
  await exports
    .getByRole("button", { name: "Download file", exact: true })
    .click();
  await expect(
    exports
      .getByRole("status")
      .filter({ hasText: "The operation could not finish" }),
  ).toBeVisible();
  await page.unroute("**/api/v1/manuscript/exports/*/artifact");
  await exports
    .getByRole("button", { name: "Copy manuscript", exact: true })
    .click();

  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh-CN");
  await expect(
    page.getByRole("button", { name: "复制已准备的正文", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".export-panel").getByText(/无法访问剪贴板/),
  ).toBeVisible();
  await expect(
    page.locator('.notification[data-error-code="exportClipboardFallback"]'),
  ).toContainText("无法访问剪贴板");
  await expect(editor).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "文稿", exact: true }),
  ).toContainText("Visible unsaved");
  await page
    .getByRole("combobox", { name: /^(Language|语言)$/, exact: true })
    .selectOption("en");
  const beforeHeading = await (
    await page.request.get("/api/v1/manuscript")
  ).json();
  const headingId = crypto.randomUUID();
  await command("ApplyDocumentEdit", {
    operations: [
      ...beforeHeading.blocks.map((b: { id: string }) => ({
        op: "deleteBlock",
        id: b.id,
      })),
      {
        op: "insertBlock",
        after: null,
        block: {
          id: headingId,
          kind: "heading",
          attrs: { level: 2 },
          runs: [{ text: "Heading-only 中文", marks: [] }],
        },
      },
    ],
    expectedBlockRevisions: beforeHeading.blocks.map(
      (b: { id: string; revision: number }) => ({
        id: b.id,
        revision: b.revision,
      }),
    ),
    group: {
      clientSessionId: crypto.randomUUID(),
      groupId: crypto.randomUUID(),
      groupSequence: 1,
      kind: "discrete",
    },
  });
  await page.reload();
  await page.setViewportSize({ width: 360, height: 800 });
  await openExports(page);
  const format = page.getByLabel("Export format", { exact: true });
  for (
    let n = 0;
    n < 60 && !(await format.evaluate((el) => el === document.activeElement));
    n++
  )
    await page.keyboard.press("Tab");
  await expect(format).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  await expect(
    exports.getByRole("button", { name: "Export manuscript", exact: true }),
  ).toBeFocused();
  const [headingCapture] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/manuscript/exports") &&
        response.request().method() === "POST",
    ),
    page.keyboard.press("Enter"),
  ]);
  expect(headingCapture.ok()).toBeTruthy();
  const headingJob = await headingCapture.json();
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/v1/manuscript/exports/${headingJob.id}`,
      );
      return (await response.json()).status;
    })
    .toBe("ready");
  await expect(exports.getByLabel("Recent generated files")).toHaveValue(
    headingJob.id,
  );
  await expect(
    exports.getByRole("status").filter({ hasText: /^File generated ·/ }),
  ).toBeVisible();
  const panelBounds = (await exports.boundingBox())!;
  const recentBounds = (await exports
    .getByLabel("Recent generated files")
    .boundingBox())!;
  expect(recentBounds.x).toBeGreaterThanOrEqual(panelBounds.x);
  expect(recentBounds.x + recentBounds.width).toBeLessThanOrEqual(
    panelBounds.x + panelBounds.width + 1,
  );
  const headingArtifact = await page.request.get(
    `/api/v1/manuscript/exports/${headingJob.id}/artifact`,
  );
  expect(await headingArtifact.text()).toBe("Heading-only 中文\n");
  const onlyHeading = await (
    await page.request.get("/api/v1/manuscript")
  ).json();
  await exports.screenshot({ path: ".artifacts/export-narrow.png" });
  await command("ApplyDocumentEdit", {
    operations: [{ op: "deleteBlock", id: headingId }],
    expectedBlockRevisions: onlyHeading.blocks.map(
      (b: { id: string; revision: number }) => ({
        id: b.id,
        revision: b.revision,
      }),
    ),
    group: {
      clientSessionId: crypto.randomUUID(),
      groupId: crypto.randomUUID(),
      groupSequence: 1,
      kind: "discrete",
    },
  });
  await page.reload();
  await openExports(page);
  const beforeEmpty = await (
    await page.request.get("/api/v1/manuscript/exports")
  ).json();
  await exports
    .getByRole("button", { name: "Copy manuscript", exact: true })
    .click();
  await expect(
    exports.getByText("There is no manuscript text to export.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await (await page.request.get("/api/v1/manuscript/exports")).json(),
  ).toHaveLength(beforeEmpty.length);
});

test("lost Cancel and retained Retry responses resolve their original control identity without a second action", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("combobox", { name: /^(Language|语言)$/, exact: true })
    .selectOption("en");
  const items = await (
    await page.request.get("/api/v1/manuscript/exports")
  ).json();
  expect(items.length).toBeGreaterThan(0);
  let job = {
    ...items[0],
    status: "running",
    inputRetained: true,
    delivery: null,
  };
  const controls: Record<string, unknown[]> = { cancel: [], retry: [] };
  let lostCancel = false,
    lostRetry = false;
  await page.route("**/api/v1/manuscript/exports**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      await route.fulfill({ json: path.endsWith("/exports") ? [job] : job });
      return;
    }
    const kind = path.endsWith("/cancel")
      ? "cancel"
      : path.endsWith("/retry")
        ? "retry"
        : null;
    if (!kind) {
      await route.continue();
      return;
    }
    controls[kind]!.push(request.postDataJSON());
    if (kind === "cancel") {
      job = { ...job, status: "cancelled", inputRetained: false };
      if (!lostCancel) {
        lostCancel = true;
        await route.abort();
        return;
      }
    } else {
      job = { ...job, status: "ready", inputRetained: false, attempt: 2 };
      if (!lostRetry) {
        lostRetry = true;
        await route.abort();
        return;
      }
    }
    await route.fulfill({ json: job });
  });
  await page.reload();
  await openExports(page);
  const exports = page.getByRole("region", {
    name: "Export manuscript",
    exact: true,
  });
  await exports.getByRole("button", { name: "Cancel", exact: true }).click();
  await exports
    .getByRole("button", {
      name: "Resolve previous export request",
      exact: true,
    })
    .click();
  expect(controls.cancel).toHaveLength(2);
  expect(controls.cancel[1]).toEqual(controls.cancel[0]);
  await expect(
    exports.getByRole("status").filter({ hasText: "Cancelled" }),
  ).toBeVisible();
  job = { ...job, status: "failed", attempt: 1, inputRetained: true };
  await page.reload();
  await openExports(page);
  await exports
    .getByRole("button", { name: "Retry captured input", exact: true })
    .click();
  await exports
    .getByRole("button", {
      name: "Resolve previous export request",
      exact: true,
    })
    .click();
  expect(controls.retry).toHaveLength(2);
  expect(controls.retry[1]).toEqual(controls.retry[0]);
  await expect(
    exports.getByRole("status").filter({ hasText: "File generated" }),
  ).toBeVisible();
});

test("restart exposes an unknown native receipt and reselect requires a fresh explicit delivery intent on the same artifact", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const host = window as any;
    host.__deliveries = [];
    const oldDelivery = "4fdc80ea-fd55-4a5f-89dc-f4d6d60f388a";
    const request = async (path: string, body?: unknown) => {
      const r = await fetch(`/api/v1${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await r.json();
      return r.ok ? { ok: true, data } : { ok: false, code: data.code };
    };
    host.sceneSparrow = {
      health: () => request("/health"),
      readProject: () => request("/project"),
      ensureProject: (command: unknown) => request("/project/ensure", command),
      renameProject: (command: unknown) => request("/project/rename", command),
      readAiSettings: () => request("/ai/settings"),
      readManuscript: () => request("/manuscript"),
      readHistory: () => request("/history"),
      readPlanning: () => request("/planning"),
      readReviews: () => request("/reviews"),
      readSources: () => request("/sources"),
      readFinalization: () => request("/manuscript/finalization"),
      executeManuscript: (c: unknown) => request("/manuscript/commands", c),
      commandReceipt: (id: string) => request(`/commands/${id}`),
      readExports: async () => {
        const r = await request("/manuscript/exports");
        if (r.ok)
          r.data = r.data
            .filter((j: any) => j.status === "ready")
            .map((j: any, i: number) =>
              i
                ? j
                : {
                    ...j,
                    delivery: {
                      deliveryId: oldDelivery,
                      jobId: j.id,
                      artifactHash: j.artifactHash,
                      status: "unknown",
                      error: "DELIVERY_STATUS_UNKNOWN",
                    },
                  },
            );
        return r;
      },
      saveExport: async (action: any) => {
        host.__deliveries.push(action);
        return {
          ok: true,
          data: {
            ...action,
            status: action.deliveryId === oldDelivery ? "unknown" : "saved",
            error: null,
          },
        };
      },
      subscribeEvents: () => () => {},
      onCloseRequested: () => () => {},
      onCloseAborted: () => () => {},
      onFileIntakeProgress: () => () => {},
    };
  });
  await page.goto("/");
  await page
    .getByRole("combobox", { name: /^(Language|语言)$/, exact: true })
    .selectOption("en");
  await openExports(page);
  const exports = page.getByRole("region", {
    name: "Export manuscript",
    exact: true,
  });
  await expect(
    exports.getByRole("status").filter({ hasText: "Delivery status unknown" }),
  ).toBeVisible();
  expect(await page.evaluate(() => (window as any).__deliveries)).toEqual([]);
  await exports
    .getByRole("button", { name: "Save file…", exact: true })
    .click();
  await expect(
    exports.getByRole("status").filter({ hasText: "Delivery status unknown" }),
  ).toBeVisible();
  const reselect = exports.getByRole("button", {
    name: /Check destination and select a new save destination/,
  });
  await reselect.click();
  await expect(
    exports.getByRole("status").filter({ hasText: "File saved" }),
  ).toBeVisible();
  const actions = await page.evaluate(() => (window as any).__deliveries);
  expect(actions).toHaveLength(2);
  expect(actions[1].jobId).toBe(actions[0].jobId);
  expect(actions[1].artifactHash).toBe(actions[0].artifactHash);
  expect(actions[1].deliveryId).not.toBe(actions[0].deliveryId);
});
