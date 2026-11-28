import { execFile } from "node:child_process";

export const TOP_INSET_MAX = 400;
/** A compositor probe that takes longer than this counts as no answer. */
export const PROBE_WAIT_MS = 1500;
export const TOP_INSET_ENV = "SEIRA_GLANCE_TOP_INSET";

/** A whole number of px from 0 to TOP_INSET_MAX, else null. */
export function validInset(value) {
  const number = typeof value === "string" && /^\d{1,3}$/.test(value) ? Number(value) : value;
  return Number.isInteger(number) && number >= 0 && number <= TOP_INSET_MAX ? number : null;
}

/** Runs a command and returns its stdout. Rejects on a missing binary, a non-zero exit or a timeout. */
export const runCommand = (cmd, args, timeout = PROBE_WAIT_MS) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
});

const sameOrigin = (rect, bounds) => rect.x === bounds.x && rect.y === bounds.y;
const inside = (rect, bounds) => rect.x >= bounds.x && rect.x < bounds.x + bounds.width && rect.y >= bounds.y && rect.y < bounds.y + bounds.height;
const list = (text) => { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed : []; };

/** `hyprctl monitors -j`: `reserved` is [left, top, right, bottom], so the panel is entry 1. */
const hyprland = {
  when: (env) => Boolean(env.HYPRLAND_INSTANCE_SIGNATURE),
  command: ["hyprctl", ["monitors", "-j"]],
  read(text, display) {
    const monitors = list(text).filter((entry) => entry && typeof entry === "object");
    const found = monitors.find((entry) => sameOrigin(entry, display.bounds)) ?? monitors.find((entry) => entry.focused === true);
    return validInset(Array.isArray(found?.reserved) ? found.reserved[1] : null);
  },
};

/** `swaymsg -t get_workspaces`: a workspace's rect starts below the bar, so its offset from the output's top is the panel. */
const sway = {
  when: (env) => Boolean(env.SWAYSOCK),
  command: ["swaymsg", ["-t", "get_workspaces"]],
  read(text, display) {
    const spaces = list(text).filter((entry) => entry?.rect && typeof entry.rect.x === "number" && typeof entry.rect.y === "number");
    const onDisplay = spaces.filter((entry) => entry.visible !== false && inside(entry.rect, display.bounds));
    const found = onDisplay.find((entry) => entry.focused === true) ?? onDisplay[0] ?? spaces.find((entry) => entry.focused === true);
    return found ? validInset(found.rect.y - display.bounds.y) : null;
  },
};

const PROVIDERS = [hyprland, sway];

/**
 * How many px at the top of the primary display a panel keeps, when Electron's work area does not show it (Linux only).
 * Order: a real work area wins (0 here), then SEIRA_GLANCE_TOP_INSET, then the compositor.
 * 0 means nothing reserves the top. null means a compositor was there to ask and gave no usable answer. It never throws.
 */
export async function resolveTopInset({ platform, env, display, run = runCommand, timeoutMs = PROBE_WAIT_MS }) {
  try {
    if (platform !== "linux" || !display?.bounds || !display.workArea || display.workArea.y > display.bounds.y) return 0;
    const set = validInset(env?.[TOP_INSET_ENV]);
    if (set !== null) return set;
    let asked = false;
    for (const provider of PROVIDERS) {
      if (!provider.when(env ?? {})) continue;
      asked = true;
      const found = await probe(provider, display, run, timeoutMs);
      if (found !== null) return found;
    }
    return asked ? null : 0;
  } catch {
    return null;
  }
}

async function probe(provider, display, run, timeoutMs) {
  let timer;
  try {
    const wait = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); timer.unref?.(); });
    const text = await Promise.race([Promise.resolve().then(() => run(provider.command[0], provider.command[1], timeoutMs)), wait]);
    return text === null ? null : provider.read(String(text), display);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
