import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { pendingAppConnections, subscribeAppConnected, takeAppConnections } from "@/lib/app-connected";
import { appSwitchPatch, botAppScope } from "@/lib/bot-app-access";
import type { ConnectorStatus } from "@/lib/connector-status";
import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStore, type Action, type Bot, type InstanceInfo } from "@/state/store";
import { EMAIL_SLUG } from "../../shared/email";
import { GITHUB_APP_SLUG } from "../../shared/github-app";
import { BotAvatar } from "./Avatar";
import { UndoToast } from "./bot-access/ShareBotButton";
import { BotSwitch } from "./bot-panel/rows";
import { GrantDialog } from "./GrantDialog";
import { GithubGrantPrompt } from "./GithubGrantPrompt";

let connectingFromBot: string | null = null;
let notice: { slug: string; text: string } | null = null;
let changeRequested: string | null = null;
const watchers = new Set<() => void>();

function tell() {
  for (const watch of Array.from(watchers)) watch();
}
function subscribe(watch: () => void) {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}

/** The Apps pop-up, opened from inside a bot: an app connected there goes to that bot even if its apps were off. */
export function connectAppFromBot(dispatch: (action: Action) => void, botId: string) {
  connectingFromBot = botId;
  dispatch({ type: "toggleSettings", open: false });
  dispatch({ type: "togglePlugins", open: true, surface: "apps" });
}

function takeConnectingBot(): string | null {
  const botId = connectingFromBot;
  connectingFromBot = null;
  return botId;
}

export function showAppGrantNotice(next: { slug: string; text: string } | null) {
  notice = next;
  tell();
}

/** "Your bots can now use Apollo · Change", for a few seconds. It outlives the Apps pop-up, which Change opens again. */
export function AppGrantNotice() {
  const { dispatch } = useStore();
  const shown = useSyncExternalStore(subscribe, () => notice, () => null);
  const done = useCallback(() => showAppGrantNotice(null), []);
  if (!shown) return null;
  return (
    <UndoToast
      key={shown.text}
      text={shown.text}
      actionLabel={t("apps.usedByChange")}
      onUndo={async () => {
        changeRequested = shown.slug;
        dispatch({ type: "togglePlugins", open: true, surface: "apps" });
        tell();
      }}
      onDone={done}
    />
  );
}

/** The bots whose access an app can be given from here: a Team Cloud member's own helper is theirs alone. */
export function botsForApps(bots: Bot[], instances: InstanceInfo[]): Bot[] {
  return bots.filter((bot) =>
    !bot.hidden &&
    !bot.defaultBot?.person &&
    instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)?.capabilities?.composioMcp === true);
}

function connectedAppSlugs(status: Record<string, ConnectorStatus>, emailConnected: boolean | null): string[] {
  const slugs = Object.entries(status).filter(([, service]) => service.connected).map(([slug]) => slug);
  return emailConnected && !slugs.includes(EMAIL_SLUG) ? [...slugs, EMAIL_SLUG] : slugs;
}

type AppAllowList = { allowAll: boolean; allowlist: readonly string[] } | undefined;

function grantConnectedApp({ admin, bots, allowed, startingBot, write, slug, app }: {
  admin: boolean | null;
  bots: Bot[];
  allowed: AppAllowList;
  startingBot: string | null;
  write: (bot: Bot, slug: string, on: boolean) => void;
  slug: string;
  app: string;
}) {
  if (admin !== true || !bots.length) return;
  if (allowed && !allowed.allowAll && !allowed.allowlist.includes(slug)) return;
  let without = 0;
  for (const bot of bots) {
    if (botAppScope(bot, slug) !== null) continue;
    if (bot.composio !== false || bot.id === startingBot) write(bot, slug, true);
    else without += 1;
  }
  const text = without === 0 ? t("apps.botsCanUse", { app })
    : without === 1 ? t("apps.botsCannotUseOne", { app })
    : t("apps.botsCannotUse", { app, count: without });
  showAppGrantNotice({ slug, text });
}

/** Mounted once, beside the notice: gives an app connected from a chat card to the bots that may use it. */
export function AppGrantHost() {
  const { state, dispatch } = useStore();
  const admin = useOwnerOrAdmin();
  const pending = useSyncExternalStore(subscribeAppConnected, pendingAppConnections, () => 0);
  const latest = useRef({ admin, state, dispatch });
  latest.current = { admin, state, dispatch };
  useEffect(() => {
    if (!pending || admin === null) return;
    const { admin: isAdmin, state: current, dispatch: send } = latest.current;
    for (const { slug, app } of takeAppConnections()) {
      grantConnectedApp({
        admin: isAdmin,
        bots: botsForApps(current.bots, current.instances),
        allowed: current.config?.managedPolicy?.apps,
        startingBot: null,
        write: (bot, appSlug, on) => {
          const patch = appSwitchPatch(bot, [appSlug], appSlug, on);
          if (Object.keys(patch).length > 0) send({ type: "updateBot", botId: bot.id, patch });
        },
        slug,
        app,
      });
    }
  }, [pending, admin]);
  return null;
}

/** Security: only an owner or admin's connection gives an app to bots, and only they can change which bots use it. A bot
 * whose apps are off stays off, unless the connection was started from that bot. */
export function useAppGrants({ status, emailConnected, inventoryReady }: { status: Record<string, ConnectorStatus>; emailConnected: boolean | null; inventoryReady: boolean }) {
  const { state, dispatch } = useStore();
  const admin = useOwnerOrAdmin();
  const [startingBot] = useState(takeConnectingBot);
  const [changing, setChanging] = useState<string | null>(null);
  const requested = useSyncExternalStore(subscribe, () => changeRequested, () => null);
  const bots = botsForApps(state.bots, state.instances);
  const canChange = admin === true && inventoryReady && bots.length > 0;
  const allowed = state.config?.managedPolicy?.apps;

  useEffect(() => {
    if (!requested) return;
    changeRequested = null;
    setChanging(requested);
    tell();
  }, [requested]);

  const write = (bot: Bot, slug: string, on: boolean) => {
    const patch = appSwitchPatch(bot, connectedAppSlugs(status, emailConnected), slug, on);
    if (Object.keys(patch).length > 0) dispatch({ type: "updateBot", botId: bot.id, patch });
  };
  const latest = useRef({ admin, bots, allowed, startingBot, write });
  latest.current = { admin, bots, allowed, startingBot, write };

  const appConnected = useCallback((slug: string, app: string) => {
    const now = latest.current;
    grantConnectedApp({ ...now, slug, app });
  }, []);
  const dismiss = useCallback(() => setChanging(null), []);

  const done = (on: ReadonlySet<string>) => {
    if (changing) {
      for (const bot of bots) if (on.has(bot.id) !== (botAppScope(bot, changing) !== null)) write(bot, changing, on.has(bot.id));
    }
    setChanging(null);
  };

  return { canChange, appConnected, change: setChanging, dismiss, done, changing: canChange ? changing : null, bots };
}

export function AppGrantPrompt(props: {
  app: string;
  slug: string;
  bots: Bot[];
  onDone: (on: ReadonlySet<string>) => void;
  onDismiss: () => void;
}) {
  return props.slug === GITHUB_APP_SLUG
    ? <GithubGrantPrompt bots={props.bots} onDismiss={props.onDismiss} />
    : <ConnectedAppGrantPrompt {...props} />;
}

function ConnectedAppGrantPrompt({ app, slug, bots, onDone, onDismiss }: {
  app: string;
  slug: string;
  bots: Bot[];
  onDone: (on: ReadonlySet<string>) => void;
  onDismiss: () => void;
}) {
  const [on, setOn] = useState<ReadonlySet<string>>(() => new Set(
    bots.filter((bot) => botAppScope(bot, slug) !== null).map((bot) => bot.id),
  ));

  const toggle = (botId: string) => setOn((current) => {
    const next = new Set(current);
    if (!next.delete(botId)) next.add(botId);
    return next;
  });

  return (
    <GrantDialog
      slug={slug}
      title={t("apps.whichBots", { app })}
      onDismiss={onDismiss}
      action={(
        <button type="button" onClick={() => onDone(on)} className="rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110">
          {t("common.done")}
        </button>
      )}
    >
      {bots.map((bot) => (
        <div key={bot.id} className="flex min-h-11 items-center gap-2.5">
          <BotAvatar bot={bot} size={24} animated={false} />
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{bot.name}</span>
          <BotSwitch color={bot.color} checked={on.has(bot.id)} aria-label={t("botSettings.simple.appToggle", { name: bot.name, app })} onClick={() => toggle(bot.id)} />
        </div>
      ))}
    </GrantDialog>
  );
}
