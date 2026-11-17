import { projectHistory, openDocumentMenu } from "./helpers/workbench";
import { test, expect } from "@playwright/test";
import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
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
  test.setTimeout(1800000);
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
      id: `00000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, "0")}`,
      kind: i % 100 === 0 ? "heading" : i % 100 < 4 ? "list_item" : "paragraph",
      attrs:
        i % 100 === 0
          ? { level: 2 }
          : i % 100 < 4
            ? {
                listKind: i % 100 === 2 ? "ordered" : "bullet",
                depth: i % 100 === 2 ? 1 : 0,
              }
            : {},
      runs: [
        {
          text: `Source ${i} 中文`,
          marks: i % 17 === 0 ? [{ type: "bold" }] : [],
        },
      ],
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
    const sources: Array<{ name: string; bytes: number; sha256: string }> = [];
    if (process.env.SCENESPARROW_PERF_SOURCES === "1") {
      // @ts-expect-error Self-authored document fixtures are plain ESM.
      const { docx, pdf } = await import("../fixtures/documents.mjs");
      const files = [
        {
          name: "large-source.txt",
          bytes: Buffer.from("source only 中文 é\n".repeat(262144)),
        },
        {
          name: "reference.md",
          bytes: Buffer.from("# Reference\n\nSource **only** 中文\n"),
        },
        {
          name: "reference.docx",
          bytes: docx("<w:p><w:r><w:t>Reference only 中文</w:t></w:r></w:p>"),
        },
        {
          name: "reference.pdf",
          bytes: pdf([{ text: "Reference source only" }]),
        },
      ];
      const { createHash } = await import("node:crypto");
      for (const file of files) {
        const intakeId = crypto.randomUUID();
        const upload = await page.request.post("/api/v1/intakes", {
          headers: {
            "x-intake-id": intakeId,
            "x-file-name": encodeURIComponent(file.name),
            "content-type": "application/octet-stream",
          },
          data: file.bytes,
        });
        expect(upload.ok()).toBeTruthy();
        const intake = await upload.json();
        state = (await req("/manuscript")).data;
        await command("AddSourceFile", {
          sourceId: crypto.randomUUID(),
          intakeId: intake.id,
          hash: intake.hash,
        });
        sources.push({
          name: file.name,
          bytes: file.bytes.length,
          sha256: createHash("sha256").update(file.bytes).digest("hex"),
        });
      }
    }
    let largeIds: string[] = [];
    for (const size of (
      process.env.SCENESPARROW_PERF_SIZES ?? "50000,500000,2000000"
    )
      .split(",")
      .map(Number)) {
      const current = (await req("/manuscript")).data;
      state = current;
      const chunk = Math.ceil((size - 5000) / 4),
        large = Array.from({ length: 4 }, (_, i) => ({
          id:
            largeIds[i] ??
            `ffffffff-0000-4000-8000-${(i + 1).toString(16).padStart(12, "0")}`,
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
      for (
        let n = 0;
        n < Number(process.env.SCENESPARROW_PERF_SAMPLES ?? 50);
        n++
      ) {
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
          projectHistory(page, "Undo"),
        ]);
        await openDocumentMenu(page);
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
          projectHistory(page, "Redo"),
        ]);
        await openDocumentMenu(page);
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
        blockCount: currentBody.blocks.length,
        longestTextBlockBytes: Math.max(
          ...currentBody.blocks.map((b: { runs: Array<{ text: string }> }) =>
            Buffer.byteLength(b.runs.map((r) => r.text).join("")),
          ),
        ),
        fixtureSha256: await page.evaluate(
          async (body) =>
            [
              ...new Uint8Array(
                await crypto.subtle.digest(
                  "SHA-256",
                  new TextEncoder().encode(JSON.stringify(body)),
                ),
              ),
            ]
              .map((n) => n.toString(16).padStart(2, "0"))
              .join(""),
          currentBody.blocks,
        ),
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
        sampledProcessRssKiB: await (async () => {
          const pids = process.env.SCENESPARROW_PERF_PID_FILE
            ? JSON.parse(
                await readFile(process.env.SCENESPARROW_PERF_PID_FILE, "utf8"),
              )
            : {};
          pids.testWorker = process.pid;
          const cdp = await browser.newBrowserCDPSession();
          const info = await cdp.send("SystemInfo.getProcessInfo");
          await cdp.detach();
          for (const p of info.processInfo)
            pids[`chromium-${p.type}-${p.id}`] = p.id;
          const rss: Record<string, { pid: number; rssKiB: number }> = {};
          for (const [label, pid] of Object.entries(pids))
            try {
              const status = await readFile(`/proc/${pid}/status`, "utf8");
              const kib = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0);
              if (kib > 0) rss[label] = { pid: Number(pid), rssKiB: kib };
            } catch {}
          return rss;
        })(),
      });
    }
    const report = {
      platform: process.platform,
      browser: browser.version(),
      build:
        process.env.SCENESPARROW_PRODUCTION_UI === "1"
          ? "release core + production browser"
          : "debug core + Vite development browser",
      hardware: {
        cpu: "AMD EPYC 9V74",
        effectiveCpuQuota: 4,
        cgroupMemoryGiB: 32,
      },
      sources,
      samplesPerOperation: Number(process.env.SCENESPARROW_PERF_SAMPLES ?? 50),
      setupMs: +setupMs.toFixed(2),
      provider: "counted localhost fake endpoint through actual SDK",
      providerCalls: provider.calls.length,
      results,
    };
    expect(provider.calls).toHaveLength(10);
    await mkdir(".artifacts", { recursive: true });
    await writeFile(
      `.artifacts/${process.env.SCENESPARROW_PERF_LABEL ?? "review-performance"}.json`,
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } finally {
    await provider.close();
  }
});
