"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, AlertTriangle, LogIn } from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Input } from "@/components/Input";

export default function LoginPage() {
  const router   = useRouter();
  const supabase = createBrowserSupabase();

  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    router.replace("/dashboard");
    router.refresh();
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        <div className="text-center mb-8">
          <h1 className="font-serif text-3xl text-fg leading-tight">Warehouse Monitor</h1>
          <p className="mt-2 text-xs text-fg-subtle">Internal tool · sign in to continue</p>
        </div>

        <Card className="px-7 py-7">
          <form onSubmit={onSubmit} className="space-y-5">

            <label className="block">
              <span className="block text-xs font-medium uppercase tracking-wider text-fg-muted mb-1.5">
                Email
              </span>
              <Input
                type="email"
                required
                autoFocus
                autoComplete="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                disabled={loading}
              />
            </label>

            <label className="block">
              <span className="block text-xs font-medium uppercase tracking-wider text-fg-muted mb-1.5">
                Password
              </span>
              <Input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                disabled={loading}
              />
            </label>

            {error && (
              <div className="flex items-center gap-2 px-3 py-2.5 rounded text-xs text-danger bg-danger/10 border border-danger/30">
                <AlertTriangle size={13} className="shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button type="submit" disabled={loading || !email || !password} className="w-full">
              {loading
                ? <><Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> Signing in…</>
                : <><LogIn size={14} /> Sign in</>}
            </Button>

            <p className="text-xs text-fg-subtle text-center leading-relaxed">
              Accounts are created by an admin in Supabase.
              <br />Forgot your password? Ask an admin to reset it.
            </p>
          </form>
        </Card>
      </div>
    </div>
  );
}
