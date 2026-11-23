// The export file that Hermes Agent writes for Seira, and the skill text that tells Hermes how to write it.

export const HERMES_EXPORT = {
  manifest: "seira-import.json",
  format: "seira-agent-import",
  version: 1,
  app: "hermes-agent",
  skill: "seira-export",
  filePrefix: "seira-export-hermes",
} as const;

export const HERMES_EXPORT_LIMITS = {
  manifestBytes: 8 * 1024 * 1024,
  agents: 32,
  keyChars: 64,
  nameChars: 80,
  personaChars: 100_000,
  entries: 1_000,
  entryChars: 8_000,
  skills: 64,
  routines: 128,
  promptChars: 16_000,
  channels: 32,
  skillFiles: 200,
  skillBytes: 16 * 1024 * 1024,
} as const;

/**
 * The wire format of `seira-import.json`. Every agent path starts with `agents/<key>/`.
 * `schedule`: a 5-field cron line, `every <n><m|h|d>`, or an ISO date for one run.
 * `source.timeZone`: the IANA zone the cron lines run in. `source.instance`: a stable id of the Hermes folder.
 */
export interface HermesExportManifest {
  format: typeof HERMES_EXPORT.format;
  version: typeof HERMES_EXPORT.version;
  source: { app: typeof HERMES_EXPORT.app; exportedAt?: string; timeZone?: string; instance?: string };
  agents: HermesExportAgent[];
}

export interface HermesExportAgent {
  key: string;
  name: string;
  persona?: string;
  aboutYou?: string[];
  memories?: string[];
  skills?: string[];
  routines?: Array<{ name: string; prompt: string; schedule: string }>;
  channels?: string[];
}

export const EXPORT_KEY = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const EXPORT_INSTANCE = /^[0-9a-f]{16,64}$/;
export const EXPORT_CHANNEL = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Security invariant: an export that holds one of these files is refused whole, never read in part. */
const SECRET_FILES = new Set([
  "auth.json", ".credentials.json", "credentials.json", "secrets.json", "auth-profiles.json", "token.json",
  ".netrc", ".npmrc", ".pypirc", ".git-credentials", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
]);
const SECRET_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".kdbx", ".gpg", ".asc"];
const SECRET_FOLDERS = new Set(["credentials", ".ssh", ".gnupg", ".aws", "mcp-tokens"]);
const ARCHIVE_EXTENSIONS = [".zip", ".tar", ".gz", ".tgz", ".7z", ".rar", ".bz2", ".xz", ".zst"];
/** Folders a tool makes again; an export leaves them out of a skill. */
export const REBUILT_FOLDERS: ReadonlySet<string> = new Set([".git", "node_modules", ".venv", "venv", "__pycache__"]);

export type RefusedEntry = "secret" | "archive";

/** Why an entry name makes the whole export unsafe to read, or null. `name` uses "/" separators. */
export function refusedEntry(name: string): RefusedEntry | null {
  const parts = name.toLowerCase().split("/");
  const file = parts.at(-1) ?? "";
  if (file.startsWith(".env") || /private.*key/.test(file) || SECRET_FILES.has(file)
    || SECRET_EXTENSIONS.some((extension) => file.endsWith(extension))
    || parts.slice(0, -1).some((part) => SECRET_FOLDERS.has(part))) return "secret";
  if (ARCHIVE_EXTENSIONS.some((extension) => file.endsWith(extension))) return "archive";
  return null;
}

const list = (items: readonly string[]) => items.map((item) => `\`${item}\``).join(", ");

/** The skill a person gives to Hermes. Hermes follows it as written, so it names every rule the reader checks. */
export const HERMES_EXPORT_SKILL = `---
name: ${HERMES_EXPORT.skill}
description: Export the user's Hermes Agent profiles into one .zip file that Seira imports, with each profile's persona, memories, skills, routines and channel names. Use when the user asks to move, export or migrate Hermes to Seira.
---

# Export Hermes profiles for Seira

Make one \`.zip\` file. The user drops it in Seira at **Settings → Import & export → Bring things in → Move from another AI**.
Each Hermes profile becomes one Seira bot. Seira refuses the whole file when the manifest is wrong or when the
file holds a key, so follow the format below exactly.

## Steps

1. **Find the profiles.** The Hermes folder is \`$HERMES_HOME\`, or \`~/.hermes\` when it is not set. When
   \`$HERMES_HOME\` ends in \`/profiles/<name>\`, the Hermes folder is two levels up.
   - The \`default\` profile is the Hermes folder itself.
   - Each other profile is a folder in \`<Hermes folder>/profiles/\`. Skip \`profiles/.deleted\`.
   - A folder is a profile when it has \`SOUL.md\` or \`config.yaml\`.

2. **Read each profile.** Read only these files:
   - \`SOUL.md\`: the persona. Remove HTML comments. When only a heading is left, the profile has no persona.
   - \`memories/USER.md\` (about the user) and \`memories/MEMORY.md\` (memories). A line with only \`§\` separates
     two entries.
   - \`skills/\`: each folder with a \`SKILL.md\`, at \`skills/<name>/\` or \`skills/<category>/<name>/\`. Skip folders
     whose name starts with \`.\`. Skip each skill whose frontmatter \`name\` is in \`skills/.bundled_manifest\` (one
     \`name:hash\` on each line): Hermes ships those. Skip this skill (\`${HERMES_EXPORT.skill}\`).
   - \`cron/jobs.json\`: \`{"jobs": [...]}\`. Each job has \`name\`, \`prompt\`, \`schedule\`, \`enabled\` and \`state\`.
   - \`config.yaml\`: read only the names of the keys under \`platforms:\`, such as \`telegram\`. Copy no value.

   Do not open \`.env\`, \`auth.json\`, \`state.db\`, \`sessions/\`, \`mcp-tokens/\` or \`vault/\`. They hold keys and
   chat history. Seira does not take them from a file.

3. **Ask which profiles.** Show each profile with its number of memories, skills and routines. Ask: "Export all
   profiles, or only some?" Wait for the answer.

4. **Map each profile** to one entry of \`agents\` (see Format):
   - \`key\`: the profile name in lowercase, with \`_\` and spaces changed to \`-\`. The \`default\` profile has the
     key \`hermes\`.
   - \`name\`: \`Hermes\` for the \`default\` profile. Else the profile name as words, first letter in capitals:
     \`research-desk\` becomes \`Research desk\`.
   - \`persona\`: the text of \`SOUL.md\`. Leave it out when the profile has no persona.
   - \`aboutYou\`: the entries of \`memories/USER.md\`. \`memories\`: the entries of \`memories/MEMORY.md\`.
   - \`skills\`: copy each skill folder to \`agents/<key>/skills/<folder name>/\`, and list that path.
   - \`routines\`: one for each job (see Schedules). Skip a job that has a \`script\`, or has \`no_agent\` set: it
     runs a script, not the agent. Seira brings every routine in paused.
   - \`channels\`: the names under \`platforms:\` in \`config.yaml\`. The user connects each one again in Seira.

5. **Remove secrets.** Copy no API key, token, password, cookie or private key, in a file or in text. In a persona,
   a memory or a prompt, replace a secret with \`<removed: ask the user>\`. Seira refuses the whole file when it
   holds a file named \`.env*\`, \`*private*key*\`, ${list([...SECRET_FILES])}, or a file that ends in
   ${list(SECRET_EXTENSIONS)}, or a folder named ${list([...SECRET_FOLDERS])}. It also refuses a file inside the
   file that ends in ${list(ARCHIVE_EXTENSIONS)}. Leave out a skill that has one of these, and tell the user. In each
   skill, leave out the folders ${list([...REBUILT_FOLDERS])}: a tool makes them again.

6. **Build the folder** in a new temporary folder outside the Hermes folder. Write \`${HERMES_EXPORT.manifest}\` last.

7. **Check it** with the checklist below. Then zip the contents of the folder, with \`${HERMES_EXPORT.manifest}\` at
   the root of the zip. Python works on every system:
   \`python3 -c "import shutil,sys; shutil.make_archive(sys.argv[1], 'zip', sys.argv[2])" <base> <folder>\`
   writes \`<base>.zip\`. Write it as \`.${HERMES_EXPORT.filePrefix}-<YYYY-MM-DD>.zip.part\` in \`~/Downloads\`, or in the
   home folder when \`~/Downloads\` does not exist. When the zip is complete, rename it to
   \`${HERMES_EXPORT.filePrefix}-<YYYY-MM-DD>.zip\` in the same folder. Then delete the temporary folder.

8. **Tell the user**, only after the rename: the path of the file, the number of bots, and what you left out.
   Server tools (MCP) and their keys stay in Hermes. Tell the user to open Seira, go to
   **Settings → Import & export → Bring things in → Move from another AI**, and drop the file there.
   When the user talks to you in a chat that only the user can read, offer to send the file there.
   Never send it to a group or a channel that other people read.

## Format

\`\`\`
${HERMES_EXPORT.manifest}
agents/<key>/skills/<folder>/SKILL.md    one folder for each skill
\`\`\`

\`<key>\` is lowercase letters, digits and hyphens, ${HERMES_EXPORT_LIMITS.keyChars} characters or fewer, and does not
start or end with a hyphen. Each key is unique. Every path of an agent starts with \`agents/<key>/\`.

\`${HERMES_EXPORT.manifest}\`:

\`\`\`json
{
  "format": "${HERMES_EXPORT.format}",
  "version": ${HERMES_EXPORT.version},
  "source": {
    "app": "${HERMES_EXPORT.app}",
    "exportedAt": "2026-11-23T10:00:00Z",
    "timeZone": "Europe/Warsaw",
    "instance": "3f9a0c1d2e4b5a6c"
  },
  "agents": [
    {
      "key": "hermes",
      "name": "Hermes",
      "persona": "You are Hermes, a calm personal assistant. Keep answers short.",
      "aboutYou": ["The user lives in Warsaw."],
      "memories": ["The user keeps notes in Obsidian."],
      "skills": ["agents/hermes/skills/daily-brief"],
      "routines": [{ "name": "Morning brief", "prompt": "Write my morning brief.", "schedule": "30 7 * * *" }],
      "channels": ["telegram"]
    }
  ]
}
\`\`\`

| Field | Rule |
| --- | --- |
| \`source.timeZone\` | The IANA time zone of this computer: \`$TZ\`, else \`timedatectl show -p Timezone --value\`, else the part of the \`/etc/localtime\` link after \`zoneinfo/\`. Leave it out when you cannot find it. |
| \`source.instance\` | The first 16 hex characters of the SHA-256 of \`<host name>:<Hermes folder path>\`. Seira uses it to update the same bots on the next export. |
| \`name\` | Required. ${HERMES_EXPORT_LIMITS.nameChars} characters or fewer. |
| \`persona\` | Optional. ${HERMES_EXPORT_LIMITS.personaChars.toLocaleString("en-US")} characters or fewer. |
| \`aboutYou\`, \`memories\` | Up to ${HERMES_EXPORT_LIMITS.entries.toLocaleString("en-US")} strings each, ${HERMES_EXPORT_LIMITS.entryChars.toLocaleString("en-US")} characters or fewer each. |
| \`skills\` | Up to ${HERMES_EXPORT_LIMITS.skills} folder paths. Each folder has \`SKILL.md\` at its root, with YAML frontmatter that has \`name\` and \`description\`. Each folder holds ${HERMES_EXPORT_LIMITS.skillFiles} files and ${HERMES_EXPORT_LIMITS.skillBytes / 1024 / 1024} MB or fewer. |
| \`routines\` | Up to ${HERMES_EXPORT_LIMITS.routines}. \`name\`: the job's \`name\`, or the first words of its prompt. \`prompt\`: the job's \`prompt\`, ${HERMES_EXPORT_LIMITS.promptChars.toLocaleString("en-US")} characters or fewer. |
| \`channels\` | Up to ${HERMES_EXPORT_LIMITS.channels} names. Names only, never a token. |

### Schedules

| Hermes \`schedule\` | Seira \`schedule\` |
| --- | --- |
| \`{"kind": "cron", "expr": "0 9 * * 1-5"}\` or \`"0 9 * * 1-5"\` | \`"0 9 * * 1-5"\` |
| \`{"kind": "interval", "minutes": 30}\` or \`"every 30m"\` | \`"every 30m"\`. Use \`h\` or \`d\` when the minutes divide evenly: \`"every 2h"\`. |
| \`{"kind": "once", "run_at": "2027-01-05T09:00:00+01:00"}\` | \`"2027-01-05T09:00:00+01:00"\`. Skip it when the time is in the past. |
| A relative time such as \`"in 30m"\` | Skip it, and tell the user. |

Seira reports each routine it cannot schedule. The rest of the bot still comes in.

## Checklist

- [ ] \`${HERMES_EXPORT.manifest}\` is at the root of the zip, not in a folder.
- [ ] \`format\` is \`${HERMES_EXPORT.format}\`, \`version\` is \`${HERMES_EXPORT.version}\`, and \`source.app\` is \`${HERMES_EXPORT.app}\`.
- [ ] Each \`key\` is unique, and each path starts with \`agents/<key>/\`.
- [ ] Each skill folder has \`SKILL.md\` with frontmatter. No skill is \`${HERMES_EXPORT.skill}\` or ships with Hermes.
- [ ] No secret in any file or text. No \`.env\`, \`auth.json\`, key file or archive inside the zip.
- [ ] No ${list([...REBUILT_FOLDERS])} folders.
`;
