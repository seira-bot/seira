import type { CloudSignIn } from "./control-plane-client.mjs";

export declare function createSeiraCloudSignIn(options: {
  origin: string;
  identity: { deviceName: string; platform: string; appVersion?: string };
  fetchImpl?: typeof fetch;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
}): CloudSignIn;
