import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { VideoProject } from "../../packages/contracts/src/generated";

test("video project exports the official skill and plays a supervised render @web-smoke", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Video project", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Video project" });
  await dialog.getByRole("button", { name: "Create video project" }).click();
  await expect(
    dialog.getByText("remotion-best-practices", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("4.0.547", { exact: false })).toBeVisible();
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export video project" }).click();
  await expect((await download).suggestedFilename()).toBe(
    "scenesparrow-video.zip",
  );
  await dialog.getByRole("button", { name: "Render preview" }).click();
  const video = dialog.getByLabel("Rendered video preview");
  await expect(video).toBeVisible({ timeout: 90000 });
  await video.evaluate(async (element) => {
    const video = element as HTMLVideoElement;
    await video.play();
  });
  await expect
    .poll(() =>
      video.evaluate((element) => (element as HTMLVideoElement).currentTime),
    )
    .toBeGreaterThan(0.2);
  await expect
    .poll(() =>
      video.evaluate((element) => (element as HTMLVideoElement).videoWidth),
    )
    .toBe(640);
  await video.evaluate((element) => (element as HTMLVideoElement).pause());
  await dialog.screenshot({
    path: ".artifacts/video-project/web-playback.png",
  });
});

test("video Agent request presents a data diff and retains newer typing during adoption", async ({
  page,
}) => {
  await page.route("**/api/v1/agent/catalog", (route) =>
    route.fulfill({
      json: [
        {
          id: "codex",
          label: "Codex",
          available: true,
          models: [{ id: "fixture", label: "Fixture model" }],
        },
      ],
    }),
  );
  let current: VideoProject | null = null;
  await page.route(
    /\/api\/v1\/markdown-projects\/[^/]+\/video(?:\/.*)?$/,
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const projectId = path.split("/")[4]!;
      if (!path.endsWith("/changes") && !path.endsWith("/decide")) {
        if (route.request().method() === "GET")
          return route.fulfill({
            contentType: "application/json",
            body: JSON.stringify(current),
          });
        current = {
          projectId,
          revision: randomUUID(),
          composition: {
            title: "SceneSparrow / 幕雀",
            background: "#142d27",
            accent: "#d9edb2",
            direction: "right",
          },
          skill: {
            name: "remotion-best-practices",
            version: "4.0.547",
            revision: "a3f4098a2afd0e13f6a6f8c8760e275f75457ea9",
            sha256: "fixture",
          },
          proposals: [],
          renderRevision: null,
        };
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(current),
        });
      }
      const body = route.request().postDataJSON();
      if (path.endsWith("/changes")) {
        expect(body.instruction).toBe(
          "Change the title to Hello / 你好 and move left.",
        );
        expect(body.modelId).toBe("fixture");
        current!.proposals.push({
          requestId: body.requestId,
          baseRevision: current!.revision,
          engineId: body.engineId,
          modelId: body.modelId,
          instruction: body.instruction,
          reply: "Changed the title and motion direction.",
          composition: {
            ...current!.composition,
            title: "Hello / 你好",
            direction: "left",
          },
          status: "pending",
          errorCode: null,
        });
      } else {
        expect(body.decision).toBe("apply");
        current!.composition = current!.proposals[0]!.composition!;
        current!.revision = randomUUID();
        current!.proposals[0]!.status = "applied";
      }
      await route.fulfill({ json: current });
    },
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Video project", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Video project" });
  await dialog.getByRole("button", { name: "Create video project" }).click();
  const composer = dialog.getByRole("textbox", { name: "Ask the Agent" });
  await composer.fill("Change the title to Hello / 你好 and move left.");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(dialog.getByRole("table")).toContainText("Hello / 你好");
  await expect(dialog.getByRole("table")).toContainText("SceneSparrow / 幕雀");
  await composer.fill("Keep this next request while I review.");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(
    dialog.getByText("Applied to this video project."),
  ).toBeVisible();
  await expect(composer).toHaveValue("Keep this next request while I review.");
});
