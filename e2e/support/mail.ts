import { expect } from "@playwright/test";

// The local Supabase stack catches every auth email in Mailpit (supabase/config.toml
// [local_smtp]). API: https://mailpit.axllent.org/docs/api-v1/
const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";

type Summary = { ID: string; Subject: string; To: { Address: string }[] };

async function search(to: string): Promise<Summary[]> {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  if (!res.ok) throw new Error(`Mailpit search failed: HTTP ${res.status}`);
  return ((await res.json()) as { messages: Summary[] }).messages;
}

export async function mailCount(to: string): Promise<number> {
  return (await search(to)).length;
}

// Waits for the newest email to `to` whose subject matches, and returns the /auth/confirm link
// in it. `after` is how many emails `to` had before the action that sends this one.
export async function confirmLink(to: string, subject: RegExp, after = 0): Promise<string> {
  let found: Summary | undefined;
  await expect
    .poll(
      async () => {
        const messages = await search(to);
        found = messages.length > after ? messages.find((m) => subject.test(m.Subject)) : undefined;
        return !!found;
      },
      { message: `email "${subject}" to ${to}`, timeout: 20_000 },
    )
    .toBe(true);
  const res = await fetch(`${MAILPIT}/api/v1/message/${found!.ID}`);
  const html = ((await res.json()) as { HTML: string }).HTML;
  const href = html.match(/href="([^"]*\/auth\/confirm\?[^"]*)"/)?.[1];
  if (!href) throw new Error(`no /auth/confirm link in "${found!.Subject}"`);
  return href.replaceAll("&amp;", "&");
}
