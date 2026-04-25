"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

// Cookie persistence (not localStorage) so the server can read the theme on
// the next request and ship the right HTML — no flash. The inline bootstrap
// script in app/layout.tsx handles the same cookie on first paint.

function readThemeCookie(): "light" | "dark" | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/(?:^|; )theme=([^;]+)/);
  if (!m) return null;
  const v = decodeURIComponent(m[1]);
  return v === "dark" || v === "light" ? v : null;
}

function writeThemeCookie(value: "light" | "dark") {
  // 1 year, on every path, lax SameSite. Plain document.cookie is fine —
  // theme is not security-sensitive.
  document.cookie = `theme=${value}; path=/; max-age=31536000; samesite=lax`;
}

export function ThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const [isDark, setIsDark]   = useState(false);

  useEffect(() => {
    setMounted(true);
    const cookie = readThemeCookie();
    if (cookie) {
      setIsDark(cookie === "dark");
    } else {
      // No cookie yet — fall back to whatever the bootstrap script decided.
      setIsDark(document.documentElement.classList.contains("dark"));
    }
  }, []);

  const toggle = () => {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle("dark", next);
    writeThemeCookie(next ? "dark" : "light");
  };

  // Render a stable shell pre-mount so SSR + first paint match.
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle dark mode"
      title="Toggle dark mode"
      className="inline-flex items-center justify-center w-8 h-8 rounded text-fg-muted hover:bg-bg-sunken hover:text-fg transition-colors"
    >
      {mounted && isDark ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}
