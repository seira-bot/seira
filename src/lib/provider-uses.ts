import { t } from "./i18n";
import type { ProviderUse } from "../../shared/provider-uses";

const SHOWN = 5;

function providerUse(value: unknown): ProviderUse | null {
  const { kind, bot, count } = Object(value) as { kind?: unknown; bot?: unknown; count?: unknown };
  if (kind === "default") return { kind };
  if (typeof bot !== "string") return null;
  if (kind === "model" || kind === "backup" || kind === "running") return { kind, bot };
  return kind === "thread" && typeof count === "number" ? { kind, bot, count } : null;
}

function describe(use: ProviderUse): string {
  switch (use.kind) {
    case "default": return t("provider.blocked.default");
    case "thread": return t("provider.blocked.thread", { bot: use.bot, count: String(use.count) });
    case "model": return t("provider.blocked.model", { bot: use.bot });
    case "backup": return t("provider.blocked.backup", { bot: use.bot });
    case "running": return t("provider.blocked.running", { bot: use.bot });
  }
}

/** The sentence that names what still uses a provider, from the `usedBy` list of a refused Hide or Remove; empty when the
 * refusal has none. */
export function providerUsesText(body: unknown): string {
  const { usedBy } = Object(body) as { usedBy?: unknown };
  const uses = (Array.isArray(usedBy) ? usedBy : []).flatMap((entry) => providerUse(entry) ?? []);
  if (uses.length === 0) return "";
  const list = uses.slice(0, SHOWN).map(describe).join(", ");
  return t("provider.blocked.list", { list: uses.length > SHOWN ? t("provider.blocked.more", { list, count: String(uses.length - SHOWN) }) : list });
}
