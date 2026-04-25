// Mirror of ml/classes.py — keep these two files in sync.
// Class IDs are positional (must match data.yaml order on the Python side).

export const CLASS_NAMES = [
  "worker_with_helmet",
  "worker_no_helmet",
  "worker_with_reflective",
  "worker_no_reflective_vest",
  "pallet_filled",
  "pallet_empty",
  "forklift_with_boxes",
  "forklift_no_carry",
] as const;

export type DetectionClass = (typeof CLASS_NAMES)[number];

export const PPE_VIOLATION_CLASSES = new Set<DetectionClass>([
  "worker_no_helmet",
  "worker_no_reflective_vest",
]);

export const WORKER_CLASSES = new Set<DetectionClass>([
  "worker_with_helmet",
  "worker_no_helmet",
  "worker_with_reflective",
  "worker_no_reflective_vest",
]);

export const PALLET_CLASSES   = new Set<DetectionClass>(["pallet_filled", "pallet_empty"]);
export const FORKLIFT_CLASSES = new Set<DetectionClass>(["forklift_with_boxes", "forklift_no_carry"]);

export type AlertLevel = "info" | "warning" | "danger";

export const VIOLATION_SEVERITY: Record<string, AlertLevel> = {
  worker_no_helmet:          "danger",
  worker_no_reflective_vest: "warning",
};

// Human-friendly labels for the legend / dashboard chips.
export const CLASS_LABELS: Record<string, string> = {
  worker_with_helmet:        "Worker · helmet",
  worker_no_helmet:          "Worker · no helmet",
  worker_with_reflective:    "Worker · vest",
  worker_no_reflective_vest: "Worker · no vest",
  pallet_filled:             "Pallet · filled",
  pallet_empty:              "Pallet · empty",
  forklift_with_boxes:       "Forklift · loaded",
  forklift_no_carry:         "Forklift · idle",
};

export function isPpeViolation(cls: string): boolean {
  return PPE_VIOLATION_CLASSES.has(cls as DetectionClass);
}
