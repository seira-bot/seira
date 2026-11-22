# Folder access

An admin chooses which other folders a bot may use. A choice applies to one bot, or to every bot in a department.
Each folder is read-only or **Can change**. **Only chosen folders** limits a bot to those folders, its working
folder and its own folder. Code: `server/folder-access.ts`, `server/bot-folders.ts`, `server/department-folders.ts`.

## Where to set it

| For | Place |
|---|---|
| One bot | The bot's panel, page **Folder**, card **Other folders**. Advanced bot settings, section **Access** |
| A department | The team map, the department's menu, **Folders** |

- Only an admin can change folder access. The server refuses an editor, a member or a bot with `403`.
- A Team Cloud home and a hosted workspace refuse the setting. The UI says "Folders are set on the computer where Seira runs."
- A bot with no setting, in a department with no setting, works as before. Its box plan, engine arguments and file roots do not change.

## How the folders add up

- A turn gets the department's folders plus the bot's own folders.
- When both lists hold the same folder, the bot's entry replaces the department's entry.
- Access is limited when the bot or its department turns on **Only chosen folders**. The bot's card then reads "Set by <department>".
- A list holds at most 20 folders.
- A department's list moves with a rename of the department, and goes away when the department is deleted.

Bot settings keep the bot's list in `folderAccess` (`{ limited, folders: [{ path, write }] }`). Department lists live in
`department-folders.json` in the data folder, mode 0600.

## What the server refuses

When an admin saves a list, the server refuses with `400` and a plain message a path that:

- is relative, missing, or not a folder;
- is the file system root or a system folder (`/etc`, `/usr`, `/proc`, `C:\Windows` and others);
- is inside the Seira data folder, or holds it;
- makes the list longer than 20 folders.

The server stores each folder as its real path. When a turn starts, it checks each folder again. A folder that is gone,
or whose real path changed (for example, a symbolic link that now points somewhere else), stays out of that turn. The
server writes one log line for it.

## Where each rule holds

| Layer | Read-only folder | Can change folder | Only chosen folders |
|---|---|---|---|
| Bot box (Linux: a Cloud home for every bot, a computer for limited bots; [bot-box.md](bot-box.md#chosen-folders)) | Bound read-only, also inside a folder bound read-write | Bound read-write | Every command the engine runs sees only these folders. `HOME` is an empty private folder. Engine sign-ins come back read-write, program installs and git settings read-only |
| Claude Code | `--add-dir` and `permissions.additionalDirectories`; `Edit`, `Write` and `NotebookEdit` denied under it | `--add-dir` and `permissions.additionalDirectories` | Reads and writes outside the working folders blocked. Claude Code 2.1.330 or later; an older known version refuses the turn with "Update Claude Code to let this bot use only its chosen folders." |
| Codex | Not a writable root | Added to `writableRoots` of a workspace-write sandbox | Full access runs in workspace-write with network on, so only the working folder and Can change folders are writable |
| OpenCode | Allowed in `external_directory`; `edit` denied under it | Allowed in `external_directory` | Every other outside folder denied |
| Antigravity | Its file reads through Seira are allowed; its file writes through Seira are refused | Its file reads and writes through Seira are allowed | Its file calls through Seira always stay inside the working folder and the chosen folders. Its own commands are not limited; use the bot box |
| Seira's own file tools (attach, show, the file tools of in-process chat engines) | Files can be shown and attached; a write is refused | Files can be shown, attached and written | A path outside the working folder, the bot's own folder and the chosen folders is refused |
| Publishing an app | A read-only folder is never a source, and no app record is written inside one | Can be a source | No change |

A kept engine process starts again on the bot's next turn when its folders change.

## What it does not do

- **Commands where the bot box does not run.** On a Linux computer the box runs the turns of a bot with **Only chosen
  folders** on, when unprivileged bubblewrap works ([bot-box.md](bot-box.md#on-a-linux-computer)). It does not run for
  a bot without that limit, on macOS, on Windows, in the Flatpak, or where the kernel refuses user namespaces. There a
  shell command that the engine runs can open any file the computer's user can open. Claude Code and OpenCode stop
  their own edit tools in a read-only folder, not a command such as `bash`. The folder card says so and points to
  **Ask for approval**, which shows each command first. Where the box runs, the card says that commands also see only
  these folders.
- **Reads on Codex, Gemini and other ACP engines where the box does not run.** These engines have no read setting per
  folder.
- **The engines' sign-in folders in a box on a computer.** They stay shared and read-write, so a limited bot can change
  settings that the person's own CLI runs ([bot-box.md](bot-box.md#what-it-does-not-do-yet)).
- **Codex: a read-only folder inside a writable one.** A read-only folder inside the working folder or inside a Can
  change folder stays writable. Codex 0.171.0 has no read-only subfolder in its sandbox policy.
- **Claude Code: a Can change folder inside a read-only one.** The deny rules of the read-only folder also cover the
  inner folder, so it becomes read-only. A folder name with `*`, `?`, brackets or parentheses can stop a deny rule from
  matching.
- **OpenCode path forms.** The `edit` deny rules use three path forms. Not every OpenCode version was checked against them.
- **A folder swap during a call.** Seira's file tools check a path and then use it. A folder swapped between the two
  steps is not caught. The bot box binds real paths when the process starts.
- **More than one working folder per conversation.** A conversation still has one working folder.
- **Team Cloud and hosted workspaces.** The setting is refused there in this version.
- **Bot creation and copies.** A new bot starts with no folder setting, and a copy of a bot does not take its folders.
