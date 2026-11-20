import { readFileSync } from "node:fs";

// CI runs test files side by side on vitest's workers, and a suite's ports are only probed, never reserved. So a port's
// low bits name the worker that may use it: two workers never pick the same port, whatever range each asks for. Two
// slots each, because a harness also listens one above its own port. Outside a worker a port stays as it was picked.
const SLOTS = 32;
const FOLDED_SPAN = 124 * SLOTS;

export function forWorker(port: number, poolId: string | undefined = process.env.VITEST_POOL_ID): number {
  const id = Number(poolId);
  if (!Number.isSafeInteger(id) || id < 1) return port;
  return port - (port % SLOTS) + ((id - 1) % (SLOTS / 2)) * 2;
}

/** The lowest port the OS hands out itself: Linux's ip_local_port_range, else IANA's dynamic range (macOS, Windows).
 * Every outgoing connection on the machine holds one of these as its local port, and a listener cannot bind a port that
 * an open connection holds (EADDRINUSE), so a probe that found it free does not keep it free. */
export function ephemeralFloor(): number {
  try {
    return Number(readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0]) || 49_152;
  } catch {
    return 49_152;
  }
}

let floorOfThisMachine: number | undefined;

/** A port at or above the ephemeral floor moves into the blocks just below it, so it and the port above it stay out of
 * the range that outgoing connections take. A port below the floor stays as it is. */
export function belowEphemeral(port: number, floor = floorOfThisMachine ??= ephemeralFloor()): number {
  const limit = floor - (floor % SLOTS);
  if (port < limit) return port;
  const span = Math.min(FOLDED_SPAN, limit - 1_024);
  return limit - span + ((port - limit) % span);
}

/** A random port of this worker in `from`..`from + span`, for a suite that has no time to probe. */
export function workerPort(from: number, span: number): number {
  return forWorker(belowEphemeral(from + Math.floor(Math.random() * span)));
}
