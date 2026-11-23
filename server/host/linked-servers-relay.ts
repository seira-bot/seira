// What a link through Seira Relay keeps apart from links.json: <data>/linked-servers/relay.json, mode 600. It names the
// relay invites that are open, the links this server hosts over the relay, and the relay route of each link it joined.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { parseDescriptor } from "../../companion/src/e2e/descriptor.ts";
import { writeFileAtomic } from "../atomic.ts";
import { ensurePrivateDir } from "../data-dir.ts";
import { LINK_ID, linkedServersDir } from "./linked-servers-store.ts";

/** Links that others joined over the relay at one time. */
export const RELAY_LINKS_MAX = 4;
/** Invites for a relay link that wait to be used at one time. */
export const RELAY_INVITES_MAX = 2;
/** The start of the device id under which the relay admits a link. */
export const LINK_DEVICE_PREFIX = "link:";

const FILE = "relay.json";
const hex64 = z.string().regex(/^[0-9a-f]{64}$/u);
const route = z.object({ v: z.literal(1), k: z.string().max(200), h: z.string().max(64), r: z.array(z.string().max(64)).min(1).max(4) }).strict()
  .refine((descriptor) => { const parsed = parseDescriptor(descriptor); return parsed.outcome === "ok" && parsed.hostId !== null; });
const fileSchema = z.object({
  v: z.literal(1),
  invites: z.array(hex64).max(RELAY_INVITES_MAX),
  hosted: z.array(z.string().regex(LINK_ID)).max(RELAY_LINKS_MAX),
  joined: z.record(z.string().regex(LINK_ID), route),
}).strict();

export type RelayLinksFile = z.infer<typeof fileSchema>;

const empty = (): RelayLinksFile => ({ v: 1, invites: [], hosted: [], joined: {} });

/** The address that stands in for the far server of a relay link. Nothing resolves or dials it. */
export const placeholderOrigin = (hostId: Buffer): string => `https://h-${hostId.toString("hex")}.e2e.invalid`;

/** A file that is missing is empty. A file that does not parse is empty too, and says so once. */
export function readRelayLinks(dataDir: string, log: (line: string) => void = () => {}): RelayLinksFile {
  let text: string;
  try { text = readFileSync(join(linkedServersDir(dataDir), FILE), "utf8"); } catch { return empty(); }
  try {
    const parsed = fileSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch { /* reported below */ }
  log("linked servers: their relay record did not parse, so no relay link is in use");
  return empty();
}

export function writeRelayLinks(dataDir: string, file: RelayLinksFile): void {
  ensurePrivateDir(linkedServersDir(dataDir));
  writeFileAtomic(join(linkedServersDir(dataDir), FILE), JSON.stringify(fileSchema.parse(file)), { mode: 0o600 });
}
