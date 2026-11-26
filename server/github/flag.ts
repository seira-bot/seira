import type { AppConfig } from "../config.ts";

/** SEIRA_GITHUB_APP=1 or 0 wins over `features.githubApp` in config.json. On unless false. */
export function githubAppEnabled(cfg: Pick<AppConfig, "features">, env: NodeJS.ProcessEnv = process.env): boolean {
  const forced = env.SEIRA_GITHUB_APP?.trim();
  if (forced === "1") return true;
  if (forced === "0") return false;
  return cfg.features?.githubApp !== false;
}
