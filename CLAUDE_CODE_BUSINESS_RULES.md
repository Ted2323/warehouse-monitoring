# Claude Code brief — business rules + state derivation (phase 2)

## Goal

Add a server-side business-rules layer on top of the compositional class set established in `CLAUDE_CODE_CLASS_MIGRATION.md`. Three deliverables:

1. **Per-object state model** — every detected object gets a derived state (worker compliance, forklift operating-vs-idle, pallet filled-vs-empty).
2. **Violation taxonomy** — three mutually-exclusive worker violations, including the compound `worker_unsafe` case.
3. **`critical` severity tier** — new tier above `danger` for the compound case, plus DB and frontend support.

This brief assumes phase 1 (class migration) is already merged. Do not redo that work; build on top of it.

---

## 1. State derivation rules

All state derivation lives in `ml/associate.py` (extend the file from phase 1). State is computed once per `/detect` call and exposed in the response — the frontend should never re-derive it.

### Worker compliance state

For each `worker` detection (confidence ≥ 0.30):

| State | Condition |
|---|---|
| `compliant` | helmet associated AND vest associated |
| `partial` | exactly one of helmet / vest associated |
| `unsafe` | neither associated |

Helmet/vest association rules are unchanged from phase 1 (helmet center in upper third of worker bbox; vest IoU ≥ 0.15 OR vest center in worker bbox).

### Forklift operational state — REPLACES the cargo-based logic from phase 1

Phase 1 derived `forklifts_carrying` from forklift-vs-box IoU. **That's wrong.** Replace it with worker-presence:

| State | Condition | Counter field |
|---|---|---|
| `operating` | a `worker` detection is associated with the forklift (worker center inside forklift bbox OR worker-vs-forklift IoU ≥ 0.20) | `forklifts_operating` |
| `idle` | no worker associated | `forklifts_idle` |

**Migration note:** `forklifts_carrying` is a **rename + behavior change**, not a rename alone:
- The key in the `inventory` JSON changes from `forklifts_carrying` to `forklifts_operating`.
- The derivation function changes from box-IoU to worker-association.
- Drop the cargo-based logic entirely. We are not tracking forklift cargo state in this phase.
- Update the mock fixture, tests, frontend, and DB comment that currently say `forklifts_carrying`.

### Pallet state — unchanged from phase 1

| State | Condition | Counter field |
|---|---|---|
| `filled` | a `box` center sits inside the pallet bbox | `pallets_filled` |
| `empty` | no box inside | `pallets_empty` |

Keep the existing implementation.

### Helper to add to `ml/associate.py`

```python
def associate_forklift_with_worker(forklift_bbox, workers, iou_threshold=0.20):
    """Returns the worker dict that is operating this forklift, or None."""
    fx1, fy1, fx2, fy2 = forklift_bbox
    for w in workers:
        wcx, wcy = w["cx"], w["cy"]
        if fx1 <= wcx <= fx2 and fy1 <= wcy <= fy2:
            return w
        if iou(forklift_bbox, w["bbox"]) >= iou_threshold:
            return w
    return None
```

---

## 2. Violation taxonomy — mutually exclusive, one per worker

Replace the current `check_ppe_violations` body with this precedence chain. **Critical:** a worker emits exactly ONE violation entry, never two. This keeps `total_violations` honest as "count of unsafe workers" rather than "count of PPE failures across workers × items".

```python
def check_ppe_violations(detections):
    workers  = [d for d in detections if d["class"] == "worker"   and d["confidence"] >= 0.30]
    helmets  = [d for d in detections if d["class"] == "helmet"]
    vests    = [d for d in detections if d["class"] == "vest"]

    out = []
    for w in workers:
        has_helmet = any(associate_helmet(w, h) for h in helmets)
        has_vest   = any(associate_vest(w, v)   for v in vests)

        if not has_helmet and not has_vest:
            out.append(_violation("worker_unsafe", w, "critical"))
        elif not has_helmet:
            out.append(_violation("worker_no_helmet", w, "danger"))
        elif not has_vest:
            out.append(_violation("worker_no_vest", w, "danger"))   # upgraded from warning
        # compliant → no emission
    return out

def _violation(cls, worker, level):
    return {
        "class":       cls,
        "bbox":        worker["bbox"],
        "confidence":  worker["confidence"],
        "alert_level": level,
    }
```

Update `ml/classes.py`:

```python
DERIVED_VIOLATIONS = {"worker_no_helmet", "worker_no_vest", "worker_unsafe"}

VIOLATION_SEVERITY = {
    "worker_no_helmet": "danger",
    "worker_no_vest":   "danger",   # upgraded
    "worker_unsafe":    "critical", # new tier
}
```

Mirror in `frontend/lib/classes.ts`:

```ts
export const DERIVED_VIOLATION_CLASSES = new Set([
  "worker_no_helmet", "worker_no_vest", "worker_unsafe",
]);

export const VIOLATION_SEVERITY: Record<string, "info"|"warning"|"danger"|"critical"> = {
  worker_no_helmet: "danger",
  worker_no_vest:   "danger",
  worker_unsafe:    "critical",
};

export const CLASS_LABELS: Record<string, string> = {
  // ...existing entries...
  worker_no_helmet: "Worker · no helmet",
  worker_no_vest:   "Worker · no vest",
  worker_unsafe:    "Worker · no PPE",   // new
};
```

---

## 3. New severity tier: `critical`

### DB migration — new file `database/migrations/2026-04-27_critical_severity.sql`

```sql
-- Allow 'critical' as a fourth alert level.
ALTER TABLE warehouse_zones
    DROP CONSTRAINT IF EXISTS warehouse_zones_alert_level_check;
ALTER TABLE warehouse_zones
    ADD CONSTRAINT warehouse_zones_alert_level_check
    CHECK (alert_level IN ('info', 'warning', 'danger', 'critical'));

-- Refresh the PPE violation view to include worker_unsafe.
CREATE OR REPLACE VIEW ppe_violation_events AS
SELECT
    l.id            AS log_id,
    l.camera_id,
    l.detected_at,
    l.image_url,
    v->>'class'                AS violation_class,
    v->>'alert_level'          AS alert_level,
    (v->>'confidence')::float  AS confidence,
    v->'bbox'                  AS bbox
FROM detection_logs l,
     jsonb_array_elements(l.violations) v
WHERE v->>'class' IN ('worker_no_helmet', 'worker_no_vest', 'worker_unsafe');
```

Also update `database/schema.sql` so a fresh setup uses the same constraint and view definition (don't leave it inconsistent with the migration).

### Frontend — `globals.css` (or wherever your design tokens live)

Add a `--critical` token. Pick a deeper red than `--danger` so they're visually distinct in the alert feed:

```css
:root {
  --critical: #B00020;        /* deeper than --danger */
  --critical-bg: #B0002022;   /* low-alpha for badges */
}
```

### Frontend — `BBoxOverlay.tsx`

Extend `BBOX_STROKE` and add a stroke style for derived violation overlays. The raw model classes (`worker`, etc.) keep their existing colors; only when the dashboard renders the **violations layer** (separate from raw detections) do we use severity colors. Make sure `worker_unsafe` bboxes pulse or use a dashed stroke at 2px to be unmistakable.

```ts
const SEVERITY_STROKE: Record<string, string> = {
  info:     "var(--fg-muted)",
  warning:  "var(--warning)",
  danger:   "var(--danger)",
  critical: "var(--critical)",
};
```

### Frontend — anywhere severity is rendered as a chip/badge

Grep for `alert_level` and `VIOLATION_SEVERITY` usage in `frontend/`. Each badge component needs a `critical` branch with the new color and ideally an icon (an octagon/hazard symbol works well).

---

## 4. Response shape additions

Extend the `/detect` response with a `compliance_summary` block. The existing `inventory` block stays for backward compatibility but `forklifts_carrying` is renamed to `forklifts_operating`.

```json
{
  "detections": [...],
  "ppe_violations": [...],
  "zone_violations": [...],
  "inventory": {
    "pallets_filled":      1,
    "pallets_empty":       0,
    "forklifts_operating": 1,
    "forklifts_idle":      0,
    "workers_total":       3,
    "workers_compliant":   1
  },
  "compliance_summary": {
    "workers_total":     3,
    "workers_compliant": 1,
    "workers_partial":   1,
    "workers_unsafe":    1,
    "critical_count":    1,
    "danger_count":      1,
    "warning_count":     0
  },
  "total_objects":    8,
  "total_violations": 2
}
```

Implementation:

```python
def summarize_compliance(detections, ppe_violations):
    workers = [d for d in detections if d["class"] == "worker" and d["confidence"] >= 0.30]
    by_severity = {"critical": 0, "danger": 0, "warning": 0}
    by_state    = {"compliant": 0, "partial": 0, "unsafe": 0}
    for v in ppe_violations:
        by_severity[v["alert_level"]] = by_severity.get(v["alert_level"], 0) + 1
        if v["class"] == "worker_unsafe":
            by_state["unsafe"] += 1
        else:
            by_state["partial"] += 1
    by_state["compliant"] = max(0, len(workers) - by_state["unsafe"] - by_state["partial"])
    return {
        "workers_total":     len(workers),
        "workers_compliant": by_state["compliant"],
        "workers_partial":   by_state["partial"],
        "workers_unsafe":    by_state["unsafe"],
        "critical_count":    by_severity["critical"],
        "danger_count":      by_severity["danger"],
        "warning_count":     by_severity["warning"],
    }
```

Wire it in `analyze_image` and the `/detect` route handler. Persist `compliance_summary` either inside the existing `inventory` JSONB column (cheapest) or as a new column — your call, but if you keep it inside `inventory`, update the schema comment in `database/schema.sql`.

---

## 5. Files to change

| File | Change |
|---|---|
| `ml/associate.py` | Add `associate_forklift_with_worker`. |
| `ml/detect.py` | Rewrite `check_ppe_violations` (precedence chain, three-way emit). Rewrite forklift counters to use worker association. Add `summarize_compliance`. Wire it into `analyze_image`. |
| `ml/classes.py` | Add `worker_unsafe` to `DERIVED_VIOLATIONS`. Update `VIOLATION_SEVERITY` (add `worker_unsafe: critical`, change `worker_no_vest` to `danger`). |
| `ml/server.py` | Include `compliance_summary` in the `/detect` JSON response. |
| `ml/fixtures/mock_detection.json` | Add a third worker that has neither helmet nor vest, so the fixture exercises all three violation tiers. Update `inventory.forklifts_operating`. Add `compliance_summary`. |
| `ml/tests/test_associate.py` | Add cases: worker missing both → exactly one `worker_unsafe` (not two violations). Forklift with worker center inside → `operating`. Forklift alone → `idle`. Compliance summary numbers add up to `workers_total`. |
| `frontend/lib/classes.ts` | Add `worker_unsafe` to violations set + labels. Update severity map. Add `"critical"` to the `AlertLevel` type. |
| `frontend/components/BBoxOverlay.tsx` | Severity-driven stroke for derived violations. Critical = dashed 2px in `--critical`. |
| `frontend/app/api/detect/route.ts` | Forward `compliance_summary` through to the dashboard if it currently strips/reshapes the response. |
| Frontend dashboard / alert feed components | Add `critical` rendering everywhere severity is shown. Grep for `'danger'` and `'warning'` literals — each chip / icon / sort-key likely needs a `critical` branch. |
| `database/schema.sql` | Update `warehouse_zones_alert_level_check` to allow `'critical'`. Update the `ppe_violation_events` view's `WHERE` clause to include `worker_unsafe`. Update the `inventory` schema comment to mention `compliance_summary` and the renamed `forklifts_operating`. |
| `database/migrations/2026-04-27_critical_severity.sql` | New file — see SQL above. |
| `README.md` | Document the violation taxonomy table and the four severity tiers. |
| `CLAUDE_CODE_BRIEF.md` (project-level) | Update the violation/severity sections to match. |

---

## 6. Verification — do all of these before declaring done

1. `pytest ml/tests` — all phase-1 tests still pass, plus the new ones for `worker_unsafe`, forklift operating/idle, and compliance_summary arithmetic.
2. Mock-mode round-trip:
   ```bash
   cd ml && python server.py --mock &
   curl -H "Authorization: Bearer $DETECTION_SERVICE_TOKEN" -X POST localhost:8000/detect \
        -H "Content-Type: application/json" \
        -d '{"image_url":"x","camera_id":"a0000000-0000-0000-0000-000000000001"}'
   ```
   Confirm the response contains `compliance_summary` with `workers_unsafe ≥ 1` and `critical_count ≥ 1`. Confirm `inventory.forklifts_operating` exists and `inventory.forklifts_carrying` does NOT.
3. Apply the migration in a Supabase **branch** (not prod). `SELECT * FROM ppe_violation_events WHERE alert_level='critical' LIMIT 5;` should not error and should match what the mock would have inserted.
4. `npx tsc --noEmit` in `frontend/` → exit 0.
5. Run the dashboard against the mock backend and confirm:
   - A `worker_unsafe` detection renders with the new `--critical` color and is visually distinct from `danger` items.
   - The compliance summary tiles show the correct counts (3 workers, 1 compliant, 1 partial, 1 unsafe — based on the updated fixture).
   - Forklift count tile reads "operating" not "carrying".
6. Grep verification — no leftover references to the renamed key:
   ```bash
   grep -rE 'forklifts_carrying|forklift_with_boxes|forklift_no_carry' \
        --exclude-dir=node_modules --exclude-dir=.venv --exclude-dir=.git \
        --exclude-dir=migrations --exclude-dir=dataset \
        --exclude=CLAUDE_CODE_CLASS_MIGRATION.md --exclude=CLAUDE_CODE_BUSINESS_RULES.md
   ```
   Should return zero hits.

---

## Out of scope — do not change

- Proximity escalation between workers and forklifts (we explicitly chose the per-worker-only path).
- Zone-aware severity escalation.
- Forklift cargo tracking (boxes-on-forklift). If the warehouse later needs this, add it as a separate metric, not as a state.
- Multi-frame violation tracking (each `/detect` call remains stateless).
- The Roboflow integration toggle.

---

## When you're done

Reply with:
1. `git diff --stat` for files this brief touched.
2. The mock `/detect` response (verbatim) showing all three violation types appearing across the fixture.
3. Output of the grep in step 6 of Verification (should be empty).
4. Screenshot or DOM dump of one critical-tier badge on the dashboard so we can confirm it visually breaks out of the danger/warning bucket.
