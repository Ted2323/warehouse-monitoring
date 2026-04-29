"""
STEP 4 — DETECTION ENGINE
Runs YOLOv8 inference, classification-driven PPE violation checks, and
zone-violation checks (secondary signal). Called by the Next.js API route via
subprocess or deployed as a FastAPI service (see server.py).
"""

import os
import sys
import json
from pathlib import Path
from typing import Optional

try:
    # Loaded as part of the `ml` package (Docker / Render: `uvicorn ml.server:app`).
    from .classes import (
        CLASS_NAMES,
        WORKER_CLASS,
        HELMET_CLASS,
        VEST_CLASS,
        PALLET_CLASS,
        BOX_CLASS,
        FORKLIFT_CLASS,
        VIOLATION_SEVERITY,
    )
    from .associate import (
        worker_has_helmet,
        worker_has_vest,
        pallet_is_filled,
        forklift_is_operating,
    )
except ImportError:
    # Loaded as a top-level module (local `cd ml && python detect.py ...`).
    from classes import (  # type: ignore[no-redef]
        CLASS_NAMES,
        WORKER_CLASS,
        HELMET_CLASS,
        VEST_CLASS,
        PALLET_CLASS,
        BOX_CLASS,
        FORKLIFT_CLASS,
        VIOLATION_SEVERITY,
    )
    from associate import (  # type: ignore[no-redef]
        worker_has_helmet,
        worker_has_vest,
        pallet_is_filled,
        forklift_is_operating,
    )


# Workers below this confidence are dropped before association — phantom
# worker detections would otherwise spawn spurious "no helmet" violations.
# Mirrors frontend MIN_CONFIDENCE (lib/classes.ts): a violation we wouldn't
# render shouldn't be derived in the first place.
WORKER_CONF_THRESHOLD = 0.50


# ─── INSTALL DEPS IF NEEDED ─────────────────────────────────
def ensure_deps():
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install",
                           "ultralytics", "pillow", "shapely", "supabase", "-q"])


# ─── ZONE CHECKER ────────────────────────────────────────────
def point_in_polygon(cx: float, cy: float, polygon: list) -> bool:
    """Ray-casting algorithm — checks if (cx, cy) is inside polygon."""
    n = len(polygon)
    inside = False
    px, py = cx, cy
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi + 1e-9) + xi):
            inside = not inside
        j = i
    return inside


def check_violations(detections: list, zones: list) -> list:
    """
    Zone-based violations (secondary signal). Only fires when the detection's
    class matches a zone's `object_class` and the zone is RESTRICTED.
    Works with the new class set; if no zones reference these classes, returns [].
    """
    violations = []

    for det in detections:
        obj_class = det["class"]
        cx, cy = det["cx"], det["cy"]

        for zone in zones:
            if not zone["is_active"]:
                continue
            if zone["object_class"] != obj_class:
                continue
            if zone["rule_type"] != "RESTRICTED":
                continue

            polygon = zone["polygon"]
            if isinstance(polygon, str):
                polygon = json.loads(polygon)

            if point_in_polygon(cx, cy, polygon):
                violations.append({
                    "class":       obj_class,
                    "zone_id":     zone["id"],
                    "zone_name":   zone["zone_name"],
                    "alert_level": zone["alert_level"],
                    "bbox":        det["bbox"],
                    "confidence":  det["confidence"],
                })

    return violations


# ─── PPE VIOLATION CHECK (association-driven, mutually exclusive) ────
def _violation(cls: str, worker: dict, level: str) -> dict:
    return {
        "class":       cls,
        "bbox":        worker["bbox"],
        "confidence":  worker["confidence"],
        "alert_level": level,
    }


def check_ppe_violations(detections: list) -> list:
    """
    Derive PPE violations from bbox association. The model emits base classes
    only; compliance state comes from whether a helmet / vest is associated
    with each worker bbox (see ml/associate.py for the rules).

    Phase-2 precedence chain — each worker emits AT MOST ONE entry:
      - missing both helmet and vest → worker_unsafe   (critical)
      - missing helmet only          → worker_no_helmet (danger)
      - missing vest only            → worker_no_vest  (danger)
      - has both                     → no emission (compliant)

    This keeps `total_violations` honest as the count of unsafe workers, not
    the count of PPE failures across workers × items.

    Workers below WORKER_CONF_THRESHOLD are dropped before association.
    """
    workers = [d for d in detections
               if d["class"] == WORKER_CLASS
               and d["confidence"] >= WORKER_CONF_THRESHOLD]
    helmets = [d for d in detections if d["class"] == HELMET_CLASS]
    vests   = [d for d in detections if d["class"] == VEST_CLASS]

    out = []
    for w in workers:
        has_helmet = worker_has_helmet(w["bbox"], helmets)
        has_vest   = worker_has_vest(w["bbox"], vests)

        if not has_helmet and not has_vest:
            out.append(_violation("worker_unsafe",    w, VIOLATION_SEVERITY["worker_unsafe"]))
        elif not has_helmet:
            out.append(_violation("worker_no_helmet", w, VIOLATION_SEVERITY["worker_no_helmet"]))
        elif not has_vest:
            out.append(_violation("worker_no_vest",   w, VIOLATION_SEVERITY["worker_no_vest"]))
        # else: compliant — no emission
    return out


# ─── INVENTORY / TELEMETRY SUMMARY ───────────────────────────
def summarize_inventory(detections: list) -> dict:
    """
    Aggregate state/telemetry from base-class detections via association.
      - pallets_filled / pallets_empty: based on whether a box's center lies
        inside the pallet's bbox.
      - forklifts_operating / forklifts_idle: based on whether a worker is
        associated with the forklift (phase-2 — replaces the box-IoU rule).
      - workers_total: count of workers above WORKER_CONF_THRESHOLD.
      - workers_compliant: workers with both a helmet AND a vest associated.
    """
    workers   = [d for d in detections
                 if d["class"] == WORKER_CLASS
                 and d["confidence"] >= WORKER_CONF_THRESHOLD]
    helmets   = [d for d in detections if d["class"] == HELMET_CLASS]
    vests     = [d for d in detections if d["class"] == VEST_CLASS]
    pallets   = [d for d in detections if d["class"] == PALLET_CLASS]
    boxes     = [d for d in detections if d["class"] == BOX_CLASS]
    forklifts = [d for d in detections if d["class"] == FORKLIFT_CLASS]

    pallets_filled = sum(1 for p in pallets if pallet_is_filled(p["bbox"], boxes))
    pallets_empty  = len(pallets) - pallets_filled

    forklifts_operating = sum(1 for f in forklifts if forklift_is_operating(f["bbox"], workers))
    forklifts_idle      = len(forklifts) - forklifts_operating

    workers_compliant = sum(
        1 for w in workers
        if worker_has_helmet(w["bbox"], helmets) and worker_has_vest(w["bbox"], vests)
    )

    return {
        "pallets_filled":      pallets_filled,
        "pallets_empty":       pallets_empty,
        "forklifts_operating": forklifts_operating,
        "forklifts_idle":      forklifts_idle,
        "workers_total":       len(workers),
        "workers_compliant":   workers_compliant,
    }


# ─── COMPLIANCE SUMMARY ──────────────────────────────────────
def summarize_compliance(detections: list, ppe_violations: list) -> dict:
    """
    Roll-up of worker compliance and severity counts. Designed to feed the
    dashboard's KPI tiles directly. Counts are derived from `ppe_violations`
    so they stay consistent with the precedence chain in
    `check_ppe_violations` (one entry per worker).

    Output:
      workers_total / workers_compliant / workers_partial / workers_unsafe
      critical_count / danger_count / warning_count
    """
    workers = [d for d in detections
               if d["class"] == WORKER_CLASS
               and d["confidence"] >= WORKER_CONF_THRESHOLD]

    by_severity = {"critical": 0, "danger": 0, "warning": 0, "info": 0}
    workers_unsafe  = 0
    workers_partial = 0
    for v in ppe_violations:
        level = v.get("alert_level", "warning")
        by_severity[level] = by_severity.get(level, 0) + 1
        if v["class"] == "worker_unsafe":
            workers_unsafe += 1
        else:
            workers_partial += 1

    workers_compliant = max(0, len(workers) - workers_unsafe - workers_partial)

    return {
        "workers_total":     len(workers),
        "workers_compliant": workers_compliant,
        "workers_partial":   workers_partial,
        "workers_unsafe":    workers_unsafe,
        "critical_count":    by_severity["critical"],
        "danger_count":      by_severity["danger"],
        "warning_count":     by_severity["warning"],
    }


# ─── YOLO INFERENCE ──────────────────────────────────────────
# Default confidence threshold. Ultralytics' default is 0.25, which is fine
# for a model with mAP > 0.7 but filters out too much from a model with
# modest accuracy (≤0.5). DETECT_CONF env var lets us tune in production
# without a code change.
DETECT_CONF = float(os.environ.get("DETECT_CONF", "0.10"))


# Module-level YOLO cache — instantiating YOLO() costs 3-10s on CPU torch
# (the wheel we ship on Render free tier), so reusing one model across
# requests turns the per-request cost from "model load + inference" into
# just inference. server.py warms this at startup so the first /detect
# after a cold boot doesn't have to pay the load cost while Vercel's
# 60s budget ticks down.
_MODEL_CACHE: dict = {}

def load_model(model_path: str = "./best.pt"):
    """Load (or return cached) YOLO model for `model_path`."""
    cached = _MODEL_CACHE.get(model_path)
    if cached is not None:
        return cached
    from ultralytics import YOLO
    model = YOLO(model_path)
    _MODEL_CACHE[model_path] = model
    return model


def run_inference(image_path: str, model_path: str = "./best.pt",
                  conf: Optional[float] = None) -> list:
    model = load_model(model_path)
    results = model(image_path, verbose=False, conf=conf or DETECT_CONF)[0]

    detections = []
    for box in results.boxes:
        x1, y1, x2, y2 = box.xyxy[0].tolist()
        cls_id = int(box.cls[0])
        conf   = float(box.conf[0])
        label  = results.names[cls_id]

        detections.append({
            "class":      label,
            "confidence": round(conf, 4),
            "bbox":       [round(x1), round(y1), round(x2), round(y2)],
            "cx":         round((x1 + x2) / 2),
            "cy":         round((y1 + y2) / 2),
        })

    return detections


# ─── SUPABASE INTEGRATION ────────────────────────────────────
def get_zones(camera_id: str) -> list:
    from supabase import create_client

    url = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    sb  = create_client(url, key)

    res = sb.table("warehouse_zones") \
            .select("*") \
            .eq("camera_id", camera_id) \
            .eq("is_active", True) \
            .execute()

    return res.data


def save_detection_log(camera_id: str, image_url: str,
                       detections: list,
                       ppe_violations: list,
                       zone_violations: list,
                       inventory: dict,
                       compliance_summary: Optional[dict] = None):
    from supabase import create_client

    url = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    sb  = create_client(url, key)

    all_violations = ppe_violations + zone_violations

    # Phase-2: persist compliance_summary inside the existing inventory JSONB
    # so we don't need a schema migration to add a column. The /detect API
    # response keeps it at top level for ergonomic consumers (see brief §4).
    inventory_with_summary = dict(inventory)
    if compliance_summary is not None:
        inventory_with_summary["compliance_summary"] = compliance_summary

    sb.table("detection_logs").insert({
        "camera_id":        camera_id,
        "image_url":        image_url,
        "detections":       detections,
        "violations":       all_violations,
        "inventory":        inventory_with_summary,
        "total_objects":    len(detections),
        "total_violations": len(all_violations),
    }).execute()


# ─── MAIN PIPELINE ───────────────────────────────────────────
def analyze_image(image_path: str, camera_id: str,
                  model_path: str = "./best.pt",
                  image_url:  str = "") -> dict:
    """
    Full pipeline: YOLO inference → PPE check → zone check → log to Supabase.
    Returns result dict with the new shape (additive).
    """
    print(f"🔍 Analyzing: {image_path}")

    # 1. Run YOLOv8
    detections = run_inference(image_path, model_path)
    print(f"   Detected {len(detections)} objects")

    # 2. Classification-driven PPE violations (primary)
    ppe_violations = check_ppe_violations(detections)
    print(f"   Found {len(ppe_violations)} PPE violations")

    # 3. Inventory / telemetry summary
    inventory = summarize_inventory(detections)

    # 4. Zone violations (secondary signal — only if zones exist)
    zones = get_zones(camera_id)
    print(f"   Loaded {len(zones)} zones for camera {camera_id}")
    zone_violations = check_violations(detections, zones)
    print(f"   Found {len(zone_violations)} zone violations")

    # 5. Compliance summary — derived from PPE violations only (zone violations
    # have their own severity but don't represent worker-PPE state).
    compliance_summary = summarize_compliance(detections, ppe_violations)

    for v in ppe_violations:
        level_icon = {"critical": "🛑", "danger": "🚨", "warning": "⚠️", "info": "ℹ️"}.get(v["alert_level"], "⚠️")
        print(f"   {level_icon} [PPE/{v['alert_level'].upper()}] {v['class']}")
    for v in zone_violations:
        level_icon = {"critical": "🛑", "danger": "🚨", "warning": "⚠️", "info": "ℹ️"}.get(v["alert_level"], "⚠️")
        print(f"   {level_icon} [ZONE/{v['alert_level'].upper()}] {v['class']} in {v['zone_name']}")

    # 6. Persist
    save_detection_log(
        camera_id, image_url,
        detections, ppe_violations, zone_violations, inventory,
        compliance_summary=compliance_summary,
    )

    return {
        "detections":         detections,
        "ppe_violations":     ppe_violations,
        "zone_violations":    zone_violations,
        "inventory":          inventory,
        "compliance_summary": compliance_summary,
        "total_objects":      len(detections),
        "total_violations":   len(ppe_violations) + len(zone_violations),
    }


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Warehouse Layout Monitor — Detection Engine")
    parser.add_argument("--image",     required=True,  help="Path to image file")
    parser.add_argument("--camera_id", required=True,  help="Camera UUID from Supabase")
    parser.add_argument("--model",     default="./best.pt", help="Path to best.pt")
    args = parser.parse_args()

    result = analyze_image(args.image, args.camera_id, args.model)
    print("\n📦 Result JSON:")
    print(json.dumps(result, indent=2))
