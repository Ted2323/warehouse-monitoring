import { CLASS_LABELS, type AlertLevel } from "@/lib/classes";

export type Detection = {
  class: string;
  confidence: number;
  bbox: [number, number, number, number];
  cx: number;
  cy: number;
};

export type ViolationOverlay = {
  class: string;
  bbox: [number, number, number, number];
  alert_level: AlertLevel;
};

// Raw model classes — base colors only. Derived violations (worker_unsafe,
// worker_no_helmet, worker_no_vest) are drawn from `violations` using
// SEVERITY_STROKE so the worker bbox keeps its base "worker" outline and the
// violation overlay sits on top of it.
const BBOX_STROKE: Record<string, string> = {
  worker:   "var(--success)",
  helmet:   "var(--success)",
  vest:     "var(--success)",
  pallet:   "var(--accent)",
  box:      "var(--accent)",
  forklift: "var(--warning)",
};
const FALLBACK_STROKE = "var(--fg-muted)";

const SEVERITY_STROKE: Record<AlertLevel, string> = {
  info:     "var(--fg-muted)",
  warning:  "var(--warning)",
  danger:   "var(--danger)",
  critical: "var(--critical)",
};

/** Stable bbox key — bbox.join(",") matches the keying convention used by
 *  the dashboard's seen-violation set, so we can drive both with the same
 *  derivation without an extra mapping. */
export const bboxKey = (bbox: [number, number, number, number]) => bbox.join(",");

/** Tiny "lock-on" corner brackets — 4 L-shapes at the bbox corners, drawn
 *  on top of any pulsing rect to read as a sci-fi targeting reticle. */
function CornerBrackets({
  sx, sy, sw, sh, stroke,
}: { sx: number; sy: number; sw: number; sh: number; stroke: string }) {
  const L = Math.min(14, sw / 4, sh / 4);   // arm length, scales with bbox
  const w = 2;                              // stroke width for the brackets
  // Each corner is two short lines forming an L.
  return (
    <g stroke={stroke} strokeWidth={w} strokeLinecap="round" fill="none">
      {/* TL */} <line x1={sx} y1={sy} x2={sx + L} y2={sy} /><line x1={sx} y1={sy} x2={sx} y2={sy + L} />
      {/* TR */} <line x1={sx + sw} y1={sy} x2={sx + sw - L} y2={sy} /><line x1={sx + sw} y1={sy} x2={sx + sw} y2={sy + L} />
      {/* BL */} <line x1={sx} y1={sy + sh} x2={sx + L} y2={sy + sh} /><line x1={sx} y1={sy + sh} x2={sx} y2={sy + sh - L} />
      {/* BR */} <line x1={sx + sw} y1={sy + sh} x2={sx + sw - L} y2={sy + sh} /><line x1={sx + sw} y1={sy + sh} x2={sx + sw} y2={sy + sh - L} />
    </g>
  );
}

export function BBoxOverlay({
  detections,
  violations = [],
  criticalBboxes,
  naturalW, naturalH, displayW, displayH,
}: {
  detections: Detection[];
  violations?: ViolationOverlay[];
  /** Set of `bbox.join(",")` for detections whose worker has a `worker_unsafe`
   *  (critical) violation. Members get the .bbox-critical pulse + thicker stroke. */
  criticalBboxes?: Set<string>;
  naturalW: number; naturalH: number; displayW: number; displayH: number;
}) {
  const scaleX = displayW / naturalW;
  const scaleY = displayH / naturalH;
  return (
    <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${displayW} ${displayH}`}>
      {/* Layer 1 — raw detections (base classes). */}
      {detections.map((det, i) => {
        const [x1,y1,x2,y2] = det.bbox;
        const sx = x1*scaleX, sy = y1*scaleY, sw = (x2-x1)*scaleX, sh = (y2-y1)*scaleY;
        const stroke = BBOX_STROKE[det.class] ?? FALLBACK_STROKE;
        const label  = `${CLASS_LABELS[det.class] ?? det.class} ${Math.round(det.confidence*100)}%`;
        const labelW = label.length * 6.5 + 10;
        const isCriticalDet = criticalBboxes?.has(bboxKey(det.bbox)) ?? false;
        // For critical workers we re-tint the base rect so the pulse feels
        // continuous (the stroke is the only animated property — the corner
        // brackets sit on top in the same color).
        const rectStroke = isCriticalDet ? "var(--critical)" : stroke;
        return (
          <g key={`d${i}`}>
            <rect x={sx} y={sy} width={sw} height={sh} fill="none"
              stroke={rectStroke}
              strokeWidth={isCriticalDet ? 2.5 : 1.5}
              rx={2}
              className={isCriticalDet ? "bbox-critical" : undefined} />
            <CornerBrackets sx={sx} sy={sy} sw={sw} sh={sh} stroke={rectStroke} />
            <rect x={sx} y={Math.max(0, sy-20)} width={labelW} height={18} fill={rectStroke} rx={2} />
            <text x={sx+5} y={Math.max(0, sy-20)+13} fill="white" fontSize={11} fontWeight={500} className="font-sans">
              {label}
            </text>
          </g>
        );
      })}

      {/* Layer 2 — derived violation overlays. Critical = dashed 2px in
          --critical so it's unmistakable when overlaid on a worker box. */}
      {violations.map((v, i) => {
        const [x1,y1,x2,y2] = v.bbox;
        const sx = x1*scaleX, sy = y1*scaleY, sw = (x2-x1)*scaleX, sh = (y2-y1)*scaleY;
        const stroke = SEVERITY_STROKE[v.alert_level] ?? FALLBACK_STROKE;
        const isCritical = v.alert_level === "critical";
        const label = CLASS_LABELS[v.class] ?? v.class;
        const labelW = label.length * 6.5 + 10;
        // Place the violation chip below the bbox so it doesn't fight the
        // detection label above; clamp into the viewport.
        const labelY = Math.min(displayH - 18, sy + sh + 2);
        return (
          <g key={`v${i}`}>
            <rect x={sx-1} y={sy-1} width={sw+2} height={sh+2} fill="none"
              stroke={stroke}
              strokeWidth={isCritical ? 2 : 1.5}
              strokeDasharray={isCritical ? "6,4" : "4,3"}
              rx={2}
              className={isCritical ? "bbox-critical" : undefined} />
            <rect x={sx} y={labelY} width={labelW} height={18} fill={stroke} rx={2} />
            <text x={sx+5} y={labelY+13} fill="white" fontSize={11} fontWeight={600} className="font-sans">
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
