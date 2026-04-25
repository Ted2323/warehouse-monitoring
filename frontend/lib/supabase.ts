// Browser-safe Supabase client. Import this from client components.
// For server components / route handlers that need cookies, import from
// `@/lib/supabase-server` instead — that module pulls in `next/headers`,
// which Next refuses to bundle into client code.

import { createBrowserClient } from "@supabase/ssr";

const SUPABASE_URL  = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export function createBrowserSupabase() {
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON);
}
