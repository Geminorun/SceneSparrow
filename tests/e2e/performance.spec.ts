import { openWorkbench } from "./helpers/workbench";
import { test, expect } from "@playwright/test";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
test("measures Linux manuscript fixtures with real browser input and core receipts", async ({
  page,
  browser,
}) => {
  test.skip(
    process.env.SCENESPARROW_PERFORMANCE !== "1",
    "Run pnpm perf:s1 explicitly.",
  );
  test.setTimeout(240000);
  await openWorkbench(page);
  await expect(
    page.getByRole("button", { name: "Import manuscript", exact: true }),
  ).toBeVisible();
  const project = (await (await page.request.get("/api/v1/project")).json())
    .project;
  const quantiles = (samples: number[]) => {
    const ordered = [...samples].sort((a, b) => a - b);
    return {
      samples: samples.length,
      p50Ms: Number(ordered[Math.ceil(ordered.length * 0.5) - 1]!.toFixed(2)),
      p95Ms: Number(ordered[Math.ceil(ordered.length * 0.95) - 1]!.toFixed(2)),
    };
  };
  const results = [];
  for (const size of [50000, 500000, 2000000]) {
    const text = Array.from(
      { length: Math.ceil(size / 1000) },
      (_, i) => `${String(i).padStart(5, "0")} ` + "x".repeat(992),
    )
      .join("\n\n")
      .slice(0, size);
    const current = await (await page.request.get("/api/v1/manuscript")).json();
    const jobId = crypto.randomUUID();
    const response = await page.request.post("/api/v1/document-jobs", {
      data: {
        type: "preparePaste",
        jobId,
        text,
        expectedWorkingRevision: current.workingRevision,
      },
    });
    expect(response.ok()).toBeTruthy();
    let job;
    for (let n = 0; n < 400; n++) {
      job = await (
        await page.request.get(`/api/v1/document-jobs/${jobId}`)
      ).json();
      if (!["queued", "running"].includes(job.status)) break;
      await page.waitForTimeout(25);
    }
    expect(job.status).toBe("ready");
    const imported = await page.request.post("/api/v1/manuscript/commands", {
      data: {
        type: "CommitManuscriptImport",
        requestId: crypto.randomUUID(),
        projectId: project.id,
        expectedWorkingRevision: current.workingRevision,
        payload: {
          preparedId: jobId,
          candidateHash: job.candidateHash,
          mode: current.workspaceStage === "outline" ? "start" : "replace",
        },
      },
    });
    expect(imported.ok()).toBeTruthy();
    await page.reload();
    const editor = page.getByRole("textbox", {
      name: "Manuscript",
      exact: true,
    });
    await expect(editor).toBeVisible();
    await editor.click();
    await editor.press("ControlOrMeta+End");
    const typing: number[] = [],
      flush: number[] = [],
      undo: number[] = [];
    for (let sample = 0; sample < 10; sample++) {
      await page.evaluate(() => {
        const target = window as unknown as { typingSample: number | null };
        target.typingSample = null;
        document.querySelector(".tiptap")!.addEventListener(
          "keydown",
          () => {
            const start = performance.now();
            requestAnimationFrame(() => {
              target.typingSample = performance.now() - start;
            });
          },
          { once: true, capture: true },
        );
      });
      await page.keyboard.press("z");
      await page.waitForFunction(
        () =>
          (window as unknown as { typingSample: number | null })
            .typingSample !== null,
        undefined,
        { timeout: 5000 },
      );
      typing.push(
        await page.evaluate(
          () => (window as unknown as { typingSample: number }).typingSample,
        ),
      );
      const start = performance.now();
      await page
        .getByRole("heading", { name: "Manuscript", exact: true })
        .click();
      await expect(page.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "saved",
        { timeout: 30000 },
      );
      flush.push(performance.now() - start);
      const undoStart = performance.now();
      await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().endsWith("/manuscript/commands") &&
            r.request().postDataJSON()?.type === "UndoProject",
        ),
        page.getByRole("button", { name: "Undo", exact: true }).click(),
      ]);
      await expect(
        page.getByRole("button", { name: "Redo", exact: true }),
      ).toBeEnabled({ timeout: 30000 });
      undo.push(performance.now() - undoStart);
      await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().endsWith("/manuscript/commands") &&
            r.request().postDataJSON()?.type === "RedoProject",
        ),
        page.getByRole("button", { name: "Redo", exact: true }).click(),
      ]);
      await expect(
        page.getByRole("button", { name: "Undo", exact: true }),
      ).toBeEnabled({ timeout: 30000 });
      await editor.click();
      await editor.press("ControlOrMeta+End");
    }
    const directories = (await readdir(".local"))
      .filter((n) => /^e2e-\d+$/.test(n))
      .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
    const directory = join(".local", directories.at(-1)!);
    const db = new DatabaseSync(join(directory, "project.sqlite"), {
      readOnly: true,
    });
    const hashes = db
      .prepare(
        "SELECT snapshot_hash AS hash FROM manuscripts WHERE snapshot_hash IS NOT NULL UNION SELECT payload_hash FROM blocks UNION SELECT before_hash FROM history_entries UNION SELECT after_hash FROM history_entries UNION SELECT input_hash FROM import_provenance UNION SELECT result_hash FROM import_provenance",
      )
      .all()
      .map((row) => String(row.hash));
    db.close();
    let retainedBytes = 0;
    for (const hash of new Set(hashes))
      retainedBytes += (await stat(join(directory, "objects", hash))).size;
    const objects = await readdir(join(directory, "objects"));
    let objectBytes = 0;
    for (const hash of objects)
      objectBytes += (await stat(join(directory, "objects", hash))).size;
    const cdp = await browser.newBrowserCDPSession();
    const info = await cdp.send("SystemInfo.getProcessInfo");
    let browserRss = 0;
    for (const process of info.processInfo) {
      try {
        const status = await readFile(`/proc/${process.id}/status`, "utf8");
        browserRss += Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024;
      } catch {}
    }
    await cdp.detach();
    const coreRows = execFileSync("ps", ["-eo", "pid=,comm=,rss="], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((line) => line.includes("scenesparrow"));
    const coreRss = coreRows.reduce(
      (total, line) => total + Number(line.trim().split(/\s+/).at(-1)) * 1024,
      0,
    );
    results.push({
      fixtureBytes: Buffer.byteLength(text),
      blocks: job.result.blocks.length,
      syntheticKeydownToAnimationFrame: quantiles(typing),
      blurToSaved: quantiles(flush),
      undoClickToRedoAvailable: quantiles(undo),
      retainedKnownObjectBytes: retainedBytes,
      totalLiveObjectBytes: objectBytes,
      totalLiveObjects: objects.length,
      coreRssBytes: coreRss,
      chromiumRssBytes: browserRss,
      testRunnerRssBytes: process.memoryUsage().rss,
    });
  }
  await mkdir(".artifacts", { recursive: true });
  await writeFile(
    ".artifacts/step-03-performance.json",
    JSON.stringify(
      {
        environment: {
          platform: process.platform,
          node: process.version,
          browser: browser.version(),
          rust: execFileSync("rustc", ["--version"], {
            encoding: "utf8",
          }).trim(),
        },
        method:
          "10 samples per fixture; real Chromium synthetic keydown-to-next-animation-frame, blur-to-saved and undo-click-to-redo-available. RSS sampled after each fixture; retained known objects include current/history and import provenance. No native OS claim.",
        results,
      },
      null,
      2,
    ),
  );
});
