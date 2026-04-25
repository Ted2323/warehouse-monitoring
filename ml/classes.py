"""Single source of truth for the warehouse-monitor detection class set.

Every other module (detection, server, training, frontend mirror) must import
class strings from here. Do not hardcode class names elsewhere.

Class IDs are defined by their order in CLASS_NAMES and must match the order
in the training `data.yaml` (Ultralytics derives IDs from YAML order).
"""

CLASS_NAMES = [
    "worker_with_helmet",
    "worker_no_helmet",
    "worker_with_reflective",
    "worker_no_reflective_vest",
    "pallet_filled",
    "pallet_empty",
    "forklift_with_boxes",
    "forklift_no_carry",
]

PPE_VIOLATION_CLASSES = {"worker_no_helmet", "worker_no_reflective_vest"}
WORKER_CLASSES = {
    "worker_with_helmet",
    "worker_no_helmet",
    "worker_with_reflective",
    "worker_no_reflective_vest",
}
PALLET_CLASSES = {"pallet_filled", "pallet_empty"}
FORKLIFT_CLASSES = {"forklift_with_boxes", "forklift_no_carry"}

VIOLATION_SEVERITY = {
    "worker_no_helmet": "danger",
    "worker_no_reflective_vest": "warning",
}
