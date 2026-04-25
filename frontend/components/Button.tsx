import { forwardRef, type ButtonHTMLAttributes } from "react";
import { twMerge } from "tailwind-merge";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size    = "sm" | "md";

const VARIANT: Record<Variant, string> = {
  primary:   "bg-accent text-accent-fg hover:bg-accent-hover",
  secondary: "bg-transparent border border-border-strong text-fg hover:bg-bg-sunken",
  ghost:     "bg-transparent text-fg-muted hover:bg-bg-sunken hover:text-fg",
  danger:    "bg-danger text-white hover:opacity-90",
};

const SIZE: Record<Size, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?:    Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button({ className, variant = "primary", size = "md", type = "button", ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        className={twMerge(
          "inline-flex items-center justify-center gap-1.5 rounded font-medium transition-colors",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
          VARIANT[variant],
          SIZE[size],
          className,
        )}
        {...rest}
      />
    );
  },
);
