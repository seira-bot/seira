import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { inviteAddsToBot } from "@/lib/invite-access";
import { loadDepartmentChoices, openFolderDepartments, saveDepartmentAccess, type DepartmentChoices } from "@/lib/department-access";
import { GRANT_LEVELS, type AccessGrant, type GrantLevel } from "../../shared/department-access";
import { Segmented } from "./bot-panel/rows";
import { CopyLink, inviteLink } from "./InviteLink";
import { Select } from "./Select";
import { SettingsLook } from "./SettingsPrimitives";
import { normalizeAccessEntry, withEntry, type SignInLists } from "./SignInAccessCard";

type Kind = "whole" | "departments" | "bots";
type Levels = Record<string, GrantLevel>;

export interface InviteDialogProps {
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
  preset?: { departments?: string[]; bots?: string[] };
  edit?: { entry: string; grant: AccessGrant | null };
}

const BOTS_FILTER_FROM = 9;

const levelsOf = <T,>(items: readonly T[], key: (item: T) => string, level: (item: T) => GrantLevel): Levels =>
  Object.fromEntries(items.map((item) => [key(item), level(item)]));

function startingKind(props: Pick<InviteDialogProps, "preset" | "edit">): Kind {
  const grant = props.edit?.grant;
  if (grant) return grant.departments.length ? "departments" : grant.bots.length ? "bots" : "whole";
  if (props.preset?.departments?.length) return "departments";
  if (props.preset?.bots?.length) return "bots";
  return "whole";
}

const listOf = (names: string[]): string => {
  try {
    return new Intl.ListFormat(undefined, { style: "long", type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
};

function PickRow({ checked, onToggle, label, sub, level, onLevel, levelLabel, itemKey }: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  sub?: string;
  level: GrantLevel;
  onLevel: (level: GrantLevel) => void;
  levelLabel: string;
  itemKey: string;
}) {
  return (
    <li data-invite-item={itemKey} className="flex min-h-9 items-center justify-between gap-2 py-1">
      <label className="flex min-w-0 flex-1 items-center gap-2 text-[13px] text-ink">
        <input type="checkbox" checked={checked} onChange={onToggle} className="shrink-0" />
        <span className="min-w-0">
          <span dir="auto" className="block truncate">{label}</span>
          {sub && <span dir="auto" className="block truncate text-[12px] text-ink-secondary">{sub}</span>}
        </span>
      </label>
      {checked && (
        <Select size="sm" value={level} aria-label={levelLabel} onChange={(event) => onLevel(event.target.value as GrantLevel)}>
          {GRANT_LEVELS.map((value) => <option key={value} value={value}>{t(value === "chat" ? "invite.level.chat" : "invite.level.view")}</option>)}
        </Select>
      )}
    </li>
  );
}

function Shell({ title, subtitle, titleId, dialogRef, children }: { title: string; subtitle?: string; titleId: string; dialogRef: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  return (
    <div className="ui-scrim fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-invite-dialog
        className="ui-modal flex max-h-full w-full max-w-[480px] flex-col text-ink shadow-2xl outline-none animate-pop-in motion-reduce:animate-none">
        <header className="px-5 pb-2 pt-4">
          <h2 id={titleId} className="min-w-0 truncate text-[17px] font-semibold">{title}</h2>
          {subtitle && <p dir="auto" className="mt-0.5 truncate text-[13px] text-ink-secondary">{subtitle}</p>}
        </header>
        {children}
      </div>
    </div>
  );
}

function InviteBody({ onClose, onDone, preset, edit }: Omit<InviteDialogProps, "open">) {
  const { state } = useStore();
  const titleId = useId();
  const groupId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const editing = edit !== undefined;
  const [lists, setLists] = useState<SignInLists | null>(null);
  const [base, setBase] = useState(typeof window !== "undefined" ? window.location.origin : "");
  const [choices, setChoices] = useState<DepartmentChoices | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [kind, setKind] = useState<Kind>(() => startingKind({ preset, edit }));
  const [departmentLevels, setDepartmentLevels] = useState<Levels>(() => edit?.grant?.departments.length
    ? levelsOf(edit.grant.departments, (item) => item.name, (item) => item.level)
    : Object.fromEntries((preset?.departments ?? []).map((name) => [name, "chat" as const])));
  const [botLevels, setBotLevels] = useState<Levels>(() => !edit?.grant?.departments.length && edit?.grant?.bots.length
    ? levelsOf(edit.grant.bots, (item) => item.id, (item) => item.level)
    : Object.fromEntries((preset?.bots ?? []).map((id) => [id, "chat" as const])));
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  const close = () => {
    if (link) onDone?.();
    onClose();
  };
  useModalDialog(dialogRef, close);

  useEffect(() => {
    let live = true;
    void Promise.all([
      editing ? null : api("/api/config"),
      editing ? null : api("/api/settings/custom-domain").catch(() => null),
      loadDepartmentChoices(),
    ]).then(([config, domain, found]) => {
      if (!live) return;
      if (config) setLists({ admins: Array.isArray(config.signIn?.admins) ? config.signIn.admins : [], members: Array.isArray(config.signIn?.members) ? config.signIn.members : [] });
      if (typeof domain?.publicUrl === "string" && domain.publicUrl) setBase(domain.publicUrl);
      setChoices(found);
      setLoaded(true);
    }).catch((cause: unknown) => {
      if (!live) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setLoaded(true);
    });
    return () => { live = false; };
  }, [editing]);

  const departments = useMemo(() => ["", ...(choices?.departments ?? [])], [choices]);
  const bots = useMemo(() => {
    const rank = (section: string | undefined) => {
      const at = departments.indexOf(section ?? "");
      return at < 0 ? departments.length : at;
    };
    return state.bots.filter((bot) => !bot.hidden && !bot.defaultBot?.person).sort((a, b) => rank(a.section) - rank(b.section));
  }, [state.bots, departments]);
  const general = t("settings.section.general");
  const departmentName = (name: string) => name || general;
  const admin = role === "admin";
  const effective: Kind = admin ? "whole" : kind;
  const mixed = Boolean(edit?.grant?.departments.length && edit.grant.bots.length);
  const chosenDepartments = departments.filter((name) => name in departmentLevels);
  const chosenBots = bots.filter((bot) => bot.id in botLevels);
  const chosenKindDepartments = effective === "departments" ? chosenDepartments : departments.filter((name) => chosenBots.some((bot) => (bot.section ?? "") === name));
  const openFolders = choices && effective !== "whole" ? openFolderDepartments(chosenKindDepartments, choices.limited) : [];
  const botsIn = (name: string) => bots.filter((bot) => (bot.section ?? "") === name).map((bot) => bot.name).join(", ");
  const shownBots = filter.trim() ? bots.filter((bot) => bot.name.toLowerCase().includes(filter.trim().toLowerCase())) : bots;

  const grant = (): AccessGrant => effective === "departments"
    ? { departments: chosenDepartments.map((name) => ({ name, level: departmentLevels[name]! })), bots: [] }
    : { departments: [], bots: chosenBots.map((bot) => ({ id: bot.id, level: botLevels[bot.id]! })) };

  const summary = (() => {
    if (admin) return t("people.access.adminReason");
    if (effective === "whole") return t("invite.summary.whole");
    const items = effective === "departments"
      ? chosenDepartments.map((name) => ({ name: departmentName(name), level: departmentLevels[name]! }))
      : chosenBots.map((bot) => ({ name: bot.name, level: botLevels[bot.id]! }));
    if (!items.length) return t(effective === "departments" ? "invite.pickDepartments" : "invite.pickBots");
    const chat = items.filter((item) => item.level === "chat").map((item) => item.name);
    const view = items.filter((item) => item.level === "view").map((item) => item.name);
    const inDepartments = effective === "departments";
    return [
      chat.length ? t(inDepartments ? "invite.summary.chatDepartments" : "invite.summary.chat", { names: listOf(chat) }) : "",
      view.length ? t(inDepartments ? "invite.summary.viewDepartments" : "invite.summary.view", { names: listOf(view) }) : "",
    ].filter(Boolean).join(" ");
  })();
  const typedEntry = edit ? edit.entry : email.trim().toLowerCase();
  const sharedWithSome = effective === "bots" ? chosenBots.filter((bot) => inviteAddsToBot(bot, typedEntry)).map((bot) => bot.name) : [];
  const byDomain = typedEntry.startsWith("@");

  const toggle = (setter: typeof setDepartmentLevels, key: string) => setter((current) => {
    const next = { ...current };
    if (key in next) delete next[key]; else next[key] = "chat";
    return next;
  });

  const submit = async () => {
    if (busy || !loaded) return;
    setError(null);
    const entry = edit ? edit.entry : normalizeAccessEntry(email);
    if (!entry) {
      setError(t("remote.signInAccess.invalid"));
      return;
    }
    const limited = effective !== "whole";
    const wanted = limited ? grant() : null;
    if (wanted && wanted.departments.length + wanted.bots.length === 0) {
      setError(t(effective === "departments" ? "invite.pickDepartments" : "invite.pickBots"));
      return;
    }
    if (wanted && sharedWithSome.length > 0 && entry.startsWith("@")) {
      setError(t("invite.domainBot", { bots: listOf(sharedWithSome) }));
      return;
    }
    setBusy(true);
    try {
      if (wanted) await saveDepartmentAccess(entry, wanted, sharedWithSome.length > 0);
      else if (edit ? edit.grant : choices?.access.people[entry]) await saveDepartmentAccess(entry, null);
      if (edit) {
        onDone?.();
        onClose();
        return;
      }
      await api("/api/config", { method: "PUT", body: JSON.stringify({ signIn: withEntry(lists!, entry, role) }) });
      setLink(inviteLink(base, entry));
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("people.access.failed"));
    } finally {
      setBusy(false);
    }
  };

  const presetDepartments = preset?.departments ?? [];
  const presetBots = preset?.bots ?? [];
  const presetName = presetDepartments.length === 1 && !presetBots.length
    ? departmentName(presetDepartments[0]!)
    : presetBots.length === 1 && !presetDepartments.length
      ? state.bots.find((bot) => bot.id === presetBots[0])?.name
      : undefined;
  const title = link ? t("invite.ready") : edit ? t("people.access.change") : presetName ? t("invite.titleTo", { name: presetName }) : t("invite.title");
  const subtitle = edit && !link ? (edit.entry.startsWith("@") ? t("people.everyoneAt", { domain: edit.entry.slice(1) }) : edit.entry) : undefined;
  const optionsOff = !loaded || choices === null;

  const radio = (value: Kind, label: string, hint?: string) => (
    <label key={value} className="flex min-h-9 items-center gap-2 py-1 text-[13px] text-ink">
      <input type="radio" name={groupId} value={value} checked={effective === value} disabled={admin || (value !== "whole" && optionsOff)} onChange={() => setKind(value)} className="shrink-0" />
      <span className="min-w-0">
        <span data-invite-kind className="block">{label}</span>
        {hint && <span className="block text-[12px] text-ink-secondary">{hint}</span>}
      </span>
    </label>
  );

  const scrolled = useRef(false);
  useEffect(() => {
    if (!loaded || scrolled.current || !(presetDepartments.length || presetBots.length)) return;
    scrolled.current = true;
    const row = [...(dialogRef.current?.querySelectorAll<HTMLElement>("[data-invite-item]") ?? [])].find((node) => node.querySelector<HTMLInputElement>("input")?.checked);
    if (typeof row?.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
  }, [loaded, presetDepartments.length, presetBots.length]);

  return createPortal(
    <SettingsLook.Provider value={false}>
      <Shell title={title} subtitle={subtitle} titleId={titleId} dialogRef={dialogRef}>
        {link ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
              <CopyLink link={link} hint={t("invite.sendHint")} />
              <p role="status" data-invite-summary className="mt-3 text-[13px] leading-relaxed text-ink-secondary">{summary}</p>
            </div>
            <footer className="flex flex-wrap items-center justify-end gap-2 px-5 pb-4">
              <button type="button" className="ui-button ui-button-primary" onClick={close}>{t("common.done")}</button>
            </footer>
          </>
        ) : (
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-4">
              {!edit && (
                <>
                  <label className="flex flex-col gap-1 text-[13px] text-ink">
                    {t("people.inviteEmail")}
                    <input
                      autoFocus
                      dir="auto"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder={t("remote.signInAccess.placeholder")}
                      disabled={busy}
                      className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none disabled:opacity-50"
                    />
                  </label>
                  <div className="flex flex-col gap-1">
                    <Segmented
                      attr="data-invite-role"
                      label={t("people.colRole")}
                      value={role}
                      onChange={setRole}
                      options={[{ value: "member", label: t("people.roleMember") }, { value: "admin", label: t("people.roleAdmin") }]}
                    />
                    <p className="text-[12px] leading-relaxed text-ink-secondary">{t("people.inviteHint")}</p>
                  </div>
                </>
              )}
              <fieldset disabled={admin || busy} className="flex min-w-0 flex-col gap-1">
                <legend className="mb-1 text-[13px] font-medium text-ink">{t("invite.access.legend")}</legend>
                {radio("whole", t("people.access.whole"))}
                {radio("departments", t("people.access.chosen"), t("invite.access.departmentsHint"))}
                {effective === "departments" && (
                  <ul className="ms-6 flex flex-col">
                    {departments.map((name) => (
                      <PickRow key={name || "general"} itemKey={name || "general"} checked={name in departmentLevels} label={departmentName(name)} sub={botsIn(name) || undefined}
                        onToggle={() => toggle(setDepartmentLevels, name)} level={departmentLevels[name] ?? "chat"}
                        onLevel={(level) => setDepartmentLevels((current) => ({ ...current, [name]: level }))}
                        levelLabel={t("invite.level.label", { name: departmentName(name) })} />
                    ))}
                  </ul>
                )}
                {radio("bots", t("invite.access.bots"), t("invite.access.botsHint"))}
                {effective === "bots" && (
                  <div className="ms-6 flex flex-col gap-1">
                    {bots.length >= BOTS_FILTER_FROM && (
                      <input dir="auto" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label={t("invite.findBot")} placeholder={t("invite.findBot")}
                        className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none" />
                    )}
                    <ul className="flex flex-col">
                      {shownBots.map((bot) => (
                        <PickRow key={bot.id} itemKey={bot.id} checked={bot.id in botLevels} label={bot.name} sub={departmentName(bot.section ?? "")}
                          onToggle={() => toggle(setBotLevels, bot.id)} level={botLevels[bot.id] ?? "chat"}
                          onLevel={(level) => setBotLevels((current) => ({ ...current, [bot.id]: level }))}
                          levelLabel={t("invite.level.label", { name: bot.name })} />
                      ))}
                    </ul>
                  </div>
                )}
              </fieldset>
              {loaded && choices === null && !admin && <p className="text-[12px] text-ink-secondary">{t("invite.access.unavailable")}</p>}
              {effective === "departments" && chosenDepartments.includes("") && <p role="note" className="text-[12px] leading-relaxed text-warning">{t("people.access.generalWarning")}</p>}
              {openFolders.length > 0 && <p role="note" className="text-[12px] leading-relaxed text-warning">{t("invite.folderWarning", { departments: listOf(openFolders.map(departmentName)) })}</p>}
              {sharedWithSome.length > 0 && <p role="note" className="text-[12px] leading-relaxed text-ink-secondary">{t(byDomain ? "invite.domainBot" : "invite.botNote", { bots: listOf(sharedWithSome) })}</p>}
              {mixed && <p role="note" className="text-[12px] leading-relaxed text-ink-secondary">{t("invite.mixed")}</p>}
              {choices?.access.unreadable && <p role="alert" className="text-[12px] text-danger">{t("people.access.unreadable")}</p>}
              <p role="status" data-invite-summary className="text-[13px] leading-relaxed text-ink-secondary">{summary}</p>
              {error && <p role="alert" dir="auto" className="text-[12px] text-danger">{error}</p>}
            </div>
            <footer className="flex flex-wrap items-center justify-end gap-2 px-5 pb-4">
              <button type="button" className="ui-button" onClick={close}>{t("common.cancel")}</button>
              <button type="submit" disabled={busy || !loaded} className="ui-button ui-button-primary">
                {busy && <Loader2 size={13} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />}{t(edit ? "common.save" : "people.invite")}
              </button>
            </footer>
          </form>
        )}
      </Shell>
    </SettingsLook.Provider>,
    document.body,
  );
}

/** Invite a person, or change a person's access: the whole team, chosen departments or chosen bots, each with a level. */
export function InviteDialog({ open, ...rest }: InviteDialogProps) {
  return open ? <InviteBody {...rest} /> : null;
}
