// `browserEngine` in config.json.
import { z } from "zod";

import { browserEgressConfigSchema, type BrowserEgressConfig } from "./egress/policy.ts";

const CDP_PORT = /^[0-9]{1,5}$/;
const CDP_URL = /^(https?|wss?):\/\/\S+$/i;

/** agent-browser's `--cdp` takes a bare port or an http(s)/ws(s) DevTools URL. */
export function isValidCdpTarget(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  if (CDP_PORT.test(value)) {
    const port = Number(value);
    return port >= 1 && port <= 65535;
  }
  return CDP_URL.test(value);
}

export type BrowserEngineKind = "agent-browser" | "chrome";

/** `attachCdpUrl`: a running Chrome that My Chrome profiles attach to. Config only, never env: the ambient environment must not redirect a bot's browser. */
export const browserEngineConfigSchema = z.object({
  attachCdpUrl: z.string().trim().max(2048).refine((value) => value === "" || isValidCdpTarget(value),
    { message: "browserEngine.attachCdpUrl must be a CDP port (1-65535) or an http(s)/ws(s) URL" }).optional(),
  idleTimeoutMinutes: z.number().int().min(1).max(60).optional(), // an unused browser closes after this; 10 when unset, 3 on Seira Cloud
  egress: browserEgressConfigSchema.optional(),
  /** The engine the person chose for the bots' browsers. Unset, Seira's own Chrome driver runs them where this host has a Chrome for it, else agent-browser. */
  engine: z.enum(["agent-browser", "chrome"]).optional(),
});

export interface BrowserEngineConfig {
  attachCdpUrl?: string;
  idleTimeoutMinutes?: number;
  egress?: BrowserEgressConfig;
  engine?: BrowserEngineKind;
}

/** The person's saved choice; null while they have not chosen, so the host decides. */
export function browserEngineChoice(cfg: { browserEngine?: BrowserEngineConfig }): BrowserEngineKind | null {
  return cfg.browserEngine?.engine ?? null;
}

/** Under vitest or a sealed test fixture (env-path.ts) only with SEIRA_BROWSER_ENGINE_DEFAULT=chrome: a test's fake
 * agent-browser then stands for the bots' browser, and no test finds this machine's Chrome or downloads one. */
export function seiraEngineByDefault(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.VITEST !== "true" && env.SEIRA_TEST_SEALED_PATH !== "1") || env.SEIRA_BROWSER_ENGINE_DEFAULT?.trim() === "chrome";
}

/** The engine that runs the bots' browsers: the saved choice, else Seira's own driver wherever it has a Chrome to run. Boxed, only agent-browser's Chrome is inside the box, so no choice moves it off agent-browser. */
export function effectiveBrowserEngine(
  cfg: { browserEngine?: BrowserEngineConfig },
  seiraEngineHasChrome: () => boolean,
  { boxed = false, env = process.env }: { boxed?: boolean; env?: NodeJS.ProcessEnv } = {},
): BrowserEngineKind {
  if (boxed) return "agent-browser";
  return browserEngineChoice(cfg) ?? (seiraEngineByDefault(env) && seiraEngineHasChrome() ? "chrome" : "agent-browser");
}
