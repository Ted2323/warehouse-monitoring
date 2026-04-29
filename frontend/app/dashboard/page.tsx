"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Upload, AlertTriangle, CheckCircle,
  Box, Truck, HardHat, Loader2, FileVideo, Image as ImageIcon,
  Clock, Shield, ChevronDown, ChevronUp, Download,
  Scan, BarChart3, Package, LogOut, Octagon,
} from "lucide-react";
import {
  CLASS_LABELS, VIOLATION_SEVERITY,
  isPpeViolation, type AlertLevel,
} from "@/lib/classes";
import { createBrowserSupabase } from "@/lib/supabase";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BBoxOverlay, type Detection, bboxKey } from "@/components/BBoxOverlay";
import {
  VideoPlayer,
  type VideoFrame, type VideoSession, type VideoPlayerHandle,
} from "@/components/VideoPlayer";
import { LiveBurnIn } from "@/components/LiveBurnIn";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { ComplianceGauge } from "@/components/ComplianceGauge";
import { Timeline, type TimelineEntry } from "@/components/Timeline";

// ─── TYPES ───────────────────────────────────────────────────
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
type ComplianceSummary = {
  workers_total: number;
  workers_compliant: number;
  workers_partial: number;
  workers_unsafe: number;
  critical_count: number;
  danger_count: number;
  warning_count: number;
};
type AuditEntry = {
  id: string;
  timestamp: Date;
  source: string;
  detections: Detection[];
  ppeViolations: PpeViolation[];
  zoneViolations: ZoneViolation[];
  inventory: Inventory;
  complianceSummary?: ComplianceSummary;
  previewSrc: string;
  imageUrl?: string;
  videoTimeSeconds?: number;
};

// ─── HELPERS ─────────────────────────────────────────────────
const EMPTY_INVENTORY: Inventory = {
  pallets_filled: 0, pallets_empty: 0,
  forklifts_operating: 0, forklifts_idle: 0,
  workers_total: 0, workers_compliant: 0,
};

// Phase-2: `critical` is a fourth severity tier above `danger`. Uses the new
// "critical" Chip variant (solid fill, white text) so a worker_unsafe entry
// is visually distinct from a row of danger/warning items.
const ALERT_CHIP: Record<AlertLevel, "critical" | "danger" | "warning" | "success"> = {
  critical: "critical",
  danger:   "danger",
  warning:  "warning",
  info:     "success",
};

function topAlertOfPpe(v: PpeViolation[]): AlertLevel | null {
  if (!v.length) return null;
  if (v.some(x => x.alert_level === "critical")) return "critical";
  if (v.some(x => x.alert_level === "danger"))   return "danger";
  if (v.some(x => x.alert_level === "warning"))  return "warning";
  return "info";
}

// Phase-3 toast de-dupe window. A given violation key (class + bbox) can
// re-toast after this many ms — keeps the dashboard reactive over a long
// session without spamming when the same worker stays in frame.
const TOAST_WINDOW_MS = 30_000;

function violationKey(v: PpeViolation): string {
  return `${v.class}:${v.bbox.join(",")}`;
}

// ─── AUDIT ROW ───────────────────────────────────────────────
function AuditRow({ entry, isActive, onClick }: { entry: AuditEntry; isActive: boolean; onClick: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const totalV = entry.ppeViolations.length + entry.zoneViolations.length;
  const alert  = topAlertOfPpe(entry.ppeViolations)
              ?? (entry.zoneViolations[0]?.alert_level ?? null);

  return (
    <div className={`border-b border-border last:border-b-0 transition-colors ${isActive ? "bg-bg-sunken" : "hover:bg-bg-sunken/60"}`}>
      <div onClick={onClick} className="px-4 py-3 cursor-pointer select-none flex gap-3">
        {entry.previewSrc && (
          <img
            src={entry.previewSrc}
            alt=""
            className="w-24 h-[72px] object-cover rounded border border-border shrink-0 bg-bg-sunken"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <Clock size={10} className="text-fg-subtle shrink-0" />
            <span className="text-xs font-mono tabular-nums text-fg-muted flex-1">
              {entry.timestamp.toLocaleTimeString()}
            </span>
            {alert
              ? <Chip variant={ALERT_CHIP[alert]}>{alert}</Chip>
              : <Chip variant="success">clear</Chip>
            }
          </div>
          <p className="text-sm text-fg font-medium truncate leading-tight mb-1">
            {entry.source}
          </p>
          <div className="flex items-center gap-3 text-xs text-fg-muted">
            <span>{entry.detections.length} obj</span>
            {totalV > 0 ? (
              <span className="font-medium text-fg">
                {totalV} violation{totalV > 1 ? "s" : ""}
              </span>
            ) : (
              <span className="flex items-center gap-1 text-success">
                <CheckCircle size={10} /> clean
              </span>
            )}
            {totalV > 0 && (
              <button type="button"
                onClick={e => { e.stopPropagation(); setExpanded(v => !v); }}
                className="ml-auto text-fg-subtle hover:text-fg-muted transition-colors"
                aria-label={expanded ? "Collapse" : "Expand"}>
                {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
            )}
          </div>
        </div>
      </div>
      {expanded && totalV > 0 && (
        <div className="px-4 pb-3 pt-1 space-y-1.5 bg-bg-sunken/50 border-t border-border">
          {entry.ppeViolations.map((v, i) => {
            const tone =
              v.alert_level === "critical" ? "text-critical" :
              v.alert_level === "danger"   ? "text-danger"   :
              v.alert_level === "warning"  ? "text-warning"  : "text-fg-muted";
            const Icon = v.alert_level === "critical" ? Octagon : AlertTriangle;
            return (
              <div key={`p${i}`} className="flex items-center gap-2 text-xs">
                <Icon size={10} className={tone} />
                <span className="text-fg font-medium">{CLASS_LABELS[v.class] ?? v.class}</span>
                <span className="text-fg-subtle uppercase tracking-wider">PPE</span>
              </div>
            );
          })}
          {entry.zoneViolations.map((v, i) => (
            <div key={`z${i}`} className="flex items-center gap-2 text-xs">
              <AlertTriangle size={10} className="text-warning" />
              <span className="text-fg font-medium">{CLASS_LABELS[v.class] ?? v.class}</span>
              <span className="text-fg-muted">in</span>
              <span className="text-fg-muted truncate">{v.zone_name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── KPI CARD ────────────────────────────────────────────────
function KpiCard({ icon, label, primary, secondary, tone = "neutral" }: {
  icon: React.ReactNode; label: string;
  primary: { value: React.ReactNode; suffix?: string };
  secondary?: { value: React.ReactNode; suffix?: string };
  tone?: "critical" | "danger" | "success" | "neutral" | "accent";
}) {
  const toneText = {
    critical: "text-critical",
    danger:   "text-danger",
    success:  "text-success",
    accent:   "text-accent",
    neutral:  "text-fg",
  }[tone];

  return (
    <Card className="px-5 py-4">
      <div className="flex items-center gap-2.5 mb-3">
        <div className="w-7 h-7 rounded flex items-center justify-center text-fg-muted bg-bg-sunken border border-border">
          {icon}
        </div>
        <span className="text-xs uppercase tracking-wider font-medium text-fg-muted">
          {label}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className={`font-serif text-4xl leading-none ${toneText}`}>{primary.value}</span>
        {primary.suffix && <span className="text-xs text-fg-muted">{primary.suffix}</span>}
        {secondary !== undefined && (
          <span className="ml-auto text-sm font-mono tabular-nums text-fg-muted">
            {secondary.value}{secondary.suffix ? ` ${secondary.suffix}` : ""}
          </span>
        )}
      </div>
    </Card>
  );
}

// ─── MAIN PAGE ───────────────────────────────────────────────
export default function DashboardPage() {
  const [dragging,     setDragging]    = useState(false);
  const [loading,      setLoading]     = useState(false);
  const [auditLog,     setAuditLog]    = useState<AuditEntry[]>([]);
  const [activeEntry,  setActiveEntry] = useState<AuditEntry | null>(null);
  const [videoSession, setVideoSession] = useState<VideoSession | null>(null);
  const [imgSize,      setImgSize]     = useState({ w: 640, h: 480 });
  const [error,        setError]       = useState<string | null>(null);
  const [progress,     setProgress]    = useState<{ current: number; total: number } | null>(null);
  // Phase-3: ring buffer of severity ticks for the live timeline.
  const [timeline,     setTimeline]    = useState<TimelineEntry[]>([]);

  const imgRef         = useRef<HTMLImageElement>(null);
  const fileInputRef   = useRef<HTMLInputElement>(null);
  const videoPlayerRef = useRef<VideoPlayerHandle>(null);
  // Phase-3: violationKey → last-toasted timestamp (ms). Used by the
  // sliding-window de-dupe so the same worker_unsafe re-toasts after
  // TOAST_WINDOW_MS rather than going silent for the rest of the session.
  const seenToastsRef  = useRef<Map<string, number>>(new Map());
  const CAMERA_ID    = "a0000000-0000-0000-0000-000000000001";

  const router   = useRouter();
  const supabase = useMemo(() => createBrowserSupabase(), []);

  const onSignOut = useCallback(async () => {
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }, [supabase, router]);

  const adaptLog = useCallback((log: any): AuditEntry => {
    const violations = (log.violations ?? []) as any[];
    const ppeViolations: PpeViolation[]   = [];
    const zoneViolations: ZoneViolation[] = [];
    for (const v of violations) {
      if (v.zone_id || v.zone_name) {
        zoneViolations.push({
          class: v.class, zone_name: v.zone_name,
          alert_level: v.alert_level, confidence: v.confidence,
        });
      } else if (isPpeViolation(v.class)) {
        ppeViolations.push({
          class: v.class, bbox: v.bbox, confidence: v.confidence,
          alert_level: v.alert_level ?? VIOLATION_SEVERITY[v.class] ?? "warning",
        });
      }
    }
    // Phase-2 persistence: compliance_summary is nested inside the inventory
    // JSONB. Pre-phase-2 rows don't have it — leave undefined.
    const inventoryRaw = (log.inventory ?? EMPTY_INVENTORY) as any;
    const complianceSummary: ComplianceSummary | undefined = inventoryRaw?.compliance_summary;

    return {
      id:                log.id,
      timestamp:         new Date(log.detected_at),
      source:            log.image_url?.split("/").pop() ?? "archived",
      detections:        log.detections ?? [],
      ppeViolations,
      zoneViolations,
      inventory:         inventoryRaw as Inventory,
      complianceSummary,
      previewSrc:        log.image_url ?? "",
      imageUrl:          log.image_url,
    };
  }, []);

  useEffect(() => {
    // Fire a wakeup ping in parallel with the logs fetch so the Render
    // free-tier container starts booting while the user is still picking a
    // file. By the time they upload, /detect is warm and the cold-start
    // poll inside /api/detect is skipped entirely.
    fetch("/api/wakeup").catch(() => {});

    fetch(`/api/logs?camera_id=${CAMERA_ID}&limit=50`)
      .then(r => r.json())
      .then(({ logs }) => {
        if (!logs?.length) return;
        setAuditLog(logs.map(adaptLog));
      })
      .catch(() => {});
  }, [adaptLog]);

  // Phase-3 helper — fire toasts for newly-seen violations and push a tick
  // onto the live timeline. Skipped during /api/logs rehydrate so historical
  // entries don't blast 50 toasts on first paint.
  const onNewDetection = useCallback((entry: AuditEntry) => {
    const now = Date.now();

    // Sliding-window de-dupe — drop any seen-key whose stamp is older than
    // TOAST_WINDOW_MS so the same violation can re-toast in a long session.
    const seen = seenToastsRef.current;
    for (const [k, ts] of seen) if (now - ts > TOAST_WINDOW_MS) seen.delete(k);

    for (const v of entry.ppeViolations) {
      const key = violationKey(v);
      if (seen.has(key)) continue;
      seen.set(key, now);
      const label = CLASS_LABELS[v.class] ?? v.class;
      const description = `Camera A · ${entry.timestamp.toLocaleTimeString()}`;
      if (v.alert_level === "critical") {
        toast.error(label, { description, duration: 5000 });
      } else if (v.alert_level === "danger") {
        toast.warning(label, { description, duration: 4000 });
      }
      // info / warning PPE shouldn't happen in phase 2+, but harmless if it does.
    }

    // Push timeline tick — color = highest PPE severity in this frame, or
    // "clear" when nothing fired. Zone violations don't drive the timeline
    // since they're a secondary signal.
    const top = topAlertOfPpe(entry.ppeViolations);
    setTimeline(prev => [
      ...prev.slice(-119),  // hard cap so the buffer never grows unbounded
      { id: entry.id, t: now, maxSeverity: top ?? "clear" },
    ]);
  }, []);

  const processImage = useCallback(async (file: File | Blob, sourceName: string): Promise<AuditEntry> => {
    const previewSrc = URL.createObjectURL(file);
    const fd = new FormData();
    fd.append("image", file, sourceName);
    fd.append("camera_id", CAMERA_ID);
    const res  = await fetch("/api/detect", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Detection failed");
    return {
      id:                crypto.randomUUID(),
      timestamp:         new Date(),
      source:            sourceName,
      detections:        data.detections ?? [],
      ppeViolations:     data.ppe_violations  ?? [],
      zoneViolations:    data.zone_violations ?? [],
      inventory:         (data.inventory ?? EMPTY_INVENTORY) as Inventory,
      complianceSummary: data.compliance_summary as ComplianceSummary | undefined,
      previewSrc,
      imageUrl:          data.image_url,
    };
  }, []);

  const extractFrames = useCallback(
    (videoFile: File, intervalSec = 2): Promise<{ frames: { blob: Blob; t: number }[]; duration: number }> =>
      new Promise((resolve, reject) => {
        const video = document.createElement("video");
        video.src   = URL.createObjectURL(videoFile);
        video.muted = true;
        video.addEventListener("loadedmetadata", async () => {
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth; canvas.height = video.videoHeight;
          const ctx = canvas.getContext("2d")!;
          const duration = video.duration;
          const times: number[] = [];
          for (let t = 0; t < duration; t += intervalSec) times.push(+t.toFixed(1));
          const frames: { blob: Blob; t: number }[] = [];
          for (const t of times) {
            video.currentTime = t;
            await new Promise<void>(r => video.addEventListener("seeked", () => r(), { once: true }));
            ctx.drawImage(video, 0, 0);
            const blob = await new Promise<Blob>(r => canvas.toBlob(b => r(b!), "image/jpeg", 0.85));
            frames.push({ blob, t });
          }
          URL.revokeObjectURL(video.src);
          resolve({ frames, duration });
        });
        video.addEventListener("error", reject);
      }),
    [],
  );

  const handleFile = useCallback(async (file: File) => {
    const isImage = file.type.startsWith("image/");
    const isVideo = file.type.startsWith("video/");
    if (!isImage && !isVideo) return;
    setError(null); setLoading(true); setProgress(null);
    try {
      if (isImage) {
        // Switching back to image: drop any active video session so its blob URL
        // is revoked by the cleanup effect.
        setVideoSession(null);
        const entry = await processImage(file, file.name);
        setAuditLog(prev => [entry, ...prev]);
        setActiveEntry(entry);
        onNewDetection(entry);
      } else {
        // Hide static viewer + previous video while we analyze.
        setActiveEntry(null);
        setVideoSession(null);

        const url = URL.createObjectURL(file);
        const { frames, duration } = await extractFrames(file, 2);
        setProgress({ current: 0, total: frames.length });
        const sessionFrames: VideoFrame[] = [];
        // Per-frame failures (e.g. Render cold-start 502 on the first frame)
        // shouldn't kill the whole video — keep going, summarize at the end.
        const failures: string[] = [];

        for (let i = 0; i < frames.length; i++) {
          const t = frames[i].t;
          try {
            const entry = await processImage(frames[i].blob, `${file.name} — frame ${t}s`);
            entry.videoTimeSeconds = t;
            setAuditLog(prev => [entry, ...prev]);
            onNewDetection(entry);
            sessionFrames.push({
              t,
              detections:    entry.detections,
              ppeViolations: entry.ppeViolations,
              zoneViolations: entry.zoneViolations,
              inventory:     entry.inventory,
            });
          } catch (frameErr: any) {
            failures.push(`frame ${t}s: ${frameErr?.message ?? "failed"}`);
          }
          setProgress({ current: i + 1, total: frames.length });
        }

        const sessionDuration = Number.isFinite(duration) && duration > 0
          ? duration
          : (sessionFrames.length ? sessionFrames[sessionFrames.length - 1].t + 2 : 0);

        if (sessionFrames.length > 0) {
          setVideoSession({ url, duration: sessionDuration, frames: sessionFrames, filename: file.name });
        }
        if (failures.length > 0) {
          // Surface a concise tally rather than the raw HTML error from
          // Render's cold-start page.
          const head = failures[0];
          const more = failures.length > 1 ? ` (+${failures.length - 1} more)` : "";
          setError(`${failures.length} of ${frames.length} frames failed${more} — ${head}`);
        }
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false); setProgress(null);
    }
  }, [processImage, extractFrames, onNewDetection]);

  // Revoke the previous video blob URL when the session changes or the page unmounts.
  useEffect(() => {
    if (!videoSession) return;
    const url = videoSession.url;
    return () => { URL.revokeObjectURL(url); };
  }, [videoSession]);

  const exportCSV = useCallback((entries: AuditEntry[]) => {
    const header = "timestamp,source,objects,ppe_violations,zone_violations,alert_level,details";
    const rows = entries.map(e => {
      const totalV = e.ppeViolations.length + e.zoneViolations.length;
      const alert  = topAlertOfPpe(e.ppeViolations)
                  ?? (e.zoneViolations[0]?.alert_level ?? (totalV ? "warning" : "clear"));
      const details = [
        ...e.ppeViolations.map(v => `PPE:${v.class}`),
        ...e.zoneViolations.map(v => `ZONE:${v.class} in ${v.zone_name}`),
      ].join("; ");
      return [e.timestamp.toISOString(), `"${e.source.replace(/"/g,'""')}"`,
        e.detections.length, e.ppeViolations.length, e.zoneViolations.length,
        alert, `"${details}"`].join(",");
    });
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(blob),
      download: `warehouse-audit-${new Date().toISOString().slice(0,10)}.csv`,
    });
    a.click(); URL.revokeObjectURL(a.href);
  }, []);

  const kpis = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recent = auditLog.filter(e => e.timestamp.getTime() >= cutoff);
    const ppe24h      = recent.reduce((s, e) => s + e.ppeViolations.length, 0);
    const critical24h = recent.reduce(
      (s, e) => s + e.ppeViolations.filter(v => v.alert_level === "critical").length, 0);
    const latest = auditLog[0]?.inventory ?? EMPTY_INVENTORY;
    return {
      ppe24h,
      critical24h,
      pallets:   { filled: latest.pallets_filled,         empty: latest.pallets_empty },
      forklifts: { operating: latest.forklifts_operating, idle: latest.forklifts_idle },
    };
  }, [auditLog]);

  const criticalCount   = auditLog.filter(e => topAlertOfPpe(e.ppeViolations) === "critical").length;
  const dangerCount     = auditLog.filter(e => topAlertOfPpe(e.ppeViolations) === "danger").length;
  const warningCount    = auditLog.filter(e => topAlertOfPpe(e.ppeViolations) === "warning").length;
  const totalObjects    = auditLog.reduce((s, e) => s + e.detections.length, 0);
  const totalViolations = auditLog.reduce(
    (s, e) => s + e.ppeViolations.length + e.zoneViolations.length, 0,
  );

  // Phase-3 — gauge inputs come from the latest entry's compliance_summary
  // (server-derived) or fall back to the inventory roll-up. Empty state is
  // workers_total=0 → gauge handles that internally.
  const gaugeData = useMemo(() => {
    const latest = auditLog[0];
    const summary = latest?.complianceSummary;
    if (summary) return { total: summary.workers_total, compliant: summary.workers_compliant };
    const inv = latest?.inventory ?? EMPTY_INVENTORY;
    return { total: inv.workers_total, compliant: inv.workers_compliant };
  }, [auditLog]);

  // Phase-3 — bbox keys for the active static-image entry's critical workers
  // so the overlay can pulse the right rects.
  const activeCriticalBboxes = useMemo(() => {
    if (!activeEntry) return new Set<string>();
    return new Set(
      activeEntry.ppeViolations
        .filter(v => v.alert_level === "critical")
        .map(v => bboxKey(v.bbox)),
    );
  }, [activeEntry]);

  return (
    <div className="min-h-screen">

      {/* ── HEADER ── */}
      <header className="border-b border-border bg-bg/95 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-[1320px] mx-auto px-8 py-4 flex items-center gap-4">
          <h1 className="font-serif text-lg text-fg leading-none">Warehouse Monitor</h1>
          <span className="text-xs text-fg-subtle">PPE · Asset Status</span>
          <div className="flex-1" />
          <span className="text-xs text-fg-muted">{auditLog.length} entries</span>
          {criticalCount > 0 && (
            <Chip variant="critical">
              <Octagon size={10} className="shrink-0" />
              {criticalCount} critical
            </Chip>
          )}
          {dangerCount > 0 && (
            <Chip variant="danger">{dangerCount} danger</Chip>
          )}
          {warningCount > 0 && (
            <Chip variant="warning">{warningCount} warning</Chip>
          )}
          <ThemeToggle />
          <Button variant="ghost" size="sm" onClick={onSignOut} title="Sign out">
            <LogOut size={13} /> Sign out
          </Button>
        </div>
      </header>

      {/* ── MAIN ── */}
      <main className="px-8 py-6 max-w-[1320px] mx-auto">

        {/* Phase-3: compliance gauge sits above the KPI row so the overall
            "are we safe right now?" read is the first thing the eye lands on. */}
        <div className="mb-4">
          <ComplianceGauge
            workersTotal={gaugeData.total}
            workersCompliant={gaugeData.compliant}
          />
        </div>

        {/* KPI ROW */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <KpiCard
            icon={kpis.critical24h > 0 ? <Octagon size={15} /> : <HardHat size={15} />}
            label="PPE violations · 24h"
            primary={{ value: <AnimatedNumber value={kpis.ppe24h} />,
                       suffix: kpis.ppe24h === 1 ? "event" : "events" }}
            secondary={kpis.critical24h > 0
              ? { value: <AnimatedNumber value={kpis.critical24h} />, suffix: "critical" }
              : undefined}
            tone={kpis.critical24h > 0 ? "critical"
                : kpis.ppe24h     > 0 ? "danger"
                : "success"}
          />
          <KpiCard
            icon={<Package size={15} />}
            label="Pallets"
            primary={{   value: <AnimatedNumber value={kpis.pallets.filled} />, suffix: "filled" }}
            secondary={{ value: <AnimatedNumber value={kpis.pallets.empty} />,  suffix: "empty"  }}
            tone="accent"
          />
          <KpiCard
            icon={<Truck size={15} />}
            label="Forklifts"
            primary={{   value: <AnimatedNumber value={kpis.forklifts.operating} />, suffix: "operating" }}
            secondary={{ value: <AnimatedNumber value={kpis.forklifts.idle} />,      suffix: "idle"      }}
            tone="neutral"
          />
        </div>

        <div className="grid grid-cols-[1fr_370px] gap-5 items-start">

          {/* ── LEFT ── */}
          <div className="flex flex-col gap-4">

            {/* Drop zone */}
            <Card
              onDragOver={e => { if (loading) return; e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => { e.preventDefault(); setDragging(false); if (loading) return; const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
              onClick={() => { if (!loading) fileInputRef.current?.click(); }}
              className={`px-6 py-5 flex items-center gap-5 cursor-pointer transition-colors ${
                loading ? "opacity-60 cursor-not-allowed" :
                dragging ? "border-accent bg-bg-sunken" : "hover:bg-bg-sunken"
              }`}
            >
              <div className="w-10 h-10 rounded flex items-center justify-center shrink-0 bg-bg-sunken border border-border text-fg-muted">
                {loading
                  ? <Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} />
                  : <Upload size={18} />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-fg">
                  {loading
                    ? progress ? `Processing frame ${progress.current} / ${progress.total}…` : "Running detection…"
                    : dragging ? "Release to analyze" : "Drop an image or video to analyze"}
                </p>
                <p className="mt-1 text-xs text-fg-muted flex gap-3">
                  {loading
                    ? <span>Inference in progress — please wait</span>
                    : <>
                        <span className="flex items-center gap-1"><ImageIcon size={10} /> JPG / PNG</span>
                        <span className="flex items-center gap-1"><FileVideo size={10} /> MP4 · frames every 2s</span>
                      </>}
                </p>
              </div>
              <input ref={fileInputRef} type="file" accept="image/*,video/*"
                aria-label="Upload image or video" title="Upload image or video"
                className="hidden"
                onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} />
            </Card>

            {/* Video progress */}
            {progress && (
              <Card className="px-5 py-4">
                <div className="flex justify-between mb-2 text-xs">
                  <span className="text-fg-muted font-medium">Processing video frames</span>
                  <span className="text-fg-subtle font-mono">{progress.current} / {progress.total}</span>
                </div>
                <progress value={progress.current} max={progress.total} className="progress-bar" />
              </Card>
            )}

            {/* Frame viewer — video player when a video session is loaded, else static image */}
            {videoSession ? (
              <VideoPlayer ref={videoPlayerRef} session={videoSession} />
            ) : activeEntry?.previewSrc ? (
              <Card className="overflow-hidden">
                {/* ring-1 white/10 mirrors VideoPlayer's "monitoring station"
                    border so both viewer surfaces feel uniform. */}
                <div className="relative ring-1 ring-white/10">
                  <img ref={imgRef} src={activeEntry.previewSrc} alt="Detection frame"
                    onLoad={() => { if (imgRef.current) setImgSize({ w: imgRef.current.naturalWidth, h: imgRef.current.naturalHeight }); }}
                    className="w-full block max-h-[520px] object-contain bg-bg-sunken" />
                  {imgRef.current && (
                    <BBoxOverlay
                      detections={activeEntry.detections}
                      violations={activeEntry.ppeViolations}
                      criticalBboxes={activeCriticalBboxes}
                      naturalW={imgSize.w} naturalH={imgSize.h}
                      displayW={imgRef.current.offsetWidth} displayH={imgRef.current.offsetHeight}
                    />
                  )}

                  {/* Phase-3: same LIVE/timestamp burn-in the VideoPlayer uses
                      so a still-image viewer also reads as "monitoring". */}
                  <LiveBurnIn />

                  {loading && !progress && (
                    <div className="absolute inset-0 flex items-center justify-center gap-3 bg-bg/70">
                      <Loader2 size={22} className="text-accent" style={{ animation: "spin 1s linear infinite" }} />
                      <span className="text-sm font-medium text-fg">Running inference…</span>
                    </div>
                  )}
                  <div className="absolute bottom-3 left-3 text-xs px-2 py-1 rounded bg-bg-elevated border border-border text-fg-muted">
                    {activeEntry.source}
                  </div>
                </div>
              </Card>
            ) : (
              <Card className="flex flex-col items-center justify-center gap-3 py-16">
                <div className="w-14 h-14 rounded-lg flex items-center justify-center bg-bg-sunken border border-border">
                  {loading
                    ? <Loader2 size={24} className="text-accent" style={{ animation: "spin 1s linear infinite" }} />
                    : <Scan size={24} className="text-fg-subtle" />}
                </div>
                <p className="text-sm font-medium text-fg">
                  {loading ? (progress ? `Frame ${progress.current} / ${progress.total}` : "Running detection…") : "No frame selected"}
                </p>
                <p className="text-xs text-fg-subtle">
                  {loading ? "YOLOv8 is analyzing your image" : "Upload media above to begin analysis"}
                </p>
              </Card>
            )}

            {/* Phase-3 — live severity timeline. Always visible; empty
                strip is the steady "no scans yet" state. */}
            <Timeline entries={timeline} />

            {/* Error */}
            {error && (
              <div className="px-4 py-3 rounded text-sm flex items-center gap-2 bg-danger/10 border border-danger/30 text-danger">
                <AlertTriangle size={14} className="shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* Stats row */}
            {auditLog.length > 0 && (
              <div className="grid grid-cols-4 gap-3">
                {[
                  { icon: <BarChart3     size={14}/>, value: auditLog.length,  label: "Frames",     tone: "neutral" as const },
                  { icon: <Box           size={14}/>, value: totalObjects,    label: "Objects",    tone: "neutral" as const },
                  { icon: <AlertTriangle size={14}/>, value: totalViolations, label: "Violations",
                    tone: criticalCount   ? "critical" as const
                        : totalViolations ? "danger"   as const
                        : "success"       as const },
                  { icon: criticalCount > 0 ? <Octagon size={14}/> : <Shield size={14}/>,
                    value: criticalCount || dangerCount,
                    label: criticalCount ? "Critical" : "Danger",
                    tone: criticalCount ? "critical" as const
                        : dangerCount   ? "danger"   as const
                        : "neutral"     as const },
                ].map(({ icon, value, label, tone }) => {
                  const toneText = {
                    critical: "text-critical",
                    danger:   "text-danger",
                    success:  "text-success",
                    neutral:  "text-fg",
                  }[tone];
                  return (
                    <Card key={label} className="px-4 py-3 flex items-center gap-3">
                      <div className="w-8 h-8 rounded flex items-center justify-center shrink-0 bg-bg-sunken border border-border text-fg-muted">
                        {icon}
                      </div>
                      <div>
                        <div className={`font-serif text-2xl leading-none ${toneText}`}>
                          <AnimatedNumber value={value} />
                        </div>
                        <div className="text-xs text-fg-muted mt-0.5">{label}</div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── RIGHT: SAFETY VIOLATIONS FEED ── */}
          <Card className="sticky top-[68px] overflow-hidden">
            <div className="px-5 py-3.5 flex items-center gap-2.5 border-b border-border">
              <div className="w-7 h-7 rounded flex items-center justify-center bg-bg-sunken border border-border text-danger">
                <Shield size={13} />
              </div>
              <span className="text-xs uppercase tracking-wider font-medium text-fg-muted">
                Safety Violations
              </span>
              {auditLog.length > 0 && (
                <>
                  <span className="text-xs font-mono text-fg-subtle">{auditLog.length}</span>
                  <div className="ml-auto flex gap-1.5">
                    <Button variant="ghost" size="sm" onClick={() => exportCSV(auditLog)}>
                      <Download size={11} /> Export
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => { setAuditLog([]); setActiveEntry(null); setVideoSession(null); }}>
                      Clear
                    </Button>
                  </div>
                </>
              )}
            </div>

            <div className="overflow-y-auto" style={{ maxHeight: "calc(100vh - 340px)" }}>
              {auditLog.length === 0 ? (
                <div className="py-14 px-5 flex flex-col items-center gap-2.5 text-center">
                  <BarChart3 size={28} className="text-fg-subtle" />
                  <p className="text-sm font-medium text-fg-muted">No entries yet</p>
                  <p className="text-xs text-fg-subtle">Upload an image or video to begin</p>
                </div>
              ) : auditLog.map(entry => (
                <AuditRow key={entry.id} entry={entry}
                  isActive={activeEntry?.id === entry.id}
                  onClick={() => {
                    if (videoSession && entry.videoTimeSeconds !== undefined) {
                      videoPlayerRef.current?.seek(entry.videoTimeSeconds);
                    } else {
                      setActiveEntry(entry);
                    }
                  }} />
              ))}
            </div>

            {auditLog.length > 0 && (
              <div className="px-5 py-3 flex items-center justify-between border-t border-border">
                <span className="text-xs text-fg-muted">{auditLog.length} scans total</span>
                <span className={`text-xs font-medium ${
                  criticalCount   > 0 ? "text-critical" :
                  totalViolations > 0 ? "text-danger"   : "text-success"}`}>
                  {totalViolations > 0 ? `${totalViolations} violations` : "All clear"}
                </span>
              </div>
            )}
          </Card>

        </div>
      </main>
    </div>
  );
}
