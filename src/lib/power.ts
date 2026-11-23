import { useSyncExternalStore } from "react";

import { productName } from "./brand";
import { t } from "./i18n";
import { setEveryBotPaused } from "./bot-pause";

export type PowerKind = "restart" | "shutdown";
export type PowerUpdate = { version: string };
export type VisorKind = "restart" | "update" | "shutdown" | "wake";
export type VisorFlag = "instant" | "reduced" | "closed" | "glint" | "eyes" | "shut" | "wide" | "merge" | "out" | "breathing" | "text" | "opening" | "leaving";

export const HOLD_MS = 800;
export const WAKE_KEY = "seira.power.wake";
export const WAKE_WINDOW_MS = 2 * 60_000;
const PATIENCE_MS = 15_000;

export interface WorkingBot {
  busy?: boolean;
  activity?: string;
}

/** A bot is working when it says so, or when it is busy and not waiting on the person. */
export function workingBotCount(bots: readonly WorkingBot[] | undefined): number {
  return (bots ?? []).filter((bot) => bot.activity === "working" || (Boolean(bot.busy) && bot.activity !== "waiting-on-you")).length;
}

export function prefersReducedMotion(): boolean {
  if (typeof document !== "undefined" && document.documentElement.dataset.reducedMotion === "true") return true;
  return globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export interface WakeMarker {
  kind: "restart" | "update";
  version?: string;
  at: number;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function rememberWake(marker: WakeMarker): void {
  try {
    storage()?.setItem(WAKE_KEY, JSON.stringify(marker));
  } catch {
    // Storage can be blocked by the browser.
  }
}

export function forgetWake(): void {
  try {
    storage()?.removeItem(WAKE_KEY);
  } catch {
    // Storage can be blocked by the browser.
  }
}

/** Reads and removes the marker; a marker older than two minutes, or a damaged one, is no marker. */
export function takeWake(now = Date.now()): WakeMarker | null {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(WAKE_KEY) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  forgetWake();
  try {
    const marker = JSON.parse(raw) as Partial<WakeMarker> | null;
    if (!marker || (marker.kind !== "restart" && marker.kind !== "update") || typeof marker.at !== "number") return null;
    if (now - marker.at > WAKE_WINDOW_MS || marker.at - now > WAKE_WINDOW_MS) return null;
    return { kind: marker.kind, at: marker.at, ...(typeof marker.version === "string" ? { version: marker.version } : {}) };
  } catch {
    return null;
  }
}

export interface VisorState {
  kind: VisorKind | null;
  version: string;
  flags: ReadonlySet<VisorFlag>;
}

export interface ToastAction {
  label: string;
  quiet?: boolean;
  run: () => void;
}

export interface PowerToast {
  id: number;
  text: string;
  ok?: boolean;
  actions: ToastAction[];
}

export interface PowerWait {
  kind: PowerKind;
  update: PowerUpdate | null;
}

const IDLE: VisorState = { kind: null, version: "", flags: new Set() };
let visor: VisorState = IDLE;
let toast: PowerToast | null = null;
let wait: PowerWait | null = null;
let run = 0;
let toastId = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const usePowerVisor = (): VisorState => useSyncExternalStore(subscribe, () => visor, () => IDLE);
export const usePowerToast = (): PowerToast | null => useSyncExternalStore(subscribe, () => toast, () => null);
export const usePowerWait = (): PowerWait | null => useSyncExternalStore(subscribe, () => wait, () => null);
export const getPowerVisor = (): VisorState => visor;
export const getPowerToast = (): PowerToast | null => toast;
export const getPowerWait = (): PowerWait | null => wait;

function setVisor(next: VisorState): void {
  visor = next;
  emit();
}

function edit(add: readonly VisorFlag[] = [], remove: readonly VisorFlag[] = []): void {
  const flags = new Set(visor.flags);
  for (const flag of remove) flags.delete(flag);
  for (const flag of add) flags.add(flag);
  setVisor({ ...visor, flags });
}

export function clearToast(): void {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  if (toast) {
    toast = null;
    emit();
  }
}

export function showToast(text: string, { ok = false, actions = [], ttl = 3200 }: { ok?: boolean; actions?: ToastAction[]; ttl?: number } = {}): void {
  clearToast();
  toast = { id: ++toastId, text, ok, actions };
  const shown = toast.id;
  toastTimer = setTimeout(() => {
    if (toast?.id === shown) clearToast();
  }, ttl);
  emit();
}

export interface PowerDeps {
  relaunch?: () => Promise<unknown> | unknown;
  install?: () => Promise<unknown> | unknown;
  quit?: () => Promise<unknown> | unknown;
  reduced?: () => boolean;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
}

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function resolveDeps(deps: PowerDeps = {}): Required<PowerDeps> {
  const ogb = typeof window === "undefined" ? undefined : window.ogb;
  return {
    relaunch: deps.relaunch ?? (() => ogb?.relaunch?.()),
    install: deps.install ?? (() => ogb?.updater?.install()),
    quit: deps.quit ?? (() => ogb?.quit?.()),
    reduced: deps.reduced ?? prefersReducedMotion,
    sleep: deps.sleep ?? sleepMs,
    now: deps.now ?? Date.now,
  };
}

async function closeVisor(token: number, deps: Required<PowerDeps>): Promise<boolean> {
  if (deps.reduced()) {
    edit(["reduced", "closed", "eyes"]);
    await deps.sleep(220);
    return token === run;
  }
  await deps.sleep(20);
  if (token !== run) return false;
  edit(["closed"]);
  await deps.sleep(320);
  if (token !== run) return false;
  edit(["glint"]);
  await deps.sleep(180);
  if (token !== run) return false;
  edit(["eyes"]);
  await deps.sleep(300);
  return token === run;
}

async function openVisor(token: number, deps: Required<PowerDeps>): Promise<void> {
  edit([], ["breathing", "text", "merge", "out"]);
  if (deps.reduced()) {
    edit(["leaving"], ["closed"]);
    await deps.sleep(220);
  } else {
    edit(["eyes", "shut"]);
    await deps.sleep(120);
    if (token !== run) return;
    edit(["wide"], ["shut"]);
    await deps.sleep(170);
    if (token !== run) return;
    edit([], ["wide"]);
    await deps.sleep(300);
    if (token !== run) return;
    edit(["opening"], ["closed", "glint", "eyes"]);
    await deps.sleep(320);
  }
  if (token === run) setVisor(IDLE);
}

export async function runRestart(update: PowerUpdate | null, depsIn?: PowerDeps): Promise<void> {
  const deps = resolveDeps(depsIn);
  const token = ++run;
  clearToast();
  setVisor({ kind: update ? "update" : "restart", version: update?.version ?? "", flags: new Set() });
  if (!(await closeVisor(token, deps))) return;
  if (!deps.reduced()) edit(["shut"]);
  edit(["text"]);
  await deps.sleep(200);
  if (token !== run) return;
  edit(["breathing"]);
  await deps.sleep(400);
  if (token !== run) return;
  rememberWake({ kind: update ? "update" : "restart", at: deps.now(), ...(update ? { version: update.version } : {}) });
  try {
    await (update ? deps.install() : deps.relaunch());
  } catch {
    forgetWake();
    await openVisor(token, deps);
    return;
  }
  await deps.sleep(PATIENCE_MS);
  if (token !== run) return;
  forgetWake();
  await openVisor(token, deps);
}

export async function runShutDown(depsIn?: PowerDeps): Promise<void> {
  const deps = resolveDeps(depsIn);
  const token = ++run;
  clearToast();
  setVisor({ kind: "shutdown", version: "", flags: new Set() });
  if (!(await closeVisor(token, deps))) return;
  edit(["text"]);
  if (deps.reduced()) {
    await deps.sleep(900);
    if (token !== run) return;
    edit([], ["text", "eyes"]);
  } else {
    await deps.sleep(260);
    if (token !== run) return;
    edit(["shut"]);
    await deps.sleep(400);
    if (token !== run) return;
    edit(["merge"]);
    await deps.sleep(400);
    if (token !== run) return;
    edit(["out"], ["text"]);
    await deps.sleep(400);
    if (token !== run) return;
  }
  try {
    await deps.quit();
  } catch {
    await openVisor(token, deps);
    return;
  }
  await deps.sleep(PATIENCE_MS);
  if (token !== run) return;
  await openVisor(token, deps);
}

export async function playWake(depsIn?: PowerDeps): Promise<boolean> {
  const deps = resolveDeps(depsIn);
  const marker = takeWake(deps.now());
  if (!marker) return false;
  const token = ++run;
  setVisor({ kind: "wake", version: marker.version ?? "", flags: new Set(deps.reduced() ? ["reduced", "closed", "eyes", "instant"] : ["instant", "closed", "eyes", "shut"]) });
  await deps.sleep(deps.reduced() ? 60 : 200);
  if (token !== run) return true;
  edit([], ["instant"]);
  await openVisor(token, deps);
  if (token !== run) return true;
  const updated = marker.kind === "update" && marker.version;
  showToast(updated ? t("power.toast.updated", { version: marker.version! }) : t("power.toast.restarted", { app: productName() }), { ok: true, ttl: updated ? 4200 : 2800 });
  return true;
}

export function runPower(kind: PowerKind, update: PowerUpdate | null, deps?: PowerDeps): Promise<void> {
  return kind === "restart" ? runRestart(update, deps) : runShutDown(deps);
}

/** Runs the action, or waits for the working bots to finish their step first. */
export function requestPower(kind: PowerKind, options: { update: PowerUpdate | null; working: number; deps?: PowerDeps }): "running" | "waiting" {
  if (wait) return "waiting";
  if (options.working > 0) {
    wait = { kind, update: options.update };
    clearToast();
    emit();
    return "waiting";
  }
  void runPower(kind, options.update, options.deps);
  return "running";
}

export function cancelWait(): void {
  if (!wait) return;
  wait = null;
  emit();
}

/** Runs the waiting action now: the last bot finished, or the person did not want to wait. */
export function runWaiting(deps?: PowerDeps): void {
  const waiting = wait;
  if (!waiting) return;
  wait = null;
  emit();
  void runPower(waiting.kind, waiting.update, deps);
}

export interface PauseDeps {
  set?: (paused: boolean) => Promise<unknown>;
  onError?: (message: string) => void;
}

/** Pauses or resumes every bot, and says so with an Undo. */
export async function pauseEveryBot(paused: boolean, deps: PauseDeps = {}): Promise<boolean> {
  try {
    await (deps.set ?? setEveryBotPaused)(paused);
  } catch (error) {
    deps.onError?.(error instanceof Error ? error.message : String(error));
    return false;
  }
  if (paused) showToast(t("power.toast.paused"), { ttl: 4200, actions: [{ label: t("common.undo"), quiet: true, run: () => { void pauseEveryBot(false, deps); } }] });
  else showToast(t("power.toast.resumed"), { ttl: 2400 });
  return true;
}

export function resetPowerForTest(): void {
  run += 1;
  visor = IDLE;
  toast = null;
  wait = null;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  emit();
}
