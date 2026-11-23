// Read before main.tsx's first-paint writes: applySkin stamps seira-skin on every boot.
const PRIOR_RUN_KEYS = ["seira-skin", "seira-installed", "seira-email-gate", "seira-drafts", "seira-show-threads"];

export function hasPriorRun(store: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return PRIOR_RUN_KEYS.some((key) => store?.getItem(key) != null);
  } catch {
    return false;
  }
}
