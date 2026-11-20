// The one place that names what earlier versions called things. Each name here exists only so a person who updates keeps
// their data: folders and files are moved to the current name once, and old user files still open.

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
/** The header an earlier version sent a webhook secret in. */
export const LEGACY_WEBHOOK_AUTH_HEADER = "x-openmaus-secret";
/** The header the deployed event broker still reads the poller id from. */
export const LEGACY_POLLER_HEADER = "x-omb-poller";
