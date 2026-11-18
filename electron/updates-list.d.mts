export declare const UPDATES_LIST_ORIGIN: string;
export declare function updatesListOrigin(env?: Record<string, string | undefined>): string;
export interface UpdatesList {
  /** Returns the receipt that can withdraw this opt-in. */
  updatesConsentByEmail(input: { email: string; installId: string; textVersion: string }): Promise<string>;
  withdrawUpdatesConsent(input: { status: "withdrawn" | "declined"; receipt: string }): Promise<void>;
}
export declare function createUpdatesList(options?: { origin?: string; fetcher?: typeof fetch }): UpdatesList;
