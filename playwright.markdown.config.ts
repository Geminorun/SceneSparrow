import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import { resolve } from "node:path";

export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: [
    "markdown-file-project.spec.ts",
    "external-agent.spec.ts",
    "agent-conversations.spec.ts",
  ],
  webServer: {
    ...base.webServer,
    command: "node scripts/dev.mjs",
    url: "http://127.0.0.1:5173",
    env: {
      SCENESPARROW_MARKDOWN_PROJECTS_DIR: resolve(
        `.local/markdown-e2e-${Date.now()}`,
      ),
      SCENESPARROW_PROJECT_DIR: resolve(
        `.local/markdown-unused-sql-${Date.now()}`,
      ),
    },
  },
});
