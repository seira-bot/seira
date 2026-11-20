import type { CloudSignIn } from "./control-plane-client.mjs";

/** The Seira Cloud that signs people in: SEIRA_CLOUD_ORIGIN when valid, else Seira's own. */
export declare function seiraCloudSignInOrigin(env?: NodeJS.ProcessEnv): string;
export declare function createSeiraCloudSignIn(options: {
  origin: string;
  identity: { deviceName: string; platform: string; appVersion?: string };
  fetchImpl?: typeof fetch;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
}): CloudSignIn;
