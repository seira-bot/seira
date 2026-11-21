export const CLOUD_SIGNED_HEADERS = {
  machine: "x-seira-cloud-machine",
  timestamp: "x-seira-cloud-timestamp",
  nonce: "x-seira-cloud-nonce",
  signature: "x-seira-cloud-signature",
} as const;

export const CLOUD_SIGNED_LEGACY_HEADERS = {
  machine: "x-omb-cloud-machine",
  timestamp: "x-omb-cloud-timestamp",
  nonce: "x-omb-cloud-nonce",
  signature: "x-omb-cloud-signature",
} as const;

export interface CloudSignedParts {
  machineId?: string;
  timestamp: string;
  nonce: string;
  /** The full header value, `v1=<hmac>`. */
  signature: string;
}

/** Both header names carry the same values until installed machines and Workers read only the new names. */
export function cloudSignedHeaders(parts: CloudSignedParts): Record<string, string> {
  const out: Record<string, string> = {};
  for (const names of [CLOUD_SIGNED_HEADERS, CLOUD_SIGNED_LEGACY_HEADERS]) {
    if (parts.machineId !== undefined) out[names.machine] = parts.machineId;
    out[names.timestamp] = parts.timestamp;
    out[names.nonce] = parts.nonce;
    out[names.signature] = parts.signature;
  }
  return out;
}

export interface CloudSignedRead {
  machineId: string | undefined;
  timestamp: string | undefined;
  nonce: string | undefined;
  signature: string | undefined;
}

/** Each value comes from the new name when present, else from the old name. */
export function readCloudSigned(get: (name: string) => string | undefined | null): CloudSignedRead {
  const pick = (key: keyof typeof CLOUD_SIGNED_HEADERS) => get(CLOUD_SIGNED_HEADERS[key]) ?? get(CLOUD_SIGNED_LEGACY_HEADERS[key]) ?? undefined;
  return { machineId: pick("machine"), timestamp: pick("timestamp"), nonce: pick("nonce"), signature: pick("signature") };
}
