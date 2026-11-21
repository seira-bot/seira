import { useEffect, useState } from "react";

import { api } from "@/state/store";

export interface AppUsage {
  app: string;
  calls: number;
}

/** The apps this server's bots called in the last 7 days, most calls first. Nothing, without a word, when they can't be read. */
export async function fetchAppUsage(): Promise<AppUsage[]> {
  try {
    const answer = await api("/api/apps/usage");
    return Array.isArray(answer?.apps)
      ? answer.apps.filter((entry: Partial<AppUsage>): entry is AppUsage => typeof entry?.app === "string" && typeof entry.calls === "number")
      : [];
  } catch {
    return [];
  }
}

/** Reads again when `reload` changes. */
export function useAppUsage(enabled: boolean, reload: unknown): AppUsage[] {
  const [usage, setUsage] = useState<AppUsage[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void fetchAppUsage().then((apps) => { if (alive) setUsage(apps); });
    return () => { alive = false; };
  }, [enabled, reload]);
  return usage;
}
