import { test, expect } from "../e2e/helpers/source-core";
import {
  openWorkbench,
  openDocumentMenu,
  projectHistory,
  openPanel,
  openExports,
} from "../e2e/helpers/workbench";
const idA = "11111111-1111-4111-8111-111111111111",
  idB = "22222222-2222-4222-8222-222222222222";
const mark = (id: string) => `<!-- scenesparrow:block=${id} -->`;
const editor = (page: any) => page.locator(".cm-content");
async function replace(page: any, needle: string, value: string) {
  await editor(page).evaluate(
    (
      node: HTMLElement,
      { needle, value }: { needle: string; value: string },
    ) => {
      node.focus();
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let text: Node | null;
      while ((text = walker.nextNode())) {
        const at = text.textContent?.indexOf(needle) ?? -1;
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(text, at);
        range.setEnd(text, at + needle.length);
        const selection = document.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
        return;
      }
      throw Error("Text not found: " + needle);
    },
    { needle, value },
  );
  await page.keyboard.insertText(value);
}
async function saved(page: any) {
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
}
async function changes(page: any) {
  await page.getByTestId("source-changes").click();
  await expect(
    page.getByRole("dialog", { name: "Changes", exact: true }),
  ).toBeVisible();
}

test("exact source retains BOM/mixed EOL/unknown content; real CM stays mounted and clean delivery keeps code markers", async ({
  page,
  core,
}) => {
  const raw = `\uFEFF${mark(idA)}\r\n\r\nAlpha **中😀** &amp; [link](https://example.com)\r\nsoft\n\n${mark(idB)}\n\nBeta\n\n<widget>unknown</widget>\r\n\n\`\`\`md\r\n${mark("33333333-3333-4333-8333-333333333333")}\r\n\`\`\`\n`;
  const accepted = (await core.seed(raw)).snapshot.source;
  await openWorkbench(page);
  await saved(page);
  const handle = await editor(page).elementHandle();
  await expect(editor(page)).toContainText("unknown");
  await page.keyboard.press("Control+s");
  await saved(page);
  expect((await core.disk()).toString()).toBe(accepted);
  await replace(page, "Beta", "Beta edited");
  await expect(
    page.getByRole("button", { name: "Outline", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Control+s");
  await saved(page);
  expect((await core.disk()).toString()).toBe(
    accepted.replace("Beta", "Beta edited"),
  );
  await page.getByRole("button", { name: "Outline", exact: true }).click();
  await page
    .getByRole("group", { name: "Writing view" })
    .getByRole("button", { name: "Manuscript", exact: true })
    .click();
  expect(await handle?.evaluate((node) => node.isConnected)).toBe(true);
  await openExports(page);
  await page
    .getByRole("button", { name: "Copy manuscript", exact: true })
    .click();
  await expect(page.locator(".export-panel textarea")).toContainText(
    "<widget>unknown</widget>",
  );
  await expect(page.locator(".export-panel textarea")).toContainText(
    mark("33333333-3333-4333-8333-333333333333"),
  );
  await page
    .locator(".export-panel")
    .getByRole("button", { name: "Export manuscript", exact: true })
    .click();
  await expect(
    page
      .locator(".export-panel")
      .getByRole("button", { name: "Download file", exact: true }),
  ).toBeVisible();
  const downloading = page.waitForEvent("download");
  await page
    .locator(".export-panel")
    .getByRole("button", { name: "Download file", exact: true })
    .click();
  const artifact = await readFile(await (await downloading).path());
  expect(artifact.toString()).toContain("<widget>unknown</widget>");
  expect(artifact.toString()).toContain(
    mark("33333333-3333-4333-8333-333333333333"),
  );
  expect(artifact.toString()).not.toContain(mark(idA));
  expect(artifact[0]).toBe(0xef);
  await page.locator(".document-menu > summary").click();
  await expect(editor(page)).not.toContainText("**中😀**");
  await expect(editor(page)).not.toContainText("https://example.com");
  await expect(editor(page).locator(".source-decoded-text").first()).toHaveText(
    "&",
  );
  await page.screenshot({
    path: ".artifacts/op3b/source-editor.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(editor(page)).toContainText("**中😀**");
  await expect(editor(page)).toContainText("https://example.com");
  await page.screenshot({
    path: ".artifacts/op3b/source-mode.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Source", exact: true }).click();
  expect(await handle?.evaluate((node) => node.isConnected)).toBe(true);
});

test("held ACK maps markers through newer input and IME without early autosave or caret replacement", async ({
  page,
  core,
}) => {
  await core.seed("Initial\r\n");
  await openWorkbench(page);
  await saved(page);
  let release!: () => void, observed!: () => void;
  const hold = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (observed = r));
  const payloads: any[] = [];
  core.intercept(async (path, body, phase) => {
    if (path.endsWith("/manuscript/source") && body && phase === "after") {
      payloads.push(body);
      if (payloads.length === 1) {
        observed();
        await hold;
      }
    }
  });
  await replace(page, "Initial", "Initial edited");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("New leaf");
  await page.keyboard.press("Control+s");
  await started;
  await editor(page).dispatchEvent("compositionstart");
  await page.keyboard.insertText(" 中文😀");
  const selection = await page.evaluate(
    () => document.getSelection()?.anchorOffset,
  );
  release();
  await expect(editor(page)).toContainText("New leaf 中文😀");
  await page.waitForTimeout(700);
  expect(payloads).toHaveLength(1);
  expect(await page.evaluate(() => document.getSelection()?.anchorOffset)).toBe(
    selection,
  );
  await expect(editor(page)).toBeFocused();
  await editor(page).dispatchEvent("compositionend");
  await page.waitForTimeout(800);
  expect(payloads).toHaveLength(1);
  await expect(
    page.getByRole("button", { name: "Outline", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Control+s");
  await saved(page);
  expect((await core.disk()).toString()).toContain("New leaf 中文😀");

  let releaseTopology!: () => void, topologyStarted!: () => void;
  const topologyHold = new Promise<void>(
    (resolve) => (releaseTopology = resolve),
  );
  const topologyObserved = new Promise<void>(
    (resolve) => (topologyStarted = resolve),
  );
  let heldTopology = false;
  core.intercept(async (path, body, phase) => {
    if (
      path.endsWith("/manuscript/source") &&
      body &&
      phase === "after" &&
      !heldTopology
    ) {
      heldTopology = true;
      topologyStarted();
      await topologyHold;
    }
  });
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("Another leaf");
  await page.keyboard.press("Control+s");
  await topologyObserved;
  await replace(page, "Another leaf", "# New heading\n\nAnother leaf");
  releaseTopology();
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "conflict",
  );
  await expect(editor(page)).toContainText("New heading");
  const acceptedTopology = await core.request("/manuscript/source");
  expect(acceptedTopology.source).toContain("Another leaf");
  expect(acceptedTopology.source).not.toContain("New heading");
  expect(
    (await core.request("/manuscript/source/status")).candidateId,
  ).toBeNull();
  await changes(page);
  await page
    .getByRole("button", {
      name: "Discard local input and reload saved source",
      exact: true,
    })
    .click();
  await saved(page);
  await expect(editor(page)).not.toContainText("New heading");
});

test("five shared source transitions, independent lock A/edit B and source selection review", async ({
  page,
  core,
}) => {
  await core.seed(
    `${mark(idA)}\n\nAlpha **中😀** &amp; [link](https://example.com)\n\n${mark(idB)}\n\nBeta\n`,
  );
  await openWorkbench(page);
  await saved(page);
  const before = await core.request("/manuscript");
  await expect(page.locator(`[data-lock-block="${idA}"]`)).toBeVisible();
  await page.locator(`[data-lock-block="${idA}"]`).click();
  await expect(page.locator(`[data-lock-block="${idA}"]`)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await saved(page);
  await replace(page, "Alpha", "Forbidden");
  await expect(editor(page)).toContainText("Alpha");
  await expect(editor(page)).not.toContainText("Forbidden");
  for (let i = 1; i <= 5; i++) {
    await replace(page, i === 1 ? "Beta" : `Beta${i - 1}`, `Beta${i}`);
    await page.keyboard.press("Control+s");
    await saved(page);
  }
  const after = await core.request("/manuscript");
  expect(after.blocks.find((b: any) => b.id === idA).revision).toBe(
    before.blocks.find((b: any) => b.id === idA).revision,
  );
  for (let i = 4; i >= 0; i--) {
    await projectHistory(page, "Undo");
    await saved(page);
    await expect(editor(page)).toContainText(i ? `Beta${i}` : "Beta");
  }
  await projectHistory(page, "Redo");
  await saved(page);
  await expect(editor(page)).toContainText("Beta1");
  await replace(page, "中😀", "中😀");
  await openPanel(page, "Comments");
  // The selection toolbar captures native decoded offsets even across inline syntax.
  await expect(
    page.getByRole("button", { name: "Review selection", exact: true }).first(),
  ).toBeVisible();
  await page.screenshot({
    path: ".artifacts/op3b/source-locks-review.png",
    fullPage: true,
  });
});

test("external clean/dirty/missing/stale candidates remain explicit and exact local recovery is reachable", async ({
  page,
  core,
}) => {
  await core.seed(`${mark(idA)}\r\n\r\nSaved version\r\n`);
  await openWorkbench(page);
  await saved(page);
  const history = await core.request("/history");
  await core.external(`${mark(idA)}\r\n\r\nExternal version\r\n`);
  await expect(page.getByTestId("source-changes")).toHaveAttribute(
    "data-pending",
    "true",
  );
  await expect(editor(page)).toContainText("Saved version");
  await replace(page, "Saved version", "Dirty local");
  await changes(page);
  await page.getByText("Full source versions", { exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "External file", exact: true }),
  ).toHaveValue(/External version/);
  await expect(
    page.getByRole("textbox", { name: "Local text to copy", exact: true }),
  ).toHaveValue(/Dirty local/);
  await page.getByText("Full source versions", { exact: true }).click();
  await page.screenshot({
    path: ".artifacts/op3b/source-changes.png",
    fullPage: true,
  });
  await page.getByText("Full source versions", { exact: true }).click();
  await core.external(`${mark(idA)}\r\n\r\nNewer external\r\n`);
  await page
    .getByRole("button", {
      name: "Save current local content instead",
      exact: true,
    })
    .click();
  await expect(page.getByRole("dialog", { name: "Changes" })).toBeVisible();
  await page.waitForTimeout(3600);
  await expect(page.locator(".notification")).toHaveCount(0);
  await expect(page.getByTestId("source-changes")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Local text to copy", exact: true }),
  ).toHaveValue(/Dirty local/);
  await page.getByRole("button", { name: "Rescan file", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "External file", exact: true }),
  ).toHaveValue(/Newer external/);
  await page
    .getByRole("button", {
      name: "Save current local content instead",
      exact: true,
    })
    .click();
  await expect
    .poll(
      async () =>
        await core
          .disk()
          .then((bytes) => bytes.toString())
          .catch(() => ""),
    )
    .toContain("Dirty local");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await saved(page);
  const after = await core.request("/history");
  expect(after.undoCount).toBe(history.undoCount + 1);
  await core.external(null);
  await page.getByTestId("source-changes").click();
  await page.getByRole("button", { name: "Rescan file", exact: true }).click();
  await expect(
    page
      .getByText(
        "The manuscript file is missing. Restore it with saved or local content.",
      )
      .first(),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Restore saved file; discard external changes",
      exact: true,
    })
    .click();
  await expect
    .poll(
      async () =>
        await core
          .disk()
          .then((bytes) => bytes.toString())
          .catch(() => ""),
    )
    .toContain("Dirty local");
});

test("same-process known v1/v2 recovery and explicit unknown preservation expose exact staged evidence", async ({
  page,
  core,
}) => {
  await core.seed("Saved version\r\n");
  await openWorkbench(page);
  await saved(page);
  for (const version of [1, 2]) {
    await core.injectIntent(false, version);
    await changes(page);
    await page
      .getByRole("button", { name: "Rescan file", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Recover known write", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Recover known write", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Recover known write", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Close", exact: true }).click();
  }
  await core.injectIntent(true);
  await changes(page);
  await page.getByRole("button", { name: "Rescan file", exact: true }).click();
  await page
    .getByRole("button", { name: "Recover known write", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Preserve unexpected files and clear write fence",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Preserve unexpected files and clear write fence",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("region", { name: "Retained source versions" }),
  ).toBeVisible();
  const rows = page
    .getByRole("region", { name: "Retained source versions" })
    .locator("div");
  const invalid = rows.filter({ hasText: "Staged version" });
  await invalid.getByRole("button", { name: "Compare version" }).click();
  await expect(
    page.getByText(
      "This version is not valid UTF-8. Download its exact bytes.",
    ),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download exact evidence bytes" })
    .click();
  const evidence = await download;
  expect(evidence.suggestedFilename()).toBe("manuscript-evidence.md");
  expect([...(await readFile(await evidence.path()))]).toEqual([
    0xef, 0xbb, 0xbf, 0xff, 0x00,
  ]);
  await page.screenshot({
    path: ".artifacts/op3b/source-recovery-evidence.png",
    fullPage: true,
  });
});

// @ts-expect-error Counted local provider fixture is plain ESM.
import {
  planningProvider,
  planningOutput,
  configurePlanning,
} from "../fixtures/planning.mjs";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
for (const recovery of ["pending", "not_applied"] as const)
  test(`counted initial draft ${recovery} retains the paid result and updates actual Markdown without inference retry`, async ({
    page,
    core,
  }) => {
    const provider = await planningProvider();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    try {
      await configurePlanning(
        async (path: string, body?: unknown, method?: string) => ({
          status: 200,
          data: await core.request(path, body, method),
        }),
        provider.root,
      );
      const source = await core.request("/manuscript/source"),
        planning = await core.request("/planning");
      planning.content.brief.topic = "A captured draft";
      planning.content.brief.language = "en";
      planning.content.nodes = [
        {
          id: randomUUID(),
          revision: 1,
          depth: 0,
          title: "Birds learn 中文",
          keyPoints: [],
        },
      ];
      await core.request("/manuscript/commands", {
        type: "SavePlanning",
        requestId: randomUUID(),
        projectId: source.projectId,
        expectedWorkingRevision: source.workingRevision,
        payload: {
          content: planning.content,
          group: {
            clientSessionId: randomUUID(),
            groupId: randomUUID(),
            groupSequence: 1,
            kind: "discrete",
          },
        },
      });
      provider.setHandler(async (_req: unknown, res: any, body: any) => {
        await held;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: { content: JSON.stringify(planningOutput(body)) },
                finish_reason: "stop",
              },
            ],
          }),
        );
      });
      await openWorkbench(page);
      const original = await editor(page).elementHandle();
      await page.getByRole("button", { name: "Outline", exact: true }).click();
      await page
        .getByRole("button", {
          name: "Write draft from this outline",
          exact: true,
        })
        .click();
      await expect.poll(() => provider.calls.length).toBe(1);
      const guarded = await core.request("/manuscript/source");
      await expect(
        core.request("/manuscript/source", {
          requestId: randomUUID(),
          projectId: guarded.projectId,
          expectedWorkingRevision: guarded.workingRevision,
          expectedGeneration: guarded.generation,
          expectedHash: guarded.acceptedHash,
          source: "Unpermitted manual body",
          group: {
            clientSessionId: randomUUID(),
            groupId: randomUUID(),
            groupSequence: 1,
            kind: "discrete",
          },
        }),
      ).rejects.toThrow("TASK_USING_CONTENT");
      await core.external("External notes while the draft runs\r\n");
      release();
      let task: any;
      await expect
        .poll(async () => {
          task = (await core.request("/planning")).tasks[0];
          return task?.run.status;
        })
        .toBe("succeeded");
      expect(task.application).toBe("pending");
      await page
        .getByRole("button", { name: "Generation history", exact: true })
        .click();
      await expect(
        page.getByText("Result ready; waiting to apply…", { exact: true }),
      ).toBeVisible();
      if (recovery === "not_applied") {
        await core.injectIntent(true, 2, task.id);
        await changes(page);
        await page
          .getByRole("button", { name: "Rescan file", exact: true })
          .click();
        await page
          .getByRole("button", {
            name: "Preserve unexpected files and clear write fence",
            exact: true,
          })
          .click();
        await expect
          .poll(
            async () =>
              (await core.request(`/planning/tasks/${task.id}`)).application,
          )
          .toBe("not_applied");
        await page
          .getByRole("button", { name: "Rescan file", exact: true })
          .click();
        await expect(
          page.getByRole("button", {
            name: "Restore saved file; discard external changes",
            exact: true,
          }),
        ).toBeVisible();
        await page
          .getByRole("button", {
            name: "Restore saved file; discard external changes",
            exact: true,
          })
          .click();
        await expect
          .poll(
            async () =>
              await core
                .disk()
                .then((bytes) => bytes.toString())
                .catch(() => "missing"),
          )
          .toBe("");
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await page
          .getByRole("button", {
            name: "Use saved result locally",
            exact: true,
          })
          .click();
      } else {
        await changes(page);
        await page
          .getByRole("button", { name: "Rescan file", exact: true })
          .click();
        await expect(
          page.getByRole("button", {
            name: "Restore saved file; discard external changes",
            exact: true,
          }),
        ).toBeVisible();
        await page
          .getByRole("button", {
            name: "Restore saved file; discard external changes",
            exact: true,
          })
          .click();
        await page.getByRole("button", { name: "Close", exact: true }).click();
      }
      await expect
        .poll(
          async () =>
            (await core.request(`/planning/tasks/${task.id}`)).application,
        )
        .toBe("applied");
      await expect(editor(page)).toContainText("完整初稿");
      expect((await core.disk()).toString()).toContain("完整初稿");
      expect(provider.calls).toHaveLength(1);
      expect(await original?.evaluate((node) => node.isConnected)).toBe(true);
    } finally {
      release?.();
      await provider.close();
    }
  });

test("partial source review decodes inline text, protects only the active scope, and accepts into Markdown", async ({
  page,
  core,
}) => {
  const provider = await planningProvider();
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  try {
    await configurePlanning(
      async (path: string, body?: unknown, method?: string) => ({
        status: 200,
        data: await core.request(path, body, method),
      }),
      provider.root,
    );
    await core.seed(
      `\uFEFF${mark(idA)}\r\n\r\nAlpha **中😀** &amp; [link](https://example.com)\r\n\r\n${mark(idB)}\n\nOutside stays\n`,
    );
    await openWorkbench(page);
    provider.setHandler(async (_req: unknown, res: any, body: any) => {
      await hold;
      const user = body.messages.find((m: any) => m.role === "user").content;
      const input = JSON.parse(
        typeof user === "string"
          ? user
          : user.find((p: any) => p.type === "text").text,
      );
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: {
                content: JSON.stringify({
                  schemaVersion: 1,
                  mode: "replace_ranges",
                  explanation: "Clarify selected text",
                  replacements: input.thread.anchor.ranges.map(
                    (_: any, rangeIndex: number) => ({
                      rangeIndex,
                      runs: [{ text: "清晰🐦", marks: [] }],
                    }),
                  ),
                }),
              },
              finish_reason: "stop",
            },
          ],
        }),
      );
    });
    await replace(page, "中😀", "中😀");
    await page.keyboard.press("Control+s");
    await saved(page);
    // Select the actual decorated source text without editing it.
    await editor(page).evaluate((node: HTMLElement) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walker.nextNode())) {
        const at = text.textContent?.indexOf("中😀") ?? -1;
        if (at >= 0) {
          const range = document.createRange();
          range.setStart(text, at);
          range.setEnd(text, at + 3);
          document.getSelection()!.removeAllRanges();
          document.getSelection()!.addRange(range);
          node.focus();
          return;
        }
      }
      throw Error("Selection target missing");
    });
    await openPanel(page, "Comments");
    const panel = page.getByRole("complementary", {
      name: "Comments",
      exact: true,
    });
    await panel
      .getByRole("button", { name: "Review selection", exact: true })
      .click();
    await panel.getByLabel("Comment type").selectOption("revision_note");
    await panel
      .getByLabel("Your question or instruction")
      .fill("Clarify just the selected Chinese and emoji");
    await panel
      .getByRole("button", { name: "Save comment", exact: true })
      .click();
    await expect(panel.locator(".review-card")).toHaveCount(1);
    const review = (await core.request("/reviews")).cards[0];
    expect(review.thread.anchor.ranges[0]).toMatchObject({
      blockId: idA,
      start: 6,
      end: 9,
      quote: "中😀",
      wholeBlock: false,
    });
    await panel
      .getByRole("button", { name: "Generate change", exact: true })
      .click();
    await expect.poll(() => provider.calls.length).toBe(1);
    await expect(
      page
        .locator(`[data-lock-block="${idA}"]`)
        .locator("..")
        .getByRole("status"),
    ).toBeVisible();
    await replace(page, "Alpha", "Forbidden");
    await expect(editor(page)).toContainText("Alpha");
    await replace(page, "Outside stays", "Outside edited");
    await page.keyboard.press("Control+s");
    await saved(page);
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("Independent new C");
    await page.keyboard.press("Control+s");
    await saved(page);
    release();
    await expect(
      panel.getByRole("button", { name: "Accept change", exact: true }),
    ).toBeEnabled();
    await panel
      .getByRole("button", { name: "Accept change", exact: true })
      .click();
    await expect(editor(page)).toContainText("清晰🐦");
    const disk = (await core.disk()).toString();
    expect(disk).toContain("清晰🐦");
    expect(disk).toContain("Alpha");
    expect(disk).toContain("Outside edited");
    expect(provider.calls).toHaveLength(1);
  } finally {
    release?.();
    await provider.close();
  }
});

test("live deletion/retype and ordinary clipboard preserve leaf identities beside an independently locked block", async ({
  page,
  core,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await core.seed(
    `\uFEFF${mark(idA)}\r\n\r\nLocked A\r\n\r\n${mark(idB)}\n\nEditable B\n`,
  );
  await openWorkbench(page);
  await page.locator(`[data-lock-block="${idA}"]`).click();
  await expect(page.locator(`[data-lock-block="${idA}"]`)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const before = await core.request("/manuscript");
  await replace(page, "Editable B", "");
  await page.keyboard.press("Control+s");
  await saved(page);
  const empty = await core.request("/manuscript/source");
  expect(empty.source).toContain(`scenesparrow:empty=${idB}`);
  expect(empty.source).toContain("Locked A");
  await editor(page).dispatchEvent("compositionstart");
  await page.keyboard.insertText("重写中文😀");
  await editor(page).dispatchEvent("compositionend");
  await page.keyboard.press("Control+s");
  await saved(page);
  const retyped = await core.request("/manuscript/source");
  expect(retyped.source).toContain(`scenesparrow:block=${idB}`);
  await expect(editor(page)).toContainText("重写中文😀");
  const after = await core.request("/manuscript");
  expect(after.blocks.find((b: any) => b.id === idA).revision).toBe(
    before.blocks.find((b: any) => b.id === idA).revision,
  );
  // The ordinary live clipboard includes hidden metadata in its raw selection,
  // while A remains locked throughout the independent insertion.
  await editor(page).focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+c");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).not.toContain("scenesparrow:");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+v");
  await page.keyboard.press("Control+s");
  await saved(page);
  const pasted = await core.request("/manuscript/source");
  expect(pasted.bindings.filter((b: any) => b.id === idB)).toHaveLength(1);
  expect(pasted.semanticBlockIds).toHaveLength(4);
  await projectHistory(page, "Undo");
  await saved(page);
  await expect
    .poll(
      async () =>
        (await core.request("/manuscript/source")).semanticBlockIds.length,
    )
    .toBe(2);
  await projectHistory(page, "Redo");
  await saved(page);
  await expect
    .poll(
      async () =>
        (await core.request("/manuscript/source")).semanticBlockIds.length,
    )
    .toBe(4);
  expect(
    (await core.request("/manuscript")).blocks.find((b: any) => b.id === idA)
      .revision,
  ).toBe(before.blocks.find((b: any) => b.id === idA).revision);
});

test("native CRLF breaks and raw CommonMark code spans retain decoded review coordinates", async ({
  page,
  core,
}) => {
  const raw = `\uFEFF${mark(idA)}\r\n\r\nOne\r\nsoft  \r\nhard \` \r\n中😀\r\n \` and \`   \` and \`literal &amp; \\*\`\r\n`;
  await core.seed(raw);
  await openWorkbench(page);
  await saved(page);
  const native = await core.request("/manuscript");
  expect(native.blocks[0].runs.map((r: any) => r.text).join("")).toBe(
    "One\nsoft\nhard  中😀  and     and literal &amp; \\*",
  );
  // Source mode exposes precise token interiors; ordinary live selection keeps
  // that active line raw while the review owner receives decoded text ranges.
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await editor(page).evaluate((node: HTMLElement) => {
    node.focus();
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let child;
    while ((child = walker.nextNode())) {
      const at = child.textContent?.indexOf("中😀") ?? -1;
      if (at >= 0) {
        const range = document.createRange();
        range.setStart(child, at);
        range.setEnd(child, at + 3);
        document.getSelection()!.removeAllRanges();
        document.getSelection()!.addRange(range);
        return;
      }
    }
    throw Error("Code span selection missing");
  });
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await openPanel(page, "Comments");
  const panel = page.getByRole("complementary", {
    name: "Comments",
    exact: true,
  });
  await panel
    .getByRole("button", { name: "Review selection", exact: true })
    .click();
  await panel
    .getByLabel("Your question or instruction")
    .fill("Check this normalized code span");
  await panel
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await expect(panel.locator(".review-card")).toHaveCount(1);
  const anchor = (await core.request("/reviews")).cards[0].thread.anchor
    .ranges[0];
  expect(anchor).toMatchObject({
    blockId: idA,
    quote: "中😀",
    start: 15,
    end: 18,
    wholeBlock: false,
  });
  expect((await core.disk()).toString()).toBe(raw);
});

test("source/planning share manual history and localized narrow recovery retains the mounted editor", async ({
  page,
  core,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "scenesparrow.application-preferences",
      JSON.stringify({ version: 1, saveMode: "off", saveDelaySeconds: 5 }),
    ),
  );
  await core.seed(`${mark(idA)}\r\n\r\nBody0\r\n`);
  await openWorkbench(page);
  const handle = await editor(page).elementHandle();
  const writes: string[] = [];
  core.intercept(async (path, body, phase) => {
    if (body && phase === "before") writes.push(path);
  });
  for (let index = 1; index <= 6; index++) {
    await replace(page, `Body${index - 1}`, `Body${index}`);
    await page.keyboard.press("ArrowLeft");
  }
  expect(
    writes.filter((path) => path.endsWith("/manuscript/source")),
  ).toHaveLength(0);
  await page.keyboard.press("Control+s");
  await saved(page);
  const history = await core.request("/history");
  expect(history.undoCount).toBe(5);
  await page.waitForTimeout(2300);
  expect(await core.request("/history")).toEqual(history);
  await page.getByRole("button", { name: "Outline", exact: true }).click();
  await page
    .getByLabel("Your idea", { exact: true })
    .fill("Shared source and planning input 中文");
  await page.keyboard.press("Control+s");
  await saved(page);
  expect((await core.request("/planning")).content.brief.topic).toContain(
    "Shared source",
  );
  await page
    .getByRole("group", { name: "Writing view" })
    .getByRole("button", { name: "Manuscript", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh-CN");
  await expect(
    page.getByRole("textbox", { name: "文稿", exact: true }),
  ).toBeVisible();
  expect(await handle?.evaluate((node) => node.isConnected)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("source-changes").click();
  const dialog = page.getByRole("dialog", { name: "文件变更", exact: true });
  await expect(dialog).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() => !!document.activeElement?.closest("dialog")),
  ).toBe(true);
  await page.screenshot({
    path: ".artifacts/op3b/source-changes-zh-mobile.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("source-changes")).toBeFocused();
  expect((await core.disk()).toString()).toContain("Body6");
});

test("an unsaved combined proposal guards browser refresh while the manuscript is saved", async ({
  page,
  core,
}) => {
  const raw = `${mark(idA)}\n\nSaved body\n`;
  await core.seed(raw);
  await openWorkbench(page);
  await saved(page);
  await core.external(raw.replace("Saved body", "External body"));
  await expect(page.getByTestId("source-changes")).toHaveAttribute(
    "data-pending",
    "true",
  );
  await changes(page);
  await page.getByText("Combined proposal", { exact: true }).first().click();
  await page
    .getByRole("textbox", { name: "Combined proposal", exact: true })
    .fill("Proposal draft kept in this tab");
  await saved(page);
  expect(
    await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
});

test("clean external acceptance and a one-line combined proposal preserve exact mixed endings; partial writes stay pending", async ({
  page,
  core,
}) => {
  const raw = `\uFEFF${mark(idA)}\r\n\r\nUntouched A\r\n\r\n${mark(idB)}\n\nBody B\n`;
  await core.seed(raw);
  await openWorkbench(page);
  await core.external(raw.replace("Body B", "External B"));
  await expect(page.getByTestId("source-changes")).toHaveAttribute(
    "data-pending",
    "true",
  );
  await expect(editor(page)).toContainText("Body B");
  await changes(page);
  await expect(
    page.getByRole("button", { name: "Use external content", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Use external content", exact: true })
    .click();
  await expect
    .poll(async () => (await core.request("/manuscript/source")).source)
    .toBe(raw.replace("Body B", "External B"));
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await saved(page);
  await core.external(raw.replace("Body B", "New external B"));
  await expect(page.getByTestId("source-changes")).toHaveAttribute(
    "data-pending",
    "true",
  );
  await replace(page, "External B", "Local B");
  await changes(page);
  await page.getByText("Combined proposal", { exact: true }).first().click();
  const proposal = page.getByRole("textbox", {
    name: "Combined proposal",
    exact: true,
  });
  await proposal.fill(
    (await proposal.inputValue()).replace("Local B", "Combined B"),
  );
  const proposalNode = await proposal.elementHandle();
  await proposal.focus();
  await proposal.press("Control+End");
  let candidateRead!: () => void, releaseCandidate!: () => void;
  const candidateObserved = new Promise<void>(
    (resolve) => (candidateRead = resolve),
  );
  const candidateHeld = new Promise<void>(
    (resolve) => (releaseCandidate = resolve),
  );
  let heldCandidate = false;
  core.intercept(async (path, _body, phase) => {
    if (
      path.includes("/manuscript/source/candidates/") &&
      phase === "after" &&
      !heldCandidate
    ) {
      heldCandidate = true;
      candidateRead();
      await candidateHeld;
    }
  });
  await core.external(raw.replace("Body B", "Third external B"));
  await candidateObserved;
  await expect(proposal).toBeFocused();
  expect(await proposalNode?.evaluate((node) => node.isConnected)).toBe(true);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.insertText(" 中文😀");
  const proposalCaret = await proposal.evaluate(
    (node: HTMLTextAreaElement) => node.selectionStart,
  );
  await expect(
    page.getByRole("button", { name: "Save edited proposal", exact: true }),
  ).toBeDisabled();
  releaseCandidate();
  await expect(
    page.getByRole("region", { name: "External changes from saved source" }),
  ).toContainText("Third external B");
  expect(await proposalNode?.evaluate((node) => node.isConnected)).toBe(true);
  await expect(proposal).toBeFocused();
  expect(
    await proposal.evaluate((node: HTMLTextAreaElement) => node.selectionStart),
  ).toBe(proposalCaret);
  await expect(proposal).toHaveValue(/Combined B 中文😀/);

  await page
    .getByRole("button", { name: "Save edited proposal", exact: true })
    .click();
  await expect
    .poll(async () => (await core.disk()).toString())
    .toBe(raw.replace("Body B", "Combined B 中文😀"));
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await saved(page);
  await core.external("<!-- scenesparrow:block=");
  await page.getByTestId("source-changes").click();
  await page.getByRole("button", { name: "Rescan file", exact: true }).click();
  await expect(
    page.getByText(
      "This external version is incomplete or invalid. Keep your local source, restore the saved file, or edit a complete proposal.",
    ),
  ).toBeVisible();
  await expect(editor(page)).toContainText("Combined B");
  await expect(
    page.getByRole("button", { name: "Use external content", exact: true }),
  ).toBeDisabled();
});

test("lost save ACK with a newer accepted snapshot retains local input and offers explicit recovery without an external candidate", async ({
  page,
  core,
}) => {
  await core.seed(`${mark(idA)}\r\n\r\nBody\r\n`);
  await openWorkbench(page);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (entered = r));
  let writes = 0;
  core.intercept(async (path, body, phase) => {
    if (path.endsWith("/manuscript/source") && body && phase === "after") {
      writes++;
      if (writes === 1) {
        entered();
        await held;
        return "abort";
      }
    }
  });
  await replace(page, "Body", "Edited");
  await page.keyboard.press("Control+s");
  await started;
  await page.keyboard.insertText(" newer input");
  const current = await core.request("/manuscript/source");
  await core.request("/manuscript/source", {
    requestId: randomUUID(),
    projectId: current.projectId,
    expectedWorkingRevision: current.workingRevision,
    expectedGeneration: current.generation,
    expectedHash: current.acceptedHash,
    source: current.source.replace("Edited", "Other client accepted"),
    group: {
      clientSessionId: randomUUID(),
      groupId: randomUUID(),
      groupSequence: 1,
      kind: "discrete",
    },
  });
  release();
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "conflict",
  );
  await expect(editor(page)).toContainText("Edited newer input");
  await page.waitForTimeout(3600);
  await expect(page.locator(".notification")).toHaveCount(0);
  await changes(page);
  await expect(
    page.getByRole("button", {
      name: "Discard local input and reload saved source",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    (await core.request("/manuscript/source/status")).candidateId,
  ).toBeNull();
  await page.getByText("Full source versions", { exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Local text to copy", exact: true }),
  ).toHaveValue(/Edited newer input/);
  await expect(
    page.getByRole("textbox", { name: "Saved source", exact: true }),
  ).toHaveValue(/Other client accepted/);
  await page
    .getByRole("button", {
      name: "Discard local input and reload saved source",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await saved(page);
  await expect(editor(page)).toContainText("Other client accepted");
  expect(writes).toBe(1);
});

test("native source read failures keep authoring unavailable until explicit retry instead of creating a legacy editor", async ({
  page,
  core,
}) => {
  await core.seed("Preserved native source\r\n");
  await page.route("**/api/v1/manuscript/source", (route) =>
    route.fulfill({ status: 503, json: { code: "STORAGE_UNAVAILABLE" } }),
  );
  await page.goto("/");
  await page
    .getByRole("combobox", { name: /^(Language|语言)$/ })
    .selectOption("en");
  await expect(page.locator(".cm-editor,.document-layout .tiptap")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }).first(),
  ).toBeVisible();
  await page.unroute("**/api/v1/manuscript/source");
  await page
    .getByRole("button", { name: "Try again", exact: true })
    .first()
    .click();
  await expect(editor(page)).toContainText("Preserved native source");
  await expect(page.locator(".document-layout .tiptap")).toHaveCount(0);
  expect((await core.disk()).toString()).toContain(
    "Preserved native source\r\n",
  );
});

test("native nested and empty batch ACK maps later same-leaf input without changing frozen placement", async ({
  page,
  core,
}) => {
  await core.seed("Initial\n");
  await openWorkbench(page);
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await editor(page).focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n\n> #\n\n-\n  - child\n-\n- tail");
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  let writes = 0;
  core.intercept(async (path, body, phase) => {
    if (
      path.endsWith("/manuscript/source") &&
      body &&
      phase === "after" &&
      ++writes === 1
    ) {
      entered();
      await held;
    }
  });
  await page.keyboard.press("Control+s");
  await started;
  await page.keyboard.insertText(" 中文😀");
  const accepted = await core.request("/manuscript/source");
  expect(
    accepted.bindings.some((binding: any) => binding.kind === "empty"),
  ).toBe(true);
  expect(accepted.source).toContain("scenesparrow:empty=");
  const mounted = await editor(page).elementHandle();
  release();
  await expect(page.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "pending",
  );
  await expect(editor(page)).toContainText("tail 中文😀");
  expect(await mounted?.evaluate((node) => node.isConnected)).toBe(true);
  await page.keyboard.press("Control+s");
  await saved(page);
  expect((await core.disk()).toString()).toBe(
    accepted.source.replace("tail", "tail 中文😀"),
  );
});
