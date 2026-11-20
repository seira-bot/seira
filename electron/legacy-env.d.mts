export declare const LEGACY_ENV_REMOVAL: string;
export declare function isHarnessEnvName(name: string): boolean;
export declare function adoptLegacyEnv(
  env?: Record<string, string | undefined>,
  warn?: (line: string) => void,
): { adopted: string[]; conflicts: string[] };
