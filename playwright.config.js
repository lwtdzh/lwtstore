// @ts-check
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 120000, // 2 minutes per test (uploads can be slow)
  expect: {
    timeout: 30000,
  },
  fullyParallel: false, // Run tests sequentially to avoid race conditions
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "https://lwtstore.pages.dev",
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    actionTimeout: 30000,
    navigationTimeout: 30000,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
