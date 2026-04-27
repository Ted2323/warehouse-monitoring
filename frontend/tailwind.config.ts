import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT:  "var(--bg)",
          elevated: "var(--bg-elevated)",
          sunken:   "var(--bg-sunken)",
        },
        fg: {
          DEFAULT: "var(--fg)",
          muted:   "var(--fg-muted)",
          subtle:  "var(--fg-subtle)",
        },
        border: {
          DEFAULT: "var(--border)",
          strong:  "var(--border-strong)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          hover:   "var(--accent-hover)",
          fg:      "var(--accent-fg)",
        },
        success:  "var(--success)",
        warning:  "var(--warning)",
        danger:   "var(--danger)",
        critical: "var(--critical)",
      },
      fontFamily: {
        // CSS variables come from next/font/google in app/layout.tsx.
        serif: ["var(--font-serif)", '"Source Serif 4"', "Georgia", "serif"],
        sans:  ["var(--font-sans)",  "Inter", "system-ui", "sans-serif"],
        mono:  ["var(--font-mono)",  '"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "monospace"],
      },
      borderRadius: {
        DEFAULT: "6px",
        lg:      "10px",
      },
    },
  },
  plugins: [],
};

export default config;
