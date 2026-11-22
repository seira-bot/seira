export type PhoneWorksOnChange = "off" | "own-server";

export interface PhoneWorksOnContext {
  pairedDevice: boolean;
  scopes: readonly string[];
  cloudHome: boolean;
  hostedWorkspace: boolean;
}

/** NFR-047: a paired device may move a bot only to no computer or to the server the host already set up for it, and
 * changes nothing else in the same request. Null leaves the request to the ordinary rules. */
export function pairedDeviceWorksOnChange(body: unknown, ctx: PhoneWorksOnContext): PhoneWorksOnChange | null {
  if (!ctx.pairedDevice || !ctx.scopes.includes("admin") || ctx.cloudHome || ctx.hostedWorkspace) return null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const fields = body as Record<string, unknown>;
  const keys = Object.keys(fields).sort();
  if (keys.length === 1 && keys[0] === "computer" && fields.computer === "off") return "off";
  if (keys.length === 2 && keys[0] === "cloudBackend" && keys[1] === "computer" && fields.computer === "cloud" && fields.cloudBackend === "vps") return "own-server";
  return null;
}
