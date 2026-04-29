// Mirror of ml/classes.py — keep these two files in sync.
// Class IDs are positional (must match data.yaml order on the Python side).
//
// The model emits only base classes. Derived violations (worker_no_helmet,
// worker_no_vest, worker_unsafe) are computed server-side from bbox
// association and arrive in the API's `ppe_violations` array — they are NOT
// raw model detections. Each worker emits AT MOST ONE violation (precedence
// chain in ml/detect.py).

export const CLASS_NAMES = [
  "worker",
  "helmet",
  "vest",
  "pallet",
  "box",
  "forklift",
] as const;

export type DetectionClass = (typeof CLASS_NAMES)[number];

// Derived violation classes — emitted by the backend, not by the model.
export const DERIVED_VIOLATION_CLASSES = new Set<string>([
  "worker_no_helmet",
  "worker_no_vest",
  "worker_unsafe",
]);

// `critical` was added in phase 2 for the compound worker_unsafe case.
// Order matters for severity comparisons: info < warning < danger < critical.
export type AlertLevel = "info" | "warning" | "danger" | "critical";

export const SEVERITY_ORDER: AlertLevel[] = ["info", "warning", "danger", "critical"];

export const VIOLATION_SEVERITY: Record<string, AlertLevel> = {
  worker_no_helmet: "danger",
  worker_no_vest:   "danger",     // phase-2: upgraded from warning
  worker_unsafe:    "critical",   // phase-2: new tier
};

// Human-friendly labels for the legend / dashboard chips.
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
  worker_unsafe:    "Worker · no PPE",
};

export function isPpeViolation(cls: string): boolean {
  return DERIVED_VIOLATION_CLASSES.has(cls);
}

// Bounding-box display threshold — anything the model emits below this is
// treated as too uncertain to draw or to log as a violation. Enforced at the
// API boundary in /api/detect (write) and /api/logs (read) so both new and
// historical data render the same policy in the UI.
// Set to 0.25 (Ultralytics' default) because the current model was trained
// for DETECT_CONF=0.10 (mAP <=0.5 per commit 07e268c); 0.5 zeroed out
// detections on real-world images. Bump back up once the model improves.
export const MIN_CONFIDENCE = 0.25;
