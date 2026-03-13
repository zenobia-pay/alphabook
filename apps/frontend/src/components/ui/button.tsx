import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-[rgba(139,55,40,0.35)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--app-bg)] [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border border-[rgba(72,43,37,0.08)] bg-white text-[var(--ink)] shadow-[0_8px_22px_rgba(58,34,27,0.05)] hover:border-[rgba(72,43,37,0.12)] hover:bg-white",
        outline: "border border-[rgba(72,43,37,0.08)] bg-[rgba(255,255,255,0.72)] text-[var(--ink)] hover:border-[rgba(72,43,37,0.14)] hover:bg-white",
        ghost: "text-[var(--ink-soft)] hover:bg-[rgba(72,43,37,0.04)] hover:text-[var(--ink)]",
        accent: "bg-[var(--accent)] text-white hover:bg-[var(--accent-strong)]",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-11 px-5 text-sm",
        icon: "size-10 rounded-full",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
