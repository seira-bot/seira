export type ChromeImportStatus = 400 | 404 | 409 | 413 | 503;

/** `message` is meant for the person using the app; `status` is the HTTP status a route answers with. */
export class ChromeImportError extends Error {
  readonly status: ChromeImportStatus;

  constructor(status: ChromeImportStatus, message: string) {
    super(message);
    this.name = "ChromeImportError";
    this.status = status;
  }
}

export const chromeImportErrors = {
  tooLarge: () => new ChromeImportError(413, "This Chrome profile is too large to import."),
  noKey: () => new ChromeImportError(503, "Seira could not open Chrome's saved logins. Unlock your computer's password store, then try again."),
  badTicket: () => new ChromeImportError(409, "This list of sites has expired. Open it again."),
  badSite: () => new ChromeImportError(400, "Choose sites from the list."),
  unknownProfile: () => new ChromeImportError(404, "That browser profile is no longer available."),
  unreadable: () => new ChromeImportError(503, "Seira could not read this Chrome profile. Try again."),
};
