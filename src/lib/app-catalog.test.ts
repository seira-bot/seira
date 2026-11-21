import { describe, expect, it } from "vitest";
import { appCategories, appCategory, appCategoryLabel, CATEGORY_SECTION_SIZE, catalogSections, inCategory, rankCategories } from "./app-catalog";

const card = (slug: string, ...categories: string[]) => ({ slug, categories });

describe("appCategory", () => {
  it("puts every category name the catalog is known to send into one fixed group", () => {
    const names: Record<string, ReturnType<typeof appCategory>> = {
      Productivity: "productivity",
      "project management": "productivity",
      "task management": "productivity",
      "team collaboration": "productivity",
      "scheduling & booking": "productivity",
      spreadsheets: "productivity",
      "Developer tools": "developerTools",
      "Developer Tools & DevOps": "developerTools",
      email: "communication",
      "team chat": "communication",
      "Collaboration & Communication": "communication",
      documents: "files",
      "file management & storage": "files",
      "Document & File Management": "files",
      crm: "salesCrm",
      "Sales & Customer Support": "salesCrm",
      "images & design": "design",
      "Design & Creative Tools": "design",
      Marketing: "marketing",
      "marketing automation": "marketing",
      "ads & conversion": "marketing",
      "Marketing & Social Media": "marketing",
      Analytics: "analytics",
      "business intelligence": "analytics",
      databases: "analytics",
      "social media accounts": "social",
      accounting: "finance",
      "proposal & invoice management": "finance",
      ecommerce: "commerce",
      "E-commerce": "commerce",
      "AI & Machine Learning": "ai",
      "Workflow Automation": "automation",
      "HR & Recruiting": "hr",
      "lifestyle & entertainment": "entertainment",
      "Education & LMS": "education",
    };
    for (const [name, group] of Object.entries(names)) expect([name, appCategory(name)]).toEqual([name, group]);
  });

  it("leaves out a name that says how an app connects rather than what it is for", () => {
    expect(appCategory("model context protocol")).toBeNull();
    expect(appCategory("  ")).toBeNull();
    expect(appCategories(card("x", "model context protocol", "Productivity", "productivity", "Notes"))).toEqual(["productivity"]);
    expect(appCategories({ slug: "x" })).toEqual([]);
  });

  it("labels each group in sentence case", () => {
    expect(["productivity", "developerTools", "salesCrm", "commerce", "ai", "hr"].map((group) => appCategoryLabel(group as never)))
      .toEqual(["Productivity", "Developer tools", "Sales and CRM", "E-commerce", "AI", "HR and hiring"]);
  });
});

describe("rankCategories", () => {
  it("ranks groups by how many apps carry them, ties by id, and lists the rest under More by label", () => {
    const cards = [card("a", "Productivity", "Files"), card("b", "project management"), card("c", "Design"), card("d", "email", "team chat"), card("e", "accounting"), card("f"), { slug: "g" }];
    expect(rankCategories(cards, 2)).toEqual({ inline: ["productivity", "communication"], more: ["design", "files", "finance"] });
    expect(rankCategories([card("a", "crm"), card("b", "Analytics"), card("c", "Workflow Automation")], 0).more).toEqual(["analytics", "automation", "salesCrm"]);
    expect(rankCategories([])).toEqual({ inline: [], more: [] });
    expect(rankCategories([card("a", "model context protocol")])).toEqual({ inline: [], more: [] });
  });

  it("keeps a group Seira's own app lives in among the inline ones, taking the last place", () => {
    const cards = [card("a", "Productivity"), card("b", "Productivity"), card("c", "Design"), card("d", "Design"), card("e", "Files"), card("postiz", "Social")];
    expect(rankCategories(cards, 2, ["social"])).toEqual({ inline: ["design", "social"], more: ["files", "productivity"] });
    expect(rankCategories(cards, 3, ["social"]).inline).toEqual(["design", "productivity", "social"]);
    expect(rankCategories(cards, 4, ["social"]).inline).toEqual(["design", "productivity", "files", "social"]);
    expect(rankCategories(cards, 2, ["finance"])).toEqual(rankCategories(cards, 2));
  });
});

describe("inCategory", () => {
  it("lets everything through without a group, and matches any name in the group", () => {
    expect(inCategory({ slug: "x" }, null)).toBe(true);
    expect(inCategory(card("x", "images & design"), "design")).toBe(true);
    expect(inCategory(card("x", "model context protocol", "team chat"), "communication")).toBe(true);
    expect(inCategory({ slug: "x" }, "design")).toBe(false);
  });
});

describe("catalogSections", () => {
  const cards = [
    card("slack", "Communication"),
    card("gmail", "email"),
    ...Array.from({ length: 6 }, (_, index) => card(`p${index}`, "Productivity")),
    card("figma", "Design"),
  ];
  const connected = (slug: string) => slug === "slack";

  it("leads with connected apps, previews groups with what is left, then the whole catalog", () => {
    const sections = catalogSections(cards, connected, ["productivity", "communication", "design", "files"]);
    expect(sections.map((section) => section.kind === "category" ? section.category : section.kind)).toEqual(["connected", "productivity", "communication", "design", "all"]);
    expect(sections[0]!.cards.map((entry) => entry.slug)).toEqual(["slack"]);
    const productivity = sections[1]!;
    expect(productivity.cards).toHaveLength(CATEGORY_SECTION_SIZE);
    expect(productivity.kind === "category" && productivity.more).toBe(true);
    expect(sections[2]!.cards.map((entry) => entry.slug)).toEqual(["gmail"]);
    expect(sections.at(-1)!.cards.some((entry) => entry.slug === "slack")).toBe(false);
  });

  it("keeps the catalog section even when empty, and skips empty ones", () => {
    expect(catalogSections([], connected, ["design"])).toEqual([{ kind: "all", cards: [] }]);
  });
});
