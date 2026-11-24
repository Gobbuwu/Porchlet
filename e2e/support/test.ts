import { randomInt } from "node:crypto";
import { type Page, test as base } from "@playwright/test";

export { expect } from "@playwright/test";

// A made-up visitor IP per test (sent as X-Forwarded-For, as Vercel does), so each test gets its
// own rate-limit buckets (ADR 0015) and tests don't use up each other's limits.
export function randomIp(): string {
  return `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
}

export const test = base.extend<{ logUrlOnFailure: void }>({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, provide) => {
    await provide({ ...extraHTTPHeaders, "x-forwarded-for": randomIp() });
  },
  // CI keeps no traces, so a failed test prints the page it ended on; with the page snapshot in
  // error-context.md (printed by the CI step on failure) that shows where a flow went wrong.
  logUrlOnFailure: [
    async ({ page }, provide, testInfo) => {
      await provide();
      if (testInfo.status !== testInfo.expectedStatus) console.log(`[failed at] ${page.url()}`);
    },
    { auto: true },
  ],
});

// Waits until React has hydrated the page's form, so a click goes through React (a fetch with
// Next.js's Next-Action header) rather than a native form post. Only tests about that path need
// it: a form sent before hydration shows its message too (ADR 0018). React keeps its fiber on
// each hydrated DOM node under a "__reactFiber$" key.
export async function waitForHydration(page: Page) {
  await page.waitForFunction(() => {
    const form = document.querySelector("main form");
    return !!form && Object.keys(form).some((k) => k.startsWith("__reactFiber$"));
  });
}
