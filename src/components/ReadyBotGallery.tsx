import { useState } from "react";
import { createPortal } from "react-dom";
import { Plus, Sparkles } from "lucide-react";
import { stoppedAtBotLimit } from "@/lib/bot-limit";
import { SeiraAvatar } from "./Avatar";
import { NewBotDialog } from "./lazy-screens";
import { READY_BOT_CATEGORIES, READY_BOTS, matchesReadyBot, readyBotCopy, type ReadyBotCategory } from "@/lib/ready-bots";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { useStore, type Bot } from "@/state/store";

const APP_LABELS: Record<string, string> = {
  gmail: "Gmail", github: "GitHub", discord: "Discord", slack: "Slack", googlecalendar: "Google Calendar",
  notion: "Notion", linear: "Linear", figma: "Figma", gong: "Gong", hubspot: "HubSpot", repliz: "Repliz",
};

const CATEGORY_KEYS: Record<ReadyBotCategory, LocaleKey> = {
  everyday: "readyBots.category.everyday", work: "readyBots.category.work", writing: "readyBots.category.writing",
  design: "readyBots.category.design", sales: "readyBots.category.sales", personal: "readyBots.category.personal",
};

export function ReadyBotGallery({ search, onDialog, onAdded }: {
  search: string;
  /** The New bot dialog is open over Templates, so Templates must leave its keys alone. */
  onDialog: (open: boolean) => void;
  onAdded: (bot: Bot) => void;
}) {
  const [category, setCategory] = useState<ReadyBotCategory | null>(null);
  const { state, dispatch } = useStore();
  const [adding, setAdding] = useState<string | null>(null);

  const open = (id: string | null) => {
    if (id !== null && stoppedAtBotLimit(state)) return;
    // A paired device may not read the host's New bot defaults that the review is filled from.
    if (id !== null && window.ogb?.remoteClient?.active) { dispatch({ type: "newBot", onCreated: onAdded }); return; }
    setAdding(id); onDialog(id !== null);
  };

  const visible = READY_BOTS.filter((bot) => (!category || bot.category === category) && matchesReadyBot(bot, search));
  if (search.trim() && visible.length === 0) return null;

  const existingBots = state.bots ?? [];
  const showYourAgents = !search.trim() && category === null && existingBots.length > 0;
  const categoriesToDisplay = category ? [category] : READY_BOT_CATEGORIES;

  return (
    <section className="mb-8" aria-labelledby="ready-bots-title">
      {/* "Your agents" section, matching OpenBot marketplace */}
      {showYourAgents && (
        <div className="mb-8" aria-label="Your agents">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-[13px] font-medium text-ink-secondary">
              Your agents <span className="ml-1 text-[12px] text-ink-tertiary">{existingBots.length}</span>
            </h3>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {existingBots.map((bot, index) => (
              <div
                key={bot.id || `existing-bot-${index}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-hairline/40 bg-card/60 p-3.5 transition hover:border-hairline hover:bg-card"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <SeiraAvatar
                    color={bot.color}
                    bodyId={bot.mascotBody ?? undefined}
                    accessories={bot.mascotAccessories ?? undefined}
                    size={38}
                    animated={false}
                    label={bot.name}
                  />
                  <div className="min-w-0">
                    <h4 className="truncate text-[13px] font-medium text-ink">
                      {bot.name} <span className="text-[11px] font-normal text-ink-tertiary">by Seira</span>
                    </h4>
                    <p className="truncate text-[12px] text-ink-secondary">
                      {bot.title || bot.description || "Active agent"}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    dispatch({ type: "select", id: bot.id });
                    onAdded(bot);
                  }}
                  className="shrink-0 rounded-full border border-hairline/60 bg-raised px-3.5 py-1 text-[12px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent"
                >
                  Open chat
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main Agents header & categories */}
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 id="ready-bots-title" className="text-[16px] font-semibold text-ink tracking-tight">
            Agents
          </h3>
          <p className="text-[13px] text-ink-secondary">
            Ready-made agents with their own instructions and skills.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("readyBots.categories")}>
          {[null, ...READY_BOT_CATEGORIES].map((value) => (
            <button
              key={value ?? "all"}
              type="button"
              aria-pressed={category === value}
              onClick={() => setCategory(value)}
              className={cn(
                "rounded-full px-3 py-1 text-[12px] font-medium transition-colors",
                category === value ? "bg-ink text-panel shadow-sm" : "bg-raised/70 text-ink-secondary hover:text-ink hover:bg-raised"
              )}
            >
              {value ? t(CATEGORY_KEYS[value]) : t("readyBots.all")}
            </button>
          ))}
        </div>
      </div>

      {/* Grouped list-app layout matching OpenBot */}
      {categoriesToDisplay.map((cat) => {
        const botsInCat = visible.filter((b) => b.category === cat);
        if (botsInCat.length === 0) return null;

        return (
          <div key={cat} className="mb-7">
            {!category && (
              <h4 className="mb-3 text-[13px] font-semibold text-ink-secondary capitalize">
                {t(CATEGORY_KEYS[cat])}
              </h4>
            )}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {botsInCat.map((bot) => {
                const copy = readyBotCopy(bot);
                const skillCount = bot.skills?.length ?? 0;

                return (
                  <article
                    key={bot.id}
                    data-ready-bot={bot.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-hairline/40 bg-card/60 p-3 transition hover:border-hairline hover:bg-card hover:shadow-sm"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <SeiraAvatar
                        color={bot.look.color}
                        bodyId={bot.look.mascotBody}
                        accessories={bot.look.mascotAccessories}
                        size={38}
                        animated={false}
                        label={bot.name}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-1.5">
                          <h4 className="truncate text-[13px] font-semibold text-ink">
                            {bot.name}
                          </h4>
                          <span className="text-[11px] text-ink-tertiary">by Seira</span>
                          {skillCount > 0 && (
                            <span className="inline-flex items-center gap-0.5 text-accent font-medium text-[11px] ml-1">
                              <Sparkles size={11} aria-hidden="true" />
                              {skillCount === 1 ? "1 skill" : `${skillCount} skills`}
                            </span>
                          )}
                        </div>
                        <p className="truncate text-[12px] text-ink-secondary">
                          {copy.description}
                        </p>
                        <div className="flex items-center gap-2 text-[11px] text-ink-tertiary">
                          <span className="italic truncate max-w-[200px]">
                            {t("readyBots.try", { prompt: copy.tryAsking })}
                          </span>
                          {bot.apps.length > 0 && (
                            <span className="truncate">· {bot.apps.map((app) => APP_LABELS[app] ?? app).join(", ")}</span>
                          )}
                          {bot.routines?.length ? <span>· {t("readyBots.pausedRoutine")}</span> : null}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => open(bot.id)}
                      aria-label={t("readyBots.addAria", { name: bot.name, title: copy.title })}
                      className="flex h-7 shrink-0 items-center gap-1 rounded-md bg-raised px-3 text-[12px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      <Plus size={13} aria-hidden="true" />
                      {t("readyBots.add")}
                    </button>
                  </article>
                );
              })}
            </div>
          </div>
        );
      })}

      {adding && createPortal(
        <NewBotDialog
          readyBotId={adding}
          onClose={() => open(null)}
          onCreated={(bot) => {
            onDialog(false);
            onAdded(bot);
          }}
        />,
        document.body
      )}
    </section>
  );
}
