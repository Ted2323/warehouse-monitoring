import { forwardRef, type HTMLAttributes } from "react";
import { twMerge } from "tailwind-merge";

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function Card({ className, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={twMerge(
          "bg-bg-elevated border border-border rounded-lg",
          className,
        )}
        {...rest}
      />
    );
  },
);
