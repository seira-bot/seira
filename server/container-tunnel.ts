import { planTunnel, type TunnelPlan } from "./cli-tunnel-plan.ts";
import { cleanupTunnelOrigin, describeTunnelState, startTunnel, type RunningTunnel } from "./tunnel.ts";

export interface ContainerTunnelDeps {
  plan: typeof planTunnel;
  start: typeof startTunnel;
  cleanup: typeof cleanupTunnelOrigin;
  serverUp(port: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export const containerTunnelDeps: ContainerTunnelDeps = {
  plan: planTunnel,
  start: startTunnel,
  cleanup: cleanupTunnelOrigin,
  serverUp: async (port) => {
    try {
      const answer = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      return answer.ok && /seira|openmausbot/.test(await answer.text());
    } catch {
      return false;
    }
  },
  sleep: (ms) => new Promise((resume) => setTimeout(resume, ms)),
};

const POLL_MS = 250;

/** The guardian starts cloudflared with its own minimal environment; this keeps the launcher's provider keys out of what it reads. */
function connectorEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "SEIRA_TUNNEL_ORIGIN_PORT"]) if (env[name] !== undefined) kept[name] = env[name];
  return kept;
}

/**
 * The account tunnel of a container: planned before each server start, connected once that server answers, and
 * released before the server stops and before the next start, so two connectors never run at once.
 */
export function createContainerTunnel(options: { dataDir: string; port: number; env?: NodeJS.ProcessEnv; log: (line: string) => void; deps?: Partial<ContainerTunnelDeps> }) {
  const deps = { ...containerTunnelDeps, ...options.deps };
  const env = options.env ?? process.env;
  let plan: TunnelPlan | null = null;
  let running: RunningTunnel | null = null;
  let cancelled = false;
  let attaching: Promise<void> = Promise.resolve();
  let releasing: Promise<void> | null = null;

  return {
    /** The settings the next server gets: its public address and the private socket the tunnel forwards to. Nothing when there is no tunnel this time. */
    async prepare(): Promise<Record<string, string>> {
      cancelled = false;
      plan = null;
      const planned = await deps.plan({ dataDir: options.dataDir }, (line) => options.log(line), { running: () => running });
      if ("error" in planned) {
        options.log(`tunnel: ${planned.error}. This server starts without a public address.`);
        return {};
      }
      if ("unavailable" in planned) {
        options.log(`tunnel: ${planned.unavailable}. This server starts without a public address.`);
        return {};
      }
      plan = planned;
      return { SEIRA_PUBLIC_URL: planned.access.endpoint, SEIRA_TUNNEL_SOCKET: planned.origin.socketPath, SEIRA_SERVES_TUNNEL: "1" };
    },

    attach(pid: number): Promise<void> {
      const current = plan;
      if (!current) return Promise.resolve();
      attaching = (async () => {
        let answered = false;
        while (!cancelled && !answered) {
          answered = await deps.serverUp(options.port);
          if (!answered) await deps.sleep(POLL_MS);
        }
        if (cancelled) return;
        running = deps.start({
          dataDir: options.dataDir,
          access: current.access,
          originTarget: { pid, socketPath: current.origin.socketPath },
          binaryPath: current.binary,
          guardian: current.guardian,
          env: connectorEnvironment(env),
          onState: (state) => options.log(describeTunnelState(state, current.access.endpoint)),
        });
        running.started.catch((error: unknown) => options.log(`tunnel: ${error instanceof Error ? error.message : String(error)}`));
        void current.account?.service.restore().catch(() => undefined);
      })();
      return attaching;
    },

    /** Stops the connector and its guardian, then removes the origin they forwarded to. Safe to call again. */
    release(): Promise<void> {
      releasing ??= (async () => {
        cancelled = true;
        await attaching.catch(() => undefined);
        const old = plan;
        const tunnel = running;
        plan = null;
        running = null;
        if (!old) return;
        old.account?.service.dispose();
        if (tunnel) await tunnel.stop().catch(() => undefined);
        deps.cleanup(old.origin);
      })().finally(() => { releasing = null; });
      return releasing;
    },
  };
}
