/** One connectable app as the Apps catalog lists it. */
export interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  /** Toolkits such as public search need no user authorization. */
  noAuth?: boolean;
  /** Composio manages no sign-in for this app, so it connects only with the person's own OAuth app. */
  needsOwnAuth?: boolean;
  domain: string | null;
  categories?: string[];
}
