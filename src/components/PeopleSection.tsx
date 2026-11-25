// Security: the invite link is convenience, not a second door; the one-time code still goes to the address itself.
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Link2, Plus, RefreshCw, Users } from "lucide-react";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { formatUsd, hasFiniteCost } from "@/lib/usage";
import { readMembership, type Membership } from "../lib/membership";
import { readSessionState, type SessionState } from "../lib/session";
import { canPairDevices } from "./ServerPairingCard";
import { withEntry, withoutEntry, type SignInLists } from "./SignInAccessCard";
import { Card } from "./SettingsPrimitives";
import { CopyLink, inviteLink } from "./InviteLink";
import { InviteDialog } from "./InviteDialog";
import { grantFor, loadDepartmentChoices, saveDepartmentAccess, type AccessGrant, type DepartmentChoices } from "@/lib/department-access";
import type { GrantLevel } from "../../shared/department-access";

export { CopyLink, inviteLink };

export type Role = "admin" | "member";


export interface Person {
  entry: string;
  role: Role;
  isDomain: boolean;
  lastSeenAt: number | null;
  devices: number;
  turns: number;
  costUsd: number | null;
  estimated?: boolean;
}

export function mergePeople(
  lists: SignInLists,
  sessions: Array<{ email?: string; lastSeenAt: number }>,
  usage: Array<{ key: string; turns: number; costUsd: number | null; estimatedUsd?: number | null }>,
): Person[] {
  const people: Person[] = [];
  const seen = new Set<string>();
  const add = (entry: string, role: Role) => {
    const key = entry.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    const devices = sessions.filter((session) => session.email?.toLowerCase() === key);
    const month = usage.find((group) => group.key === `user:${key}`);
    people.push({
      entry: key,
      role,
      isDomain: key.startsWith("@"),
      lastSeenAt: devices.length ? Math.max(...devices.map((session) => session.lastSeenAt)) : null,
      devices: devices.length,
      turns: month?.turns ?? 0,
      costUsd: month?.costUsd ?? null,
      ...(hasFiniteCost(month?.estimatedUsd) && month.estimatedUsd > 0 ? { estimated: true } : {}),
    });
  };
  for (const entry of lists.admins) add(entry, "admin");
  for (const entry of lists.members) add(entry, "member");
  return people;
}

export function peopleFromSessions(
  sessions: Array<{ email?: string; lastSeenAt: number; scopes?: string[] }>,
  usage: Array<{ key: string; turns: number; costUsd: number | null }>,
): Person[] {
  const byEmail = new Map<string, Array<{ lastSeenAt: number; scopes?: string[] }>>();
  for (const session of sessions) {
    const email = session.email?.trim().toLowerCase();
    if (email) byEmail.set(email, [...(byEmail.get(email) ?? []), session]);
  }
  return [...byEmail.entries()].map(([entry, devices]) => {
    const month = usage.find((group) => group.key === `user:${entry}`);
    return {
      entry,
      role: devices.some((device) => device.scopes?.includes("admin")) ? "admin" : "member",
      isDomain: false,
      lastSeenAt: Math.max(...devices.map((device) => device.lastSeenAt)),
      devices: devices.length,
      turns: month?.turns ?? 0,
      costUsd: month?.costUsd ?? null,
    } satisfies Person;
  }).sort((a, b) => (a.role === b.role ? a.entry.localeCompare(b.entry) : a.role === "admin" ? -1 : 1));
}

export function lastSeenLabel(lastSeenAt: number | null, now = Date.now()): string {
  if (lastSeenAt === null) return t("people.never");
  if (now - lastSeenAt < 24 * 60 * 60_000) return t("people.today");
  return new Date(lastSeenAt).toISOString().slice(0, 10);
}

const levelText = (level: GrantLevel): string => t(level === "chat" ? "invite.level.chat" : "invite.level.view");

/** What a user sees: the whole team, or each chosen department and bot with its level. */
export function accessLine(grant: AccessGrant | undefined, botName: (id: string) => string = (id) => id): string {
  if (!grant) return t("people.access.whole");
  return [
    ...grant.departments.map((item) => `${item.name || t("settings.section.general")} · ${levelText(item.level)}`),
    ...grant.bots.map((item) => `${botName(item.id)} · ${levelText(item.level)}`),
  ].join(", ") || t("people.access.none");
}

export function PeopleTable({ people, busy, onRole, onRemove, onLink, readOnly = false, access, onAccess, botName }: {
  people: Person[];
  busy: boolean;
  onRole: (person: Person, role: Role) => void;
  onRemove: (person: Person) => void;
  onLink: (person: Person) => void;
  readOnly?: boolean;
  /** Each user's access by sign-in entry; absent where nobody can be limited to departments or bots. */
  access?: Record<string, AccessGrant> | null;
  onAccess?: (person: Person) => void;
  botName?: (id: string) => string;
}) {
  if (people.length === 0) return <p className="text-[13px] text-ink-secondary">{t(readOnly ? "people.portal.empty" : "people.empty")}</p>;
  // The person and their access sit beside the role and the numbers; the actions take a line of their own.
  // On a phone the person takes the first line too.
  const columns = "grid gap-x-4 grid-cols-[auto_auto_minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]";
  const line = "col-span-full grid grid-cols-subgrid items-center gap-y-1";
  const accessOf = (person: Person) => (person.role === "member" && access ? accessLine(grantFor(access, person.entry), botName) : t("people.access.whole"));
  return (
    <div className={columns}>
      <div className={cn(line, "border-b border-hairline/40 pb-2 text-[12px] font-medium uppercase tracking-wide text-ink-secondary")}>
        <span className="col-span-full sm:col-span-1">{t("people.colPerson")}</span>
        <span>{t("people.colRole")}</span>
        <span className="sm:text-right">{t("people.colLastSeen")}</span>
        <span className="text-right">{t("people.colMonth")}</span>
      </div>
      {people.map((person) => (
        <div key={person.entry} className={cn(line, "border-b border-hairline/20 py-2 text-[13px]")}>
          <span className="col-span-full min-w-0 sm:col-span-1">
            <span className="block text-ink [overflow-wrap:anywhere]">{person.isDomain ? t("people.everyoneAt", { domain: person.entry.slice(1) }) : person.entry}</span>
            {person.devices > 0 && <span className="block text-[12px] text-ink-secondary">{t("people.devices", { count: String(person.devices) })}</span>}
            {access && <span data-person-access className="block text-[12px] text-ink-secondary [overflow-wrap:anywhere]">{accessOf(person)}</span>}
          </span>
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", person.role === "admin" ? "bg-accent/15 text-accent" : "bg-control text-ink-secondary")}>
            {person.role === "admin" ? t("people.roleAdmin") : t("people.roleMember")}
          </span>
          <span className="tabular-nums text-ink-secondary sm:text-right">{person.isDomain ? "—" : lastSeenLabel(person.lastSeenAt)}</span>
          <span className="text-right tabular-nums text-ink" title={t("people.turns", { turns: String(person.turns) })}>
            {hasFiniteCost(person.costUsd) ? `${person.estimated ? "~" : ""}${formatUsd(person.costUsd)}` : "—"}
          </span>
          {!readOnly && <span data-person-actions className="col-span-full flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] sm:justify-end">
            <button type="button" disabled={busy} onClick={() => onLink(person)} aria-label={t("people.link")} title={t("people.link")} className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50"><Link2 size={13} /></button>
            {access && onAccess && person.role === "member" && <button type="button" disabled={busy} onClick={() => onAccess(person)} className="text-ink-secondary hover:text-ink disabled:opacity-50">{t("people.access.change")}</button>}
            <button type="button" disabled={busy} onClick={() => onRole(person, person.role === "admin" ? "member" : "admin")} className="text-ink-secondary hover:text-ink disabled:opacity-50">
              {person.role === "admin" ? t("people.makeMember") : t("people.makeAdmin")}
            </button>
            <button type="button" disabled={busy} onClick={() => onRemove(person)} className="text-danger hover:underline disabled:opacity-50">{t("people.remove")}</button>
          </span>}
        </div>
      ))}
    </div>
  );
}

export function PortalPeople({ peopleUrl, people }: { peopleUrl: string | null; people: Person[] }) {
  const noop = () => {};
  return (
    <Card title={t("people.title")} subtitle={t("people.portal.subtitle")}>
      <div data-people-portal className="flex flex-col gap-3 text-[13px] leading-relaxed text-ink-secondary">
        <p>{t("people.portal.managed")}</p>
        {peopleUrl && (
          <a
            href={peopleUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-fit items-center gap-2 rounded-lg bg-control px-3 py-2 font-medium text-ink hover:bg-control/70"
          >
            {t("people.portal.open")} <ExternalLink size={14} aria-hidden="true" />
          </a>
        )}
      </div>
      <div className="mt-4">
        <PeopleTable people={people} busy={false} readOnly onRole={noop} onRemove={noop} onLink={noop} />
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-ink-secondary">{t("people.portal.note")}</p>
    </Card>
  );
}

export function PeopleSection({ simple = false, startOpen = false }: { simple?: boolean; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [tried, setTried] = useState(false);
  const [session, setSession] = useState<SessionState | null>(null);
  const [membership, setMembership] = useState<Membership | null>(null);
  const [lists, setLists] = useState<SignInLists | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [base, setBase] = useState<string>(typeof window !== "undefined" ? window.location.origin : "");
  const [emailOffered, setEmailOffered] = useState<boolean | null>(null);
  const { state: store } = useStore();
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<DepartmentChoices | null>(null);
  const [dialog, setDialog] = useState<{ edit?: { entry: string; grant: AccessGrant | null } } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [config, sessions, usage, domain, environment] = await Promise.all([
        api("/api/config"),
        api("/api/auth/sessions").catch(() => ({ sessions: [] })),
        api("/api/usage?groupBy=user").catch(() => ({ groups: [] })),
        api("/api/settings/custom-domain").catch(() => null),
        fetch("/.well-known/seira/environment").then((res) => (res.ok ? res.json() : null)).catch(() => null),
      ]);
      const current: SignInLists = {
        admins: Array.isArray(config?.signIn?.admins) ? config.signIn.admins : [],
        members: Array.isArray(config?.signIn?.members) ? config.signIn.members : [],
      };
      const authority = readMembership(config);
      setMembership(authority);
      setLists(current);
      const signedIn = Array.isArray(sessions?.sessions) ? sessions.sessions : [];
      const spent = Array.isArray(usage?.groups) ? usage.groups : [];
      setPeople(authority.authority === "portal" ? peopleFromSessions(signedIn, spent) : mergePeople(current, signedIn, spent));
      if (typeof domain?.publicUrl === "string" && domain.publicUrl) setBase(domain.publicUrl);
      setEmailOffered(environment?.capabilities?.emailSignIn === true ? true : environment ? false : null);
      setChoices(authority.authority === "portal" ? null : await loadDepartmentChoices());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void readSessionState().then((state) => {
      setSession(state);
      if (canPairDevices(state)) void load();
    });
  }, [load]);

  const save = async (next: SignInLists, before?: () => Promise<void>, after?: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await before?.();
      await api("/api/config", { method: "PUT", body: JSON.stringify({ signIn: next }) });
      await after?.();
      await load();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const botName = (id: string) => store.bots.find((bot) => bot.id === id)?.name ?? id;

  const remove = (entry: string) => {
    if (!lists) return;
    void save(withoutEntry(lists, entry), undefined, choices?.access.people[entry] ? () => saveDepartmentAccess(entry, null).catch(() => undefined) : undefined);
  };

  if (!canPairDevices(session)) return null;
  const portal = membership?.authority === "portal" ? <PortalPeople peopleUrl={membership.peopleUrl} people={people} /> : null;
  const inviteBlocked: string | null = null;
  const content = (
    <>
      {emailOffered === false && (!simple || tried) && <p className="mb-3 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-[13px] text-ink-secondary">{t(membership?.pairingCodes === false ? "people.portalSignIn" : "people.notHosted")}</p>}
      <div data-people-actions className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || inviteBlocked !== null} onClick={() => { setTried(true); setDialog({}); }} className="ui-button ui-button-primary">
          <Plus size={13} />{t("people.invite")}
        </button>
        <button type="button" onClick={() => void load()} disabled={loading || busy} aria-label={t("people.refresh")} title={t("people.refresh")} className="rounded-md p-1.5 text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50"><RefreshCw size={13} className={cn(loading && "animate-spin")} /></button>
      </div>
      {inviteBlocked !== null && <p data-people-blocked role="note" className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{inviteBlocked}</p>}
      {choices?.access.unreadable && <p role="alert" className="mt-2 text-[12px] text-danger">{t("people.access.unreadable")}</p>}
      {link && <CopyLink link={link} />}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
      <div className="mt-4">
        <PeopleTable
          people={people}
          busy={busy}
          onRole={(person, next) => { if (lists) void save(withEntry(lists, person.entry, next)); }}
          onRemove={(person) => remove(person.entry)}
          onLink={(person) => setLink(inviteLink(base, person.entry))}
          access={choices && !choices.access.unreadable ? choices.access.people : null}
          botName={botName}
          onAccess={(person) => setDialog({ edit: { entry: person.entry, grant: choices ? grantFor(choices.access.people, person.entry) ?? null : null } })}
        />
      </div>
      <InviteDialog open={dialog !== null} edit={dialog?.edit} onClose={() => setDialog(null)} onDone={() => void load()} />
      {!simple && <p className="mt-3 text-[12px] leading-relaxed text-ink-secondary">{t("people.note")}</p>}
    </>
  );
  if (simple) {
    return (
      <div data-people-summary="">
        {/* Drawn like the name row above it, a round mark then two lines, so the Account card has one text edge. */}
        <div role="group" aria-label={t("people.title")} className="flex min-w-0 items-center gap-3 px-4 py-[13px]">
          <span aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-full bg-ink/[0.06] text-ink-secondary"><Users size={20} /></span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] leading-5 text-ink">{t("people.title")}</div>
            <div className="text-[13px] leading-[18px] text-ink-secondary">{t("settings.simple.people")}</div>
          </div>
          <button type="button" aria-expanded={open} className="ui-button shrink-0" onClick={() => setOpen(!open)}>
            {open ? t("common.done") : t("settings.simple.people.invite")}
          </button>
        </div>
        {open && <div className="px-3.5 pb-3.5 pt-1">{portal ?? content}</div>}
      </div>
    );
  }
  return portal ?? <Card title={t("people.title")} subtitle={t("people.subtitle")}>{content}</Card>;
}
