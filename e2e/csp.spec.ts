import { expect, test } from "@playwright/test";

// The nonce-based Content-Security-Policy from src/proxy.ts (ADR 0014). Needs no Supabase:
// these pages render for signed-out visitors without calling Supabase Auth.
const PAGES = ["/", "/login", "/signup", "/forgot", "/auth/confirm?type=email&token_hash=x", "/no-such-page"];

function nonceOf(csp: string | undefined): string {
  const m = csp?.match(/script-src 'self' 'nonce-([A-Za-z0-9+/=]+)' 'strict-dynamic'(;|$)/);
  if (!m) throw new Error(`no script nonce in CSP: ${csp}`);
  return m[1];
}

test("every page gets a strict CSP with a fresh nonce on all its scripts", async ({ request }) => {
  for (const path of PAGES) {
    const first = await request.get(path);
    const second = await request.get(path);
    const csp = first.headers()["content-security-policy"];
    const nonce = nonceOf(csp);
    expect(nonce, `${path}: nonce must change per request`).not.toBe(
      nonceOf(second.headers()["content-security-policy"]),
    );
    expect(Buffer.from(nonce, "base64").length, `${path}: nonce bytes`).toBe(16);
    for (const directive of [
      "default-src 'self'",
      `style-src 'self' 'nonce-${nonce}'`,
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "connect-src 'self'",
    ]) {
      expect(csp, `${path}: ${directive}`).toContain(directive);
    }
    expect(csp, `${path}: no unsafe-inline or unsafe-eval in production`).not.toMatch(/unsafe-(inline|eval)/);

    const html = await first.text();
    const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
    expect(scripts.length, `${path}: scripts`).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag, `${path}: script without the nonce`).toContain(`nonce="${nonce}"`);
  }
});

test("the proxy skips only the exact asset paths, and refuses posts outside the form pages", async ({ request }) => {
  const proxied = async (path: string) =>
    /'nonce-/.test((await request.get(path)).headers()["content-security-policy"] ?? "");
  // Look-alikes of the skipped paths are pages like any other.
  for (const path of ["/favicon.icox", "/favicon.ico.txt", "/_next/staticfoo", "/_next/imagefoo"]) {
    expect(await proxied(path), `GET ${path}`).toBe(true);
  }
  for (const path of ["/favicon.ico", "/_next/image"]) expect(await proxied(path), `GET ${path}`).toBe(false);

  // A Server Action, or a form post without JavaScript, is accepted only on the pages with forms,
  // where the hosts in front of the app were measured (ADR 0029, decision 3). The skipped paths too:
  // a second matcher runs the proxy for every request with a Next-Action header.
  const action = { headers: { "next-action": "0".repeat(42) }, data: "[]" };
  for (const path of ["/", "/no-such-page", "/api/health", "/favicon.icox", "/favicon.ico", "/_next/image", "/_next/static/x"]) {
    expect((await request.post(path, action)).status(), `action POST ${path}`).toBe(405);
  }
  expect((await request.post("/", { multipart: { $ACTION_ID_0: "" } })).status(), "form POST /").toBe(405);
  for (const path of ["/login", "/w/x"]) {
    expect((await request.post(path, action)).status(), `action POST ${path}`).not.toBe(405);
  }
});

test("pages load and run their scripts with no CSP violation", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { cspViolations: string[] };
    w.cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      w.cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations), path).toEqual(
      [],
    );
  }
  // The Next.js runtime ran (it sets window.next), so the nonce'd scripts were allowed.
  expect(await page.evaluate(() => (window as unknown as { next?: { version?: string } }).next?.version)).toBeTruthy();
});
