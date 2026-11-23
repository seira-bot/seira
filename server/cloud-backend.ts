export const CLOUD_BACKEND_CHANGE_ERROR = "stop the active turn before changing the cloud backend";
export const VPS_ALIAS_RESOURCES_ERROR =
  "remove this installation's VPS computers before changing or clearing the SSH config alias";

export const VPS_BOT_ALIAS_RESOURCES_ERROR =
  "remove this bot's VPS computer before changing its SSH config alias (Settings → Desktops & browser → Desktops)";
export const VPS_BOT_ALIAS_CHANGE_ERROR = "stop the active turn before changing this bot's VPS SSH alias";
export const VPS_BOT_ALIAS_LIFECYCLE_ERROR = "wait for VPS computer actions to finish before changing this bot's SSH alias";

/** A server that cannot answer never keeps a bot on it or keeps it alive: what may be left there, and how to remove it. */
export function vpsLeftBehindNotice(done: "Moved" | "Deleted", alias: string, containerName: string): string {
  return `${done}. ${alias} could not be reached, so this bot's computer there, if it is still there, was left as it is. ` +
    `When ${alias} is back, remove it with: docker -H ssh://${alias} rm -f ${containerName}`;
}

/** Why a bot has no cloud computer while a self-hosted VPS is saved but not chosen for it. */
export function vpsNotChosenReason(botName: string, vpsAlias: string | null): string | null {
  return vpsAlias ? `${botName} has no cloud computer of its own. The self-hosted VPS ${vpsAlias} is set up ` +
    `but not chosen for ${botName}: ask the person to choose Self-hosted VPS as the cloud backend in ${botName}'s Bot settings, ` +
    `Access section, then select cloud again.` : null;
}

export function cloudBackendChangeError(botBusy: boolean, activeVpsThread: boolean): string | null {
  return botBusy || activeVpsThread ? CLOUD_BACKEND_CHANGE_ERROR : null;
}

export function vpsBotAliasChangeError(botBusy: boolean, activeVpsThread: boolean): string | null {
  return botBusy || activeVpsThread ? VPS_BOT_ALIAS_CHANGE_ERROR : null;
}

export function vpsAliasResourceChangeError(instanceCount: number): string | null {
  return instanceCount > 0 ? VPS_ALIAS_RESOURCES_ERROR : null;
}
