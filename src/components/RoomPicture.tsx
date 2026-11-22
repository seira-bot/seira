import { useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";

/** A room's own picture in a circle. When it is missing or fails to load, `fallback` (the member faces) shows instead. */
export function RoomPicture({ url, size, fallback, className }: { url?: string | null; size: number; fallback: ReactNode; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!url || failed === url) return <>{fallback}</>;
  return (
    <img
      data-room-picture=""
      src={url}
      alt=""
      draggable={false}
      onError={() => setFailed(url)}
      className={cn("shrink-0 rounded-full object-cover", className)}
      style={{ width: size, height: size }}
    />
  );
}
