/** Lines of the onboarding team suggestion in Seira's chat. */

export type TeamSuggestionState = "open" | "created" | "skipped" | "replaced";

/** A bot of a created team, as its intro line names it. */
export interface TeamIntroBot {
  id: string;
  name: string;
  job: string;
}

export interface TeamSuggestion {
  /** The package the suggestion would create: a seira.package. Nothing in it exists until the person creates the team. */
  document: Record<string, unknown>;
  /** One thing the person can send to try the team. */
  firstTask?: string;
  state: TeamSuggestionState;
}

export interface TeamIntro {
  department: string;
  bots: TeamIntroBot[];
  firstTask?: string;
}

export interface TeamSuggestionFields {
  /** Seira's question about the person's work, which no AI wrote. `text` is the English. */
  teamAsk?: true;
  /** The person's answer to `teamAsk`: Seira's AI reads it as a request to suggest a team and creates nothing. */
  teamRequest?: true;
  teamSuggestion?: TeamSuggestion;
  /** Seira's introduction of a team the person created from a suggestion. `text` is the English. */
  teamIntro?: TeamIntro;
}

export const TEAM_NAME_MAX = 60;
export const TEAM_BOT_NAME_MAX = 100;
