import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type {
  AgentSession,
  AgentTurn,
  AgentGeneration,
} from "../../packages/contracts/src/index";

const composer = (page: Page) =>
  page.getByRole("textbox", { name: "Message to Agent" });
async function fixture(page: Page, batchPreview = false) {
  const sessions = new Map<string, AgentSession>();
  const current = new Map<string, string | null>();
  const submitted: {
    session: string;
    instruction: string;
    history: string[];
  }[] = [];
  let held: (() => void) | undefined;
  await page.addInitScript(() => {
    localStorage.setItem(
      "scenesparrow.application-preferences",
      JSON.stringify({ version: 1, saveMode: "off", saveDelaySeconds: 10 }),
    );
    localStorage.setItem(
      "scenesparrow.workspace-panes",
      JSON.stringify({ right: { tab: "planning", collapsed: false } }),
    );
  });
  await page.route("**/api/v1/agent/catalog", (route) =>
    route.fulfill({
      json: [
        {
          id: "codex",
          label: "Codex",
          available: true,
          models: [{ id: "fixture-model", label: "Fixture model" }],
        },
      ],
    }),
  );
  await page.route(
    /\/api\/v1\/markdown-projects\/[^/]+\/agent\/sessions(?:\/.*)?$/,
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const match = path.match(
        /markdown-projects\/([^/]+)\/agent\/sessions(?:\/([^/]+))?(?:\/turns(?:\/([^/]+)(?:\/(events|cancel|apply))?)?)?$/,
      )!;
      const [, projectId, id, turnId, action] = match;
      const body = route.request().postDataJSON();
      if (!id && route.request().method() === "GET") {
        return route.fulfill({
          json: {
            currentId: current.get(projectId!) ?? null,
            conversations: [...sessions.values()]
              .filter((s) => s.projectId === projectId)
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .map(
                ({ id, projectId, title, engineId, modelId, updatedAt }) => ({
                  id,
                  projectId,
                  title,
                  engineId,
                  modelId,
                  updatedAt,
                }),
              ),
          },
        });
      }
      if (!id) {
        const session: AgentSession = {
          id: randomUUID(),
          projectId: projectId!,
          requestId: body.requestId,
          engineId: body.engineId,
          modelId: body.modelId,
          title: "",
          updatedAt: Date.now(),
          turns: [],
          generations: [],
        };
        sessions.set(session.id, session);
        return route.fulfill({ json: session });
      }
      if (body?.action === "new") {
        current.set(projectId!, null);
        return route.fulfill({ contentType: "application/json", json: null });
      }
      const session = sessions.get(id)!;
      if (!turnId && !body) return route.fulfill({ json: session });
      if (body?.action) {
        if (body.action === "open") current.set(projectId!, id);
        if (body.action === "rename") session.title = body.value;
        return route.fulfill({ contentType: "application/json", json: null });
      }
      if (!turnId) {
        const turn: AgentTurn = {
          id: randomUUID(),
          requestId: body.requestId,
          createdAt: Date.now(),
          instruction: body.instruction,
          attachment: body.attachment,
          reply: "",
          status: "running",
          errorCode: null,
          proposal: null,
          outcome: null,
          applyResult: null,
          applyError: null,
          context: {
            projectId: projectId!,
            kind: body.attachment.kind,
            revision: body.attachment.revision,
            sourceDigest: body.attachment.sourceDigest,
            selection: body.attachment.selection,
          },
        };
        if (batchPreview) {
          const annotations = await (
            await page.request.get(
              `/api/v1/markdown-projects/${projectId}/documents/${turn.context.kind}/annotations`,
            )
          ).json();
          const comments = annotations.comments.filter(
            (c: any) => c.status === "open",
          );
          const scopes = comments
            .filter(
              (c: any) =>
                c.anchor.resolvedStart !== null &&
                !annotations.locks.some((l: any) =>
                  l.anchors.some(
                    (a: any) =>
                      a.resolvedStart < c.anchor.resolvedEnd &&
                      a.resolvedEnd > c.anchor.resolvedStart,
                  ),
                ),
            )
            .map((c: any) => ({
              id: `scope-${c.id}`,
              selection: {
                range: {
                  start: c.anchor.resolvedStart,
                  end: c.anchor.resolvedEnd,
                },
                quote: c.anchor.quote,
              },
              commentIds: [c.id],
            }));
          turn.context.batch = {
            comments,
            locks: annotations.locks,
            scopes,
            unresolved: comments
              .filter(
                (c: any) =>
                  !scopes.some((scope: any) => scope.commentIds.includes(c.id)),
              )
              .map((c: any) => ({ commentIds: [c.id], reason: "locked" })),
          };
        }
        submitted.push({
          session: id,
          instruction: turn.instruction,
          history: session.turns
            .filter((t) => t.status === "completed")
            .map((t) => t.reply),
        });
        session.turns.push(turn);
        session.title ||= turn.instruction.slice(0, 60);
        session.updatedAt = Date.now();
        current.set(projectId!, id);
        return route.fulfill({ json: turn });
      }
      const turn = session.turns.find((t) => t.id === turnId)!;
      if (action === "apply") {
        const docPath = `/api/v1/markdown-projects/${projectId}/documents/${turn.context.kind}`;
        const doc = await (await page.request.get(docPath)).json();
        const { proposalText } =
          await import("../../packages/editor-ui/src/agent/context");
        const text = proposalText(
          { ...turn.context, session: {}, epoch: 0, text: doc.text },
          turn.proposal!,
        );
        const saved = await page.request.post(docPath, {
          data: { revision: doc.revision, text },
        });
        expect(saved.ok()).toBe(true);
        const result = await saved.json();
        for (const change of turn.proposal!.batch!.changes) {
          const scope = turn.context.batch!.scopes.find(
            (scope) => scope.id === change.scopeId,
          )!;
          for (const id of scope.commentIds)
            await page.request.post(`${docPath}/annotations`, {
              data: { action: "resolve", id },
            });
        }
        turn.outcome = "applied";
        turn.applyResult = {
          projectId: projectId!,
          kind: turn.context.kind,
          revision: result.revision,
          proposalId: turn.proposal!.id,
        };
        return route.fulfill({ json: turn.applyResult });
      }
      if (action === "cancel") {
        turn.status = "cancelled";
        return route.fulfill({ json: turn });
      }
      if (turn.instruction === "Wait in the original project")
        await new Promise<void>((resolve) => {
          held = resolve;
        });
      turn.status = "completed";
      turn.reply = `Saved answer: ${turn.instruction}`;
      const events: unknown[] = [];
      if (
        batchPreview &&
        turn.context.batch &&
        turn.instruction.startsWith("Revise")
      ) {
        turn.proposal = {
          id: randomUUID(),
          context: turn.context,
          text: "",
          batch: {
            changes: turn.context.batch.scopes.map((scope, n) => ({
              scopeId: scope.id,
              text:
                n === 0
                  ? "清晨，城市醒来 · The city wakes at dawn."
                  : "A tram crosses the square; 铃声传来。",
            })),
            unresolved: turn.context.batch.unresolved,
          },
        };
        events.push({
          type: "proposal",
          sequence: 1,
          projectId,
          sessionId: id,
          turnId,
          proposal: turn.proposal,
        });
      }
      events.push({
        type: "final",
        sequence: events.length + 1,
        projectId,
        sessionId: id,
        turnId,
        status: turn.status,
        reply: turn.reply,
        errorCode: null,
      });
      await route.fulfill({
        contentType: "text/event-stream",
        body: `event: agent\ndata: ${JSON.stringify(events)}\n\n`,
      });
    },
  );
  await page.route("**/api/v1/ai/configuration", (route) =>
    route.fulfill({ json: { configuration: { fingerprint: "fixture" } } }),
  );
  await page.route("**/api/v1/markdown-projects/*/writing", async (route) => {
    const body = route.request().postDataJSON(),
      owner = sessions.get(body.conversationId)!;
    const entry: AgentGeneration = {
      id: body.actionId,
      kind: body.kind,
      instruction: body.brief,
      status: "completed",
      text:
        body.kind === "outline"
          ? "# 城市之声 · City voices\n\n---\n\n- Opening\n  - 清晨街道"
          : "Generated draft 中文",
      errorCode: null,
      revision: body.revision,
      outlineRevision: body.outlineRevision ?? null,
      createdAt: Date.now(),
    };
    owner.generations.push(entry);
    owner.title ||= body.brief;
    current.set(owner.projectId, owner.id);
    return route.fulfill({
      json: { actionId: body.actionId, text: entry.text },
    });
  });
  return {
    sessions,
    submitted,
    waiting: () => !!held,
    release: () => held?.(),
  };
}
async function send(page: Page, instruction: string) {
  await composer(page).fill(instruction);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
async function openHistory(page: Page) {
  await page.getByRole("button", { name: "History", exact: true }).click();
  return page.getByRole("textbox", {
    name: "Search conversations",
    exact: true,
  });
}

test("AWR-AC03 history survives refresh, reopens saved context and keeps project ownership", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/");
  await expect(
    page.getByRole("tab", { name: "Agent", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await send(page, "Explain the opening 中文");
  await expect(
    page.getByText("Saved answer: Explain the opening 中文", { exact: true }),
  ).toBeVisible();
  const originalId = [...state.sessions.keys()][0]!;
  await page
    .getByRole("button", { name: "New conversation", exact: true })
    .click();
  await send(page, "A second conversation");
  await expect(
    page.getByText("Saved answer: A second conversation", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Saved answer: A second conversation", { exact: true }),
  ).toBeVisible();
  const search = await openHistory(page);
  await search.fill("opening");
  await expect(search).toBeFocused();
  await page
    .getByRole("button", {
      name: "Rename: Explain the opening 中文",
      exact: true,
    })
    .click();
  await page
    .getByRole("textbox", { name: "Rename", exact: true })
    .fill("开场讨论 · Opening notes");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("button", { name: "开场讨论 · Opening notes", exact: true })
    .click();
  await send(page, "Continue with the saved context");
  await expect(
    page.getByText("Saved answer: Continue with the saved context", {
      exact: true,
    }),
  ).toBeVisible();
  expect(state.submitted.at(-1)?.session).toBe(originalId);
  expect(state.submitted.at(-1)?.history).toEqual([
    "Saved answer: Explain the opening 中文",
  ]);
  await send(page, "Wait in the original project");
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  await expect.poll(state.waiting).toBe(true);
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "New manuscript", exact: true })
    .click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("project"))
    .not.toBe(state.sessions.get(originalId)!.projectId);
  const newProject = new URL(page.url()).searchParams.get("project");
  state.release();
  await expect(composer(page)).toBeVisible();
  await expect(
    page.getByText("Saved answer: Wait in the original project", {
      exact: true,
    }),
  ).toHaveCount(0);
  expect(state.sessions.get(originalId)!.projectId).not.toBe(newProject);
  await expect
    .poll(() => state.sessions.get(originalId)!.turns.at(-1)?.status)
    .toBe("completed");
});

test("AWR-AC04/12 unified generation, chronological results, compact history and provider settings", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await fixture(page);
  await page.goto("/");
  await composer(page).fill("Write a bilingual city story 中文");
  await page.getByRole("button", { name: "Add action", exact: true }).click();
  await page
    .getByRole("button", { name: "Generate Outline", exact: true })
    .click();
  await expect(
    page.locator(".writing-view-switch button[aria-pressed=true]"),
  ).toHaveText("Outline");
  await expect(page.locator("#markdown-outline-editor")).toContainText(
    "城市之声",
  );
  await page.getByRole("button", { name: "Add action", exact: true }).click();
  await page
    .getByRole("button", { name: "Write Draft from Outline", exact: true })
    .click();
  await expect(
    page.locator(".writing-view-switch button[aria-pressed=true]"),
  ).toHaveText("Draft preview");
  await expect(page.locator(".markdown-draft")).toContainText(
    "Generated draft 中文",
  );
  await send(page, "Explain the generated draft");
  await expect(
    page.getByText("Saved answer: Explain the generated draft", {
      exact: true,
    }),
  ).toBeVisible();
  const cards = page.locator(".agent-turn");
  await expect(cards.first()).toContainText("Generate Outline");
  await expect(cards.last()).toContainText("Explain the generated draft");
  await page.reload();
  await expect(
    page.getByText("Saved answer: Explain the generated draft", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .locator(".writing-view-switch")
    .getByRole("button", { name: "Outline", exact: true })
    .click();
  await openHistory(page);
  await page.screenshot({ path: ".artifacts/awr-agent-history-1280.png" });
  await page
    .getByRole("textbox", { name: "Search conversations", exact: true })
    .press("Escape");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("button", { name: "Agent", exact: true })
    .click();
  await expect(page.locator(".agent-settings > article")).toHaveCount(1);
  await page.screenshot({ path: ".artifacts/awr-provider-settings-1280.png" });
  await page
    .getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.setViewportSize({ width: 960, height: 720 });
  await page
    .getByRole("button", { name: "Open assistant", exact: true })
    .click();
  await openHistory(page);
  await expect(composer(page)).toBeInViewport();
  await page.screenshot({ path: ".artifacts/awr-agent-history-960.png" });
});

test("AWR-AC06/12 ordinary send captures the document notes and keeps one compact batch preview", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const state = await fixture(page, true);
  await page.goto("/");
  await expect(page.locator("#markdown-editor")).toBeVisible();
  const projectId = new URL(page.url()).searchParams.get("project")!;
  const text =
    "# 城市之声 · City voices\n\nFirst opening 中文\n\nSecond detail\n\nLocked ending\n";
  const docPath = `/api/v1/markdown-projects/${projectId}/documents/outline`;
  const saved = await (
    await page.request.post(docPath, { data: { revision: null, text } })
  ).json();
  for (const quote of [
    "First opening 中文",
    "Second detail",
    "Locked ending",
  ]) {
    const start = Buffer.byteLength(text.slice(0, text.indexOf(quote)));
    const range = { start, end: start + Buffer.byteLength(quote) };
    const result = await page.request.post(`${docPath}/annotations`, {
      data: {
        action: "comment",
        revision: saved.revision,
        range,
        text:
          quote === "First opening 中文"
            ? "让开场更有画面感 · Add a vivid opening"
            : quote === "Second detail"
              ? "Add a concrete sound in the square"
              : "Keep the quiet ending",
      },
    });
    expect(result.ok()).toBe(true);
    if (quote === "Locked ending")
      expect(
        (
          await page.request.post(`${docPath}/annotations`, {
            data: { action: "lock", revision: saved.revision, ranges: [range] },
          })
        ).ok(),
      ).toBe(true);
  }
  await page.reload();
  await page
    .locator(".writing-view-switch")
    .getByRole("button", { name: "Outline", exact: true })
    .click();
  await page.locator("#markdown-outline-editor p").first().click();
  await page.keyboard.press("End");
  await send(page, "Revise this draft using the comments · 按批注修改");
  await expect(page.locator(".agent-batch-summary")).toHaveText(
    "2 applicable · 1 unresolved",
  );
  expect(
    [...state.sessions.values()][0]!.turns[0]!.attachment.selection,
  ).toBeNull();
  await expect(page.locator(".agent-turn-context")).toHaveText(
    "Outline · 3 open comments",
  );
  await expect(
    page.getByRole("button", { name: "Apply", exact: true }),
  ).toHaveClass("primary-button");
  await page.screenshot({ path: ".artifacts/awr-batch-summary-1280.png" });
  await page.locator(".agent-batch-change summary").first().click();
  await expect(page.locator(".agent-batch-change").first()).toContainText(
    "让开场更有画面感",
  );
  await expect(
    page.getByRole("button", { name: "Apply", exact: true }),
  ).toHaveCount(1);
  await expect(composer(page)).toBeInViewport();
  await page.screenshot({ path: ".artifacts/awr-batch-preview-1280.png" });
  await page.setViewportSize({ width: 960, height: 720 });
  await page
    .getByRole("button", { name: "Open assistant", exact: true })
    .click();
  await expect(composer(page)).toBeInViewport();
  await page.screenshot({ path: ".artifacts/awr-batch-preview-960.png" });
  await page.locator(".agent-batch-change summary").first().click();
  await page.screenshot({ path: ".artifacts/awr-batch-summary-960.png" });
  await page.locator(".agent-batch-change summary").first().click();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page
    .getByRole("button", { name: "Go to passage", exact: true })
    .click();
  await expect(page.locator("#markdown-outline-editor")).toBeFocused();
  await expect(page.locator(".agent-context-chip")).toContainText(
    "Displayed document",
  );
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText("Applied", { exact: true })).toBeVisible();
  const live = await (await page.request.get(docPath)).json();
  expect(live.text).toContain("The city wakes at dawn");
  expect(live.text).toContain("Locked ending");
  await page.reload();
  await expect(page.getByText("Applied", { exact: true })).toBeVisible();
});
