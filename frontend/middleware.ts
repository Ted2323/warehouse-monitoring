// Auth gate. Anyone hitting a non-/login page without a session is bounced
// to /login; authenticated users hitting /login are bounced to /dashboard.
//
// We use @supabase/ssr (the modern replacement for auth-helpers-nextjs).

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

export async function middleware(req: NextRequest) {
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

  const { data: { session } } = await supabase.auth.getSession();
  const path = req.nextUrl.pathname;
  const isAuthRoute = path.startsWith("/login");
  const isApiRoute  = path.startsWith("/api/");

  if (!session && !isAuthRoute) {
    // For API requests (called by fetch from the dashboard), reply 401 JSON
    // so callers can show an error rather than try to parse an HTML redirect.
    if (isApiRoute) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", req.url));
  }
  if (session && isAuthRoute) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }
  return res;
}

export const config = {
  // Skip static assets only — gate every page and API route behind the session.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/public).*)"],
};
