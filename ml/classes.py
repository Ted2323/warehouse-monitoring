"""Single source of truth for the warehouse-monitor detection class set.

Every other module (detection, server, training, frontend mirror) must import
class strings from here. Do not hardcode class names elsewhere.

Class IDs are defined by their order in CLASS_NAMES and must match the order
in the training `data.yaml` (Ultralytics derives IDs from YAML order).

The model emits compositional base classes — it does not tell us PPE state or
asset state directly. Those facts are derived from bbox association between
detections in the same frame; see ml/associate.py.
"""

CLASS_NAMES = [
    "worker",
    "helmet",
    "vest",
    "pallet",
    "box",
    "forklift",
]

WORKER_CLASS   = "worker"
HELMET_CLASS   = "helmet"
VEST_CLASS     = "vest"
PALLET_CLASS   = "pallet"
BOX_CLASS      = "box"
FORKLIFT_CLASS = "forklift"

# Derived violation kinds — these are NOT model classes. They are computed
# server-side from bbox association (see ml/associate.py + ml/detect.py).
# Violations are mutually exclusive per worker — `check_ppe_violations` emits
# at most ONE entry per worker, picked by precedence (worker_unsafe > the two
# single-failure cases). Phase-2 upgrade: missing-vest is now `danger`, and a
# worker missing both items emits the new `worker_unsafe` (`critical` tier).
DERIVED_VIOLATIONS = {"worker_no_helmet", "worker_no_vest", "worker_unsafe"}

# Severity ordering: info < warning < danger < critical.
SEVERITY_ORDER = ("info", "warning", "danger", "critical")

VIOLATION_SEVERITY = {
    "worker_no_helmet": "danger",
    "worker_no_vest":   "danger",     # phase-2: upgraded from warning
    "worker_unsafe":    "critical",   # phase-2: new compound violation
}
