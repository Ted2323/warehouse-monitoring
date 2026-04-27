"use client";

import {
  forwardRef, useEffect, useImperativeHandle,
  useMemo, useRef, useState,
} from "react";
import { Card } from "@/components/Card";
import { BBoxOverlay, type Detection, bboxKey } from "@/components/BBoxOverlay";
import { LiveBurnIn } from "@/components/LiveBurnIn";
import type { AlertLevel } from "@/lib/classes";

type PpeViolation = {
  class: string;
  bbox: [number, number, number, number];
  confidence: number;
  alert_level: AlertLevel;
};
type ZoneViolation = {
  class: string;
  zone_name: string;
  alert_level: AlertLevel;
  confidence: number;
};
type Inventory = {
  pallets_filled: number;
  pallets_empty: number;
  forklifts_operating: number;
  forklifts_idle: number;
  workers_total: number;
  workers_compliant: number;
};

export type VideoFrame = {
  t: number;
  detections: Detection[];
  ppeViolations: PpeViolation[];
  zoneViolations: ZoneViolation[];
  inventory: Inventory;
};

export type VideoSession = {
  url: string;
  duration: number;
  frames: VideoFrame[];
  filename: string;
};

export type VideoPlayerHandle = {
  seek: (t: number) => void;
};

type Props = { session: VideoSession };

export const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(
  function VideoPlayer({ session }, ref) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [currentTime, setCurrentTime] = useState(0);
    const [naturalSize, setNaturalSize] = useState({ w: 640, h: 480 });
    const [displaySize, setDisplaySize] = useState({ w: 640, h: 480 });

    useImperativeHandle(ref, () => ({
      seek: (t: number) => {
        const v = videoRef.current;
        if (!v) return;
        v.currentTime = t;
        v.play().catch(() => {});
      },
    }), []);

    // Auto-play once analysis completes (browsers may block — user clicks play if so).
    useEffect(() => {
      videoRef.current?.play().catch(() => {});
    }, [session.url]);

    // Track rendered video size for overlay scaling.
    useEffect(() => {
      const v = videoRef.current;
      if (!v) return;
      const update = () => {
        if (v.clientWidth && v.clientHeight) {
          setDisplaySize({ w: v.clientWidth, h: v.clientHeight });
        }
      };
      const ro = new ResizeObserver(update);
      ro.observe(v);
      update();
      return () => ro.disconnect();
    }, []);

    // Pick the most recent analyzed frame at or before currentTime.
    const activeFrame = useMemo(() => {
      let best: VideoFrame | null = null;
      for (const f of session.frames) {
        if (f.t <= currentTime) best = f;
        else break;
      }
      return best;
    }, [currentTime, session.frames]);

    // Phase-3 — bbox keys for workers in critical state, so the overlay
    // can pulse the right rects.
    const criticalBboxes = useMemo(() => {
      if (!activeFrame) return new Set<string>();
      return new Set(
        activeFrame.ppeViolations
          .filter((v) => v.alert_level === "critical")
          .map((v) => bboxKey(v.bbox)),
      );
    }, [activeFrame]);

    return (
      <Card className="overflow-hidden">
        {/* Phase-3 — 1px white/10% inner border reinforces the
            "monitoring station" surveillance feel without overpowering
            the warm-paper card. */}
        <div className="relative ring-1 ring-white/10">
          <video
            ref={videoRef}
            src={session.url}
            controls
            playsInline
            muted
            className="block w-full h-auto bg-bg-sunken"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              setNaturalSize({ w: v.videoWidth, h: v.videoHeight });
              setDisplaySize({ w: v.clientWidth || v.videoWidth, h: v.clientHeight || v.videoHeight });
            }}
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
            onSeeked={(e) => setCurrentTime(e.currentTarget.currentTime)}
          />
          {activeFrame && displaySize.w > 0 && (
            <BBoxOverlay
              detections={activeFrame.detections}
              violations={activeFrame.ppeViolations}
              criticalBboxes={criticalBboxes}
              naturalW={naturalSize.w}
              naturalH={naturalSize.h}
              displayW={displaySize.w}
              displayH={displaySize.h}
            />
          )}

          {/* LIVE dot + timestamp burn-in (phase 3). */}
          <LiveBurnIn />

          <div className="absolute bottom-3 left-3 text-xs px-2 py-1 rounded bg-bg-elevated border border-border text-fg-muted font-mono">
            {currentTime.toFixed(1)}s · {activeFrame?.detections.length ?? 0} obj
          </div>
          <div className="absolute top-3 right-3 text-xs px-2 py-1 rounded bg-bg-elevated border border-border text-fg-muted truncate max-w-[60%]">
            {session.filename}
          </div>
        </div>
      </Card>
    );
  },
);
