import { expect, test } from "@playwright/test";
import { clientIp, onNetlify, trustedHops } from "../src/lib/auth/rate-limit";
import { isHttps } from "../src/lib/http";

// How the app reads the hosts' forwarding headers (ADR 0028). No browser or server: these call the
// functions directly, so CI checks the Netlify cases that the local stack can't produce.

const NETLIFY = { SITE_ID: "909d21e5-ed9b-4828-901d-34b8d1e26824", SITE_NAME: "porchlet" };
const xff = (value: string) => new Headers({ "x-forwarded-for": value });

test("the visitor IP is the entry the first trusted host added", () => {
  // One host (Vercel overwrites the header; an appending nginx): the last entry.
  expect(clientIp(xff("198.51.100.1"), {})).toBe("198.51.100.1");
  expect(clientIp(xff("203.0.113.9, 198.51.100.1"), {})).toBe("198.51.100.1");
  // Netlify: the CDN's entry for the visitor, then the edge function's own (measured, ADR 0028).
  expect(clientIp(xff("203.0.113.9, 198.51.100.1, 192.0.2.50"), NETLIFY)).toBe("198.51.100.1");
  expect(clientIp(xff("198.51.100.1, 192.0.2.50"), NETLIFY)).toBe("198.51.100.1");
  // Fewer entries than hops: the first one.
  expect(clientIp(xff("198.51.100.1"), NETLIFY)).toBe("198.51.100.1");
  // The setting wins over the detected host; empty entries don't count.
  expect(clientIp(xff("a, 198.51.100.1, b, c"), { TRUSTED_PROXY_HOPS: "3" })).toBe("198.51.100.1");
  expect(clientIp(xff("203.0.113.9, 198.51.100.1, , "), {})).toBe("198.51.100.1");
  expect(clientIp(new Headers(), {})).toBe("unknown");
});

test("only Netlify's own SITE_ID and SITE_NAME count as Netlify", () => {
  expect(onNetlify(NETLIFY)).toBe(true);
  expect(onNetlify({ SITE_ID: "main", SITE_NAME: "porchlet" })).toBe(false);
  expect(onNetlify({ SITE_ID: NETLIFY.SITE_ID })).toBe(false);
  expect(onNetlify({})).toBe(false);
  expect(trustedHops(NETLIFY)).toBe(2);
  expect(trustedHops({ SITE_ID: "main" })).toBe(1);
});

test("an invalid TRUSTED_PROXY_HOPS refuses instead of guessing", () => {
  for (const bad of ["0", "11", "two", "2.0", " 2", "0x2", "1e0", "-1"]) {
    expect(trustedHops({ TRUSTED_PROXY_HOPS: bad }), bad).toBeNull();
    expect(clientIp(xff("198.51.100.1"), { TRUSTED_PROXY_HOPS: bad }), bad).toBeNull();
  }
  expect(trustedHops({ TRUSTED_PROXY_HOPS: "10" })).toBe(10);
  expect(trustedHops({ TRUSTED_PROXY_HOPS: "" })).toBe(1);
});

test("HTTPS: the header when a host sends it, else the request URL", () => {
  const https = new URL("https://porchlet.example/w");
  const http = new URL("http://127.0.0.1:3000/w");
  const proto = (value: string) => new Headers({ "x-forwarded-proto": value });
  // Netlify's edge function: no header, an https:// URL (ADR 0028).
  expect(isHttps(new Headers(), https)).toBe(true);
  expect(isHttps(new Headers(), http)).toBe(false);
  expect(isHttps(new Headers())).toBe(false);
  // Next.js's own test on the header, which the Server Actions also use without a URL.
  expect(isHttps(proto("https"))).toBe(true);
  expect(isHttps(proto("http, https"))).toBe(true);
  expect(isHttps(proto("http"))).toBe(false);
  // A header that says http wins over the URL, as it does for the Server Actions.
  expect(isHttps(proto("http"), https)).toBe(false);
});
