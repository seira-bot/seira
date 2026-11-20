/** Never waits: returns the last answer for `key` and, when that answer is
 * stale or was for another key, asks again in the background. One question at
 * a time; a failed question answers `empty`. */
export function backgroundAnswer<K, T>(
  ask: (key: K) => Promise<T>,
  empty: T,
  { now = Date.now, maxAgeMs }: { now?: () => number; maxAgeMs: number },
): (key: K) => T {
  let known = empty;
  let knownKey: string | null = null;
  let checkedAt = Number.NEGATIVE_INFINITY;
  let asking = false;
  return (key) => {
    const id = JSON.stringify(key) ?? "";
    if (id !== knownKey) {
      if (asking) return empty;
      knownKey = id;
      known = empty;
      checkedAt = Number.NEGATIVE_INFINITY;
    }
    if (asking || now() - checkedAt < maxAgeMs) return known;
    asking = true;
    ask(key)
      .then(
        (answer) => { known = answer; },
        () => { known = empty; },
      )
      .finally(() => {
        checkedAt = now();
        asking = false;
      });
    return known;
  };
}
