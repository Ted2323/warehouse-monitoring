# Claude Code brief — UI polish (phase 3)

## Goal

Add six visual-polish features on top of the existing dashboard so it *feels* like a live monitoring system. All features react to the **real** `/detect` data flow — no fake data, no scripted timers, no demo-mode endpoint. When a real violation arrives from the model, the dashboard pulses, toasts, animates, and updates the gauge accordingly.

This brief assumes phases 1 and 2 (`CLAUDE_CODE_CLASS_MIGRATION.md`, `CLAUDE_CODE_BUSINESS_RULES.md`) are merged. Do not touch ML logic — this is frontend-only.

---

## Six UI features to build

### 1. Pulsing critical bbox

Extend `frontend/components/BBoxOverlay.tsx`. For any detection whose corresponding violation has `alert_level: "critical"`, render the `<rect>` with a CSS keyframe that oscillates `stroke-opacity` between 0.4 and 1.0 every 700ms, and increase `stroke-width` from 1.5 to 2.5.

```css
@keyframes critical-pulse {
  0%, 100% { stroke-opacity: 0.4; }
  50%      { stroke-opacity: 1.0; }
}
.bbox-critical { animation: critical-pulse 0.7s ease-in-out infinite; }
```

Match a detection to a violation by bbox equality. Pass `criticalBboxes: Set<string>` (where each entry is `bbox.join(",")`) into `BBoxOverlay` from the dashboard. Non-critical detections keep their existing static stroke.

**Bonus:** add corner-bracket "lock-on" markers to every detection bbox (4 small L-shaped marks at the corners instead of a continuous rectangle). Looks like a sci-fi targeting reticle, ~20 lines of SVG. Skip if time is tight — the pulse alone carries the moment.

### 2. Toast notifications on new violations

```bash
cd frontend && npm install sonner
```

Mount `<Toaster position="top-right" richColors />` in `app/layout.tsx`.

In the dashboard component, keep a `Set<string>` of seen violation keys (`${class}:${bbox.join(",")}`); when a new `/detect` response contains a key not in that set, fire the appropriate toast and add the key.

```ts
import { toast } from "sonner";

if (v.alert_level === "critical") {
  toast.error(CLASS_LABELS[v.class] ?? v.class, {
    description: `Camera A · ${new Date().toLocaleTimeString()}`,
    duration: 5000,
  });
} else if (v.alert_level === "danger") {
  toast.warning(CLASS_LABELS[v.class] ?? v.class, { duration: 4000 });
}
```

`sonner`'s `richColors` will render danger amber and critical deep-red without custom theming. Important: prune the seen set on a sliding window (e.g., entries older than 30s) so the same violation re-firing later still toasts; otherwise the dashboard goes silent after the first occurrence.

### 3. Animated KPI counters

```bash
cd frontend && npm install framer-motion
```

New file `frontend/components/AnimatedNumber.tsx`:

```tsx
import { motion, useSpring, useTransform } from "framer-motion";
import { useEffect } from "react";

export function AnimatedNumber({ value }: { value: number }) {
  const spring = useSpring(value, { mass: 0.8, stiffness: 120, damping: 18 });
  const display = useTransform(spring, (v) => Math.round(v).toString());
  useEffect(() => { spring.set(value); }, [value, spring]);
  return <motion.span>{display}</motion.span>;
}
```

Apply to: `workers_total`, `workers_compliant`, `workers_partial`, `workers_unsafe`, `critical_count`, `forklifts_operating`, `pallets_filled`. Numbers will roll up smoothly instead of snapping when the next `/detect` poll arrives.

### 4. Compliance gauge (radial dial)

New file `frontend/components/ComplianceGauge.tsx`. Add a circular progress ring above the KPI tiles showing `workers_compliant / max(1, workers_total)` as a percentage. Use `recharts` `RadialBarChart` (already in your deps).

Color rules:
- ≥80% → `var(--success)`
- 50–79% → `var(--warning)`
- <50% → `var(--critical)`

Animate the fill transition over 800ms when the value changes (`isAnimationActive` is true by default in recharts, just confirm the duration). Display the percentage in the center using `<AnimatedNumber>` followed by a small `%` glyph.

Edge case: `workers_total === 0` → render gauge at 100% green with a faint "No workers in frame" sub-label so an empty floor doesn't show as 0% red.

### 5. Recording dot + live timestamp burn-in

In `VideoPlayer.tsx` (or wherever the camera image renders), absolutely position over the top-left corner of the video frame:

```tsx
<div className="absolute top-3 left-3 flex items-center gap-2 text-white text-xs font-mono">
  <span className="w-2 h-2 rounded-full bg-critical animate-pulse" />
  <span className="font-semibold tracking-wide">LIVE</span>
  <span className="ml-2 px-2 py-0.5 bg-black/60 rounded">
    {nowString} · CAM_A
  </span>
</div>
```

`nowString` updates every 500ms via a `useEffect` interval. The black semi-transparent chip behind the timestamp gives it the surveillance-footage look. Add a subtle 1px white/10% border around the entire video frame to reinforce the "monitoring station" aesthetic.

### 6. Mini-timeline strip

New file `frontend/components/Timeline.tsx`. A 60-second-wide horizontal SVG strip below the video frame. Each `/detect` response becomes a 4px-wide vertical tick, color-coded by max severity:
- no violations → `var(--success)`
- highest is warning → `var(--warning)`
- highest is danger → `var(--danger)`
- highest is critical → `var(--critical)`

Implementation: keep a ring buffer of the last 60 entries `{ t: number, maxSeverity: string }` in dashboard state, push a new entry every time `/detect` returns. Render as `<rect>` elements with `x = (now - entry.t) * pixelsPerSecond`. Use `framer-motion`'s `<AnimatePresence>` for fade-in/out.

This single component carries enormous demo weight because it visually conveys "continuous monitoring over time" in one glance. If your `/detect` polling interval is slower than 1Hz, the timeline will look sparse — note the cadence in the README so future-you knows to tune it.

---

## Files to change

| File | Change |
|---|---|
| `frontend/components/BBoxOverlay.tsx` | Critical-pulse animation, optional corner-bracket lock-on, accept `criticalBboxes` prop. |
| `frontend/components/VideoPlayer.tsx` | Recording dot + live timestamp burn-in, white frame border. |
| `frontend/components/AnimatedNumber.tsx` | New — framer-motion spring counter. |
| `frontend/components/ComplianceGauge.tsx` | New — recharts RadialBarChart with color tier logic. |
| `frontend/components/Timeline.tsx` | New — 60s horizontal SVG strip with ring-buffer state. |
| `frontend/app/dashboard/page.tsx` | Replace static numbers with `<AnimatedNumber>`. Mount `<ComplianceGauge>` and `<Timeline>`. Wire toast firing on new violations. Pass `criticalBboxes` set into `BBoxOverlay`. |
| `frontend/app/layout.tsx` | Mount `<Toaster position="top-right" richColors />`. |
| `frontend/app/globals.css` | Add `@keyframes critical-pulse` and `.bbox-critical` class. |
| `frontend/package.json` | Add `sonner`, `framer-motion`. |

**Do not create:** `/demo/sequence` endpoint, `demo_sequence.json` fixture, demo-mode controls, or any scripted-timing infrastructure. Real `/detect` data drives everything.

---

## Verification

1. `npx tsc --noEmit` in `frontend/` → exit 0.
2. `npm run dev` and visit `/dashboard`. Confirm:
   - LIVE dot pulses, timestamp updates each second, video frame has the white border.
   - Empty state (no detections): gauge at 100% green with "No workers in frame", all KPI counters at 0, timeline empty.
3. Hit the dashboard against the real mock backend (`cd ml && python server.py --mock` then refresh dashboard). Confirm:
   - The mock fixture's three workers, two violations, and one operating forklift render.
   - The `worker_unsafe` bbox pulses in critical red.
   - Two toasts fire on first load (one danger, one critical) — these correspond to the mock's two violations.
   - Compliance gauge reads 33% in critical color (1 compliant of 3 workers).
   - Timeline shows one critical-colored tick.
   - All KPI numbers animate from 0 to their final values on first load.
4. `pytest ml/tests` → still passing (this brief shouldn't have touched ML).
5. Visual smoke test: refresh the dashboard 3 times and confirm toasts fire each time (the seen-set sliding window resets across reloads, but a 30s prune within a single session also lets the same violation re-toast).

---

## Out of scope

- Audio cues / TTS.
- Demo-mode endpoint, scripted detection sequences, or any fake data plumbing — the user explicitly chose to keep this real-data-only for now.
- Acknowledge buttons / interactivity.
- Heatmap / dwell-time overlays.
- Mobile responsive layout.
- Real video file integration (the existing `VideoPlayer` rendering stays as-is; we only overlay the LIVE dot and timestamp on top).

---

## When you're done

Reply with:
1. `git diff --stat`.
2. A screenshot of the dashboard rendering the mock fixture, showing: pulsing critical bbox (annotate which one), compliance gauge in red at 33%, two toasts visible, timeline with the critical tick, animated counters at their final values, and the LIVE dot + timestamp in the video frame corner.
3. Any feature you couldn't get to within reasonable effort — flag, don't half-ship. (The corner-bracket lock-on in feature 1 is explicitly optional.)
