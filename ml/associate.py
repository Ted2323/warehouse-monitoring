"""Bbox association — single source of truth for compositional state derivation.

The detection model emits base classes only (worker, helmet, vest, pallet, box,
forklift). It does not tell us whether a worker is wearing a helmet, whether a
pallet is filled, or whether a forklift is carrying — those facts come from
bbox association between detections in the same frame.

Both `check_ppe_violations` and `summarize_inventory` in ml/detect.py call into
this module so the rules live in exactly one place.

Rules
-----
1. Worker has helmet     — helmet center inside worker bbox AND in the upper
                            third of the worker bbox (helmets sit on heads, not
                            feet — kills false positives from helmets on the
                            floor next to a worker).
2. Worker has vest       — vest IoU with worker bbox >= 0.15 OR vest center
                            inside worker bbox. Vests cover the torso so simple
                            containment is enough; IoU handles partial occlusion.
3. Pallet is filled      — at least one box detection has its center inside the
                            pallet's bbox.
4. Forklift is operating — a worker detection is associated with the forklift
                            (worker center inside forklift bbox OR worker bbox
                            IoU >= 0.20 with forklift bbox). Phase-2 change:
                            replaces the phase-1 box-IoU "carrying" rule —
                            see CLAUDE_CODE_BUSINESS_RULES.md §1.
"""

# Tunable thresholds — keep close to the rules so they're easy to find.
VEST_IOU_THRESHOLD              = 0.15
FORKLIFT_WORKER_IOU_THRESHOLD   = 0.20
HELMET_UPPER_FRACTION           = 1 / 3


def bbox_center(b):
    """b = [x1, y1, x2, y2]"""
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def point_in_bbox(px, py, b):
    return b[0] <= px <= b[2] and b[1] <= py <= b[3]


def iou(a, b):
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter = iw * ih
    if inter == 0:
        return 0.0
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return inter / (area_a + area_b - inter)


# ─── PER-OBJECT ASSOCIATION ──────────────────────────────────
def worker_has_helmet(worker_bbox, helmets):
    """True if any helmet's center is inside worker bbox AND above the
    upper-third line of the worker bbox."""
    x1, y1, x2, y2 = worker_bbox
    upper_third_y = y1 + (y2 - y1) * HELMET_UPPER_FRACTION
    for h in helmets:
        cx, cy = bbox_center(h["bbox"])
        if point_in_bbox(cx, cy, worker_bbox) and cy <= upper_third_y:
            return True
    return False


def worker_has_vest(worker_bbox, vests):
    """True if any vest passes the IoU threshold OR has its center inside
    the worker bbox."""
    for v in vests:
        if iou(v["bbox"], worker_bbox) >= VEST_IOU_THRESHOLD:
            return True
        cx, cy = bbox_center(v["bbox"])
        if point_in_bbox(cx, cy, worker_bbox):
            return True
    return False


def pallet_is_filled(pallet_bbox, boxes):
    for box in boxes:
        cx, cy = bbox_center(box["bbox"])
        if point_in_bbox(cx, cy, pallet_bbox):
            return True
    return False


def associate_forklift_with_worker(forklift_bbox, workers,
                                   iou_threshold=FORKLIFT_WORKER_IOU_THRESHOLD):
    """Returns the worker dict that is operating this forklift, or None.

    A forklift is "operating" when a worker is on/near it. We accept either
    containment (worker center inside the forklift bbox — covers the common
    case where the operator's torso projects into the forklift cab) or a
    healthy IoU (covers the side-on case where the operator's bbox overlaps
    the forklift but the center sits just outside the cab outline).

    Cargo state (boxes-on-forklift) is intentionally NOT modeled here. See
    CLAUDE_CODE_BUSINESS_RULES.md §1 — phase 2 replaced the cargo rule with
    worker-presence.
    """
    fx1, fy1, fx2, fy2 = forklift_bbox
    for w in workers:
        wcx, wcy = w["cx"], w["cy"]
        if fx1 <= wcx <= fx2 and fy1 <= wcy <= fy2:
            return w
        if iou(forklift_bbox, w["bbox"]) >= iou_threshold:
            return w
    return None


def forklift_is_operating(forklift_bbox, workers):
    """Convenience boolean wrapper around `associate_forklift_with_worker`."""
    return associate_forklift_with_worker(forklift_bbox, workers) is not None
