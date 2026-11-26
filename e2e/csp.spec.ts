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

test("the proxy skips only the exact asset paths, and runs for every Server Action", async ({ request }) => {
  const proxied = async (path: string, action: boolean) => {
    const response = action
      ? await request.post(path, { headers: { "next-action": "0".repeat(42) }, data: "[]" })
      : await request.get(path);
    return /'nonce-/.test(response.headers()["content-security-policy"] ?? "");
  };
  // Look-alikes of the skipped paths are pages like any other.
  for (const path of ["/favicon.icox", "/favicon.ico.txt", "/_next/staticfoo", "/_next/imagefoo"]) {
    expect(await proxied(path, false), `GET ${path}`).toBe(true);
  }
  for (const path of ["/favicon.ico", "/_next/image"]) expect(await proxied(path, false), `GET ${path}`).toBe(false);
  // A Server Action posted to a skipped path still passes through the proxy, so it reaches the app
  // through the same hosts as on any page (ADR 0029: the visitor IP is counted from that hop).
  for (const path of ["/favicon.ico", "/_next/image", "/_next/static/x", "/favicon.icox", "/login"]) {
    expect(await proxied(path, true), `action POST ${path}`).toBe(true);
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
