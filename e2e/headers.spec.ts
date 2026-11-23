import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page, type Response } from "@playwright/test";

// Security headers from next.config.ts (reasons in docs/adr/0013-security-headers.md).
// The values are written out here on purpose: a change to a header must change this file too.
const expected: Record<string, string> = {
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "permissions-policy":
    "accelerometer=(), camera=(), display-capture=(), " +
    "geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), " +
    "payment=(), serial=(), usb=(), xr-spatial-tracking=()",
};

async function expectSecurityHeaders(response: Response | null, what: string) {
  expect(response, `${what}: no response`).not.toBeNull();
  const headers = await response!.allHeaders();
  for (const [name, value] of Object.entries(expected)) {
    expect(headers[name], `${what}: ${name}`).toBe(value);
  }
  expect(headers["x-powered-by"], `${what}: x-powered-by`).toBeUndefined();
}

async function gotoAndCheck(page: Page, path: string, status: number) {
  const response = await page.goto(path);
  expect(response?.status(), `${path}: status`).toBe(status);
  await expectSecurityHeaders(response, path);
}

test("every kind of response carries the security headers", async ({ page }) => {
  const scripts: Response[] = [];
  page.on("response", (r) => {
    if (r.url().includes("/_next/static/") && r.request().resourceType() === "script") {
      scripts.push(r);
    }
  });

  await gotoAndCheck(page, "/", 200); // page
  await page.waitForLoadState("load");
  expect(scripts.length, "no /_next/static script was loaded").toBeGreaterThan(0);
  await expectSecurityHeaders(scripts[0], scripts[0].url()); // build asset

  await gotoAndCheck(page, "/api/health", 200); // route handler
  await gotoAndCheck(page, "/favicon.ico", 200); // file from the app directory
  await gotoAndCheck(page, "/no-such-page", 404); // not found
});

test("the browser refuses to show the app inside a frame on another origin", async ({ page }) => {
  const app = new URL("/", test.info().project.use.baseURL).href;
  // A page on another origin (same host, another port) that frames the app. It is a real local
  // server rather than page.route(), because Chromium blocks a page it can't place on the local
  // network from framing 127.0.0.1 before frame-ancestors is ever checked.
  const framer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<iframe src="${app}" onload="window.framed = true"></iframe>`);
  });
  await new Promise<void>((resolve) => framer.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = framer.address() as AddressInfo;
    const frameDocument = page.waitForResponse(app);
    await page.goto(`http://127.0.0.1:${port}/`);
    await expectSecurityHeaders(await frameDocument, "framed /");
    await page.waitForFunction(() => (window as { framed?: boolean }).framed === true);
    const frame = page.frames().find((f) => f !== page.mainFrame());
    // A blocked frame shows the browser's error page, so the app's heading is not there.
    await expect(frame!.getByRole("heading", { name: "Porchlet", exact: true })).toHaveCount(0);
  } finally {
    await new Promise((resolve) => framer.close(resolve));
  }
});

test("same-origin POSTs still send the real Origin header", async ({ page }) => {
  // Guards the Referrer-Policy choice: under `no-referrer` browsers send `Origin: null` here,
  // which would break the Origin checks on our POST routes and Next.js Server Actions.
  const origin = new URL(test.info().project.use.baseURL!).origin;
  await page.goto("/");

  const fetchPost = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/api/health"));
  await page.evaluate(() => fetch("/api/health", { method: "POST", body: "x" }));
  expect((await (await fetchPost).allHeaders())["origin"], "fetch POST").toBe(origin);

  const formPost = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/api/health"));
  await page.evaluate(() => {
    const form = document.createElement("form");
    form.method = "post";
    form.action = "/api/health";
    document.body.append(form);
    form.submit();
  });
  expect((await (await formPost).allHeaders())["origin"], "form POST").toBe(origin);
});

test("Chromium accepts every Permissions-Policy feature and applies it", async ({ page, browserName }) => {
  // Firefox and Safari don't support the Permissions-Policy header (MDN compat data), so only
  // Chromium can check this.
  test.skip(browserName !== "chromium", "Permissions-Policy header is Chromium-only");
  const warnings: string[] = [];
  page.on("console", (m) => {
    if (/permissions.policy|feature policy|unrecognized feature/i.test(m.text())) warnings.push(m.text());
  });

  await page.goto("/");
  await page.waitForLoadState("load");
  expect(warnings, "console warnings about Permissions-Policy").toEqual([]);

  const allowed = await page.evaluate(() => {
    const policy = (document as unknown as { featurePolicy: { allowsFeature(f: string): boolean } })
      .featurePolicy;
    return {
      camera: policy.allowsFeature("camera"),
      microphone: policy.allowsFeature("microphone"),
      geolocation: policy.allowsFeature("geolocation"),
      "clipboard-write": policy.allowsFeature("clipboard-write"),
    };
  });
  expect(allowed).toEqual({ camera: false, microphone: false, geolocation: false, "clipboard-write": true });
});
