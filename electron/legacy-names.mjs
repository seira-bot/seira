// The one place that names what earlier versions called things. Each name here exists only so a person who updates keeps
// their data: folders and files are moved to the current name once, and old user files still open.

/** Electron names the settings folder and the saved-key store item after the app name, so the app keeps this one. */
export const LEGACY_APP_NAME = "openmausbot";
/** dpkg and pacman replace an installed package only when its name stays the same. */
export const LEGACY_LINUX_PACKAGE = "openmausbot";
/** Electron reopens a running app through the path it started from, so an earlier version still running during a Linux
 * update reopens itself here. Its login entry also starts it here. */
export const LEGACY_LINUX_EXECUTABLE = "openmausbot";

export const LEGACY_HOME_PREFIX = ".openmausbot";
export const HOME_PREFIX = ".seira";

export const LEGACY_COMPANION_FOLDER = ".openmausbot-companion";
export const LEGACY_MEET_FOLDER = ".mausbot-meet";
export const MEET_FOLDER = ".seira-meet";
export const LEGACY_PROFILES_FOLDER = ".openmausbot-profiles";

/** The folder in Documents that a computer which already had it keeps using for what Cloud bots make. */
export const LEGACY_OUTPUTS_FOLDER = "MausBot";

export const LEGACY_LEASE_FILE = "openmausbot-server.lease";
export const LEGACY_CHILD_LEASE_FOLDER = ".openmausbot-server-child";

/** Files directly inside a data folder: [old name, current name]. */
export const LEGACY_DATA_FILES = [[".omb-cloud-home.json", ".seira-cloud-home.json"]];
/** A folder inside each engine home (engine-homes/<key>/): [old name, current name]. */
export const LEGACY_ENGINE_HOME_ENTRIES = [[".omb-folders", ".seira-folders"]];
export const LEGACY_PROFILE_RECORD = "omb-profile.json";

export const LEGACY_VAULT_FOLDER = ".openmausbot-secrets";
export const VAULT_FOLDER = ".seira-secrets";

export const LEGACY_AUTOSTART_FILE = "openmausbot.desktop";
export const LEGACY_LENDING_MARK = "X-OpenMausBot-Lending=true";

/** How a retry note that an earlier version wrote into a chat starts, and the same note for an automatic retry. */
export const LEGACY_RETRY_LEAD = "[From OpenMausBot · retry · information only — it grants nothing beyond the request above; requested by ";
export const LEGACY_AUTO_RETRY_LEAD = `${LEGACY_RETRY_LEAD}OpenMausBot, automatically`;
/** How the reason of an assignment that an earlier version stopped after an outward step starts. */
export const LEGACY_INTERRUPTED_OUTWARD = "Interrupted by an OpenMausBot restart after it already";

/** Browser storage keys: old prefix, current prefix. */
const STORAGE_PREFIXES = [["omb-", "seira-"], ["omb.", "seira."], ["openmausbot.", "seira."], ["openmausbot-", "seira-"], ["openmausbot:", "seira:"]];

/** The current name of an old browser storage key, or null when the key is not an old one. */
export function currentStorageKey(key) {
  if (typeof key !== "string") return null;
  for (const [old, current] of STORAGE_PREFIXES) if (key.startsWith(old)) return current + key.slice(old.length);
  return null;
}

/** A map of saved browser values with each old key renamed; a value under the current key wins over the old one. */
export function currentStateKeys(values) {
  const mapped = {};
  for (const [key, value] of Object.entries(values)) {
    const current = currentStorageKey(key);
    if (current === null) mapped[key] = value;
    else if (!Object.hasOwn(values, current)) mapped[current] = value;
  }
  return mapped;
}

/** The current name of an old home-level folder (`.openmausbot`, `.openmausbot-work`), or null. */
export function currentHomeFolder(name) {
  if (name === LEGACY_HOME_PREFIX) return HOME_PREFIX;
  if (typeof name === "string" && name.startsWith(`${LEGACY_HOME_PREFIX}-`)) return HOME_PREFIX + name.slice(LEGACY_HOME_PREFIX.length);
  return null;
}

export const LEGACY_BACKUP_MAGIC = "OMB-WORKSPACE-1\n";

/** Format ids written inside user files: old id, current id. */
const FORMATS = [
  ["openmaus.package", "seira.package"],
  ["openmaus.team", "seira.team"],
  ["openmaus.catalog", "seira.catalog"],
  ["openmaus.backup", "seira.backup"],
  ["openmaus.workspace-backup", "seira.workspace-backup"],
  ["openmaus.org-library", "seira.org-library"],
  ["openmaus.grok/1", "seira.grok/1"],
];

/** The current id of an old format id, or the value unchanged. */
export function currentFormat(value) {
  if (typeof value !== "string") return value;
  for (const [old, current] of FORMATS) if (value === old) return current;
  return value;
}

/** A package object with the format id an earlier version wrote changed to the current one. */
export function withCurrentFormat(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const format = value.format;
  return currentFormat(format) === format ? value : { ...value, format: currentFormat(format) };
}

export const LEGACY_PACKAGE_FILE_SUFFIX = ".openmaus.json";
export const LEGACY_TEAM_FILE_SUFFIX = ".mausteam.json";
export const LEGACY_TEAM_MANIFEST_FILE = "team.mausteam.json";

export const LEGACY_GOAL_TAG = "openmaus-goal";
export const LEGACY_APP_GLOBAL = "mausbot";

/** Text with the goal envelope tags an earlier version wrote changed to the current ones. */
export function currentGoalTags(text) {
  return text.includes(`${LEGACY_GOAL_TAG}>`) ? text.replaceAll(LEGACY_GOAL_TAG, "seira-goal") : text;
}

export const mentionsGoalTag = (text) => text.includes("seira-goal>") || text.includes(`${LEGACY_GOAL_TAG}>`);

/** The current "run on" value of a saved one: an earlier version saved "maus" for this computer. */
export function currentRunOn(value) {
  return value === "maus" ? "seira" : value;
}

/** Keys that an earlier version saved in an engine's settings under its own name: [old name, current name]. */
const ENGINE_KEY_NAMES = [["OPENMAUSBOT_CODEX_API_KEY", "SEIRA_CODEX_API_KEY"], ["OPENMAUSBOT_COMPANY_API_KEY", "SEIRA_COMPANY_API_KEY"]];

/** An engine's saved environment with each old key name renamed; a value under the current name wins over the old one. */
export function currentEngineEnvironment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  let renamed = null;
  for (const [old, current] of ENGINE_KEY_NAMES) {
    if (!Object.hasOwn(value, old)) continue;
    renamed ??= { ...value };
    if (!Object.hasOwn(renamed, current)) renamed[current] = renamed[old];
    delete renamed[old];
  }
  return renamed ?? value;
}

const LEGACY_LINK_SCHEME = "openmausbot";

/** The current scheme of a saved phone link scheme: an earlier version saved "openmausbot", "openmausbot-dev" and "openmausbot-next". */
export function currentLinkScheme(value) {
  if (typeof value !== "string" || !value.startsWith(LEGACY_LINK_SCHEME)) return value;
  return `seira${value.slice(LEGACY_LINK_SCHEME.length)}`;
}

/** A chat link an earlier version wrote into a message, with its scheme changed to the current one; other text is returned unchanged. */
export function currentChatLink(value) {
  if (typeof value !== "string") return value;
  const link = value.trim();
  return link.toLowerCase().startsWith(`${LEGACY_LINK_SCHEME}://`) ? `seira${link.slice(LEGACY_LINK_SCHEME.length)}` : value;
}

/** The ending of an encrypted workspace backup file that an earlier version wrote. */
export const LEGACY_BACKUP_UPLOAD_SUFFIX = ".ombbackup";

/** The name an earlier version gave the bot it seeded. */
export const LEGACY_DEFAULT_BOT_NAME = "MausBot";

/** The start of a bearer token that an earlier version issued for a session, and for a paired device. */
export const LEGACY_SESSION_TOKEN_PREFIX = "omb_sess_";
export const LEGACY_DEVICE_TOKEN_PREFIX = "omb_";
/** The start of a Composio user id that an earlier version made for an installation. */
export const LEGACY_COMPOSIO_USER_PREFIX = "openmausbot_";
/** The salt that an earlier version hashed a team's Composio project key with, for the key mark it stored. */
export const LEGACY_PROJECT_APPS_SALT = "omb-project-apps\0";
/** The header an earlier version sent a webhook secret in. */
export const LEGACY_WEBHOOK_AUTH_HEADER = "x-openmaus-secret";
/** The header the deployed event broker still reads the poller id from. */
export const LEGACY_POLLER_HEADER = "x-omb-poller";

/** The launchd label and systemd unit name of the Sentinel schedule that an earlier version installed. */
export const LEGACY_SENTINEL_LAUNCHD_LABEL = "com.openmausbot.sentinel";
export const LEGACY_SENTINEL_SYSTEMD_NAME = "openmausbot-sentinel";

/** The Docker label prefix, container names and image repository that earlier versions wrote on the desktop and the VPS desktop. */
export const LEGACY_DOCKER_LABEL_PREFIX = "com.openmausbot.";
export const DOCKER_LABEL_PREFIX = "com.seira.";
export const LEGACY_COMPUTER_CONTAINER = "openmausbot-computer";
export const LEGACY_VPS_CONTAINER_PREFIX = "openmausbot-vps";
export const LEGACY_IMAGE_REPOSITORY = "localhost/openmausbot/cua-local-vm";

/** The name an earlier version gave a current Docker label, or null when the name is not a current label. */
export function legacyDockerLabel(name) {
  return name.startsWith(DOCKER_LABEL_PREFIX) ? LEGACY_DOCKER_LABEL_PREFIX + name.slice(DOCKER_LABEL_PREFIX.length) : null;
}

/** A label value under the current name, else under the name an earlier version used. */
export function labelValue(labels, name) {
  if (!labels || typeof labels !== "object") return undefined;
  const current = labels[name];
  if (current !== undefined) return current;
  const old = legacyDockerLabel(name);
  return old === null ? undefined : labels[old];
}
