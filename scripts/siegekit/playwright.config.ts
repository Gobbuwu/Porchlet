import { defineConfig, devices } from "@playwright/test";

// Only for scripts/siegekit/r2-run.sh: records the HAR and sessions SiegeKit's access-control
// checks need. Not part of the E2E suite (its testDir is ./e2e). The app must already run on
// 127.0.0.1:3000 against the local stack. PW_CHROMIUM_PATH as in the main config.
const chromiumPath = process.env.PW_CHROMIUM_PATH;

export default defineConfig({
  testDir: ".",
  testMatch: /r2-record\.spec\.ts/,
  retries: 0,
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:3000",
    trace: "off",
    ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
  },
});
