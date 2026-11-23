import { Fragment, useCallback, useEffect, useState } from "react";
import { Check, Copy, Loader2, X } from "lucide-react";
import { t } from "@/lib/i18n";
import { useCopyFeedback } from "@/lib/copy-text";
import type { LocaleKey } from "@/locales";
import { api, useStore } from "@/state/store";
import { Select } from "./Select";
import { SettingRow, SettingsEmptyRow, SettingsGroup, SettingsRows } from "./SettingsPrimitives";
import { SettingsDialog } from "./settings/SettingsDialog";
import { A2aForm, AddressList, IssuedBox, NewTokenDialog, isA2a, type A2aIssued, type A2aLink } from "./LinkedA2aForm";

export const APPROVAL_CAPS = ["ask", "edits", "auto"] as const;
export type ApprovalCap = typeof APPROVAL_CAPS[number];

export interface LinkedServer {
  id: string;
  kind?: "seira";
  name: string;
  state: "online" | "offline" | "ended";
  exposed: string[];
  cap: ApprovalCap;
  bots: Array<{ id: string; name: string }>;
}

interface Invite { text: string; expiresAt: number }

const messageOf = (cause: unknown): string => (cause instanceof Error && cause.message ? cause.message : t("linked.error.generic"));

export function inviteMinutes(expiresAt: number, now = Date.now()): number {
  return Math.max(1, Math.round((expiresAt - now) / 60_000));
}

function InviteBox({ invite, onDone }: { invite: Invite; onDone: () => void }) {
  const { state, copy } = useCopyFeedback(invite.text);
  return (
    <div data-linked-invite="" className="flex flex-col gap-2 rounded-lg border border-hairline/40 bg-inset p-3 text-[13px]">
      <div className="font-medium text-ink">{t("linked.invite.label")}</div>
      <div className="flex items-start gap-2">
        <code data-linked-invite-text="" className="min-w-0 flex-1 select-all break-all text-ink">{invite.text}</code>
        <button type="button" onClick={copy} className="ui-button shrink-0">
          {state === "copied" ? <Check size={13} aria-hidden="true" className="text-success" /> : state === "failed" ? <X size={13} aria-hidden="true" className="text-danger" /> : <Copy size={13} aria-hidden="true" />}
          {t(state === "copied" ? "linked.copied" : state === "failed" ? "common.copyFailed" : "linked.copy")}
        </button>
      </div>
      <p className="text-[12px] leading-4 text-ink-secondary">{t("linked.invite.hint", { minutes: String(inviteMinutes(invite.expiresAt)) })}</p>
      <div><button type="button" onClick={onDone} className="ui-button">{t("common.done")}</button></div>
    </div>
  );
}

function JoinBox({ onJoined, onCancel }: { onJoined: () => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/linked-servers/join", { method: "POST", body: JSON.stringify({ invite: text.trim() }) });
      await onJoined();
    } catch (cause) {
      setError(messageOf(cause));
      setBusy(false);
    }
  };
  return (
    <form data-linked-join="" className="flex flex-col gap-2 rounded-lg border border-hairline/40 bg-inset p-3 text-[13px]"
      onSubmit={(event) => { event.preventDefault(); if (text.trim() && !busy) void join(); }}>
      <label className="flex flex-col gap-1.5">
        <span className="font-medium text-ink">{t("linked.join.label")}</span>
        <textarea value={text} onChange={(event) => setText(event.target.value)} disabled={busy} rows={3} spellCheck={false}
          className="w-full resize-none rounded-lg border border-hairline/40 bg-app px-2 py-1.5 text-[13px] leading-5 text-ink outline-none focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40" />
      </label>
      {error && <p role="alert" className="text-[12px] leading-4 text-danger">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy || !text.trim()} className="ui-button ui-button-primary">
          {busy && <Loader2 size={13} aria-hidden="true" className="animate-spin" />}{t(busy ? "linked.joining" : "linked.join.submit")}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className="ui-button">{t("common.cancel")}</button>
      </div>
    </form>
  );
}

function LinkEditor({ link, mine, onSaved, onCancel }: { link: Pick<LinkedServer, "id" | "exposed" | "cap">; mine: Array<{ id: string; name: string }>; onSaved: () => Promise<void>; onCancel: () => void }) {
  const known = new Set(mine.map((bot) => bot.id));
  const [exposed, setExposed] = useState<string[]>(link.exposed.filter((id) => known.has(id)));
  const [cap, setCap] = useState<ApprovalCap>(link.cap);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: string) => setExposed((now) => (now.includes(id) ? now.filter((item) => item !== id) : [...now, id]));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/linked-servers/${link.id}`, { method: "PATCH", body: JSON.stringify({ exposed, cap }) });
      await onSaved();
    } catch (cause) {
      setError(messageOf(cause));
      setBusy(false);
    }
  };
  return (
    <div data-linked-edit="" className="flex flex-col gap-3 border-t border-hairline/20 px-4 py-3 text-[13px]">
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 font-medium text-ink">{t("linked.edit.bots")}</legend>
        {mine.length === 0 ? <p className="text-ink-secondary">{t("linked.edit.noBots")}</p> : (
          <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
            {mine.map((bot) => (
              <label key={bot.id} className="flex items-center gap-2 text-ink">
                <input type="checkbox" className="accent-accent" checked={exposed.includes(bot.id)} disabled={busy} onChange={() => toggle(bot.id)} />
                <span className="min-w-0 truncate">{bot.name}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <label className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-ink">{t("linked.edit.cap")}</span>
          <Select value={cap} disabled={busy} onChange={(event) => setCap(event.target.value as ApprovalCap)}>
            {APPROVAL_CAPS.map((value) => <option key={value} value={value}>{t(`linked.cap.${value}` as LocaleKey)}</option>)}
          </Select>
        </label>
        <p data-linked-cap-note="" className="text-[12px] leading-4 text-ink-secondary">{t(`linked.cap.${cap}.note` as LocaleKey)} {t("linked.edit.capHint")}</p>
      </div>
      {error && <p role="alert" className="text-[12px] leading-4 text-danger">{error}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={() => void save()} className="ui-button ui-button-primary">{t("common.save")}</button>
        <button type="button" disabled={busy} onClick={onCancel} className="ui-button">{t("common.cancel")}</button>
      </div>
    </div>
  );
}

function RemoveDialog({ link, onRemoved, onClose }: { link: Pick<LinkedServer, "id" | "name">; onRemoved: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/linked-servers/${link.id}`, { method: "DELETE" });
      await onRemoved();
    } catch (cause) {
      setError(messageOf(cause));
      setBusy(false);
    }
  };
  return (
    <SettingsDialog title={t("linked.remove.title", { name: link.name })} onClose={onClose}
      footer={<>
        <button type="button" className="ui-button ui-button-md rounded-full" data-autofocus="" onClick={onClose}>{t("common.cancel")}</button>
        <button type="button" disabled={busy} data-linked-remove-confirm="" className="ui-button ui-button-md rounded-full !bg-danger !text-danger-ink" onClick={() => void remove()}>{t("linked.remove.confirm")}</button>
      </>}>
      <p className="text-[13px] leading-[18px] text-ink-secondary">{t("linked.remove.body")}</p>
      {error && <p role="alert" className="text-[12px] leading-4 text-danger">{error}</p>}
    </SettingsDialog>
  );
}

export function LinkedServersSection() {
  const { state } = useStore();
  const mine = state.bots.map((bot) => ({ id: bot.id, name: bot.name }));
  const [links, setLinks] = useState<Array<LinkedServer | A2aLink> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [joining, setJoining] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<LinkedServer | A2aLink | null>(null);
  const [addingA2a, setAddingA2a] = useState(false);
  const [issued, setIssued] = useState<A2aIssued | null>(null);
  const [renewing, setRenewing] = useState<A2aLink | null>(null);

  const load = useCallback(async () => {
    try {
      const answer = await api("/api/linked-servers");
      setLinks(Array.isArray(answer?.servers) ? answer.servers : []);
      setLoadError(null);
    } catch (cause) {
      setLoadError(messageOf(cause));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const makeInvite = async () => {
    setInviting(true);
    setInviteError(null);
    setJoining(false);
    setAddingA2a(false);
    try {
      const made = await api("/api/linked-servers/invites", { method: "POST", body: "{}" });
      setInvite({ text: String(made.invite), expiresAt: Number(made.expiresAt) });
    } catch (cause) {
      setInvite(null);
      setInviteError(messageOf(cause));
    } finally {
      setInviting(false);
    }
  };

  const nameOf = (id: string) => mine.find((bot) => bot.id === id)?.name ?? id;
  const stateLine = (link: LinkedServer | A2aLink) => t((isA2a(link) ? `linked.a2a.state.${link.state}` : `linked.state.${link.state}`) as LocaleKey);
  const exposedLine = (link: LinkedServer | A2aLink) => {
    const names = link.exposed.map((id) => mine.find((bot) => bot.id === id)?.name).filter((name): name is string => Boolean(name));
    const a2a = isA2a(link);
    return names.length ? t(a2a ? "linked.a2a.exposed" : "linked.exposed", { bots: names.join(", ") }) : t(a2a ? "linked.a2a.exposed.none" : "linked.exposed.none");
  };

  return (
    <SettingsGroup label={t("linked.group")} block="links" description={t("linked.intro")}
      actions={<>
        <button type="button" disabled={inviting} onClick={() => void makeInvite()} className="ui-button">{t("linked.makeInvite")}</button>
        <button type="button" onClick={() => { setJoining(!joining); setInvite(null); setInviteError(null); setAddingA2a(false); }} aria-expanded={joining} className="ui-button">{t("linked.join")}</button>
        <button type="button" onClick={() => { setAddingA2a(!addingA2a); setJoining(false); setInvite(null); setInviteError(null); setIssued(null); }} aria-expanded={addingA2a} className="ui-button">{t("linked.a2a.add")}</button>
      </>}>
      {invite && <InviteBox invite={invite} onDone={() => setInvite(null)} />}
      {inviteError && <p role="alert" className="px-4 text-[12px] leading-4 text-danger">{inviteError}</p>}
      {joining && <JoinBox onCancel={() => setJoining(false)} onJoined={async () => { setJoining(false); await load(); }} />}
      {addingA2a && <A2aForm onCancel={() => setAddingA2a(false)} onAdded={async (made) => { setAddingA2a(false); setIssued(made); await load(); }} />}
      {issued && <IssuedBox issued={issued} nameOf={nameOf} onDone={() => setIssued(null)} />}
      {loadError && (
        <p role="alert" className="flex items-center gap-2 px-4 text-[12px] leading-4 text-danger">
          {loadError}
          <button type="button" onClick={() => void load()} className="ui-button">{t("common.tryAgain")}</button>
        </p>
      )}
      {links !== null && (
        <SettingsRows>
          {links.length === 0 && <SettingsEmptyRow>{t("linked.empty")}</SettingsEmptyRow>}
          {links.map((link) => (
            <Fragment key={link.id}>
              <SettingRow title={link.name} subtitle={stateLine(link)}
                message={<>
                  {isA2a(link) && <span data-linked-kind="" className="mb-0.5 block font-medium">{t("linked.a2a.kind")}</span>}
                  {isA2a(link) && link.problem && <span data-linked-problem="" className="mb-0.5 block text-danger">{link.problem}</span>}
                  <span data-linked-summary="">{exposedLine(link)} · {t("linked.cap.line", { cap: t(`linked.cap.${link.cap}` as LocaleKey) })}</span>
                  {isA2a(link) && link.outbound && <span data-linked-outbound="" className="mt-0.5 block break-all">{t("linked.a2a.outbound", { url: link.outbound.url })}</span>}
                  {isA2a(link) && link.inbound && (link.inbound.urls.length > 0 ? (
                    <details data-linked-inbound="" className="mt-1">
                      <summary className="cursor-pointer">{t("linked.a2a.addresses", { count: String(link.inbound.urls.length) })}</summary>
                      <div className="mt-1"><AddressList urls={link.inbound.urls} nameOf={nameOf} /></div>
                    </details>
                  ) : <span data-linked-inbound="" className="mt-0.5 block">{t("linked.a2a.noAddresses")}</span>)}
                  {link.bots.length > 0 && (
                    <details data-linked-theirs="" className="mt-1">
                      <summary className="cursor-pointer">{t("linked.theirs", { count: String(link.bots.length) })}</summary>
                      <ul className="mt-1 list-disc pl-4">{link.bots.map((bot) => <li key={bot.id}>{bot.name}</li>)}</ul>
                    </details>
                  )}
                </>}>
                <button type="button" disabled={link.state === "ended"} title={link.state === "ended" ? t("linked.state.ended") : undefined}
                  onClick={() => setEditing(editing === link.id ? null : link.id)} aria-expanded={editing === link.id} className="ui-button">{t("linked.edit")}</button>
                {isA2a(link) && link.inbound && (
                  <button type="button" disabled={link.state === "ended"} title={link.state === "ended" ? t("linked.a2a.state.ended") : undefined}
                    onClick={() => setRenewing(link)} className="ui-button">{t("linked.a2a.newToken")}</button>
                )}
                <button type="button" onClick={() => setRemoving(link)} className="ui-button">{t("linked.remove")}</button>
              </SettingRow>
              {editing === link.id && <LinkEditor link={link} mine={mine} onCancel={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); }} />}
            </Fragment>
          ))}
        </SettingsRows>
      )}
      {renewing && <NewTokenDialog link={renewing} onClose={() => setRenewing(null)}
        onIssued={async (made) => { setRenewing(null); setAddingA2a(false); setIssued(made); await load(); }} />}
      {removing && <RemoveDialog link={removing} onClose={() => setRemoving(null)} onRemoved={async () => { setRemoving(null); setEditing(null); await load(); }} />}
    </SettingsGroup>
  );
}
