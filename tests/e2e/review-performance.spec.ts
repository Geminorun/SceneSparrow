import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
// @ts-expect-error Controlled local provider fixture is plain ESM.
import { planningProvider, configurePlanning } from "../fixtures/planning.mjs";

test("measures bounded review pages and typing with 500 comments and 10 candidates", async ({
  page,
  browser,
}) => {
  test.skip(
    process.env.SCENESPARROW_REVIEW_PERFORMANCE !== "1",
    "Run the explicit review performance fixture.",
  );
  test.setTimeout(600000);
  const provider = await planningProvider();
  const req = async (path: string, body?: unknown, method?: string) => {
    const response = await page.request.fetch("/api/v1" + path, {
      method: method ?? (body ? "POST" : "GET"),
      ...(body ? { data: body } : {}),
    });
    return { status: response.status(), data: await response.json() };
  };
  const quantiles = (v: number[]) => {
    const n = [...v].sort((a, b) => a - b);
    return {
      samples: n.length,
      p50Ms: +n[Math.ceil(n.length * 0.5) - 1]!.toFixed(2),
      p95Ms: +n[Math.ceil(n.length * 0.95) - 1]!.toFixed(2),
    };
  };
  try {
    const setupStart = performance.now();
    let project = (await req("/project")).data.project;
    if (!project)
      project = (
        await req("/project", {
          requestId: crypto.randomUUID(),
          title: "Review performance",
        })
      ).data.project;
    let state = (await req("/manuscript")).data;
    const command = async (type: string, payload: unknown) => {
      const r = await req("/manuscript/commands", {
        type,
        requestId: crypto.randomUUID(),
        projectId: project.id,
        expectedWorkingRevision: state.workingRevision,
        payload,
      });
      expect(r.status, JSON.stringify(r.data)).toBe(200);
      state.workingRevision = r.data.workingRevision;
      return r.data;
    };
    if (state.workspaceStage === "outline")
      await command("StartManualDraft", {});
    const blocks = Array.from({ length: 500 }, (_, i) => ({
      id: crypto.randomUUID(),
      kind: "paragraph",
      attrs: {},
      runs: [{ text: `Source ${i} 中文`, marks: [] }],
    }));
    await command("ApplyDocumentEdit", {
      operations: blocks.map((block, i) => ({
        op: "insertBlock",
        block,
        after: i ? blocks[i - 1]!.id : null,
      })),
      expectedBlockRevisions: [],
      group: {
        groupId: crypto.randomUUID(),
        clientSessionId: crypto.randomUUID(),
        groupSequence: 1,
        kind: "discrete",
      },
    });
    state = (await req("/manuscript")).data;
    const threads: string[] = [];
    for (let i = 0; i < 500; i++) {
      const id = `${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
        b = state.blocks[i],
        quote = b.runs[0].text;
      threads.push(id);
      await command("SaveReview", {
        expectedRequestVersion: 0,
        thread: {
          id,
          kind: i < 10 ? "revision_note" : "question",
          requestVersion: 0,
          text: `Review ${i}`,
          anchor: {
            ranges: [
              {
                blockId: b.id,
                revision: b.revision,
                start: 0,
                end: quote.length,
                quote,
                wholeBlock: true,
              },
            ],
            state: "mapped",
            slot: null,
          },
          handled: false,
          deleted: false,
          language: "zh-CN",
          evidence: [],
          decision: null,
          userMessageIds: [],
        },
      });
    }
    provider.setHandler(
      async (
        _req: unknown,
        res: {
          setHeader: (k: string, v: string) => void;
          end: (v: string) => void;
        },
      ) => {
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
                    explanation: "Controlled performance proposal",
                    replacements: [
                      {
                        rangeIndex: 0,
                        runs: [{ text: "Candidate 中文", marks: [] }],
                      },
                    ],
                  }),
                },
                finish_reason: "stop",
              },
            ],
          }),
        );
      },
    );
    await configurePlanning(req, provider.root);
    for (const threadId of threads.slice(0, 10)) {
      await command("StartReviewTask", { threadId, requestVersion: 1 });
      await expect
        .poll(
          async () => {
            const cards = (await req("/reviews")).data.cards;
            return cards.find(
              (c: { thread: { id: string } }) => c.thread.id === threadId,
            )?.candidate?.status;
          },
          { timeout: 60000 },
        )
        .toBe("pending");
    }
    const setupMs = performance.now() - setupStart,
      results = [];
    let largeIds: string[] = [];
    for (const size of [500000, 2000000]) {
      const current = (await req("/manuscript")).data;
      state = current;
      const chunk = Math.ceil((size - 5000) / 4),
        large = Array.from({ length: 4 }, (_, i) => ({
          id: largeIds[i] ?? crypto.randomUUID(),
          kind: "paragraph",
          attrs: {},
          runs: [{ text: "x".repeat(chunk), marks: [] }],
        }));
      await command("ApplyDocumentEdit", {
        operations: large.map((b, i) =>
          largeIds.length
            ? { op: "setBlockContent", id: b.id, runs: b.runs }
            : {
                op: "insertBlock",
                block: b,
                after: i ? large[i - 1]!.id : blocks.at(-1)!.id,
              },
        ),
        expectedBlockRevisions: current.blocks
          .filter((b: { id: string }) => largeIds.includes(b.id))
          .map((b: { id: string; revision: number }) => ({
            id: b.id,
            revision: b.revision,
          })),
        group: {
          groupId: crypto.randomUUID(),
          clientSessionId: crypto.randomUUID(),
          groupSequence: 1,
          kind: "discrete",
        },
      });
      largeIds = large.map((b) => b.id);
      const opened = performance.now();
      await page.goto("/");
      await page
        .getByRole("combobox", { name: "Language", exact: true })
        .selectOption("en");
      const editor = page.getByRole("textbox", {
        name: "Manuscript",
        exact: true,
      });
      await expect(editor).toBeVisible();
      await expect(page.locator(".review-card")).toHaveCount(40);
      const openMs = performance.now() - opened;
      const typing: number[] = [],
        save: number[] = [],
        undo: number[] = [],
        scroll: number[] = [];
      for (let n = 0; n < 5; n++) {
        await editor.click();
        await editor.press("ControlOrMeta+End");
        await page.evaluate(() => {
          (window as unknown as { sample: number | null }).sample = null;
          document.querySelector(".tiptap")!.addEventListener(
            "keydown",
            () => {
              const start = performance.now();
              requestAnimationFrame(() => {
                (window as unknown as { sample: number }).sample =
                  performance.now() - start;
              });
            },
            { capture: true, once: true },
          );
        });
        await page.keyboard.press("z");
        await page.waitForFunction(
          () =>
            (window as unknown as { sample: number | null }).sample !== null,
        );
        typing.push(
          await page.evaluate(
            () => (window as unknown as { sample: number }).sample,
          ),
        );
        const saveStart = performance.now();
        await page
          .getByRole("heading", { name: "Manuscript", exact: true })
          .click();
        await expect(page.getByTestId("save-status")).toHaveAttribute(
          "data-state",
          "saved",
          { timeout: 60000 },
        );
        save.push(performance.now() - saveStart);
        const undoStart = performance.now();
        await Promise.all([
          page.waitForResponse(
            (response) =>
              response.url().endsWith("/manuscript/commands") &&
              response.request().postDataJSON()?.type === "UndoProject",
          ),
          page.getByRole("button", { name: "Undo", exact: true }).click(),
        ]);
        await expect(
          page.getByRole("button", { name: "Redo", exact: true }),
        ).toBeEnabled({ timeout: 60000 });
        undo.push(performance.now() - undoStart);
        await Promise.all([
          page.waitForResponse(
            (response) =>
              response.url().endsWith("/manuscript/commands") &&
              response.request().postDataJSON()?.type === "RedoProject",
          ),
          page.getByRole("button", { name: "Redo", exact: true }).click(),
        ]);
        await expect(
          page.getByRole("button", { name: "Undo", exact: true }),
        ).toBeEnabled({ timeout: 60000 });
        scroll.push(
          await page.evaluate(async () => {
            const start = performance.now();
            window.scrollTo(0, 0);
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);
            return performance.now() - start;
          }),
        );
      }
      const currentBody = (await req("/manuscript")).data;
      let count = 0,
        cursor: string | undefined;
      do {
        const page = (
          await req("/reviews" + (cursor ? `?after=${cursor}` : ""))
        ).data;
        count += page.cards.length;
        cursor = page.nextCursor;
      } while (cursor);
      expect(count).toBe(500);
      expect(
        (await req("/reviews")).data.cards.filter(
          (card: { candidate?: { status: string } }) =>
            card.candidate?.status === "pending",
        ),
      ).toHaveLength(10);
      results.push({
        nominalBytes: size,
        canonicalJsonBytes: Buffer.byteLength(JSON.stringify(currentBody)),
        actualTextBytes: Buffer.byteLength(
          currentBody.blocks
            .map((b: { runs: Array<{ text: string }> }) =>
              b.runs.map((r) => r.text).join(""),
            )
            .join(""),
        ),
        comments: 500,
        pendingCandidates: 10,
        visibleCards: await page.locator(".review-card").count(),
        visibleLockControls: await page.locator("[data-lock-block]").count(),
        openMs: +openMs.toFixed(2),
        typing: quantiles(typing),
        save: quantiles(save),
        undo: quantiles(undo),
        scrollTwoFrames: quantiles(scroll),
        sampledCoreRssKiB: execFileSync(
          "ps",
          ["-C", "scenesparrow-service", "-o", "rss="],
          { encoding: "utf8" },
        )
          .trim()
          .split(/\s+/)
          .map(Number)
          .filter((value) => value > 0),
      });
    }
    const report = {
      platform: process.platform,
      browser: browser.version(),
      build: "debug core + Vite development browser",
      setupMs: +setupMs.toFixed(2),
      provider: "counted localhost fake endpoint through actual SDK",
      providerCalls: provider.calls.length,
      results,
    };
    expect(provider.calls).toHaveLength(10);
    await mkdir(".artifacts", { recursive: true });
    await writeFile(
      ".artifacts/review-performance.json",
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } finally {
    await provider.close();
  }
});
