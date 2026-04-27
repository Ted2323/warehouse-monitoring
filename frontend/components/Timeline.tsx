"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { Card } from "@/components/Card";
import type { AlertLevel } from "@/lib/classes";

export type TimelineEntry = {
  id: string;        // stable React key — survives across re-renders
  t: number;         // wall-clock ms (Date.now()) when /detect returned
  maxSeverity: AlertLevel | "clear";
};

const WINDOW_SECONDS = 60;
const TICK_W         = 4;     // px per tick
const STRIP_HEIGHT   = 36;    // matches the brief's "strip" feel

const SEVERITY_COLOR: Record<TimelineEntry["maxSeverity"], string> = {
  clear:    "var(--success)",
  info:     "var(--fg-muted)",
  warning:  "var(--warning)",
  danger:   "var(--danger)",
  critical: "var(--critical)",
};

/**
 * Phase-3 mini-timeline — a 60-second-wide horizontal strip below the
 * camera frame. Each /detect response pushes a colored tick; ticks scroll
 * leftward as time advances and drop off the left edge once they age past
 * WINDOW_SECONDS.
 *
 * `now` is held in state and refreshed every 500ms so ticks visibly scroll
 * even when no new /detect responses arrive — that's the "continuous
 * monitoring" affordance the brief is after.
 */
export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  // Trim to the active window — pure render-time filter, the parent owns
  // the ring buffer.
  const visible = entries.filter((e) => (now - e.t) / 1000 <= WINDOW_SECONDS);

  return (
    <Card className="px-4 py-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] uppercase tracking-wider font-medium text-fg-muted">
          Live timeline · last {WINDOW_SECONDS}s
        </span>
        <span className="text-[10px] font-mono text-fg-subtle tabular-nums">
          {visible.length} {visible.length === 1 ? "scan" : "scans"}
        </span>
      </div>

      <div
        className="relative w-full overflow-hidden rounded bg-bg-sunken border border-border"
        style={{ height: STRIP_HEIGHT }}
        aria-label="Severity timeline"
      >
        {/* Horizontal mid-line so an empty strip still looks like a track. */}
        <div className="absolute inset-x-0 top-1/2 h-px bg-border pointer-events-none" />

        {/* Positioned divs (not SVG) so we can use a `right: <pct>` offset
            that scales with the container width without a ResizeObserver. */}
        <AnimatePresence>
          {visible.map((e) => {
            const ageSec        = (now - e.t) / 1000;
            const rightPct      = (ageSec / WINDOW_SECONDS) * 100;
            return (
              <motion.div
                key={e.id}
                initial={{ opacity: 0, scaleY: 0.6 }}
                animate={{ opacity: 1, scaleY: 1 }}
                exit={{ opacity: 0, scaleY: 0.6 }}
                transition={{ duration: 0.25 }}
                className="absolute top-1 rounded-[1px]"
                style={{
                  right:  `calc(${rightPct}% - ${TICK_W / 2}px)`,
                  width:  TICK_W,
                  height: STRIP_HEIGHT - 8,
                  background: SEVERITY_COLOR[e.maxSeverity],
                }}
              />
            );
          })}
        </AnimatePresence>
      </div>

      <div className="flex justify-between mt-1 text-[10px] font-mono text-fg-subtle tabular-nums">
        <span>−{WINDOW_SECONDS}s</span>
        <span>now</span>
      </div>
    </Card>
  );
}
