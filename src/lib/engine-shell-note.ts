import type { ConfigStatus, InstanceInfo } from "@/state/store";

/**
 * An API engine (an OpenAI-compatible endpoint) is a chat engine inside Seira. It runs a command only on a computer
 * Seira lends it. Where This computer is not available and no Cloud VPS or My Cloud is set up, a bot on such an engine
 * can lose its shell without any other sign. The page cannot see whether a Local VM is set up, so this only says when the
 * shell may be missing; it changes no setting.
 */
export function engineMayLackShell({ instance, capabilities, config }: {
  instance: Pick<InstanceInfo, "driverKind"> | undefined;
  capabilities: Pick<DesktopCapabilities, "localComputer">;
  config: Pick<ConfigStatus, "cloudHome" | "vps"> | null | undefined;
}): boolean {
  if (instance?.driverKind !== "openai-compat") return false;
  if (capabilities.localComputer.available) return false;
  return config?.cloudHome !== true && config?.vps?.configured !== true;
}
