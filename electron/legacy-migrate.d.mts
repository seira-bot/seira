export declare const LEGACY_MOVE_RECEIPT: string;
export declare function rewriteLegacyHomePaths(text: string): string;

interface MigrateOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  fs?: typeof import("node:fs");
  log?: (line: string) => void;
  held?: (dataDir: string) => boolean;
}

export declare function migrateHomeFolders(options: MigrateOptions & { home: string; rewriteFiles?: string[] }): [string, string][];
export declare function migrateLegacyData(options: { home: string; dataDir: string; log?: (line: string) => void }): void;
export declare function migrateInnerFiles(options: MigrateOptions & { dataDir: string; home?: string }): [string, string][];
