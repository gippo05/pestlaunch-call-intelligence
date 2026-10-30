import * as React from "react";
import { cn } from "@/lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input({ className, ...props }, ref) {
  return (
    <input
      className={cn(
        "flex h-11 w-full rounded-lg border border-line bg-white px-3.5 text-sm text-ink shadow-sm outline-none placeholder:text-stone-400 focus-visible:border-blue-700 focus-visible:ring-2 focus-visible:ring-blue-700/20 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
