import { defineConfig, devices } from "@playwright/test";
import { API_URL, PAYSTACK_URL, WEB_URL } from "./support/env.js";

/**
 * Full-stack browser tests: local PostgreSQL and Redis, the API, a fake
 * Paystack, and the production build of the web app. Specs run in file order
 * against one shared, freshly created database, which teardown drops.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "report" }]],
  outputDir: "results",
  globalTeardown: "./global-teardown.ts",
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    { command: "tsx support/start-paystack.ts", url: `${PAYSTACK_URL}/__health`, reuseExistingServer: false, timeout: 30_000, ignoreHTTPSErrors: true },
    { command: "tsx support/start-api.ts", url: `${API_URL}/health/ready`, reuseExistingServer: false, timeout: 120_000 },
    { command: "tsx support/start-web.ts", url: `${WEB_URL}/management`, reuseExistingServer: false, timeout: 300_000 },
  ],
});
