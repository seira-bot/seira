import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Loader2, MoreHorizontal, X } from "lucide-react";
import { api, desktopApprovalBridge, persistBotUpdate, useStore, type Bot, type InstanceInfo } from "@/state/store";
import type { BotUpdatePatch } from "@/state/bot-patch-queue";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { engineDisplayName } from "@/lib/engine-name";
import { SIGN_IN_FAMILY_LABEL, signInFamily } from "@/lib/engine-rail";
import { useProviderOrder } from "@/lib/provider-health";
import {
  followBotModelRequest, moveChoices, planProviderOff, providerUses, rememberProviderOff, runProviderOff, undoProviderOff, useProviderOffResult,
  type MoveChoice, type MoveTarget, type MovedBot,
} from "@/lib/provider-off";
import type { ProviderUse } from "../../shared/provider-uses";
import { ConfirmDialog } from "./ConfirmDialog";
import { blockedUses, ProviderBlockers } from "./ProviderBlockers";
import { hasSavedApiKey } from "./EngineSetup";
import { MENU_LABEL, MENU_SEPARATOR, MENU_SHEET, SIMPLE_MENU_META, SIMPLE_MENU_ROW } from "./menu-recipe";
import { providerName } from "./EngineLibrary";
import { InstanceProviderMark } from "./ProviderIcons";
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

async function setHidden(instanceId: string, hidden: boolean, apply: (instances: InstanceInfo[]) => void, refresh: () => Promise<unknown>, force = false) {
  const reply = await api(`/api/instances/${encodeURIComponent(instanceId)}`, { method: "PATCH", body: JSON.stringify(force ? { hidden, force } : { hidden }) });
  if (Array.isArray(reply?.instances)) apply(reply.instances);
  else await Promise.resolve(refresh()).catch(() => {});
}

export interface ProviderOff {
  instance: InstanceInfo;
  /** Whether the provider is hidden after its bots move; an account that can be removed only moves them. */
  hides: boolean;
  used: Bot[];
  choices: MoveChoice[];
  target: MoveTarget | null;
  busy: boolean;
  error: string | null;
  /** What still uses the provider after a refused Hide; empty otherwise. */
  blocked: ProviderUse[];
  dismissBlocked: () => void;
  hideAnyway: () => void;
  run: (to?: MoveTarget) => void;
}

/** Hide for a provider no bot uses; Move and hide for one that is in use. */
export function useProviderOff(instance: InstanceInfo, { hide = true }: { hide?: boolean } = {}): ProviderOff {
  const { state, dispatch, refreshInstances } = useStore();
  const { health } = useProviderOrder(state.instances);
  const persist = useBotSaver();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<ProviderUse[]>([]);
  const used = providerUses(instance.instanceId, state.bots);
  const choices = used.length > 0 ? moveChoices(instance.instanceId, state.instances, health) : [];
  const first = choices.find((choice) => choice.usable);
  const target: MoveTarget | null = first ? { instance: first.instance, selection: first.selection } : null;
  const run = async (to: MoveTarget | null = target) => {
    if (busy || (used.length > 0 && !to)) return;
    setBusy(true);
    setError(null);
    setBlocked([]);
    let refused = false;
    try {
      const result = await runProviderOff({ instanceId: instance.instanceId, displayName: engineDisplayName(instance) }, planProviderOff(instance.instanceId, state.bots, to), {
        persist,
        followBotModel: followBotModelRequest,
        ...(hide ? { hide: () => setHidden(instance.instanceId, true, (instances) => dispatch({ type: "instances", instances }), refreshInstances).catch((cause) => {
          const uses = blockedUses(cause);
          if (uses.length > 0) { refused = true; setBlocked(uses); }
          throw cause;
        }) } : {}),
      });
      if (!refused || result.moved.length > 0) rememberProviderOff(result);
      if (!result.hidden) await Promise.resolve(refreshInstances()).catch(() => {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const hideAnyway = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await setHidden(instance.instanceId, true, (instances) => dispatch({ type: "instances", instances }), refreshInstances, true);
      setBlocked([]);
      rememberProviderOff({ instanceId: instance.instanceId, name: engineDisplayName(instance), moved: [], stayed: [], hidden: true });
    } catch (cause) {
      const uses = blockedUses(cause);
      if (uses.length > 0) setBlocked(uses);
      else setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return { instance, hides: hide, used, choices, target, busy, error, blocked, dismissBlocked: () => setBlocked([]), hideAnyway: () => void hideAnyway(), run: (to) => void run(to) };
}

const ITEM = "ui-menu-row w-full text-left text-ink disabled:cursor-not-allowed disabled:opacity-50";
const NOTE = "px-3 pb-1 pt-0.5 text-[11px] leading-snug text-ink-secondary";

/** The Hide part of a provider menu, in every menu that has one. With `onChoose`, a person who has more than one place to
 * move the bots to picks it in the picker that `onChoose` opens. */
export function ProviderOffItems({ off, onDone, onChoose }: { off: ProviderOff; onDone: () => void; onChoose?: () => void }) {
  const { used, target, busy, hides } = off;
  const go = (action: () => void) => () => { onDone(); action(); };
  if (used.length === 0) {
    if (!hides) return null;
    return <button type="button" role="menuitem" data-provider-hide disabled={busy} title={t("engines.hideHint")} className={ITEM} onClick={go(() => off.run())}>{t("engines.hide")}</button>;
  }
  const count = String(used.length);
  const many = onChoose !== undefined && off.choices.filter((choice) => choice.usable).length > 1;
  return <>
    <p data-provider-used className={NOTE}>{t("provider.usedBy", { count })}</p>
    {!target
      ? <p data-provider-no-target className={NOTE}>{t(hides ? "provider.noTarget" : "provider.noTargetMove")}</p>
      : many
        ? <button type="button" role="menuitem" data-provider-move-choose aria-haspopup="menu" disabled={busy} className={cn(ITEM, "flex items-center gap-2")} onClick={onChoose}>
          <span className="min-w-0 flex-1 truncate">{t(hides ? "provider.moveAndHideChoose" : "provider.moveChoose", { count })}</span>
          <ChevronRight size={14} className="shrink-0 text-ink-tertiary rtl:-scale-x-100" aria-hidden="true" />
        </button>
        : <button type="button" role="menuitem" data-provider-move disabled={busy} title={t("engines.hideHint")} className={ITEM} onClick={go(() => off.run())}>
          {t(hides ? "provider.moveAndHide" : "provider.move", { count, target: engineDisplayName(target.instance) })}
        </button>}
  </>;
}

const enabledItems = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).filter((item) => !item.disabled);

/** Where the bots go: another account of the same provider first, then any other ready AI. */
export function ProviderMovePicker({ off, onBack, onDone }: { off: ProviderOff; onBack: () => void; onDone: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const count = String(off.used.length);
  const same = off.choices.filter((choice) => choice.sameProvider);
  const other = off.choices.filter((choice) => !choice.sameProvider);
  const family = signInFamily(off.instance);
  const provider = family ? SIGN_IN_FAMILY_LABEL[family] : providerName(off.instance);
  useEffect(() => { if (rootRef.current) enabledItems(rootRef.current).find((item) => item.hasAttribute("data-provider-move-to"))?.focus(); }, []);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = enabledItems(event.currentTarget);
    if (items.length === 0) return;
    const at = items.findIndex((item) => item === document.activeElement);
    const next = event.key === "ArrowDown" ? (at + 1) % items.length
      : event.key === "ArrowUp" ? (at <= 0 ? items.length - 1 : at - 1)
      : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
  };
  const row = (choice: MoveChoice) => {
    const email = choice.instance.snapshot.account?.email;
    const meta = choice.usable ? email : choice.reason;
    return (
      <button key={choice.instance.instanceId} type="button" role="menuitem" data-provider-move-to={choice.instance.instanceId}
        disabled={!choice.usable || off.busy} title={choice.reason} className={cn(SIMPLE_MENU_ROW, "disabled:cursor-not-allowed")}
        onClick={() => { onDone(); off.run({ instance: choice.instance, selection: choice.selection }); }}>
        <InstanceProviderMark instance={choice.instance} size={16} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{engineDisplayName(choice.instance)}</span>
          {meta && <span className={SIMPLE_MENU_META}>{meta}</span>}
        </span>
      </button>
    );
  };
  const both = same.length > 0 && other.length > 0;
  return (
    <div ref={rootRef} data-provider-move-picker className="flex flex-col" onKeyDown={onKeyDown}>
      <button type="button" role="menuitem" data-provider-move-back className={cn(ITEM, "flex items-center gap-2 text-ink-secondary hover:text-ink")} onClick={onBack}>
        <ChevronLeft size={14} className="rtl:-scale-x-100" aria-hidden="true" />
        <span>{t("model.simple.back")}</span>
      </button>
      <div className={MENU_SEPARATOR} role="separator" />
      <p className="px-2 pb-1 pt-1.5 text-[13px] font-medium leading-5 text-ink">{t("provider.moveTo", { count })}</p>
      {both && <p className={MENU_LABEL}>{t("provider.moveSameProvider", { provider })}</p>}
      {same.map(row)}
      {both && <>
        <div className={MENU_SEPARATOR} role="separator" />
        <p className={MENU_LABEL}>{t("provider.moveOtherAi")}</p>
      </>}
      {other.map(row)}
    </div>
  );
}

/** A provider menu that can swap its rows for the move picker. The picker resets when the menu closes and unmounts. */
export function ProviderMenuBody({ off, onDone, children }: { off: ProviderOff; onDone: () => void; children: (choose: () => void) => ReactNode }) {
  const [choosing, setChoosing] = useState(false);
  return choosing
    ? <ProviderMovePicker off={off} onBack={() => setChoosing(false)} onDone={onDone} />
    : <>{children(() => setChoosing(true))}</>;
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
    : result.stayed.length > 0 ? (result.moveOnly
      ? t("provider.partialMove", { moved: String(result.moved.length), stayed: String(result.stayed.length) })
      : t("provider.partial", { moved: String(result.moved.length), stayed: String(result.stayed.length), name: result.name }))
    : result.moved.length > 0 && !result.hidden ? t("provider.moved", { count: String(result.moved.length), target: result.target ?? "" })
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
      {(open || error || off.blocked.length > 0 || (status && result)) && (
        <Floating anchor={buttonRef} panelRef={panelRef}>
          {open && (
            <div role="menu" className={cn("w-[260px]", MENU_SHEET)}>
              <ProviderMenuBody off={off} onDone={close}>{(choose) => <>
              {signOut && <button type="button" role="menuitem" data-provider-sign-out className={ITEM} onClick={() => { close(); setConfirm("signOut"); }}>{t("accounts.signOut")}</button>}
              {ownApp && <p data-provider-sign-out-note className={NOTE}>{t("provider.signOutInApp", { name })}</p>}
              {target && <button type="button" role="menuitem" data-provider-remove-key className={ITEM} onClick={() => { close(); setConfirm("removeKey"); }}>{t("provider.removeKey")}</button>}
              <ProviderOffItems off={off} onDone={close} onChoose={choose} />
              </>}</ProviderMenuBody>
            </div>
          )}
          {off.blocked.length > 0 && <ProviderBlockers name={name} uses={off.blocked} onClose={off.dismissBlocked} hideAnyway={{ run: off.hideAnyway, busy: off.busy }} />}
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
