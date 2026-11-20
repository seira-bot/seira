export type SeiraService = "site" | "cloud" | "apps" | "updates" | "admin" | "accounts" | "device" | "stats" | "pages" | "companion" | "push";

export declare const SEIRA_HOSTS: Readonly<Record<SeiraService, string> & {
  cloudStaging: string;
  relayPattern: RegExp;
  relayNodePattern: RegExp;
}>;
export declare const seiraOrigin: (host: string) => string;
export declare const LIVE_SEIRA_SERVICES: readonly SeiraService[];
export declare const SEIRA_SERVICE_OVERRIDE_ENV: Readonly<Partial<Record<SeiraService, string>>>;
export declare function seiraServiceLive(name: SeiraService, env?: Record<string, string | undefined>): boolean;
