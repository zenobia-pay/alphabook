import * as React from "react";

import { cn } from "../../lib/utils";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(({ className, ...props }, ref) => {
  return (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-[84px] w-full rounded-[24px] border border-[var(--shell-border)] bg-[rgba(255,251,247,0.84)] px-4 py-3 text-sm text-[var(--ink)] shadow-sm outline-none transition-colors placeholder:text-[var(--ink-soft)] focus-visible:border-[var(--shell-strong)] focus-visible:ring-2 focus-visible:ring-[rgba(139,55,40,0.18)] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };
