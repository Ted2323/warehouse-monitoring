import type { HTMLAttributes } from "react";
import { twMerge } from "tailwind-merge";

type Variant = "success" | "warning" | "danger" | "critical" | "neutral";

// Earthy, muted backgrounds — the variant lookup keeps token usage in one place.
// `critical` is intentionally heavier (solid fill, white text) so a worker_unsafe
// chip in a row of warning/danger items locks the eye immediately.
const VARIANT: Record<Variant, string> = {
  success:  "bg-success/15  text-success  border border-success/30",
  warning:  "bg-warning/15  text-warning  border border-warning/30",
  danger:   "bg-danger/15   text-danger   border border-danger/30",
  critical: "bg-critical    text-white    border border-critical",
  neutral:  "bg-bg-sunken   text-fg-muted border border-border",
};

interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
}

export function Chip({ variant = "neutral", className, ...rest }: ChipProps) {
  return (
    <span
      className={twMerge(
        "inline-flex items-center gap-1 rounded-full text-xs px-2 py-0.5 font-medium",
        VARIANT[variant],
        className,
      )}
      {...rest}
    />
  );
}
