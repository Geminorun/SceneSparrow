import { test, expect } from "./helpers/core";
import { openWorkbench, openExports } from "./helpers/workbench";

test("legacy Copy behind a held ordinary save captures B and leaves later C editable and pending", async ({
  page,
  core,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "scenesparrow.application-preferences",
      JSON.stringify({ version: 1, saveMode: "off" }),
    );
    (window as any).capturedCopies = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as any).capturedCopies.push(text);
        },
      },
    });
  });
  await openWorkbench(page);
  const editor = page.getByRole("textbox", { name: "Manuscript", exact: true });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve)),
    held = new Promise<void>((resolve) => (release = resolve));
  const writes: any[] = [];
  core.intercept(async (path, body, phase) => {
    if (
      path.endsWith("/manuscript/commands") &&
      body?.type === "ApplyDocumentEdit"
    ) {
      if (phase === "before") writes.push(body);
      if (phase === "after" && writes.length === 1) {
        enter();
        await held;
      }
    }
  });
  await editor.fill("A predecessor");
  await page.keyboard.press("Control+s");
  await entered;
  await editor.fill("B captured");
  await openExports(page);
  await page
    .getByRole("button", { name: "Copy manuscript", exact: true })
    .click();
  await editor.fill("C later 中文");
  release();
  await expect
    .poll(() => page.evaluate(() => (window as any).capturedCopies))
    .toEqual(["B captured\n"]);
  await expect(editor).toContainText("C later 中文");
  await expect(page.getByTestId("save-status")).toHaveText("Unsaved changes");
  expect(
    (await core.request("/manuscript")).blocks
      .map((b: any) => b.runs.map((r: any) => r.text).join(""))
      .join("\n"),
  ).toBe("B captured");
  expect(writes).toHaveLength(2);
});
