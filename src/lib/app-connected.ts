const queue: Array<{ slug: string; app: string }> = [];
const watchers = new Set<() => void>();

/** An app was connected from a chat card, away from the Apps pop-up. */
export function announceAppConnected(slug: string, app: string) {
  queue.push({ slug, app });
  for (const watch of Array.from(watchers)) watch();
}

export function subscribeAppConnected(watch: () => void) {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}

export const pendingAppConnections = () => queue.length;
export const takeAppConnections = () => queue.splice(0);
