import { useState } from "react";
import { Check, Copy, Loader2, X } from "lucide-react";
import { t } from "@/lib/i18n";
import { useCopyFeedback } from "@/lib/copy-text";
import { api } from "@/state/store";
import { SettingsDialog } from "./settings/SettingsDialog";
import type { ApprovalCap } from "./LinkedServersSection";

export interface A2aLink {
  id: string;
  kind: "a2a";
  name: string;
  state: "online" | "offline" | "ended";
  exposed: string[];
  cap: ApprovalCap;
  bots: Array<{ id: string; name: string; description?: string }>;
  createdAt: number;
  outbound: { url: string; hasToken: boolean } | null;
  inbound: { urls: A2aAddress[] } | null;
  problem: string | null;
}

export interface A2aAddress { bot: string; url: string }

/** What the person must copy now: the token shows once. */
export interface A2aIssued { name: string; token?: string; urls: A2aAddress[] }

export const isA2a = (link: A2aLink | { kind?: undefined }): link is A2aLink => link.kind === "a2a";

const messageOf = (cause: unknown): string => (cause instanceof Error && cause.message ? cause.message : t("linked.error.generic"));

export function CopyButton({ text }: { text: string }) {
  const { state, copy } = useCopyFeedback(text);
  return (
    <button type="button" onClick={copy} className="ui-button shrink-0">
      {state === "copied" ? <Check size={13} aria-hidden="true" className="text-success" /> : state === "failed" ? <X size={13} aria-hidden="true" className="text-danger" /> : <Copy size={13} aria-hidden="true" />}
      {t(state === "copied" ? "linked.copied" : state === "failed" ? "common.copyFailed" : "linked.copy")}
    </button>
  );
}

export function AddressList({ urls, nameOf }: { urls: A2aAddress[]; nameOf: (bot: string) => string }) {
  return (
    <ul data-linked-a2a-addresses="" className="flex flex-col gap-1.5">
      {urls.map((address) => (
        <li key={address.bot} className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-ink">{nameOf(address.bot)}</div>
            <code className="select-all break-all text-ink-secondary">{address.url}</code>
          </div>
          <CopyButton text={address.url} />
        </li>
      ))}
    </ul>
  );
}

export function IssuedBox({ issued, nameOf, onDone }: { issued: A2aIssued; nameOf: (bot: string) => string; onDone: () => void }) {
  return (
    <div data-linked-a2a-issued="" className="flex flex-col gap-2 rounded-lg border border-hairline/40 bg-inset p-3 text-[13px]">
      {issued.token && (
        <>
          <div className="font-medium text-ink">{t("linked.a2a.token.title", { name: issued.name })}</div>
          <div className="flex items-start gap-2">
            <code data-linked-a2a-token="" className="min-w-0 flex-1 select-all break-all text-ink">{issued.token}</code>
            <CopyButton text={issued.token} />
          </div>
          <p className="text-[12px] leading-4 text-ink-secondary">{t("linked.a2a.token.hint")}</p>
        </>
      )}
      {issued.urls.length > 0 ? (
        <>
          <div className="font-medium text-ink">{t("linked.a2a.addresses.label")}</div>
          <AddressList urls={issued.urls} nameOf={nameOf} />
        </>
      ) : issued.token && <p className="text-[12px] leading-4 text-ink-secondary">{t("linked.a2a.noAddresses")}</p>}
      <div><button type="button" onClick={onDone} className="ui-button">{t("common.done")}</button></div>
    </div>
  );
}

export function A2aForm({ onAdded, onCancel }: { onAdded: (issued: A2aIssued | null) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [outbound, setOutbound] = useState(true);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [inbound, setInbound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const why = !name.trim() ? t("linked.a2a.why.name")
    : !outbound && !inbound ? t("linked.a2a.why.way")
    : outbound && !url.trim() ? t("linked.a2a.why.url")
    : null;
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: name.trim(), inbound,
        ...(outbound && url.trim() ? { url: url.trim() } : {}),
        ...(outbound && token.trim() ? { token: token.trim() } : {}),
      };
      const made = await api("/api/linked-servers/a2a", { method: "POST", body: JSON.stringify(body) });
      const urls: A2aAddress[] = Array.isArray(made?.urls) ? made.urls : [];
      await onAdded(inbound && typeof made?.token === "string" ? { name: name.trim(), token: made.token, urls } : null);
    } catch (cause) {
      setError(messageOf(cause));
      setBusy(false);
    }
  };
  const field = "w-full rounded-lg border border-hairline/40 bg-app px-2 py-1.5 text-[13px] leading-5 text-ink outline-none focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40";
  return (
    <form data-linked-a2a-form="" className="flex flex-col gap-3 rounded-lg border border-hairline/40 bg-inset p-3 text-[13px]"
      onSubmit={(event) => { event.preventDefault(); if (!why && !busy) void add(); }}>
      <label className="flex flex-col gap-1.5">
        <span className="font-medium text-ink">{t("linked.a2a.form.name")}</span>
        <input value={name} onChange={(event) => setName(event.target.value)} disabled={busy} className={field} />
      </label>
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-ink">
          <input type="checkbox" className="accent-accent" checked={outbound} disabled={busy} onChange={(event) => setOutbound(event.target.checked)} />
          <span className="font-medium">{t("linked.a2a.form.outbound")}</span>
        </label>
        {outbound && (
          <div className="flex flex-col gap-1.5 pl-6">
            <label className="flex flex-col gap-1">
              <span className="text-ink-secondary">{t("linked.a2a.form.url")}</span>
              <input value={url} onChange={(event) => setUrl(event.target.value)} disabled={busy} spellCheck={false} className={field} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-ink-secondary">{t("linked.a2a.form.token")}</span>
              <input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} disabled={busy} spellCheck={false} className={field} />
            </label>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-ink">
          <input type="checkbox" className="accent-accent" checked={inbound} disabled={busy} onChange={(event) => setInbound(event.target.checked)} />
          <span className="font-medium">{t("linked.a2a.form.inbound")}</span>
        </label>
        {inbound && <p className="pl-6 text-[12px] leading-4 text-ink-secondary">{t("linked.a2a.form.inbound.hint")}</p>}
      </div>
      {why && !busy && <p data-linked-a2a-why="" className="text-[12px] leading-4 text-ink-secondary">{why}</p>}
      {error && <p role="alert" className="text-[12px] leading-4 text-danger">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy || why !== null} title={why ?? undefined} className="ui-button ui-button-primary">
          {busy && <Loader2 size={13} aria-hidden="true" className="animate-spin" />}{t(busy ? "linked.a2a.form.adding" : "linked.a2a.form.submit")}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className="ui-button">{t("common.cancel")}</button>
      </div>
    </form>
  );
}

export function NewTokenDialog({ link, onIssued, onClose }: { link: A2aLink; onIssued: (issued: A2aIssued) => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await api(`/api/linked-servers/${link.id}/token`, { method: "POST", body: "{}" });
      await onIssued({ name: link.name, token: String(made.token), urls: Array.isArray(made.urls) ? made.urls : [] });
    } catch (cause) {
      setError(messageOf(cause));
      setBusy(false);
    }
  };
  return (
    <SettingsDialog title={t("linked.a2a.newToken.title", { name: link.name })} onClose={onClose}
      footer={<>
        <button type="button" className="ui-button ui-button-md rounded-full" data-autofocus="" onClick={onClose}>{t("common.cancel")}</button>
        <button type="button" disabled={busy} data-linked-token-confirm="" className="ui-button ui-button-md rounded-full !bg-danger !text-danger-ink" onClick={() => void make()}>{t("linked.a2a.newToken.confirm")}</button>
      </>}>
      <p className="text-[13px] leading-[18px] text-ink-secondary">{t("linked.a2a.newToken.body")}</p>
      {error && <p role="alert" className="text-[12px] leading-4 text-danger">{error}</p>}
    </SettingsDialog>
  );
}
