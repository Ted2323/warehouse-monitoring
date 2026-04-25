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
        PPE_VIOLATION_CLASSES,
        WORKER_CLASSES,
        PALLET_CLASSES,
        FORKLIFT_CLASSES,
        VIOLATION_SEVERITY,
    )
except ImportError:
    # Loaded as a top-level module (local `cd ml && python detect.py ...`).
    from classes import (  # type: ignore[no-redef]
        CLASS_NAMES,
        PPE_VIOLATION_CLASSES,
        WORKER_CLASSES,
        PALLET_CLASSES,
        FORKLIFT_CLASSES,
        VIOLATION_SEVERITY,
    )


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


# ─── PPE VIOLATION CHECK (classification-driven) ─────────────
def check_ppe_violations(detections: list) -> list:
    """
    Returns one violation dict per detection whose class is a PPE violation
    class (e.g. worker_no_helmet, worker_no_reflective_vest). No polygon
    required — the class itself encodes the violation.
    """
    out = []
    for det in detections:
        cls = det["class"]
        if cls in PPE_VIOLATION_CLASSES:
            out.append({
                "class":       cls,
                "bbox":        det["bbox"],
                "confidence":  det["confidence"],
                "alert_level": VIOLATION_SEVERITY[cls],
            })
    return out


# ─── INVENTORY / TELEMETRY SUMMARY ───────────────────────────
def summarize_inventory(detections: list) -> dict:
    """
    Aggregate state/telemetry counters from class detections. Pallet and
    forklift sub-classes are *state*, not violations.
    """
    counts = {c: 0 for c in CLASS_NAMES}
    for det in detections:
        cls = det["class"]
        if cls in counts:
            counts[cls] += 1

    with_helmet     = counts["worker_with_helmet"]
    no_helmet       = counts["worker_no_helmet"]
    with_reflective = counts["worker_with_reflective"]
    no_reflective   = counts["worker_no_reflective_vest"]

    workers_total = with_helmet + no_helmet + with_reflective + no_reflective

    # TODO: associate per-worker — model emits per-attribute classes, so a
    # single worker may be detected as both `worker_with_helmet` AND
    # `worker_with_reflective`. Until we have a tracker that fuses both
    # attributes onto one identity, we approximate "fully compliant" as the
    # min of the two compliant counts.
    workers_compliant = min(with_helmet, with_reflective)

    return {
        "pallets_filled":     counts["pallet_filled"],
        "pallets_empty":      counts["pallet_empty"],
        "forklifts_carrying": counts["forklift_with_boxes"],
        "forklifts_idle":     counts["forklift_no_carry"],
        "workers_total":      workers_total,
        "workers_compliant":  workers_compliant,
    }


# ─── YOLO INFERENCE ──────────────────────────────────────────
# Default confidence threshold. Ultralytics' default is 0.25, which is fine
# for a model with mAP > 0.7 but filters out too much from a model with
# modest accuracy (≤0.5). DETECT_CONF env var lets us tune in production
# without a code change.
DETECT_CONF = float(os.environ.get("DETECT_CONF", "0.10"))


def run_inference(image_path: str, model_path: str = "./best.pt",
                  conf: Optional[float] = None) -> list:
    from ultralytics import YOLO

    model = YOLO(model_path)
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
                       inventory: dict):
    from supabase import create_client

    url = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    sb  = create_client(url, key)

    all_violations = ppe_violations + zone_violations

    sb.table("detection_logs").insert({
        "camera_id":        camera_id,
        "image_url":        image_url,
        "detections":       detections,
        "violations":       all_violations,
        "inventory":        inventory,
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

    for v in ppe_violations:
        level_icon = {"danger": "🚨", "warning": "⚠️", "info": "ℹ️"}.get(v["alert_level"], "⚠️")
        print(f"   {level_icon} [PPE/{v['alert_level'].upper()}] {v['class']}")
    for v in zone_violations:
        level_icon = {"danger": "🚨", "warning": "⚠️", "info": "ℹ️"}.get(v["alert_level"], "⚠️")
        print(f"   {level_icon} [ZONE/{v['alert_level'].upper()}] {v['class']} in {v['zone_name']}")

    # 5. Persist
    save_detection_log(
        camera_id, image_url,
        detections, ppe_violations, zone_violations, inventory,
    )

    return {
        "detections":       detections,
        "ppe_violations":   ppe_violations,
        "zone_violations":  zone_violations,
        "inventory":        inventory,
        "total_objects":    len(detections),
        "total_violations": len(ppe_violations) + len(zone_violations),
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
