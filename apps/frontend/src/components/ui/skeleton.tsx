import { cn } from "../../lib/utils";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-full bg-[rgba(72,43,37,0.08)]", className)} {...props} />;
}

export { Skeleton };
