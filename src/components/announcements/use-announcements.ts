import { useEffect, useState } from "react";
import type { CloudAccountState } from "../../../electron/cloud-account.mjs";
import { announcementHistory, announcementsUnread, markAnnouncementsRead, useAnnouncementRecord, type HistoryItem, type PersonRecord, type RecordWriter } from "@/lib/announcement-history";
import { announcementConditions, announcementFeedUpdatedAt, announcementPlan, announcementPlatform, announcementSurface, cardsForPerson, providersRestricted,
  SPONSOR_CARDS_FOR_TEAM_MEMBERS, useAnnouncementCards } from "@/lib/announcements";
import { appVersion } from "@/lib/app-links";
import { brandStatus } from "@/lib/brand";
import { cloudPlanView } from "@/lib/cloud-plan";
import { activeLocale } from "@/lib/i18n";
import { usedBefore } from "@/lib/notices";
import { useStore } from "@/state/store";
import { useDesktopNotices } from "../desktop-notices";
import { localDesktopPage, useWelcomeViewer } from "../onboarding/WelcomeGate";

function useCloudAccount(bridge: NonNullable<Window["ogb"]>["cloudAccount"]): CloudAccountState | null {
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const unsubscribe = bridge.onState(next => { if (active) setAccount(next); });
    void bridge.state().then(next => { if (active) setAccount(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  return account;
}

export interface Announcements {
  items: HistoryItem[];
  /** The red dot: false until everything it depends on has loaded. */
  unread: boolean;
  markRead: () => void;
  person: PersonRecord;
  writer: RecordWriter;
}

/** Every announcement card this person could have here, and whether one is new to them. */
export function useAnnouncements(now: () => number = Date.now): Announcements {
  const { state, dispatch } = useStore();
  useAnnouncementRecord();
  const viewer = useWelcomeViewer();
  const remote = window.ogb?.remoteClient?.active === true;
  const local = localDesktopPage();
  const bridge = !remote && local ? window.ogb?.cloudAccount : undefined;
  const desktop = remote ? undefined : window.ogb?.desktopNotices;
  const desktopState = useDesktopNotices(desktop);
  const account = useCloudAccount(bridge);
  const branded = brandStatus().source === "file";
  const team = Boolean(state.config?.team);
  const canSave = viewer?.canSave !== false;
  const cloudHome = Boolean(state.config?.cloudHome || viewer?.cloudHome);
  const sponsors = SPONSOR_CARDS_FOR_TEAM_MEMBERS || !team || viewer?.canSave === true;
  const surface = announcementSurface(local, cloudHome);
  const cards = cardsForPerson(useAnnouncementCards(!branded), {
    facts: { nowMs: now(), version: appVersion(), platform: announcementPlatform(globalThis.navigator?.userAgent), surface,
      plan: announcementPlan(surface, bridge ? cloudPlanView(account) : null, team), people: usedBefore(state.bots) ? "existing" : "new", locale: activeLocale(),
      conditions: announcementConditions(state) },
    branded, admin: canSave, sponsors: !providersRestricted(state.config?.managedPolicy) && sponsors,
  });
  const items = announcementHistory({ cards, feedUpdatedAt: announcementFeedUpdatedAt(), now: now() });
  const record = state.config?.onboarding;
  const person: PersonRecord = { record, desktopSeen: desktopState?.seen ?? [] };
  const ready = viewer !== null && (!desktop || desktopState !== null) && state.config !== null;
  const writer: RecordWriter = { team, desktop, saved: config => dispatch({ type: "configStatus", config }) };
  return {
    items, unread: ready && announcementsUnread(items, person), person, writer,
    markRead: () => markAnnouncementsRead(now(), record, writer),
  };
}
