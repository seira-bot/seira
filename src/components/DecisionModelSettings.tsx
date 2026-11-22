// Settings → AI → Routing and extraction: what the helper models do first, then one provider picker, then only the
// picked provider's fields. Security: keys are write-only; the server reports configured-or-not, never the value.
import { useEffect, useState, type ReactNode } from "react";
import { BadgeCheck, Server } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import {
  LearnMore, SETTINGS_INPUT, SLOT, SettingRow, SettingsField, SettingsFormFoot, SettingsGroup, SettingsMark, SettingsRows, SettingsTag, StatusDot,
  Switch,
} from "./SettingsPrimitives";
import { Select } from "./Select";
import { openKeySettings } from "./keys/key-focus";
import { CloudflareMark, OpenRouterMark, TypeSafeMark } from "./ProviderIcons";

type CustomApi = "systemone" | "decisions" | "chat";
const customApiOf = (api: string | undefined): CustomApi => (api === "decisions" || api === "chat" ? api : "systemone");

/** What a person can pick under Provider. `included` is offered only while the Cloud plan supplies decisions. */
type ProviderPick = "included" | "workersai" | "jev" | "openrouter" | "custom";
const PICKS: readonly ProviderPick[] = ["included", "workersai", "jev", "openrouter", "custom"];
type KeyPick = Exclude<ProviderPick, "included">;

const PICK_TITLE: Record<ProviderPick, LocaleKey> = {
  included: "keys.includedWithCloudPro", workersai: "decider.workersAi.title", jev: "decider.provider.jev",
  openrouter: "decider.provider.openrouter", custom: "decider.provider.custom",
};
const PICK_DETAIL: Record<ProviderPick, LocaleKey> = {
  included: "decider.pick.included.detail", workersai: "decider.workersAi.detail", jev: "decider.pick.jev.detail",
  openrouter: "decider.pick.openrouter.detail", custom: "decider.pick.custom.detail",
};

/** The 32 px mark before each provider. One place, so brand logos can replace these icons later. */
/** Official brand marks for named providers; plain icons for the plan and for a person's own server. */
function providerMark(pick: ProviderPick): ReactNode {
  switch (pick) {
    case "workersai": return <CloudflareMark size={18} />;
    case "jev": return <TypeSafeMark size={18} />;
    case "openrouter": return <OpenRouterMark size={18} />;
    case "included": return <BadgeCheck aria-hidden="true" />;
    case "custom": return <Server aria-hidden="true" />;
  }
}

const KEY_URL = { jev: "https://typesafe.ai", openrouter: "https://openrouter.ai/keys", workersai: "https://dash.cloudflare.com/profile/api-tokens" } as const;
const KEY_SLOT: Record<KeyPick, { credential: "jevApiKey" | "workersAiToken" | "openrouterDeciderKey" | "customDeciderKey"; field: string }> = {
  jev: { credential: "jevApiKey", field: "key" },
  workersai: { credential: "workersAiToken", field: "workersAiToken" },
  openrouter: { credential: "openrouterDeciderKey", field: "openrouterKey" },
  custom: { credential: "customDeciderKey", field: "customKey" },
};
const KEY_COPY: Record<Exclude<KeyPick, "workersai">, { label: LocaleKey; placeholder: LocaleKey }> = {
  jev: { label: "decider.key.label", placeholder: "decider.key.placeholder" },
  openrouter: { label: "decider.openrouter.key.label", placeholder: "decider.openrouter.key.placeholder" },
  custom: { label: "decider.custom.key.label", placeholder: "decider.custom.key.placeholder" },
};
const TEST_OK: Record<ProviderPick, LocaleKey> = {
  included: "decider.included.test.ok", workersai: "decider.workersAi.test.ok", jev: "decider.test.ok",
  openrouter: "decider.openrouter.test.ok", custom: "decider.custom.test.ok",
};
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;
/** The room decision budget in server/decider/room-routing.ts; slower falls back to the lead. */
const ROOM_BUDGET_MS = 1_500;

type ModelList = { source: "openrouter" | "builtin"; models: Array<{ id: string; name: string; group: "recommended" | "more" | "chat"; api?: "chat" | "decisions" }> };
const MODEL_GROUP = { recommended: "decider.model.recommended", more: "decider.model.more", chat: "decider.model.geminiChat" } as const satisfies Record<string, LocaleKey>;
type TestResult = ({ ok: true; latencyMs: number } | { ok: false; reason: string; status?: number }) & { extraction?: { ok: boolean } };

const FAILURES: Record<string, LocaleKey> = {
  rejected: "decider.error.rejected",
  unreachable: "decider.error.unreachable",
  timeout: "decider.error.timeout",
  rate_limited: "decider.error.rateLimited",
  overloaded: "decider.error.overloaded",
  malformed: "decider.error.malformed",
  no_key: "decider.error.noKey",
  misconfigured: "decider.error.misconfigured",
};

/** Cloud Pro's relay refuses an inactive subscription (402) and a used-up month of decisions (429). */
const INCLUDED_FAILURES: Record<string, LocaleKey> = {
  rejected: "decider.included.error.rejected",
  rate_limited: "decider.included.error.limited",
};

const OPENROUTER_FAILURES: Record<string, LocaleKey> = {
  ...FAILURES,
  rejected: "decider.openrouter.error.rejected",
  unreachable: "decider.openrouter.error.unreachable",
  timeout: "decider.openrouter.error.timeout",
  rate_limited: "decider.openrouter.error.rateLimited",
  overloaded: "decider.openrouter.error.overloaded",
  malformed: "decider.openrouter.error.malformed",
};

const CUSTOM_FAILURES: Record<string, LocaleKey> = {
  ...FAILURES,
  rejected: "decider.custom.error.rejected",
  unreachable: "decider.custom.error.unreachable",
  timeout: "decider.custom.error.timeout",
  rate_limited: "decider.custom.error.rateLimited",
  overloaded: "decider.custom.error.overloaded",
  malformed: "decider.custom.error.malformed",
  misconfigured: "decider.custom.error.misconfigured",
};

const WORKERS_AI_FAILURES: Record<string, LocaleKey> = {
  ...FAILURES,
  rejected: "decider.workersAi.error.rejected",
  unreachable: "decider.workersAi.error.unreachable",
  timeout: "decider.workersAi.error.timeout",
  rate_limited: "decider.workersAi.error.rateLimited",
  overloaded: "decider.workersAi.error.overloaded",
  malformed: "decider.workersAi.error.malformed",
};

const BY: Record<"jev" | "workersai" | "openrouter" | "custom" | "gemini", LocaleKey> = {
  jev: "decider.status.byJev", workersai: "decider.status.byWorkersAi", openrouter: "decider.status.byOpenRouter", custom: "decider.status.byCustom",
  gemini: "decider.status.byGemini",
};

/** Who decides and who reads, in a word each: the person's own key, the Cloud plan's, or nothing yet. */
export function helpersStatusLine(config: ConfigStatus | null): string {
  const decider = config?.decider;
  const extraction = config?.helpers?.extraction;
  const decisions = !decider?.configured ? t("decider.status.notSetUp")
    : decider.included ? t("decider.status.byCloud") : t(BY[decider.provider] ?? BY.jev);
  const reading = !extraction?.provider ? t("decider.status.notSetUp")
    : extraction.included ? t("decider.status.byCloud") : t(BY[extraction.provider]);
  return t("decider.status.line", { decisions, extraction: reading });
}

/** A fixed sentence per failure: the vendor's own body never reaches the UI. */
export function deciderFailureText(result: { reason: string; status?: number }, included = false, provider: KeyPick = "jev"): string {
  if (provider === "workersai") {
    if (result.reason === "http_error") return t("decider.workersAi.error.http", { status: String(result.status ?? "?") });
    const key = WORKERS_AI_FAILURES[result.reason];
    return key ? t(key) : t("decider.error.other");
  }
  if (provider === "custom") {
    if (result.reason === "http_error") return t("decider.custom.error.http", { status: String(result.status ?? "?") });
    const key = CUSTOM_FAILURES[result.reason];
    return key ? t(key) : t("decider.error.other");
  }
  if (provider === "openrouter") {
    // 402 is OpenRouter's answer for an account with no credits left.
    if (result.reason === "http_error" && result.status === 402) return t("decider.openrouter.error.credits");
    if (result.reason === "http_error") return t("decider.openrouter.error.http", { status: String(result.status ?? "?") });
    const key = OPENROUTER_FAILURES[result.reason];
    return key ? t(key) : t("decider.error.other");
  }
  if (included && result.reason === "http_error" && result.status === 402) return t("decider.included.error.subscription");
  if (included && INCLUDED_FAILURES[result.reason]) return t(INCLUDED_FAILURES[result.reason]!);
  if (result.reason === "http_error") return t("decider.error.http", { status: String(result.status ?? "?") });
  const key = FAILURES[result.reason];
  return key ? t(key) : t("decider.error.other");
}

/** The provider shown as picked: the saved pick, else the one deciding now, else the plan's included one or Cloudflare. */
export function pickedProvider(config: ConfigStatus | null): ProviderPick {
  const decider = config?.decider;
  const includedOffered = decider?.includedAvailable === true || decider?.included === true;
  const chosen = decider?.chosen;
  if (chosen && (chosen !== "included" || includedOffered)) return chosen;
  if (decider?.configured && decider.included) return "included";
  const inUse = decider?.provider;
  if (decider?.configured && inUse && inUse !== "gemini") return inUse;
  if (inUse === "custom") return "custom";
  return includedOffered ? "included" : "workersai";
}

/** Whether the person's own key for a provider is saved: from the key list, else from what decides now. */
function ownKeySaved(config: ConfigStatus | null, pick: KeyPick): boolean {
  const decider = config?.decider;
  const own = config?.helpers?.own;
  const listed = { jev: own?.jev, workersai: own?.workersAi, openrouter: own?.openrouter, custom: undefined }[pick];
  const slot = config?.savedKeys?.[KEY_SLOT[pick].credential]?.configured;
  const inUse = Boolean(decider?.configured && !decider.included && decider.provider === pick && decider.keySource !== "shared");
  return listed ?? slot ?? inUse;
}

/** A text setting saved when it loses focus or on Enter, and only when it changed. */
function SavedText({ saved, onSave, disabled, label, placeholder, testId }: {
  saved: string; onSave: (value: string) => void; disabled: boolean; label: string; placeholder: string; testId: string;
}) {
  const [value, setValue] = useState(saved);
  useEffect(() => setValue(saved), [saved]);
  const commit = () => { if (value.trim() !== saved) onSave(value.trim()); };
  return (
    <input
      type="text"
      data-testid={testId}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => event.key === "Enter" && commit()}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={label}
      autoComplete="off"
      spellCheck={false}
      className={cn(SETTINGS_INPUT, "[width:var(--settings-select-width,200px)] max-w-full")}
    />
  );
}

const LINK = "cursor-pointer text-accent-text hover:underline focus-visible:underline";

export function DecisionModelSettings() {
  const { state, dispatch } = useStore();
  const config = state.config;
  const decider = config?.decider;
  const picked = pickedProvider(config);
  const configured = decider?.configured ?? false;
  const includedOffered = decider?.includedAvailable === true || decider?.included === true;
  const enabled = decider?.enabled ?? false;
  const roomRouting = decider?.jobs.roomRouting ?? true;
  const sharedKey = config?.helpers?.sharedKey ?? decider?.sharedKey ?? false;
  const own = picked === "included" ? false : ownKeySaved(config, picked);
  const savedAccount = config?.helpers?.workersAiAccountId ?? "";
  const [value, setValue] = useState("");
  const [account, setAccount] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<{ ok: boolean; text: string } | null>(null);
  const [models, setModels] = useState<ModelList | null>(null);
  const [more, setMore] = useState(false);
  const draft = value.trim();
  const accountId = (account ?? savedAccount).trim();
  const accountChanged = picked === "workersai" && account !== null && accountId !== savedAccount;
  const clearing = !draft && own && !accountChanged;
  const customReady = decider?.provider === "custom" && configured;
  const usable = picked === "included" ? decider?.included === true
    : picked === "openrouter" ? own || sharedKey
      : picked === "custom" ? customReady : own;

  const applied = (status: ConfigStatus) => dispatch({ type: "configStatus", config: status });
  const put = async (decision: Record<string, unknown>) => applied(await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ decider: decision }) }));

  const patch = async (decision: Record<string, unknown>) => {
    if (switching) return;
    setSwitching(true);
    setError(null);
    try {
      await put(decision);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSwitching(false);
    }
  };

  useEffect(() => {
    if (picked !== "openrouter" || models) return;
    let cancelled = false;
    api<ModelList>("/api/decider/models").then(
      (list) => { if (!cancelled) setModels(list); },
      () => undefined,
    );
    return () => { cancelled = true; };
  }, [picked, models]);

  const reset = () => { setValue(""); setAccount(null); setVerdict(null); setError(null); };
  const choose = (pick: ProviderPick) => {
    if (pick === picked && decider?.chosen === pick) return;
    reset();
    void patch({ provider: pick });
  };
  const edit = (decision: { openrouterModel: string; openrouterApi: "chat" | "decisions" } | { customApi: CustomApi }) => {
    setVerdict(null);
    void patch(decision);
  };

  const save = async () => {
    if (picked === "included" || saving || (!draft && !own && !accountChanged)) return;
    if (picked === "workersai" && draft && !ACCOUNT_ID.test(accountId)) return setError(t("decider.workersAi.needsAccount"));
    setSaving(true);
    setError(null);
    setVerdict(null);
    try {
      // A key saved under a provider shown as picked but never saved as the pick keeps that pick.
      const pick = draft && decider?.chosen !== picked ? { provider: picked } : {};
      // The account ID before the token: the token's check on save needs it.
      const accountFirst = picked === "workersai" && (accountChanged || (draft && !savedAccount)) ? { workersAiAccountId: accountId } : {};
      if (Object.keys(pick).length || Object.keys(accountFirst).length) await put({ ...pick, ...accountFirst });
      if (draft || clearing) {
        const slot = KEY_SLOT[picked];
        applied(window.ogb?.setCredential
          ? await window.ogb.setCredential(slot.credential, draft)
          : await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ decider: { [slot.field]: draft } }) }));
      }
      reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (testing || saving || (!draft && !usable)) return;
    if (picked === "workersai" && draft && !ACCOUNT_ID.test(accountId)) return setError(t("decider.workersAi.needsAccount"));
    setTesting(true);
    setVerdict(null);
    setError(null);
    const body = picked === "included" ? {} : { provider: picked, ...(draft ? { key: draft, ...(picked === "workersai" ? { accountId } : {}) } : {}) };
    try {
      const result = await api<TestResult>("/api/decider/test", { method: "POST", body: JSON.stringify(body) });
      const extraction = result.extraction ? [t(result.extraction.ok ? "decider.test.extractionOk" : "decider.test.extractionFailed")] : [];
      const sharedOnly = picked === "openrouter" && !draft && !own;
      setVerdict(result.ok
        ? {
          ok: result.extraction?.ok !== false,
          text: [
            t(sharedOnly ? "decider.openrouter.test.okShared" : TEST_OK[picked], { ms: String(result.latencyMs) }),
            ...(result.latencyMs > ROOM_BUDGET_MS ? [t("decider.test.slow")] : []),
            ...extraction,
          ].join(" "),
        }
        : { ok: false, text: [deciderFailureText(result, picked === "included", picked === "included" ? "jev" : picked), ...extraction].join(" ") });
    } catch (cause) {
      setVerdict({ ok: false, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setTesting(false);
    }
  };

  const typing = (set: (next: string) => void) => (event: { target: { value: string } }) => { setVerdict(null); setError(null); set(event.target.value); };

  /** The picked provider's key: write-only, one field, saved with the card's Save. */
  const keyField = (label: string, placeholder: string) => (
    <SettingsField label={label}>
      <input
        type="password"
        data-testid="decider-key"
        value={value}
        onChange={typing(setValue)}
        onKeyDown={(event) => event.key === "Enter" && void save()}
        disabled={saving}
        placeholder={own ? t("keys.replace") : placeholder}
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        className={SETTINGS_INPUT}
      />
    </SettingsField>
  );

  const openrouterHint: LocaleKey | null = picked !== "openrouter" ? null
    : own ? (sharedKey ? "decider.openrouter.status.ownFallbackHint" : null)
      : sharedKey ? "decider.openrouter.status.sharedHint" : "decider.openrouter.status.notConnectedHint";

  /** Rows above the key: the OpenRouter model, or the custom endpoint's address, model and protocol. */
  const providerRows = () => {
    if (picked === "openrouter") {
      return (
        <SettingRow title={t("decider.model.label")} subtitle={models?.source === "builtin" ? t("decider.model.builtinNote") : undefined}>
          <Select
            data-testid="decider-model"
            value={decider?.model ?? ""}
            onChange={(event) => edit({
              openrouterModel: event.target.value,
              openrouterApi: models?.models.find((model) => model.id === event.target.value)?.api ?? "chat",
            })}
            disabled={switching}
            aria-label={t("decider.model.label")}
          >
            {decider?.model && !models?.models.some((model) => model.id === decider.model) && (
              <option value={decider.model}>{decider.model}</option>
            )}
            {(["recommended", "more", "chat"] as const).map((group) => {
              const inGroup = models?.models.filter((model) => model.group === group) ?? [];
              return inGroup.length > 0 && (
                <optgroup key={group} label={t(MODEL_GROUP[group])}>
                  {inGroup.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                </optgroup>
              );
            })}
          </Select>
        </SettingRow>
      );
    }
    if (picked !== "custom") return null;
    // The saved custom settings come back only while the custom endpoint is the provider in use.
    const savedCustom = decider?.provider === "custom";
    return (
      <>
        <SettingRow title={t("decider.custom.baseUrl")} subtitle={t("decider.custom.baseUrlDetail")}>
          <SavedText testId="decider-custom-base-url" saved={savedCustom ? decider?.baseUrl ?? "" : ""} disabled={switching}
            label={t("decider.custom.baseUrl")} placeholder={t("decider.custom.baseUrlPlaceholder")}
            onSave={(customBaseUrl) => void patch({ customBaseUrl })} />
        </SettingRow>
        <SettingRow title={t("decider.custom.model")}>
          <SavedText testId="decider-custom-model" saved={savedCustom ? decider?.model ?? "" : ""} disabled={switching}
            label={t("decider.custom.model")} placeholder={t("decider.custom.modelPlaceholder")}
            onSave={(customModel) => void patch({ customModel })} />
        </SettingRow>
        <SettingRow title={t("decider.custom.api")}>
          <Select
            data-testid="decider-custom-api"
            value={customApiOf(savedCustom ? decider?.api : undefined)}
            onChange={(event) => edit({ customApi: customApiOf(event.target.value) })}
            disabled={switching}
            aria-label={t("decider.custom.api")}
          >
            <option value="systemone">{t("decider.custom.api.systemone")}</option>
            <option value="decisions">{t("decider.custom.api.decisions")}</option>
            <option value="chat">{t("decider.custom.api.chat")}</option>
          </Select>
        </SettingRow>
      </>
    );
  };

  /** The fields under the rows: the key (and Cloudflare's account ID), then a hint and where to get a key. */
  const keyFields = () => {
    if (picked === "included") return null;
    if (picked === "workersai") {
      return (
        <div data-decider-key="" className="flex flex-col gap-3 px-4 pb-1 pt-3">
          <SettingsField label={t("decider.workersAi.accountId")}>
            <input
              type="text"
              data-testid="decider-account"
              value={account ?? savedAccount}
              onChange={typing(setAccount)}
              disabled={saving}
              placeholder={t("decider.workersAi.accountIdPlaceholder")}
              aria-label={t("decider.workersAi.accountId")}
              autoComplete="off"
              spellCheck={false}
              className={SETTINGS_INPUT}
            />
          </SettingsField>
          {keyField(t("decider.workersAi.token"), t("decider.workersAi.tokenPlaceholder"))}
          <p className="text-[13px] leading-[18px] text-ink-secondary">
            <a href={KEY_URL.workersai} target="_blank" rel="noopener noreferrer" className={LINK}>{t("decider.workersAi.getKey")}</a>
          </p>
        </div>
      );
    }
    const copy = KEY_COPY[picked];
    const placeholder = picked === "openrouter" && !own && sharedKey ? t("decider.openrouter.key.overridePlaceholder") : t(copy.placeholder);
    return (
      <div data-decider-key="" className="flex flex-col gap-2 px-4 pb-1 pt-3">
        {keyField(t(copy.label), placeholder)}
        {picked !== "custom" && (
          <p className="text-[13px] leading-[18px] text-ink-secondary">
            {openrouterHint && <>{t(openrouterHint)}{" "}</>}
            {openrouterHint && !own && (
              <><button type="button" data-testid="decider-manage-keys" onClick={() => dispatch(openKeySettings("openrouter"))}
                className="cursor-pointer text-accent-text hover:underline">{t("decider.openrouter.key.manageLink")}</button>
                {!(picked === "openrouter" && sharedKey) && <span aria-hidden="true"> · </span>}</>
            )}
            {!(picked === "openrouter" && sharedKey) && (
              <a href={KEY_URL[picked]} target="_blank" rel="noopener noreferrer" className={LINK}>
                {t(picked === "openrouter" ? "decider.openrouter.key.getKey" : "decider.key.getKey")}
              </a>
            )}
          </p>
        )}
      </div>
    );
  };

  const statusText = picked === "openrouter" && !own && sharedKey ? t("decider.openrouter.status.shared")
    : !usable ? t("decider.status.notSetUpShort")
      : picked === "openrouter" && sharedKey ? t("decider.openrouter.status.own")
        : t("decider.status.connected");
  const offered = PICKS.filter((pick) => pick !== "included" || includedOffered);

  return (
    <>
      <SettingsGroup label={t("settings.ai.routing")} block="routing"
        description={<>{t("decider.introShort")}{" "}<LearnMore onClick={() => setMore(!more)} /></>}>
        {more && <p data-decider-more="" className="px-4 text-[12px] leading-4 text-ink-secondary">{t("decider.intro")}</p>}
        <SettingsRows>
          <SettingRow
            title={t("decider.master")}
            subtitle={<span role="status" data-testid="helpers-status">{helpersStatusLine(config)}</span>}
            message={configured ? undefined : t("decider.masterNeedsKey")}
          >
            <Switch
              data-testid="decider-master"
              aria-label={t("decider.master")}
              checked={enabled}
              disabled={!configured || switching || !config}
              onClick={() => void patch({ enabled: !enabled })}
              className="cursor-pointer"
            />
          </SettingRow>
          <SettingRow title={t("decider.jobs.roomRouting")} subtitle={t("decider.jobs.roomRoutingDetail")}>
            <Switch
              data-testid="decider-job-roomRouting"
              aria-label={t("decider.jobs.roomRouting")}
              checked={enabled && roomRouting}
              disabled={!enabled || switching}
              onClick={() => void patch({ jobs: { roomRouting: !roomRouting } })}
              className="cursor-pointer"
            />
          </SettingRow>
          {/* Jobs that aren't built yet are not listed: a row nobody can use is noise (§6.5 Not applicable). */}
        </SettingsRows>
      </SettingsGroup>

      <SettingsGroup label={t("decider.provider.title")} block="routing-provider">
        <SettingsRows icons>
          <div role="radiogroup" aria-label={t("decider.provider.title")} className="contents">
            {offered.map((pick) => (
              <label key={pick} data-decider-pick={pick} className={cn("flex min-h-11 items-center gap-3 px-4 py-3", switching || !config ? "cursor-default" : "cursor-pointer")}>
                <span data-settings-slot="" className={SLOT}><SettingsMark>{providerMark(pick)}</SettingsMark></span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-center gap-1.5 text-[14px] leading-5 text-ink">
                    {t(PICK_TITLE[pick])}
                    {pick !== "included" && ownKeySaved(config, pick) && <SettingsTag>{t("common.saved")}</SettingsTag>}
                  </span>
                  <span className="mt-0.5 text-[13px] leading-[18px] text-ink-secondary">{t(PICK_DETAIL[pick])}</span>
                </span>
                <input
                  type="radio"
                  name="decider-provider"
                  value={pick}
                  data-testid={`decider-pick-${pick}`}
                  checked={picked === pick}
                  disabled={switching || !config}
                  onChange={() => choose(pick)}
                  className="size-4 shrink-0 cursor-pointer accent-[var(--color-ink)] disabled:cursor-default disabled:opacity-40"
                />
              </label>
            ))}
          </div>
        </SettingsRows>
      </SettingsGroup>

      <SettingsGroup label={t(PICK_TITLE[picked])} block="routing-key">
        <SettingsRows selectWidth={200}>
          {providerRows()}
          {keyFields()}
          <SettingsFormFoot status={<span className="flex flex-col gap-1">
            <span role="status" data-testid="decider-status" className="flex items-center">
              {usable ? <StatusDot tone="success" /> : <span aria-hidden="true" className="mr-1.5 inline-block size-1.5 rounded-full bg-ink/20" />}{statusText}
            </span>
            {error && <span role="alert" className="text-danger">{error}</span>}
            {verdict && <span role="status" className={verdict.ok ? "text-ink-secondary" : "text-danger"}>{verdict.text}</span>}
          </span>}>
            <button
              type="button"
              data-testid="decider-test"
              onClick={() => void test()}
              disabled={testing || saving || (!draft && !usable)}
              className="ui-button ui-button-md cursor-pointer rounded-full"
            >
              {testing ? t("keys.testing") : t("keys.test")}
            </button>
            {picked !== "included" && (
              <button
                type="button"
                data-testid="decider-save"
                onClick={() => void save()}
                disabled={saving || (!draft && !own && !accountChanged)}
                title={clearing ? t("keys.removeKey") : t("common.save")}
                className={cn("ui-button ui-button-md cursor-pointer rounded-full", clearing && "!text-danger")}
              >
                {saving ? t("settings.threads.saving") : clearing ? t("keys.clear") : t("common.save")}
              </button>
            )}
          </SettingsFormFoot>
        </SettingsRows>
      </SettingsGroup>
    </>
  );
}
