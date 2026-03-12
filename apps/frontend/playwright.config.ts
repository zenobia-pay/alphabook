import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

const repoRoot = path.resolve(import.meta.dirname, "../..");

export default defineConfig({
  testDir: "./test",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: "http://127.0.0.1:4193",
    headless: true,
    viewport: { width: 1440, height: 1024 },
  },
  webServer: [
    {
      command: "PORT=8788 npm run dev:node -w @alphabook/orchestrator-worker",
      url: "http://127.0.0.1:8788/health",
      reuseExistingServer: !process.env.CI,
      cwd: repoRoot,
      timeout: 30_000,
    },
    {
      command: "npm run dev -w @alphabook/frontend -- --host 127.0.0.1 --port 4193",
      url: "http://127.0.0.1:4193",
      reuseExistingServer: !process.env.CI,
      cwd: repoRoot,
      timeout: 30_000,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
