/** What a person with chosen access may do with a bot: read it ("view") or also write to it ("chat"). */
export type GrantLevel = "view" | "chat";

export const GRANT_LEVELS: readonly GrantLevel[] = ["chat", "view"];

/** The departments and bots one person sees on a self-hosted server. Each item has its own level. */
export interface AccessGrant {
  /** By department name; "" is General. */
  departments: Array<{ name: string; level: GrantLevel }>;
  /** By bot id. */
  bots: Array<{ id: string; level: GrantLevel }>;
}

/** Who may see which departments and bots on a self-hosted server. A person with no entry sees the whole team. */
export interface DepartmentAccessView {
  /** False where people are managed elsewhere (a Team Cloud or a hosted workspace). */
  available: boolean;
  /** Sign-in entry (an address or `@domain`) to that person's grant. */
  people: Record<string, AccessGrant>;
  /** The saved choices could not be read: until they are fixed, every member sees nothing. */
  unreadable: boolean;
}

/** `access: null` gives the person the whole team again. A bot named here that is not shared with everyone gets the
 * entry added to the people who can see it, in the same request. */
export interface DepartmentAccessChange {
  entry: string;
  access: AccessGrant | null;
  /** The admin confirms that the entry joins the people of each chosen bot that is not shared with them yet. */
  admitBots?: boolean;
}
