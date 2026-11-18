import { cn } from "@/lib/cn";

export function SlidingThumb({ index, count, className }: { index: number; count: number; className?: string }) {
  if (index < 0 || count < 1) return null;
  return (
    <span
      aria-hidden="true"
      data-segment-thumb=""
      style={{ "--i": index, width: `calc((100% - 6px) / ${count})` } as React.CSSProperties}
      className={cn(
        "pointer-events-none absolute inset-y-[3px] start-[3px] translate-x-[calc(var(--i)*100%)] rounded-full bg-ink/[0.1] transition-transform duration-200 ease-out motion-reduce:transition-none rtl:-translate-x-[calc(var(--i)*100%)]",
        className,
      )}
    />
  );
}
