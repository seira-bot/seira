import { createHash } from "node:crypto";
import { LEGACY_VPS_CONTAINER_PREFIX } from "../electron/legacy-names.mjs";

export const VPS_MANAGED_LABEL = "com.seira.vps";
export const VPS_CONTAINER_LABEL = "com.seira.container";
export const VPS_ENVIRONMENT_LABEL = "com.seira.environment";
export const VPS_VIEWER_LABEL = "com.seira.vps-viewer";
export const VPS_CONTAINER_PREFIX = "seira-vps";
export const MANAGED_VPS_CONTAINER_NAME = new RegExp(`^(?:${VPS_CONTAINER_PREFIX}|${LEGACY_VPS_CONTAINER_PREFIX})-[a-z0-9]{1,12}-[a-f0-9]{12}$`);

type Inspect<T> = (args: string[]) => Promise<T>;

/** Docker and Podman report "No such object/image/container"; any other inspect failure is transport, not absence. */
export function isMissingObjectMessage(message: string): boolean {
  return /no such (object|image|container)/i.test(message);
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function containerNamePart(botId: string): string {
  return botId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "bot";
}

export function vpsContainerName(botId: string): string {
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 12);
  return `${VPS_CONTAINER_PREFIX}-${containerNamePart(botId)}-${hash}`;
}

export function vpsLegacyContainerName(botId: string): string {
  return vpsContainerName(botId).replace(VPS_CONTAINER_PREFIX, LEGACY_VPS_CONTAINER_PREFIX);
}

export function isVpsContainerOf(botId: string, containerName: string): boolean {
  return containerName === vpsContainerName(botId) || containerName === vpsLegacyContainerName(botId);
}

export async function inspectImageOrLegacy<T>(inspect: Inspect<T>, image: string, legacyImage: string): Promise<T> {
  try {
    return await inspect(["image", "inspect", image]);
  } catch (error) {
    if (!isMissingObjectMessage(messageOf(error))) throw error;
    return inspect(["image", "inspect", legacyImage]);
  }
}

export async function inspectContainerOrLegacy<T>(inspect: Inspect<T>, botId: string, name: string): Promise<{ found: T; name: string }> {
  try {
    return { found: await inspect(["inspect", name]), name };
  } catch (error) {
    if (!isMissingObjectMessage(messageOf(error))) throw error;
    const legacyName = vpsLegacyContainerName(botId);
    try {
      return { found: await inspect(["inspect", legacyName]), name: legacyName };
    } catch {
      throw error;
    }
  }
}
