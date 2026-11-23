import { createServerClient } from "@supabase/ssr";
import { cookies, headers } from "next/headers";
import { connection } from "next/server";
import { authCookieOptions, hardenCookie, supabaseEnv } from "./config";
import { isHttps } from "@/lib/http";

// A Supabase client for Server Components and Server Actions, acting as the signed-in user.
// Create one per request; never share it.
export async function createClient() {
  // Wait for the request first: during `next build` this stops here, so the build needs no env,
  // and the client's use of Date.now() always runs at request time.
  await connection();
  const cookieStore = await cookies();
  const secure = isHttps(await headers());
  const { url, key } = supabaseEnv();
  return createServerClient(url, key, {
    cookieOptions: authCookieOptions(secure),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        // Server Components can't set cookies; the proxy refreshes the session for them.
        // Server Actions can, and they are the only place a session starts or ends.
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, hardenCookie(options, secure));
          }
        } catch {
          // Called from a Server Component: ignored on purpose (see above).
        }
      },
    },
  });
}
