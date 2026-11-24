import { randomInt } from "node:crypto";
import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";

// A made-up visitor IP per test (sent as X-Forwarded-For, as Vercel does), so each test gets its
// own rate-limit buckets (ADR 0015) and tests don't use up each other's limits.
export function randomIp(): string {
  return `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
}

export const test = base.extend({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, provide) => {
    await provide({ ...extraHTTPHeaders, "x-forwarded-for": randomIp() });
  },
});
