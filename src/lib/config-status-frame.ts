import type { ConfigStatus } from "@/state/config-status";

/** A live `config` frame: the GET /api/config body inside the stream's `kind` and `seq`. */
export type ConfigStatusFrame = ConfigStatus & { kind?: "config"; seq?: number };

export function configStatusFromFrame(frame: ConfigStatusFrame): ConfigStatus {
  const { kind: _kind, seq: _seq, ...status } = frame;
  return status;
}
