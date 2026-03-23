import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/visual",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,

  reporter: [
    ["html", { outputFolder: "reports/playwright", open: "never" }],
    ["json", { outputFile: "reports/results.json" }],
    ["line"],
  ],

  use: {
    baseURL: process.env.STORYBOOK_URL ?? "http://localhost:6006",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // reducedMotion: "reduce",
  },

  snapshotDir: "./tests/snapshots",
  snapshotPathTemplate:
    "{snapshotDir}/{testFileDir}/{testFileName}/{projectName}/{arg}{ext}",

  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.001,
      threshold: 0.2,
      animations: "disabled",
    },
  },

  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 5"] },
    },
  ],
});
