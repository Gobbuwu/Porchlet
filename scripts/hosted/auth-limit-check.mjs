#!/usr/bin/env node
// Hosted rate-limit check, part 1: calls Supabase Auth directly (not through the app).
// Run only against a throwaway test project. It sends about 50 failed logins for made-up
// addresses; no account is created and no email is sent.
//
// Usage: node auth-limit-check.mjs https://<ref>.supabase.co sb_publishable_...
// Both values are public (they ship to every browser).
//
// What it shows (ADR 0014, docs/milestones/M1.md "Unverified"):
//   1. spray:    one password against 10 different made-up addresses (like SiegeKit login-spray)
//   2. throttle: 40 wrong passwords against one address (like SiegeKit login-throttle)
//   3. sbff:     5 more attempts, each with a different fake Sb-Forwarded-For IP
//   4. xff:      5 more attempts, each with a different fake X-Forwarded-For IP
// If 3 or 4 get 400 instead of 429 after 2 hit the limit, that header resets the limit and
// can be used to get around it.

import { randomBytes } from "node:crypto";

const [url, key] = process.argv.slice(2);
if (!/^https:\/\/|^http:\/\/127\.0\.0\.1:/.test(url ?? "") || !key?.startsWith("sb_publishable_")) {
  console.error("Usage: node auth-limit-check.mjs https://<ref>.supabase.co sb_publishable_...");
  process.exit(2);
}

const id = () => randomBytes(5).toString("hex");
const fakeIp = () => `203.0.113.${1 + (randomBytes(1)[0] % 254)}`; // TEST-NET-3, never routed

async function login(email, headers = {}) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, "content-type": "application/json", ...headers },
    body: JSON.stringify({ email, password: "wrong-password-123" }),
  });
  const body = await res.json().catch(() => ({}));
  return `${res.status} ${body.error_code ?? body.code ?? ""}`.trim();
}

function summarize(results) {
  const counts = {};
  for (const r of results) counts[r] = (counts[r] ?? 0) + 1;
  const first429 = results.findIndex((r) => r.startsWith("429"));
  return { counts, first429: first429 === -1 ? null : first429 + 1 };
}

const started = new Date().toISOString();
const spray = [];
for (let i = 0; i < 10; i++) spray.push(await login(`nobody-${id()}@example.invalid`));
const target = `nobody-${id()}@example.invalid`;
const throttle = [];
for (let i = 0; i < 40; i++) throttle.push(await login(target));
const sbff = [];
for (let i = 0; i < 5; i++) sbff.push(await login(target, { "sb-forwarded-for": fakeIp() }));
const xff = [];
for (let i = 0; i < 5; i++) xff.push(await login(target, { "x-forwarded-for": fakeIp() }));

console.log(
  JSON.stringify(
    {
      check: "porchlet hosted auth limits, part 1 (direct)",
      started,
      finished: new Date().toISOString(),
      node: process.version,
      project: new URL(url).hostname,
      spray: summarize(spray),
      throttle: summarize(throttle),
      sbff: { results: sbff },
      xff: { results: xff },
    },
    null,
    2,
  ),
);
