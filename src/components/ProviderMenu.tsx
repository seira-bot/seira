import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Loader2, MoreHorizontal, X } from "lucide-react";
import { api, desktopApprovalBridge, persistBotUpdate, useStore, type Bot, type InstanceInfo } from "@/state/store";
import type { BotUpdatePatch } from "@/state/bot-patch-queue";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { engineDisplayName } from "@/lib/engine-name";
import { useProviderOrder } from "@/lib/provider-health";
import {
  followBotModelRequest, moveTarget, planProviderOff, providerUses, rememberProviderOff, runProviderOff, undoProviderOff, useProviderOffResult,
  type MoveTarget, type MovedBot,
} from "@/lib/provider-off";
import { ConfirmDialog } from "./ConfirmDialog";
import { hasSavedApiKey } from "./EngineSetup";
import { MENU_SHEET } from "./menu-recipe";
import { anchoredMenuPosition } from "./SidebarPopoverMenu";
import { keyEntry, keyForInstance } from "./keys/key-catalog";
import { saveKey } from "./keys/key-save";

function useBotSaver() {
  const { dispatch } = useStore();
  return async (bot: Bot, patch: BotUpdatePatch) => {
    const saved = await persistBotUpdate(bot.id, patch, new AbortController().signal, api, desktopApprovalBridge(), bot);
    dispatch({ type: "botPatched", bot: saved });
  };
}

async function setHidden(instanceId: string, hidden: boolean, apply: (instances: InstanceInfo[]) => void, refresh: () => Promise<unknown>) {
  const reply = await api(`/api/instances/${encodeURIComponent(instanceId)}`, { method: "PATCH", body: JSON.stringify({ hidden }) });
  if (Array.isArray(reply?.instances)) apply(reply.instances);
  else await Promise.resolve(refresh()).catch(() => {});
}

export interface ProviderOff {
  used: Bot[];
  target: MoveTarget | null;
  busy: boolean;
  error: string | null;
  run: () => void;
}

/** Hide for a provider no bot uses; Move and hide for one that is in use. */
export function useProviderOff(instance: InstanceInfo): ProviderOff {
  const { state, dispatch, refreshInstances } = useStore();
  const { health } = useProviderOrder(state.instances);
  const persist = useBotSaver();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const used = providerUses(instance.instanceId, state.bots);
  const target = used.length > 0 ? moveTarget(instance.instanceId, state.instances, health) : null;
  const run = async () => {
    if (busy || (used.length > 0 && !target)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await runProviderOff({ instanceId: instance.instanceId, displayName: engineDisplayName(instance) }, planProviderOff(instance.instanceId, state.bots, target), {
        persist,
        followBotModel: followBotModelRequest,
        hide: () => setHidden(instance.instanceId, true, (instances) => dispatch({ type: "instances", instances }), refreshInstances),
      });
      rememberProviderOff(result);
      if (!result.hidden) await Promise.resolve(refreshInstances()).catch(() => {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return { used, target, busy, error, run: () => void run() };
}

const ITEM = "ui-menu-row w-full text-left text-ink disabled:cursor-not-allowed disabled:opacity-50";
const NOTE = "px-3 pb-1 pt-0.5 text-[11px] leading-snug text-ink-secondary";

/** The Hide part of a provider menu, in every menu that has one. */
export function ProviderOffItems({ off, onDone }: { off: ProviderOff; onDone: () => void }) {
  const { used, target, busy } = off;
  const go = (action: () => void) => () => { onDone(); action(); };
  if (used.length === 0) {
    return <button type="button" role="menuitem" data-provider-hide disabled={busy} title={t("engines.hideHint")} className={ITEM} onClick={go(off.run)}>{t("engines.hide")}</button>;
  }
  return <>
    <p data-provider-used className={NOTE}>{t("provider.usedBy", { count: String(used.length) })}</p>
    {target
      ? <button type="button" role="menuitem" data-provider-move disabled={busy} title={t("engines.hideHint")} className={ITEM} onClick={go(off.run)}>
        {t("provider.moveAndHide", { count: String(used.length), target: engineDisplayName(target.instance) })}
      </button>
      : <p data-provider-no-target className={NOTE}>{t("provider.noTarget")}</p>}
  </>;
}

/** What the last Hide did, with Undo. It reads the app's one remembered result, because the provider it names has left
 * every list by then. */
export function ProviderOffStatus({ className }: { className?: string }) {
  const result = useProviderOffResult();
  const { state, dispatch, refreshInstances } = useStore();
  const persist = useBotSaver();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!result) return null;
  const text = result.error ? result.error
    : result.stayed.length > 0 ? t("provider.partial", { moved: String(result.moved.length), stayed: String(result.stayed.length), name: result.name })
    : result.moved.length > 0 ? t("provider.movedHidden", { name: result.name, count: String(result.moved.length), target: result.target ?? "" })
    : t("provider.hidden", { name: result.name });
  const undo = async () => {
    setBusy(true);
    setProblem(null);
    const restore = (moved: MovedBot) => persist(
      state.bots.find((bot) => bot.id === moved.id) ?? ({ id: moved.id, name: moved.name } as Bot),
      { modelSelection: moved.modelSelection, fallback: moved.fallback ?? [] },
    );
    try {
      const failed = await undoProviderOff(result, { unhide: () => setHidden(result.instanceId, false, (instances) => dispatch({ type: "instances", instances }), refreshInstances), restore, followBotModel: followBotModelRequest });
      if (failed.length > 0) setProblem(t("provider.undoFailed", { names: failed.join(", ") }));
      else rememberProviderOff(null);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-provider-off-status role="status" className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-control px-3 py-2 text-[12px] leading-snug text-ink-secondary", className)}>
      <span className={cn("min-w-0 flex-1", result.error && "text-danger")}>{text}</span>
      {(result.hidden || result.moved.length > 0) && (
        <button type="button" data-provider-undo disabled={busy} onClick={() => void undo()} className="shrink-0 font-medium text-accent hover:underline disabled:opacity-50">
          {busy ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : t("common.undo")}
        </button>
      )}
      <button type="button" aria-label={t("common.close")} disabled={busy} onClick={() => rememberProviderOff(null)} className="shrink-0 rounded p-0.5 text-ink-secondary hover:text-ink disabled:opacity-50">
        <X size={13} aria-hidden="true" />
      </button>
      {problem && <span role="alert" className="w-full text-danger">{problem}</span>}
    </div>
  );
}

/** Beside its button on top of everything, so a scrolling list cannot cut it off; below the button, or above it near the
 * bottom edge. A press inside it does not reach the menus that close on an outside press. */
function Floating({ anchor, panelRef, children }: { anchor: RefObject<HTMLElement | null>; panelRef: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const place = useCallback(() => {
    const button = anchor.current;
    const panel = panelRef.current;
    if (!button || !panel) return;
    const size = panel.getBoundingClientRect();
    const next = anchoredMenuPosition(button.getBoundingClientRect(), { width: size.width, height: size.height },
      { width: window.innerWidth, height: window.innerHeight }, getComputedStyle(button).direction === "rtl", "end");
    setAt((before) => before && before.left === next.left && before.top === next.top ? before : next);
  }, [anchor, panelRef]);
  useLayoutEffect(place);
  useEffect(() => {
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [place]);
  return createPortal(
    <div ref={panelRef} data-provider-floating onPointerDown={(event) => event.stopPropagation()}
      style={{ position: "fixed", left: at?.left ?? 0, top: at?.top ?? 0, visibility: at ? undefined : "hidden" }}
      className="z-[90] flex w-[260px] max-w-[calc(100vw-16px)] flex-col gap-1 text-[13px]">
      {children}
    </div>,
    document.body,
  );
}

const canSignOut = (instance: InstanceInfo) => instance.snapshot.state === "available" && instance.snapshot.authenticated === true
  && instance.authentication?.signOut === true && instance.snapshot.account?.method !== "api-key";

/** Signed in, and the provider's own app is the only place that can sign it out. */
const signsOutInOwnApp = (instance: InstanceInfo) => instance.snapshot.state === "available" && instance.snapshot.authenticated === true
  && instance.authentication?.signOut !== true && instance.access !== "api" && instance.access !== "custom" && !instance.trialCredit
  && instance.snapshot.account?.method !== "api-key";

const keyTarget = (instance: InstanceInfo) => {
  const id = hasSavedApiKey(instance) ? keyForInstance(instance.instanceId) : undefined;
  return id ? keyEntry(id).target : undefined;
};

/** One menu for a provider, wherever it is listed: Sign out, Remove key, Hide, or Move and hide. `name` is how the list
 * names it. `status` also shows the result of the last Hide, with Undo, under the button. */
export function ProviderMenu({ instance, name: shown, compact = false, status = false }: { instance: InstanceInfo; name?: string; compact?: boolean; status?: boolean }) {
  const { state, dispatch, refreshInstances } = useStore();
  const off = useProviderOff(instance);
  const result = useProviderOffResult();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<"signOut" | "removeKey" | null>(null);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const name = shown ?? engineDisplayName(instance);
  const signOut = canSignOut(instance);
  const ownApp = signsOutInOwnApp(instance);
  const target = keyTarget(instance);
  const sameKey = target ? state.instances.filter((other) => other.instanceId !== instance.instanceId && keyForInstance(other.instanceId) === keyForInstance(instance.instanceId)).map(engineDisplayName) : [];

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } };
    const onPointerDown = (event: PointerEvent) => { if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !panelRef.current?.contains(event.target)) setOpen(false); };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  if (instance.readOnly) return null;

  const run = async (action: "signOut" | "removeKey") => {
    setConfirm(null);
    setWorking(true);
    setProblem(null);
    try {
      if (action === "signOut") {
        const reply = await api(`/api/instances/${encodeURIComponent(instance.instanceId)}/auth/sign-out`, { method: "POST" });
        if (Array.isArray(reply?.instances)) dispatch({ type: "instances", instances: reply.instances });
        else await refreshInstances();
      } else {
        dispatch({ type: "configStatus", config: await saveKey(target!, "", false) });
        await refreshInstances();
      }
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  const busy = working || off.busy;
  const error = problem ?? off.error;
  const close = () => setOpen(false);
  return (
    <div ref={menuRef} data-provider-menu={instance.instanceId} className="relative flex shrink-0 items-center">
      <button ref={buttonRef} type="button" aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen((value) => !value)}
        aria-label={t("accounts.menu", { name })} title={t("accounts.menu", { name })}
        className={cn("flex items-center justify-center rounded-full text-ink-tertiary outline-none hover:bg-ink/[0.06] hover:text-ink focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50", compact ? "size-6" : "size-8")}>
        {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <MoreHorizontal size={compact ? 14 : 16} aria-hidden="true" />}
      </button>
      {(open || error || (status && result)) && (
        <Floating anchor={buttonRef} panelRef={panelRef}>
          {open && (
            <div role="menu" className={cn("w-[240px]", MENU_SHEET)}>
              {signOut && <button type="button" role="menuitem" data-provider-sign-out className={ITEM} onClick={() => { close(); setConfirm("signOut"); }}>{t("accounts.signOut")}</button>}
              {ownApp && <p data-provider-sign-out-note className={NOTE}>{t("provider.signOutInApp", { name })}</p>}
              {target && <button type="button" role="menuitem" data-provider-remove-key className={ITEM} onClick={() => { close(); setConfirm("removeKey"); }}>{t("provider.removeKey")}</button>}
              <ProviderOffItems off={off} onDone={close} />
            </div>
          )}
          {error && <p role="alert" className="rounded-lg bg-card p-2 text-[12px] text-danger shadow-lg">{error}</p>}
          {status && result && <ProviderOffStatus className="shadow-lg" />}
        </Floating>
      )}
      <ConfirmDialog open={confirm === "signOut"} title={t("accounts.signOutTitle", { name })}
        body={<>{t("accounts.signOutBody")}{instance.driverKind !== "claudeAgent" && instance.driverKind !== "antigravityAgent" && <span data-sign-out-cli="" className="mt-2 block">{t("accounts.signOutCliBody", { name })}</span>}</>}
        confirmLabel={t("accounts.signOut")} tone="neutral" onCancel={() => setConfirm(null)} onConfirm={() => void run("signOut")} />
      <ConfirmDialog open={confirm === "removeKey"} title={t("provider.removeKeyTitle", { name })}
        body={<>{t("provider.removeKeyBody")}{sameKey.length > 0 && <span data-remove-key-shared="" className="mt-2 block">{t("provider.removeKeyShared", { names: sameKey.join(", ") })}</span>}</>}
        confirmLabel={t("provider.removeKey")} tone="neutral" onCancel={() => setConfirm(null)} onConfirm={() => void run("removeKey")} />
    </div>
  );
}
