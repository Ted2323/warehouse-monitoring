// Auth gate. Anyone hitting a non-/login page without a session is bounced
// to /login; authenticated users hitting /login are bounced to /dashboard.
//
// Renamed from middleware.ts in Next.js 16 (see
// https://nextjs.org/docs/messages/middleware-to-proxy). The function name,
// not just the file, must be `proxy`. The matcher config export is unchanged.
// We use @supabase/ssr (the modern replacement for auth-helpers-nextjs).

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

export async function proxy(req: NextRequest) {
  const res = NextResponse.next();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return req.cookies.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          res.cookies.set({ name, value, ...options });
        },
        remove(name: string, options: CookieOptions) {
          res.cookies.set({ name, value: "", ...options });
        },
      },
    },
  );

  // getSession() will try to refresh an expired token. If the refresh token
  // has been revoked (e.g. Supabase project key rotated, user deleted), the
  // SDK throws AuthApiError("Refresh Token Not Found"). Treat that as
  // "no session" and let the redirect below clear the stale cookies.
  let session: Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"] = null;
  try {
    const { data } = await supabase.auth.getSession();
    session = data.session;
  } catch {
    session = null;
  }

  const path = req.nextUrl.pathname;
  const isAuthRoute = path.startsWith("/login");
  const isApiRoute  = path.startsWith("/api/");

  // When supabase-ssr writes cookie mutations (e.g. clearing a stale token),
  // it does so on `res`. NextResponse.redirect() creates a fresh response, so
  // we must copy those cookies forward or the clears get lost.
  const redirectTo = (target: string) => {
    const r = NextResponse.redirect(new URL(target, req.url));
    res.cookies.getAll().forEach((c) => r.cookies.set(c));
    return r;
  };

  if (!session && !isAuthRoute) {
    // For API requests (called by fetch from the dashboard), reply 401 JSON
    // so callers can show an error rather than try to parse an HTML redirect.
    if (isApiRoute) {
      const r = NextResponse.json({ error: "unauthorized" }, { status: 401 });
      res.cookies.getAll().forEach((c) => r.cookies.set(c));
      return r;
    }
    return redirectTo("/login");
  }
  if (session && isAuthRoute) {
    return redirectTo("/dashboard");
  }
  return res;
}

export const config = {
  // Skip static assets only — gate every page and API route behind the session.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/public).*)"],
};
