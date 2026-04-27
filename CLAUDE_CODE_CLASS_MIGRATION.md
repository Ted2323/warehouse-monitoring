# Claude Code brief — migrate to base-object class set

## Goal

Replace the current **stateful** class set with the **compositional** class set emitted by the new `best.pt`, and rewrite all downstream logic that depended on the stateful labels.

| Old (stateful, what code expects today) | New (compositional, what `best.pt` emits) |
|---|---|
| `worker_with_helmet`, `worker_no_helmet`, `worker_with_reflective`, `worker_no_reflective_vest` | `worker` |
| `pallet_filled`, `pallet_empty` | `pallet`, `box` |
| `forklift_with_boxes`, `forklift_no_carry` | `forklift`, `box` |

New `data.yaml` order (must match `best.pt` exactly):

```
0  worker
1  helmet
2  vest
3  pallet
4  box
5  forklift
```

The model no longer tells us PPE state or asset state directly. We now derive those facts from **bounding-box association** between detections in the same frame.

---

## Derivation rules (single source of truth)

Implement these once in `ml/classes.py` (or a sibling `ml/associate.py`) and call them from both `check_ppe_violations` and `summarize_inventory`:

1. **Worker has helmet** → there exists a `helmet` detection whose **center lies inside** that worker's bbox, *and* the helmet's bbox center is in the **upper third** of the worker's bbox (helmets are on heads, not feet — this kills false positives from a helmet on the floor next to a worker).
2. **Worker has vest** → there exists a `vest` detection whose **IoU with the worker bbox ≥ 0.15**, OR the vest's center lies inside the worker bbox. Vests cover the torso so simple containment is fine; IoU handles partial occlusion.
3. **Pallet is filled** → there exists at least one `box` detection whose **center lies inside** the pallet's bbox. Otherwise empty.
4. **Forklift is carrying** → there exists at least one `box` detection whose **bbox IoU with the forklift bbox ≥ 0.10**. Otherwise idle.

Helpers required (write them once, in Python):

```python
def bbox_center(b):  # b = [x1, y1, x2, y2]
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)

def point_in_bbox(px, py, b):
    return b[0] <= px <= b[2] and b[1] <= py <= b[3]

def iou(a, b):
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter = iw * ih
    if inter == 0: return 0.0
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return inter / (area_a + area_b - inter)
```

Mirror these in TypeScript in `frontend/lib/classes.ts` only if the frontend ever needs to recompute states client-side. Today it doesn't — the API returns fully-derived `inventory` and `violations` — so the TS side just needs the new class strings and labels.

---

## Files to change

### 1. `ml/classes.py` — full rewrite

```python
CLASS_NAMES = ["worker", "helmet", "vest", "pallet", "box", "forklift"]

WORKER_CLASS    = "worker"
HELMET_CLASS    = "helmet"
VEST_CLASS      = "vest"
PALLET_CLASS    = "pallet"
BOX_CLASS       = "box"
FORKLIFT_CLASS  = "forklift"

# Derived violation kinds (no longer model classes — they are computed states).
DERIVED_VIOLATIONS = {"worker_no_helmet", "worker_no_vest"}

VIOLATION_SEVERITY = {
    "worker_no_helmet": "danger",
    "worker_no_vest":   "warning",
}
```

Drop `PPE_VIOLATION_CLASSES`, `WORKER_CLASSES`, `PALLET_CLASSES`, `FORKLIFT_CLASSES` — nothing should reference them anymore. Update every importer to use the new names.

### 2. `ml/detect.py`

- Rewrite `check_ppe_violations(detections)` to:
  1. Filter workers, helmets, vests from `detections`.
  2. For each worker, run rules 1 & 2 above.
  3. If no helmet associated → emit `{"class": "worker_no_helmet", "bbox": worker_bbox, "confidence": worker_confidence, "alert_level": "danger"}`.
  4. If no vest associated → emit `{"class": "worker_no_vest", ...alert_level: "warning"}`.
  5. **Worker confidence threshold:** ignore workers with confidence < 0.30 to avoid spurious "no helmet" violations from phantom worker detections.
- Rewrite `summarize_inventory(detections)` to:
  - `pallets_filled` / `pallets_empty` from rule 3 over all `pallet` detections.
  - `forklifts_carrying` / `forklifts_idle` from rule 4 over all `forklift` detections.
  - `workers_total` = count of `worker` detections (above the same 0.30 threshold).
  - `workers_compliant` = workers with both helmet AND vest associated.
- Leave `check_violations` (zone violations) alone in shape, but note its `obj_class` will now be one of the new base classes — see DB migration below.
- Leave `run_inference` alone; the YOLO loader doesn't care about names.

### 3. `frontend/lib/classes.ts`

Mirror the new Python classes:

```ts
export const CLASS_NAMES = ["worker", "helmet", "vest", "pallet", "box", "forklift"] as const;
export type DetectionClass = (typeof CLASS_NAMES)[number];

// Derived violation classes — emitted by the backend, not by the model.
export const DERIVED_VIOLATION_CLASSES = new Set(["worker_no_helmet", "worker_no_vest"]);

export const VIOLATION_SEVERITY: Record<string, "info"|"warning"|"danger"> = {
  worker_no_helmet: "danger",
  worker_no_vest:   "warning",
};

export const CLASS_LABELS: Record<string, string> = {
  worker:           "Worker",
  helmet:           "Helmet",
  vest:             "Vest",
  pallet:           "Pallet",
  box:              "Box",
  forklift:         "Forklift",
  // Derived (server-emitted) violations:
  worker_no_helmet: "Worker · no helmet",
  worker_no_vest:   "Worker · no vest",
};

export function isPpeViolation(cls: string): boolean {
  return DERIVED_VIOLATION_CLASSES.has(cls);
}
```

Remove `PPE_VIOLATION_CLASSES`, `WORKER_CLASSES`, `PALLET_CLASSES`, `FORKLIFT_CLASSES`.

### 4. `frontend/components/BBoxOverlay.tsx`

Replace the `BBOX_STROKE` map keys with the new base classes:

```ts
const BBOX_STROKE: Record<string, string> = {
  worker:   "var(--success)",
  helmet:   "var(--success)",
  vest:     "var(--success)",
  pallet:   "var(--accent)",
  box:      "var(--accent)",
  forklift: "var(--warning)",
};
```

The `isPpeViolation` check still works — derived violations are tagged in the `violations` array, not in the raw `detections` overlay, so workers will render in `--success` and the violation badges/list elsewhere flag the no-helmet/no-vest cases. Confirm visual behavior by running the mock fixture once after changes.

### 5. `frontend/app/api/detect/route.ts`

Grep for any of the old class strings and update them. Most likely it just forwards JSON, but verify.

### 6. `database/schema.sql`

- Update the comment on line 24 (`object_class must match a value from ml/classes.py:CLASS_NAMES`) — still true, but the value set has changed.
- Update the seed `INSERT INTO warehouse_zones`:
  - Replace `'forklift_with_boxes'` with `'forklift'`.
  - Replace `'worker_no_helmet'` with `'worker'`. (Zones gate on the *base* class now; PPE-specific severity is handled by the derived violation, not by zones.)
- Update the `ppe_violation_events` view's `WHERE` clause:
  ```sql
  WHERE v->>'class' IN ('worker_no_helmet', 'worker_no_vest');
  ```
  (`worker_no_reflective_vest` → `worker_no_vest`.)
- Update inline comments referencing the old class names.

**Migration for existing data:** write a separate `database/migrations/2026-04-27_compositional_classes.sql` that:
1. Updates `warehouse_zones.object_class`: any of the four old `worker_*` values → `'worker'`; both `pallet_*` → `'pallet'`; both `forklift_*` → `'forklift'`.
2. Leaves `detection_logs` rows alone (historical) — but document that pre-migration logs use the old class strings and the dashboard will show them with the fallback stroke / unlabeled chip.
3. Drops and recreates `ppe_violation_events` with the new `WHERE` clause so it doesn't reference vanished string literals.

### 7. `ml/fixtures/mock_detection.json`

Regenerate so the mock returns base-class detections plus derived violations. Sketch:

```json
{
  "detections": [
    {"class": "worker",   "confidence": 0.91, "bbox": [120, 80, 220, 380], "cx": 170, "cy": 230},
    {"class": "helmet",   "confidence": 0.88, "bbox": [150, 85,  200, 130], "cx": 175, "cy": 107},
    {"class": "worker",   "confidence": 0.86, "bbox": [400, 90, 500, 390], "cx": 450, "cy": 240},
    {"class": "vest",     "confidence": 0.79, "bbox": [410, 180, 495, 290], "cx": 452, "cy": 235},
    {"class": "pallet",   "confidence": 0.83, "bbox": [600, 300, 750, 420], "cx": 675, "cy": 360},
    {"class": "box",      "confidence": 0.77, "bbox": [615, 310, 700, 390], "cx": 657, "cy": 350},
    {"class": "forklift", "confidence": 0.92, "bbox": [50, 280, 280, 470], "cx": 165, "cy": 375}
  ],
  "ppe_violations": [
    {"class": "worker_no_vest",   "bbox": [120, 80, 220, 380], "confidence": 0.91, "alert_level": "warning"},
    {"class": "worker_no_helmet", "bbox": [400, 90, 500, 390], "confidence": 0.86, "alert_level": "danger"}
  ],
  "zone_violations": [],
  "inventory": {
    "pallets_filled":     1,
    "pallets_empty":      0,
    "forklifts_carrying": 0,
    "forklifts_idle":     1,
    "workers_total":      2,
    "workers_compliant":  0
  },
  "total_objects": 7,
  "total_violations": 2
}
```

The fixture must round-trip through `summarize_inventory` and `check_ppe_violations` to *the same numbers*. Add a unit test asserting that.

### 8. `data/download_dataset.py`

If this script writes a `data.yaml`, update its `names:` list to the new six classes in the order shown at the top of this brief. If it references the old names anywhere else (folder mapping, label remap), update those too.

### 9. `README.md`

Find the section that lists the class set and replace with the new six. Document the derivation rules briefly so future-you doesn't think the model has regressed when "worker_no_helmet" doesn't appear in raw detections.

### 10. `CLAUDE_CODE_BRIEF.md`

If it documents the class set or the PPE-violation pipeline, update those sections to describe the compositional approach.

---

## Verification — do all of these before declaring done

1. `grep -rE 'worker_with_helmet|worker_no_helmet|worker_with_reflective|worker_no_reflective_vest|pallet_filled|pallet_empty|forklift_with_boxes|forklift_no_carry' --exclude-dir=node_modules --exclude-dir=.venv` returns **zero hits** outside this brief and any explicit migration script.
2. `cd ml && python -c "from classes import CLASS_NAMES; print(CLASS_NAMES)"` prints the new six in order.
3. Add `ml/tests/test_associate.py` with at least these cases:
   - Worker + helmet center in upper third of worker bbox → no `worker_no_helmet` violation.
   - Worker + helmet on the floor (center *below* worker bbox) → `worker_no_helmet` emitted.
   - Worker + vest with IoU 0.4 → no `worker_no_vest`.
   - Pallet with box center inside → `pallets_filled += 1`.
   - Forklift with box IoU 0.3 → `forklifts_carrying += 1`.
4. Run mock mode end-to-end: `cd ml && python server.py --mock` then `curl -H "Authorization: Bearer $DETECTION_SERVICE_TOKEN" -X POST localhost:8000/detect -d '{"image_url":"x","camera_id":"a0000000-0000-0000-0000-000000000001"}'` and confirm the response matches the fixture exactly.
5. Spin up the frontend and confirm:
   - Bounding boxes render with the new class colors.
   - Violation list shows "Worker · no helmet" / "Worker · no vest" labels.
   - Inventory tiles show non-zero counts for at least one mock category.
6. Apply the migration SQL in a Supabase branch (not prod), then `SELECT * FROM ppe_violation_events LIMIT 5;` should not error.

---

## Out of scope — do not change

- The `run_inference` function itself (model loading is class-agnostic).
- The Roboflow integration path (we may add `USE_ROBOFLOW` later — keep this PR focused on the local-`best.pt` path).
- RLS policies and auth.
- The CSS theme / design tokens.

---

## When you're done

Reply with:
1. The diff stats (`git diff --stat`).
2. Output of the grep in step 1 of Verification (should be empty).
3. The mock-mode curl response (paste verbatim).
4. Any class names from the new `best.pt` that you weren't sure how to map — flag them, don't guess.
