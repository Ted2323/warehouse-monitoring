"use client";

import { useEffect, useState } from "react";

/**
 * Phase-3 surveillance-style overlay — pulsing red dot + LIVE label +
 * black mono timestamp chip in the top-left corner of any camera surface.
 * Refreshes every 500ms so the seconds digit visibly ticks even when no
 * new /detect response has arrived.
 *
 * Used by both `VideoPlayer` (during video playback) and the static-image
 * frame viewer in `dashboard/page.tsx` (after a single-image upload), so
 * the "monitoring station" affordance is consistent regardless of source.
 */
export function LiveBurnIn({ cameraId = "CAM_A" }: { cameraId?: string }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 500);
    return () => clearInterval(id);
  }, []);

  // 24-hour HH:MM:SS — locale-independent so screenshots are reproducible.
  const stamp = now.toLocaleTimeString("en-GB", { hour12: false });

  return (
    <div className="absolute top-3 left-3 flex items-center gap-2 text-white text-xs font-mono pointer-events-none z-10">
      <span className="w-2 h-2 rounded-full bg-critical animate-pulse" />
      <span className="font-semibold tracking-wide">LIVE</span>
      <span className="ml-1 px-2 py-0.5 bg-black/60 rounded backdrop-blur-sm">
        {stamp} · {cameraId}
      </span>
    </div>
  );
}
