/** One folder a bot may use: its full path on the computer where Seira runs, and whether the bot may change files in it. */
export interface WireFolderGrant { path: string; write: boolean }
/** A folder list. `limited` means nothing outside the listed folders and the working folder may be used. */
export interface WireFolderAccess { limited: boolean; folders: WireFolderGrant[] }
export interface FolderAccessField {
  /** Folders this bot may use beyond its working folder; absent means no folder setting. Set by an admin on the computer where Seira runs. */
  folderAccess?: WireFolderAccess;
}
