import type { ContainerSummary, Docker, VolumeInfo } from "./docker.ts";
import { LABELS, LEGACY_LABELS, LEGACY_MADE_BY_LABEL, MADE_BY_LABEL } from "./settings.ts";

const LEGACY_NAME = new Map<string, string>([
  ...(Object.keys(LABELS) as Array<keyof typeof LABELS>).map((key) => [LABELS[key], LEGACY_LABELS[key]] as const),
  [MADE_BY_LABEL, LEGACY_MADE_BY_LABEL],
]);

type Labels = Record<string, string> | null | undefined;

/** A label's value under its current name, else under the name an earlier version wrote. */
export function labelValue(labels: Labels, name: string): string | undefined {
  const current = labels?.[name];
  if (current !== undefined) return current;
  const legacy = LEGACY_NAME.get(name);
  return legacy === undefined ? undefined : labels?.[legacy];
}

/** The same labels with each name an earlier version wrote changed to the current one; a current name wins. */
export function currentLabels(labels: Labels): Record<string, string> {
  const out: Record<string, string> = {};
  const legacyToCurrent = new Map([...LEGACY_NAME].map(([current, legacy]) => [legacy, current]));
  for (const [name, value] of Object.entries(labels ?? {})) {
    const current = legacyToCurrent.get(name);
    if (current === undefined) out[name] = value;
    else if (labels?.[current] === undefined) out[current] = value;
  }
  return out;
}

const legacyFilter = (labels: Record<string, string>) => Object.fromEntries(Object.entries(labels).map(([name, value]) => [LEGACY_NAME.get(name) ?? name, value]));

/** The containers with these labels, found under the current names and under the names earlier versions wrote. */
export async function listContainers(docker: Docker, labels: Record<string, string>): Promise<ContainerSummary[]> {
  const found = new Map<string, ContainerSummary>();
  for (const filter of [labels, legacyFilter(labels)]) for (const container of await docker.listContainers(filter)) found.set(container.Id, container);
  return [...found.values()];
}

/** The volumes with these labels, found under the current names and under the names earlier versions wrote. */
export async function listVolumes(docker: Docker, labels: Record<string, string>): Promise<VolumeInfo[]> {
  const found = new Map<string, VolumeInfo>();
  for (const filter of [labels, legacyFilter(labels)]) for (const volume of await docker.listVolumes(filter)) found.set(volume.Name, volume);
  return [...found.values()];
}
