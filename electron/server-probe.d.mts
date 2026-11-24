import type { ServerInputProblem, ServerTransport } from "./server-address.mjs";

export type ServerProbeProblem = ServerInputProblem | "unreachable" | "dns" | "certificate" | "notSeira" | "desktopApp" | "loopback" | "localNetwork"
  | "desktopAppTailnet" | "tailscaleOff" | "otherTailnet" | "magicDnsOff" | "tailnetBlocked" | "tailnetSilent";
export type ServerProbe =
  | { outcome: "found"; origin: string; label: string; version: string | null; transport: ServerTransport; code: string | null; credential: string | null }
  | { outcome: "problem"; problem: ServerProbeProblem; host?: string; code?: string; reason?: "refused" | "timeout" };

/** What the Connect sheet's Connect resolves with. */
export type ConnectOutcome = { outcome: "connected"; label: string } | Extract<ServerProbe, { outcome: "problem" }>;

export declare function probeServer(input: { address: string; code?: string; fetch: typeof fetch; ownEnvironmentId?: () => Promise<string | null>; timeoutMs?: number; platform?: string; tailnet?: () => boolean; magicDns?: () => Promise<boolean | null> }): Promise<ServerProbe>;

export declare const CONNECT_PROBLEM_KEYS: Readonly<Record<ServerProbeProblem, `native.connect.${ServerProbeProblem}`>>;

export declare function createServerConnect(deps: {
  fetch: typeof fetch;
  ownEnvironmentId: () => Promise<string | null>;
  ask: (found: Extract<ServerProbe, { outcome: "found" }>) => Promise<boolean>;
  open: (found: Extract<ServerProbe, { outcome: "found" }>, name?: string) => void;
  t: (key: string, params?: Record<string, string>) => string;
  /** Whether this computer is on a tailnet; assumed so when absent. */
  tailnet?: () => boolean;
  /** Whether this computer's tailnet has MagicDNS on (null when unknown); asks Tailscale when absent. */
  magicDns?: () => Promise<boolean | null>;
}): {
  probe: (address: string, code?: string) => Promise<ServerProbe>;
  connect: (address: string, code?: string) => Promise<ConnectOutcome>;
  connectAsking: (input: string, name?: string) => Promise<boolean>;
  connectFromLink: (link: { address: string; secret: string | null }, confirmLink: (shown: { origin: string; withSecret: boolean }) => Promise<boolean>) => Promise<boolean>;
};
