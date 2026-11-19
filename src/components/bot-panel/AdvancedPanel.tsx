import { useMemo, type ReactNode } from "react";
import { ChevronRight, Crown, Search, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { modelLabel } from "@/lib/model-label";
import { PHONE_LAYOUT, useMediaQuery } from "@/lib/use-media-query";
import { botUsage, formatUsd, hasFiniteCost } from "@/lib/usage";
import type { Bot, BotSettingsSection } from "@/state/store";
import { approvalModeOptions } from "@/lib/approval-mode-options";
import { BotAvatar } from "../Avatar";
import { useCaptionChrome } from "../DesktopCapabilities";
import { effortLabel } from "../ModelPicker";
import { ShareBotButton } from "../bot-access/ShareBotButton";
import { searchEmptyText, sectionLabel, sectionMatches, type BotSectionEntry } from "../bot-settings/sections";
import { skillSwitchOn, useManagedSkills } from "../bot-settings/SkillsSection";
import type { useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import { visibilityLabel } from "../bot-settings/VisibilitySection";
import type { BotApps } from "../bot-settings/useBotApps";
import { ADVANCED_GROUPS, memoryValue } from "./advanced-sections";
import { usePlaceChoices, useOpenComputer } from "./ComputerTab";
import { libraryItems } from "./LibraryTab";
import { PanelQuickActions, type QuickAction } from "./PanelQuickActions";
import { PanelStatePill } from "./PanelStatePill";
import { useMemoryDoc } from "./use-memory-doc";
import { roundButtonCls } from "./rows";

type Derived = ReturnType<typeof useBotSettingsDerived>;
type Values = Partial<Record<BotSettingsSection, string>>;

const countOn = (count: number) => (count > 0 ? t("botPanel.routinesOn", { count }) : t("botPanel.none"));

/** What each row says on its right, from state the panel already reads; a row with nothing cheap to say shows nothing. */
function useAdvancedValues(bot: Bot, derived: Derived): Values {
  const skills = useManagedSkills(bot);
  const memory = useMemoryDoc(bot);
  const { currentLabel } = usePlaceChoices(bot);
  const items = useMemo(() => libraryItems(bot), [bot]);
  const library = items.pages.length + items.apps.length + items.shared.length + items.unshared.length;
  const effort = bot.modelSelection?.effort;
  const model = derived.engine?.models ? modelLabel(derived.engine, bot.modelSelection?.model ?? "") : undefined;
  const usage = botUsage(bot);
  const title = bot.title.trim();
  const approval = approvalModeOptions().find((option) => option.mode === derived.approvalMode)?.label;
  return {
    identity: title || undefined,
    skills: skills.loading ? undefined : countOn(skills.skills.filter(skillSwitchOn).length),
    memory: memoryValue(bot, memory.docs, memory.error),
    library: library === 0 ? t("botPanel.none") : library === 1 ? t("botPanel.advanced.item") : t("botPanel.advanced.items", { count: library }),
    routines: countOn(derived.activeBotRoutines),
    model: model ? (effort ? `${model} · ${effortLabel(effort)}` : model) : undefined,
    permissions: approval,
    access: currentLabel,
    voice: t(bot.notifications ? "botPanel.advanced.on" : "botPanel.advanced.off"),
    visibility: visibilityLabel(bot.visibility),
    usage: usage.turns > 0 && hasFiniteCost(usage.costUsd) ? formatUsd(usage.costUsd) : undefined,
  };
}

export function AdvancedPanel({ bot, derived, sections, query, appNames, appsPhase, open, onQuery, onToggle, onOpenSection, renderBody, onClose }: {
  bot: Bot;
  derived: Derived;
  sections: readonly BotSectionEntry[];
  query: string;
  appNames: readonly string[];
  appsPhase: BotApps["phase"];
  /** The section whose body is showing, if any. */
  open: BotSettingsSection | null;
  onQuery: (value: string) => void;
  onToggle: (id: BotSettingsSection) => void;
  onOpenSection: (id: BotSettingsSection) => void;
  renderBody: (id: BotSettingsSection) => ReactNode;
  onClose: () => void;
}) {
  const { dragProps } = useCaptionChrome();
  const phone = useMediaQuery(PHONE_LAYOUT);
  const openComputer = useOpenComputer(bot);
  const values = useAdvancedValues(bot, derived);
  const q = query.trim().toLowerCase();
  const byId = new Map(sections.map((entry) => [entry.id, entry]));
  const matched = (entry: BotSectionEntry) => sectionMatches(entry, q, appNames);
  const anyMatch = sections.some(matched);
  const title = bot.title.trim();

  const quick = (action: QuickAction) => {
    if (action === "message") {
      if (phone) onClose();
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-tour="composer"] textarea')?.focus());
    } else if (action === "computer") openComputer();
    else if (action === "routines") onOpenSection("routines");
    else onOpenSection("overview");
  };

  return (
    <>
      <div {...dragProps} className="flex h-[52px] shrink-0 items-center justify-end gap-1.5 px-3">
        <ShareBotButton bot={bot} className={roundButtonCls} />
        <button type="button" onClick={onClose} aria-label={t("botSettings.simple.close")} className={roundButtonCls}>
          <X size={16} className="pointer-events-none" />
        </button>
      </div>

      <div data-advanced-hero className="relative isolate flex shrink-0 items-center gap-3.5 px-5">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-[70px] -start-[30px] -z-10 h-[180px] w-[240px] blur-[8px]"
          style={{ background: `radial-gradient(closest-side, color-mix(in oklab, var(--identity-${bot.color}) 20%, transparent), transparent)` }}
        />
        <span className="relative shrink-0">
          <BotAvatar bot={bot} size={56} state={derived.activeState} />
          {bot.chiefOfStaff && (
            <span title={t("chat.chiefOfStaff")} className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-accent text-accent-ink ring-2 ring-panel">
              <Crown size={12} aria-hidden="true" />
              <span className="sr-only">{t("chat.chiefOfStaff")}</span>
            </span>
          )}
        </span>
        <div className="flex min-w-0 flex-col items-start gap-0.5">
          <h2 id="bot-settings-title" className="max-w-full truncate text-[17px] font-semibold leading-[22px] tracking-[-0.01em] text-ink">{bot.name}</h2>
          {title && <p className="max-w-full truncate text-[13px] text-ink-secondary">{title}</p>}
          <PanelStatePill bot={bot} />
        </div>
      </div>

      <div className="shrink-0 px-4">
        <PanelQuickActions onAction={quick} canMessage={bot.yourAccess !== "view"} computerLabel="computer.tab.computer" />
      </div>

      <label className="mx-4 mb-0.5 mt-3.5 flex h-8 shrink-0 items-center gap-2 rounded-[10px] bg-inset ps-2.5 pe-1 text-ink-tertiary shadow-[inset_0_0_0_0.5px_var(--color-edge)] focus-within:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]">
        <Search size={14} aria-hidden="true" className="shrink-0" />
        <input
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            if (query) onQuery("");
            else onClose();
          }}
          placeholder={t("botSettings.search")}
          aria-label={t("botSettings.searchAria")}
          autoComplete="off"
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-tertiary focus:outline-none [&::-webkit-search-cancel-button]:appearance-none"
        />
        {query && (
          <button type="button" aria-label={t("settings.search.clear")} onClick={() => onQuery("")} className="flex size-6 shrink-0 items-center justify-center rounded-full hover:bg-ink/[0.06] hover:text-ink">
            <X size={13} aria-hidden="true" />
          </button>
        )}
      </label>

      <div data-advanced-list className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-6">
        {!anyMatch && (
          <div className="px-2 py-8 text-center text-[13px] leading-relaxed text-ink-tertiary">
            {searchEmptyText(query.trim(), appsPhase)}
          </div>
        )}
        {ADVANCED_GROUPS.map((group) => {
          const entries = group.sections.flatMap((id) => byId.get(id) ?? []);
          if (entries.length === 0) return null;
          const shown = entries.filter(matched);
          const firstShown = shown[0]?.id;
          return (
            <section key={group.id} data-advanced-group={group.id} hidden={shown.length === 0}>
              <h3 className="px-1 pb-1.5 pt-3.5 text-[12px] font-medium text-ink-tertiary">{t(group.label)}</h3>
              <div className="overflow-hidden rounded-[12px] border border-ink/[0.04] bg-ink/[0.03]">
                {entries.map((entry) => {
                  const { id, icon: Icon } = entry;
                  const isMatch = matched(entry);
                  // Memory stays mounted while hidden so its unsaved draft survives.
                  if (!isMatch && id !== "memory") return null;
                  const label = sectionLabel(entry);
                  const isOpen = open === id;
                  const value = values[id];
                  return (
                    <div
                      key={id}
                      data-bot-settings-section={id}
                      data-open={isOpen}
                      hidden={!isMatch}
                      className={cn("scroll-mt-2", id !== firstShown && "border-t border-ink/[0.05]")}
                    >
                      <button
                        type="button"
                        onClick={() => onToggle(id)}
                        aria-expanded={isOpen}
                        aria-controls={isOpen || id === "memory" ? `bot-settings-body-${id}` : undefined}
                        className="flex h-11 w-full items-center gap-3 px-3 text-left transition-colors hover:bg-ink/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                      >
                        <Icon size={16} aria-hidden="true" className="shrink-0 text-ink-secondary" />
                        <span className={cn("min-w-0 flex-1 truncate text-[14px] leading-[18px] text-ink", isOpen && "font-medium")}>{label}</span>
                        {value && <span className="max-w-[170px] shrink-0 truncate text-[13px] tabular-nums text-ink-tertiary">{value}</span>}
                        <ChevronRight
                          size={14}
                          aria-hidden="true"
                          className={cn("shrink-0 text-ink-tertiary transition-transform duration-200 motion-reduce:transition-none", isOpen ? "rotate-90" : "rtl:-scale-x-100")}
                        />
                      </button>
                      {id === "memory" ? (
                        <div id="bot-settings-body-memory" data-advanced-body="" role="region" aria-label={label} hidden={!isOpen} className="pb-4 ps-10 pe-3.5 pt-0.5">
                          {renderBody("memory")}
                        </div>
                      ) : (
                        isOpen && (
                          <div id={`bot-settings-body-${id}`} data-advanced-body="" role="region" aria-label={label} className="pb-4 ps-10 pe-3.5 pt-0.5">
                            {renderBody(id)}
                          </div>
                        )
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
