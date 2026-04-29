"""Tests for ml/associate.py + the round-trip through ml/detect.py.

Run from the repo root:
    python -m pytest ml/tests/test_associate.py
or from ml/:
    python -m pytest tests/test_associate.py
"""

import json
import sys
from pathlib import Path

# Make `ml/` importable when pytest is run from the repo root.
ML_DIR = Path(__file__).resolve().parents[1]
if str(ML_DIR) not in sys.path:
    sys.path.insert(0, str(ML_DIR))

from associate import (
    associate_forklift_with_worker,
    bbox_center,
    forklift_is_operating,
    iou,
    pallet_is_filled,
    point_in_bbox,
    worker_has_helmet,
    worker_has_vest,
)
from detect import (
    check_ppe_violations,
    summarize_compliance,
    summarize_inventory,
)


# ─── HELMET ASSOCIATION ──────────────────────────────────────
def test_helmet_in_upper_third_is_associated():
    worker = [100, 100, 200, 400]   # 100x300 worker bbox; upper third ends at y=200
    helmet = {"bbox": [120, 110, 180, 160]}  # center at (150, 135) — upper third
    assert worker_has_helmet(worker, [helmet]) is True


def test_helmet_on_floor_is_not_associated():
    worker = [100, 100, 200, 400]
    helmet = {"bbox": [120, 380, 180, 430]}  # center at (150, 405) — below worker bottom
    assert worker_has_helmet(worker, [helmet]) is False


def test_helmet_in_middle_of_worker_is_not_associated():
    """Helmet at the worker's belt would be a phantom; reject it."""
    worker = [100, 100, 200, 400]
    helmet = {"bbox": [120, 240, 180, 290]}  # center y=265 > upper third bound y=200
    assert worker_has_helmet(worker, [helmet]) is False


# ─── VEST ASSOCIATION ────────────────────────────────────────
def test_vest_with_high_iou_is_associated():
    worker = [100, 100, 200, 400]
    # Vest covering most of the torso → IoU well above 0.15
    vest = {"bbox": [110, 180, 190, 320]}
    assert iou(vest["bbox"], worker) >= 0.15
    assert worker_has_vest(worker, [vest]) is True


def test_vest_far_away_is_not_associated():
    worker = [100, 100, 200, 400]
    vest = {"bbox": [800, 800, 900, 900]}  # zero IoU, center outside
    assert worker_has_vest(worker, [vest]) is False


# ─── PALLET ASSOCIATION ──────────────────────────────────────
def test_pallet_with_box_inside_is_filled():
    pallet = [600, 300, 750, 420]
    box    = {"bbox": [615, 310, 700, 390]}  # center (657, 350) — inside pallet
    assert pallet_is_filled(pallet, [box]) is True


def test_pallet_with_no_box_is_empty():
    pallet = [600, 300, 750, 420]
    box    = {"bbox": [10, 10, 50, 50]}  # nowhere near
    assert pallet_is_filled(pallet, [box]) is False


# ─── FORKLIFT × WORKER ASSOCIATION (phase 2) ─────────────────
def test_forklift_with_worker_center_inside_is_operating():
    forklift = [50, 280, 280, 470]
    worker = {"bbox": [80, 300, 180, 460], "cx": 130, "cy": 380}  # center inside fk
    assert associate_forklift_with_worker(forklift, [worker]) is worker
    assert forklift_is_operating(forklift, [worker]) is True


def test_forklift_with_worker_high_iou_is_operating():
    """Center may sit just outside the cab, but IoU >= 0.20 → operating."""
    forklift = [100, 100, 300, 400]    # 200x300 → 60000
    # Worker bbox overlaps cab heavily but center is just outside the cab.
    # Center placed outside [100..300] horizontally so we exercise the IoU branch.
    worker = {"bbox": [50, 150, 220, 350], "cx": 50, "cy": 250}
    assert iou(forklift, worker["bbox"]) >= 0.20
    assert forklift_is_operating(forklift, [worker]) is True


def test_forklift_alone_is_idle():
    forklift = [50, 280, 280, 470]
    # Workers far away from the forklift on every axis.
    far_worker = {"bbox": [800, 50, 900, 200], "cx": 850, "cy": 125}
    assert associate_forklift_with_worker(forklift, [far_worker]) is None
    assert forklift_is_operating(forklift, [far_worker]) is False
    assert forklift_is_operating(forklift, []) is False


# ─── PPE VIOLATION PRECEDENCE (phase 2) ──────────────────────
def test_worker_missing_both_emits_one_unsafe_only():
    detections = [
        {"class": "worker", "confidence": 0.9, "bbox": [0, 0, 100, 300], "cx": 50, "cy": 150},
    ]
    out = check_ppe_violations(detections)
    assert len(out) == 1
    v = out[0]
    assert v["class"] == "worker_unsafe"
    assert v["alert_level"] == "critical"


def test_worker_missing_only_helmet_emits_no_helmet_danger():
    detections = [
        {"class": "worker", "confidence": 0.9, "bbox": [0, 0, 100, 300], "cx": 50, "cy": 150},
        {"class": "vest",   "confidence": 0.8, "bbox": [10, 100, 90, 220], "cx": 50, "cy": 160},
    ]
    out = check_ppe_violations(detections)
    assert len(out) == 1
    assert out[0]["class"] == "worker_no_helmet"
    assert out[0]["alert_level"] == "danger"


def test_worker_missing_only_vest_emits_no_vest_danger():
    detections = [
        {"class": "worker", "confidence": 0.9, "bbox": [0, 0, 100, 300], "cx": 50, "cy": 150},
        {"class": "helmet", "confidence": 0.8, "bbox": [30, 10, 70, 50], "cx": 50, "cy": 30},
    ]
    out = check_ppe_violations(detections)
    assert len(out) == 1
    assert out[0]["class"] == "worker_no_vest"
    assert out[0]["alert_level"] == "danger"


def test_compliant_worker_emits_no_violation():
    detections = [
        {"class": "worker", "confidence": 0.9, "bbox": [0, 0, 100, 300], "cx": 50, "cy": 150},
        {"class": "helmet", "confidence": 0.8, "bbox": [30, 10, 70, 50],  "cx": 50, "cy": 30},
        {"class": "vest",   "confidence": 0.8, "bbox": [10, 100, 90, 220],"cx": 50, "cy": 160},
    ]
    assert check_ppe_violations(detections) == []


# ─── COMPLIANCE SUMMARY ARITHMETIC ───────────────────────────
def test_compliance_summary_buckets_sum_to_workers_total():
    """compliant + partial + unsafe must equal workers_total for any input."""
    fx = json.loads(FIXTURE_PATH.read_text())
    detections = fx["detections"]
    ppe = check_ppe_violations(detections)
    s = summarize_compliance(detections, ppe)
    assert s["workers_compliant"] + s["workers_partial"] + s["workers_unsafe"] == s["workers_total"]


def test_compliance_summary_severity_counts_match_violations():
    fx = json.loads(FIXTURE_PATH.read_text())
    detections = fx["detections"]
    ppe = check_ppe_violations(detections)
    s = summarize_compliance(detections, ppe)
    assert s["critical_count"] == sum(1 for v in ppe if v["alert_level"] == "critical")
    assert s["danger_count"]   == sum(1 for v in ppe if v["alert_level"] == "danger")
    assert s["warning_count"]  == sum(1 for v in ppe if v["alert_level"] == "warning")


def test_compliance_summary_ignores_low_confidence_workers():
    """Workers below WORKER_CONF_THRESHOLD (0.50) don't count toward workers_total."""
    detections = [
        {"class": "worker", "confidence": 0.95, "bbox": [0, 0, 100, 300], "cx": 50, "cy": 150},
        {"class": "worker", "confidence": 0.10, "bbox": [200, 0, 300, 300], "cx": 250, "cy": 150},
        # 0.40 used to count under the old 0.30 threshold; under the
        # tightened 0.50 threshold it must be dropped.
        {"class": "worker", "confidence": 0.40, "bbox": [400, 0, 500, 300], "cx": 450, "cy": 150},
    ]
    s = summarize_compliance(detections, check_ppe_violations(detections))
    assert s["workers_total"] == 1


# ─── HELPERS ─────────────────────────────────────────────────
def test_bbox_center_basic():
    assert bbox_center([0, 0, 10, 20]) == (5, 10)


def test_point_in_bbox():
    assert point_in_bbox(5, 5, [0, 0, 10, 10]) is True
    assert point_in_bbox(15, 5, [0, 0, 10, 10]) is False


def test_iou_disjoint_is_zero():
    assert iou([0, 0, 10, 10], [100, 100, 110, 110]) == 0.0


def test_iou_identical_is_one():
    a = [0, 0, 10, 10]
    assert iou(a, a) == 1.0


# ─── FIXTURE ROUND-TRIP ──────────────────────────────────────
FIXTURE_PATH = ML_DIR / "fixtures" / "mock_detection.json"


def test_fixture_round_trip_inventory():
    fx = json.loads(FIXTURE_PATH.read_text())
    assert summarize_inventory(fx["detections"]) == fx["inventory"]


def test_fixture_round_trip_ppe_violations():
    fx = json.loads(FIXTURE_PATH.read_text())
    derived = check_ppe_violations(fx["detections"])
    # Order may differ; compare as sets of (class, tuple(bbox)).
    norm = lambda vs: sorted((v["class"], tuple(v["bbox"])) for v in vs)
    assert norm(derived) == norm(fx["ppe_violations"])


def test_fixture_round_trip_compliance_summary():
    fx = json.loads(FIXTURE_PATH.read_text())
    derived = check_ppe_violations(fx["detections"])
    assert summarize_compliance(fx["detections"], derived) == fx["compliance_summary"]
