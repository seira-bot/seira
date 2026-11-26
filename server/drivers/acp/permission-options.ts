// Which option of an ACP `session/request_permission` the driver sends for an answer. An approval never takes a
// wider option than the one the person gave: "allow" picks only `allow_once`, and "allow for this session" picks
// `allow_always` only when the agent ends that option with its own session (`nativeSessionGrant`).
export type PermissionOption = { optionId?: string; kind?: string; name?: string };

const optionId = (o: PermissionOption | undefined) => (typeof o?.optionId === "string" ? o.optionId : undefined);

export function permissionOptions(options: PermissionOption[], nativeSessionGrant: boolean) {
  const once = (kind: string) => optionId(options.find((o) => o.kind === kind && typeof o.optionId === "string"));
  return {
    optionFor: (want: "allow" | "reject"): string | null =>
      once(`${want}_once`) ?? (want === "reject" ? optionId(options.find((o) => String(o.kind ?? "").startsWith("reject") && typeof o.optionId === "string")) : undefined) ?? null,
    optionAlways: nativeSessionGrant ? once("allow_always") ?? null : null,
  };
}
