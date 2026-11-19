import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
export default defineConfig({
  testDir: "tests/e2e-source",
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://127.0.0.1:5173",
    locale: "en-US",
    trace: "retain-on-failure",
    launchOptions: process.env.SCENESPARROW_TEST_BROWSER
      ? { executablePath: process.env.SCENESPARROW_TEST_BROWSER }
      : {},
  },
  webServer: {
    command: "node scripts/dev.mjs",
    url: "http://127.0.0.1:5173",
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      SCENESPARROW_PROJECT_DIR: resolve(`.local/source-e2e-${Date.now()}`),
      SCENESPARROW_APP_DATA_DIR: resolve(`.local/source-e2e-app-${Date.now()}`),
      SCENESPARROW_PROJECT_OPEN_MODE: "format-create",
    },
  },
});
