import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Source_Serif_4, Inter, JetBrains_Mono } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

const sans = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const serif = Source_Serif_4({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "600", "700"],
  variable: "--font-serif",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Warehouse Monitor",
  description: "PPE compliance and asset-status detection",
  icons: { icon: "/favicon.svg" },
};

// Read theme from cookie at request time so initial HTML carries `.dark`.
// Inline script below also re-reads the cookie before hydration in case it
// was written without a full reload (defense in depth — no flash either way).
const THEME_BOOTSTRAP = `
(function () {
  try {
    var m = document.cookie.match(/(?:^|; )theme=([^;]+)/);
    var theme = m ? decodeURIComponent(m[1]) : null;
    if (theme === 'dark') document.documentElement.classList.add('dark');
    else if (theme === 'light') document.documentElement.classList.remove('dark');
  } catch (e) {}
})();
`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = (await cookies()).get("theme")?.value;
  const isDark = theme === "dark";

  return (
    <html
      lang="en"
      className={`${sans.variable} ${serif.variable} ${mono.variable}${isDark ? " dark" : ""}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="antialiased font-sans bg-bg text-fg">
        {children}
        {/* Phase-3: live toast feed for new violations. richColors gives
            sonner's default amber/red theming, which lines up with our
            danger/critical severities — see app/dashboard/page.tsx for
            the firing logic + sliding-window de-dupe. */}
        <Toaster position="top-right" richColors theme={isDark ? "dark" : "light"} />
      </body>
    </html>
  );
}
