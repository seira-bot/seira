/** A self-hosted server without Premium lets this many people sign in with an email. */
export const FREE_PEOPLE_LIMIT = 5;

/**
 * The Premium key as Settings → People shows it to an admin.
 * - `active`: valid, more than 30 days left.
 * - `endingSoon`: valid, 30 days or fewer left.
 * - `grace`: past its end date by less than 7 days; people stay unlimited.
 * - `ended`: past its grace; the free limit applies to new people.
 * - `invalid`: the key given is not a Premium key this app accepts.
 * - `unreadable`: the saved key could not be read.
 */
export type PremiumKeyState = "active" | "endingSoon" | "grace" | "ended" | "invalid" | "unreadable";

export interface PremiumKeyStatus {
  state: PremiumKeyState;
  /** `environment`: set where the server starts, so Settings cannot change it. */
  source: "settings" | "environment";
  customer?: string;
  /** The key's end date, YYYY-MM-DD (UTC). */
  endsOn?: string;
  /** The last day of the grace, YYYY-MM-DD (UTC). */
  graceEndsOn?: string;
  /** Whole days until `endsOn`. */
  daysLeft?: number;
}

/** Someone who holds a place without being listed by address: they signed in through an `@domain` entry. */
export interface JoinedPerson {
  email: string;
  /** The `@domain` entry that lets them in. */
  via: string;
  role: "admin" | "member";
  lastSeenAt: number | null;
  devices: number;
}

/** GET /api/people/plan: admins only. */
export interface PeoplePlanStatus {
  /** False where the server does not decide who signs in (a Team Cloud, a hosted workspace, My Cloud). */
  applies: boolean;
  /** `unlimited`: an Enterprise licence grants it. */
  plan: "free" | "premium" | "unlimited";
  people: number;
  limit: number;
  /** The free plan has no place left for a new person. */
  full: boolean;
  joined: JoinedPerson[];
  key: PremiumKeyStatus | null;
  upgradeUrl: string;
}
