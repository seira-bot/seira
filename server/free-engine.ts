// A new person with no ready AI gets OpenCode's free no-login models as a backup: installed once, never over an existing CLI.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { freeFallback } from "../shared/ai-ranking.ts";

export interface FreeEngineCandidate {
  instanceId: string;
  driverKind: string;
  snapshot: { state: "available" | "unavailable"; freeFallback?: boolean };
  install?: { server?: { standalone?: unknown; package?: unknown } };
  cliCandidates?: readonly string[];
}

export type FreeEngineSkip = "ai-ready" | "opencode-present" | "refused" | "not-installable";
export type FreeEngineDecision = { install: string } | { skip: FreeEngineSkip };

interface FreeEngineState {
  outcome: "installed" | "skipped" | "failed";
  reason?: string;
  attempts: number;
  at: string;
}

const MAX_ATTEMPTS = 3;

export function freeEngineInstallEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.SEIRA_FREE_ENGINE?.trim();
  if (flag === "0") return false;
  return (env.VITEST !== "true" && env.SEIRA_TEST_SEALED_PATH !== "1") || flag === "1";
}

export function freeEngineDecision<T extends FreeEngineCandidate>(
  instances: readonly T[],
  ready: (instance: T) => boolean,
  refused: (instance: T) => boolean,
): FreeEngineDecision {
  if (instances.some((instance) => ready(instance) && !freeFallback(instance))) return { skip: "ai-ready" };
  const opencode = instances.find((instance) => instance.driverKind === "opencodeGo");
  if (!opencode) return { skip: "not-installable" };
  if (refused(opencode)) return { skip: "refused" };
  if (opencode.snapshot.state === "available" || (opencode.cliCandidates?.length ?? 0) > 0) return { skip: "opencode-present" };
  if (!opencode.install?.server?.standalone && !opencode.install?.server?.package) return { skip: "not-installable" };
  return { install: opencode.instanceId };
}

export interface FreeEngineDeps<T extends FreeEngineCandidate = FreeEngineCandidate> {
  statePath: string;
  enabled: boolean;
  instances(): Promise<readonly T[]>;
  ready(instance: T): boolean;
  refused(instance: T): boolean;
  install(instanceId: string): Promise<unknown>;
  changed(): void;
  installed(instanceId: string): Promise<void>;
  log(line: string): void;
}

export function createFreeEngineInstaller<T extends FreeEngineCandidate>(deps: FreeEngineDeps<T>) {
  let installingId: string | null = null;
  let running: Promise<void> | null = null;

  function readState(): FreeEngineState | null {
    try {
      const value = JSON.parse(readFileSync(deps.statePath, "utf8")) as Partial<FreeEngineState> | null;
      if (!value || typeof value !== "object") return null;
      if (value.outcome !== "installed" && value.outcome !== "skipped" && value.outcome !== "failed") return null;
      return { outcome: value.outcome, attempts: typeof value.attempts === "number" ? value.attempts : 0, at: String(value.at ?? ""), ...(value.reason ? { reason: value.reason } : {}) };
    } catch {
      return null;
    }
  }

  function writeState(state: Omit<FreeEngineState, "at">): void {
    mkdirSync(dirname(deps.statePath), { recursive: true });
    writeFileSync(deps.statePath, JSON.stringify({ ...state, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
  }

  async function run(): Promise<void> {
    if (!deps.enabled) return;
    const previous = readState();
    if (previous?.outcome === "installed" || previous?.outcome === "skipped") return;
    const attempts = previous?.attempts ?? 0;
    if (attempts >= MAX_ATTEMPTS) return;
    const decision = freeEngineDecision(await deps.instances(), deps.ready, deps.refused);
    if ("skip" in decision) {
      writeState({ outcome: "skipped", reason: decision.skip, attempts });
      deps.log(`skipped: ${decision.skip}`);
      return;
    }
    installingId = decision.install;
    deps.changed();
    let done = false;
    try {
      if (await deps.install(decision.install) === false) throw new Error("this server cannot install OpenCode");
      writeState({ outcome: "installed", attempts: attempts + 1 });
      deps.log("installed OpenCode as a free backup");
      done = true;
    } catch (error) {
      writeState({ outcome: "failed", attempts: attempts + 1 });
      deps.log(`install failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      installingId = null;
      deps.changed();
    }
    if (!done) return;
    await deps.installed(decision.install);
    deps.changed();
  }

  return {
    start(): Promise<void> {
      running ??= run().catch((error) => {
        deps.log(`stopped: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => { running = null; });
      return running;
    },
    installing: (instanceId: string): boolean => installingId === instanceId,
  };
}
