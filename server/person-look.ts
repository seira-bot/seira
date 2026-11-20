import { randomPersonLook } from "../shared/person-look.ts";
import type { AppConfig } from "./config.ts";
import { saveConfig } from "./config.ts";

/** Gives the person on this computer a look the first time they have none, and keeps it. */
export function ensureProfileLook(cfg: AppConfig, options: { random?: () => number; save?: (patch: Pick<AppConfig, "profile">) => void } = {}): void {
  if (cfg.profile?.look) return;
  const look = randomPersonLook(options.random);
  try {
    (options.save ?? saveConfig)({ profile: { look } });
  } catch {
    return;
  }
  cfg.profile = { ...cfg.profile, look };
}
