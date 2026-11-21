import type { LocalSource } from "./reader.ts";

export async function locateLocalSources(_env: NodeJS.ProcessEnv, _home: string): Promise<LocalSource[]> {
  return [];
}
