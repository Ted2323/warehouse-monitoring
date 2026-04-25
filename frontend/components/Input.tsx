import { forwardRef, type InputHTMLAttributes } from "react";
import { twMerge } from "tailwind-merge";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={twMerge(
          "w-full bg-bg-sunken border border-border rounded px-3 py-2 text-sm text-fg",
          "placeholder:text-fg-subtle",
          "focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none",
          "disabled:opacity-50",
          className,
        )}
        {...rest}
      />
    );
  },
);
