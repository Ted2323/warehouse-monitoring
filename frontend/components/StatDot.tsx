import { twMerge } from "tailwind-merge";

type Tone = "success" | "warning" | "danger" | "muted";

const TONE: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger:  "bg-danger",
  muted:   "bg-fg-subtle",
};

export function StatDot({
  tone = "muted",
  className,
}: {
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={twMerge("inline-block w-2 h-2 rounded-full", TONE[tone], className)}
    />
  );
}
