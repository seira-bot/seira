// The proof that a workspace switch finished, signed with the computer's transport key `T`.
// Wire contract: packages/phone-protocol/src/workspaces.ts (this build cannot import from that package; a test keeps the two in step).
import { createPrivateKey, sign, type KeyObject } from "node:crypto";

import { b64u, keyId } from "./credentials.ts";
import type { KeyPair } from "./noise.ts";

export const SWITCH_PROOF_LABEL = "seira-switch-proof v1";
export const NONCE_BYTES = 32;
/** A proof is valid this long after it is made; the operation's own time limit still applies. */
export const PROOF_TTL_MS = 2 * 60_000;

export interface SwitchProofFields {
  keyId: Uint8Array;
  binding: Uint8Array;
  deviceId: string;
  operationId: string;
  fromWorkspaceId: string;
  fromEnvironmentId?: string;
  workspaceId: string;
  environmentId: string;
  nonce: Uint8Array;
  issuedAt: number;
  expiresAt: number;
}

/** The exact bytes that are signed: the label, a zero byte, then the fields in contract order. A string is a 2-byte big-endian
 * length and its UTF-8 bytes; a time is 8 bytes big-endian. */
export function switchProofMessage(fields: SwitchProofFields): Buffer {
  const parts: Buffer[] = [Buffer.from(SWITCH_PROOF_LABEL, "utf8"), Buffer.of(0), Buffer.from(fields.keyId), Buffer.from(fields.binding)];
  const string = (value: string) => {
    const bytes = Buffer.from(value, "utf8");
    parts.push(Buffer.of(bytes.length >> 8, bytes.length & 255), bytes);
  };
  const time = (value: number) => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64BE(BigInt(value));
    parts.push(bytes);
  };
  string(fields.deviceId);
  string(fields.operationId);
  string(fields.fromWorkspaceId);
  string(fields.fromEnvironmentId ?? "");
  string(fields.workspaceId);
  string(fields.environmentId);
  parts.push(Buffer.from(fields.nonce));
  time(fields.issuedAt);
  time(fields.expiresAt);
  return Buffer.concat(parts);
}

/** Signs with the transport key. The key also does Diffie-Hellman for the Noise handshake; the label above keeps a signature
 * made here from being a signature over anything else. */
export interface SwitchProofSigner {
  keyId: Buffer;
  sign(message: Uint8Array): Buffer;
}

export function switchProofSigner(key: KeyPair): SwitchProofSigner {
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: b64u(key.privateKey),
    x: b64u(key.publicKey.subarray(1, 33)),
    y: b64u(key.publicKey.subarray(33, 65)),
  };
  const privateKey: KeyObject = createPrivateKey({ key: jwk, format: "jwk" });
  return { keyId: keyId(key.publicKey), sign: (message) => sign("sha256", message, { key: privateKey, dsaEncoding: "ieee-p1363" }) };
}
