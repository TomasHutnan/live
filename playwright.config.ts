import { defineConfig, devices } from "@playwright/test";

// WebKit runs only for the controls flow, and needs the official Playwright
// image on hosts it does not support. See the README.
const webkit = process.env.LIVE_E2E_WEBKIT === "1";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 4,
  reporter: [["list"]],
  outputDir: "test-results",
  projects: [
    ...(webkit
      ? []
      : [{ name: "chromium", testIgnore: /webkit\.spec/, use: { ...devices["Desktop Chrome"] } }]),
    ...(webkit
      ? [{ name: "webkit", testMatch: /(webkit)\.spec/, use: { ...devices["Desktop Safari"] } }]
      : [{ name: "chromium-controls", testMatch: /webkit\.spec/, use: { ...devices["Desktop Chrome"] } }]),
  ],
});
