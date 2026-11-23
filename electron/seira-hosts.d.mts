export type SeiraHost = "site" | "cloud" | "apps" | "updates" | "admin" | "accounts" | "device" | "stats" | "pages" | "companion" | "push" | "tunnel";
export type SeiraService = Exclude<SeiraHost, "tunnel"> | "serverTunnel";

export declare const SEIRA_HOSTS: Readonly<Record<SeiraHost, string> & {
  cloudStaging: string;
  relayPattern: RegExp;
  relayNodePattern: RegExp;
}>;
export declare const seiraOrigin: (host: string) => string;
export declare const LIVE_SEIRA_SERVICES: readonly SeiraService[];
export declare const SEIRA_SERVICE_OVERRIDE_ENV: Readonly<Partial<Record<SeiraService, string>>>;
export declare function seiraServiceLive(name: SeiraService, env?: Record<string, string | undefined>, live?: readonly SeiraService[]): boolean;
