import { activeLocale, t } from "./i18n";
import type { LocaleKey } from "@/locales";

export interface CatalogCard {
  slug: string;
  categories?: string[];
}

export const INLINE_CATEGORY_COUNT = 5;
export const CATEGORY_SECTION_COUNT = 3;
export const CATEGORY_SECTION_SIZE = 4;
export const POPULAR_SECTION_SIZE = 4;

/** Composio sends about 40 free-form category names in mixed case; the dialog shows these fixed groups instead. */
export type AppCategory =
  | "productivity" | "developerTools" | "communication" | "files" | "salesCrm" | "design" | "marketing" | "analytics"
  | "social" | "finance" | "commerce" | "ai" | "automation" | "hr" | "entertainment" | "education";

const CATEGORY_RULES: ReadonlyArray<readonly [AppCategory, RegExp]> = [
  ["marketing", /market|advertis|\bads\b|\bseo\b|newsletter|campaign/],
  ["social", /social/],
  ["salesCrm", /\bcrm\b|sales|customer|support|help ?desk|ticketing/],
  ["hr", /\bhr\b|recruit|hiring|human resources|talent|payroll|employee/],
  ["finance", /financ|account|invoic|payment|billing|bank|\btax|expense/],
  ["commerce", /commerce|\bshop|retail|\bstores?\b/],
  ["ai", /\bai\b|artificial intelligence|machine learning|\bllms?\b/],
  ["education", /educat|\blms\b|course|school|learning/],
  ["analytics", /analytic|intelligence|database|\bdata\b|metric|report/],
  ["communication", /e-?mail|chat|messag|communicat|\bsms\b|phone|telephon|voice|meeting|conferenc|inbox/],
  ["files", /\bfiles?\b|document|storage|\bdrive\b|\bpdf|signature/],
  ["developerTools", /develop|devops|\bcode|coding|\bapis?\b|hosting|monitor|security|infrastructure|deploy|testing/],
  ["design", /design|image|creative|photo|video|graphic/],
  ["automation", /automat|workflow|integration/],
  ["productivity", /productiv|project|task|schedul|calendar|booking|\bnotes?\b|spreadsheet|collaborat|\bforms?\b|survey|knowledge/],
  ["entertainment", /entertain|lifestyle|\bmedia\b|music|\bgam(e|es|ing)\b|news/],
];

export function appCategory(name: string): AppCategory | null {
  const text = name.trim().toLowerCase();
  return CATEGORY_RULES.find(([, rule]) => rule.test(text))?.[0] ?? null;
}

export function appCategories(card: CatalogCard): AppCategory[] {
  return [...new Set((card.categories ?? []).map(appCategory).filter((group): group is AppCategory => group !== null))];
}

export function appCategoryLabel(category: AppCategory): string {
  return t(`apps.category.${category}` as LocaleKey);
}

/** Groups by how many apps they hold, the rest under More by label; `keep` ones (an app of Seira's own lives there) always show inline. */
export function rankCategories(cards: readonly CatalogCard[], inline = INLINE_CATEGORY_COUNT, keep: readonly AppCategory[] = []): { inline: AppCategory[]; more: AppCategory[] } {
  const counts = new Map<AppCategory, number>();
  for (const card of cards) for (const category of appCategories(card)) counts.set(category, (counts.get(category) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([category]) => category);
  const kept = keep.filter((category) => ranked.indexOf(category) >= inline);
  const shown = [...ranked.slice(0, Math.max(0, inline - kept.length)), ...kept];
  const more = ranked.filter((category) => !shown.includes(category));
  return { inline: shown, more: more.sort((a, b) => appCategoryLabel(a).localeCompare(appCategoryLabel(b), activeLocale())) };
}

export function inCategory(card: CatalogCard, category: AppCategory | null): boolean {
  return category === null || appCategories(card).includes(category);
}

export type CatalogSection<Card> =
  | { kind: "popular"; cards: Card[] }
  | { kind: "connected"; cards: Card[] }
  | { kind: "category"; category: AppCategory; cards: Card[]; more: boolean }
  | { kind: "all"; cards: Card[] };

const appKey = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** The catalog slugs of the apps in `usage` (most calls first), up to the size of the Popular section. */
export function popularSlugs(usage: ReadonlyArray<{ app: string }>, cards: readonly CatalogCard[]): string[] {
  const slugByKey = new Map(cards.map((card) => [appKey(card.slug), card.slug]));
  const slugs = usage.flatMap(({ app }) => slugByKey.get(appKey(app)) ?? []);
  return [...new Set(slugs)].slice(0, POPULAR_SECTION_SIZE);
}

/** `popular` lists catalog slugs, most used first; an app in it shows there and in no other section. */
export function catalogSections<Card extends CatalogCard>(
  cards: readonly Card[],
  isConnected: (slug: string) => boolean,
  categories: readonly AppCategory[],
  popular: readonly string[] = [],
): CatalogSection<Card>[] {
  const sections: CatalogSection<Card>[] = [];
  const popularCards = popular.flatMap((slug) => cards.find((card) => card.slug === slug) ?? []);
  if (popularCards.length) sections.push({ kind: "popular", cards: popularCards });
  const rest = cards.filter((card) => !popularCards.includes(card));
  const connected = rest.filter((card) => isConnected(card.slug));
  if (connected.length) sections.push({ kind: "connected", cards: connected });
  for (const category of categories.slice(0, CATEGORY_SECTION_COUNT)) {
    const open = rest.filter((card) => !isConnected(card.slug) && inCategory(card, category));
    if (open.length) sections.push({ kind: "category", category, cards: open.slice(0, CATEGORY_SECTION_SIZE), more: open.length > CATEGORY_SECTION_SIZE });
  }
  sections.push({ kind: "all", cards: rest.filter((card) => !isConnected(card.slug)) });
  return sections;
}

// Catalog blurbs come in English; the known ones show in the app's language.
const CONNECTOR_COPY: Record<string, string> = {
  "google calendar": "googleCalendar",
  "google sheets": "googleSheets",
  "google docs": "googleDocs",
  notion: "notion",
  github: "github",
  linear: "linear",
  sentry: "sentry",
  jira: "jira",
  slack: "slack",
  gmail: "gmail",
  discord: "discord",
  "google drive": "googleDrive",
  posthog: "posthog",
  "x (twitter)": "xTwitter",
  reddit: "reddit",
  zapier: "zapier",
  hubspot: "hubspot",
  salesforce: "salesforce",
  asana: "asana",
  trello: "trello",
  dropbox: "dropbox",
  airtable: "airtable",
  figma: "figma",
  stripe: "stripe",
};

export function connectorDescription(card: { label: string; blurb: string }): string {
  const id = CONNECTOR_COPY[card.label.trim().toLowerCase()];
  return id ? t(`apps.catalog.${id}.blurb` as LocaleKey) : card.blurb;
}
