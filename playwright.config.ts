import { defineConfig, devices } from "@playwright/test";

// E2E runs against the production build (`next start`) and the local Supabase stack
// (`npx supabase start`, then scripts/e2e/write-env.sh for .env.local). PW_CHROMIUM_PATH lets a machine with a preinstalled Chromium use it instead
// of Playwright's download; CI leaves it unset.
const chromiumPath = process.env.PW_CHROMIUM_PATH;

export default defineConfig({
  testDir: "./e2e",
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { baseURL: "http://127.0.0.1:3000", trace: "off" },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
      },
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        // Form history off: in Playwright's headless Firefox, once an email is saved (typed and
        // sent earlier in the same test), a click on the submit button sometimes loses its mouse
        // press and the form is never sent. Measured: 20 of 450 clicks lost with the default, 0 of
        // 450 with this pref; visible Firefox and Mozilla's own Firefox lost none (M1.md). A bug in
        // Playwright's headless Firefox, not reported upstream: on each Playwright bump, re-run the
        // same-email tests without this pref and drop it once they pass.
        launchOptions: { firefoxUserPrefs: { "browser.formfill.enable": false } },
      },
    },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ].flatMap((project) => [
    // e2e/invite-cap.spec.ts uses up the E2E admin's 20 invitations per hour, which the other
    // tests need, so it runs on its own after them: `--project=chromium --project=chromium-cap`
    // (ADR 0024). Run scripts/e2e/make-admin.sh again for a fresh admin before the next run.
    { ...project, testIgnore: /invite-cap\.spec\.ts/ },
    { ...project, name: `${project.name}-cap`, testMatch: /invite-cap\.spec\.ts/, dependencies: [project.name] },
  ]),
  webServer: {
    command: "npm run start -- --hostname 127.0.0.1 --port 3000",
    url: "http://127.0.0.1:3000/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
