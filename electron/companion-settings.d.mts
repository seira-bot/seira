export type CompanionRoute = "wifi" | "relay" | "tailscale" | "https";
export declare const ROUTES: readonly CompanionRoute[];
export declare function defaultStartRoutes(relayConfigured: boolean | undefined): CompanionRoute[];
