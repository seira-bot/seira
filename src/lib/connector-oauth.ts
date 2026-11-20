import { openExternalLink } from "./app-links";

export interface PendingAuthorization {
  url: string;
  createdAt: number;
}

/** Composio authorization links expire after ten minutes; reopening the page must not renew the clock. */
export const AUTHORIZATION_LINK_MS = 10 * 60 * 1_000;

export function reusableConnectionUrl(page: PendingAuthorization | null | undefined, now = Date.now()): string | null {
  return page && now >= page.createdAt && now - page.createdAt < AUTHORIZATION_LINK_MS ? page.url : null;
}

/** Reserve the tab during the click, before an authorization request consumes the browser's user activation. */
export function reserveConnectionPage() {
  const appOpensLinks = Boolean(window.ogb);
  let page: Window | null = null;
  let navigated = false;
  let cancelled = false;
  if (!appOpensLinks) {
    try {
      page = window.open("", "_blank");
      if (page) page.opener = null;
    } catch {
      page?.close();
      page = null;
    }
  }
  return {
    /** False on a desktop page from another server, which has no openExternal. Electron 43 gives the window's open
     * handler every window.open, with or without a click, and returns null whether the link opened or not. */
    confirms: !appOpensLinks || Boolean(window.ogb?.openExternal),
    async open(url: string): Promise<boolean> {
      if (cancelled) return false;
      if (appOpensLinks) {
        try {
          await openExternalLink(url);
        } catch {
          return false;
        }
        return !cancelled;
      }
      if (!page || page.closed) return false;
      try {
        page.location.replace(url);
        navigated = true;
        return true;
      } catch {
        return false;
      }
    },
    cancel() {
      cancelled = true;
      if (!navigated && page && !page.closed) page.close();
    },
  };
}
