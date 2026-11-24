// seira://pair?address=<server origin>: the Open in app button of a server's /pair page. A link comes from outside the app, so it
// is data and never a decision: this file only reads it, strictly and without a network request. The person confirms the
// normalized server first (server-probe.mjs, connectFromLink); the server's own page then asks for the pairing code.
// A link never carries a pairing code or token: an OS link reaches the app as a launch argument, and a launch argument stays
// in the process command line, where other programs read it. A link that carries one is refused, not repaired.
const MAX_LINK_LENGTH = 2048;
const PARAMETERS = new Set(["address", "name"]);
const UNSAFE_CHARACTER = /[\s\p{Cc}\\]/u;
/** Any control character: C0 (U+0000-001F), DEL and C1 (U+0080-009F). The outer link is checked as the OS delivered it, and the
 * address is checked again after decoding: `%0A` or `%09` is invisible text there, and the URL parser would drop it silently. */
const CONTROL_CHARACTER = /\p{Cc}/u;
/** The outer action as the OS delivered it, before any URL normalization: the scheme and host `pair`, then `?` and a query, and no
 * `#` at all (an empty fragment marker is also a fragment). The URL parser would drop what this refuses. */
const ACTION = /^seira:\/\/pair\?[^#]*$/i;
/** The server address as the link spelled it after decoding: a scheme, then a host and an optional port, then at most one `/`.
 * No user name, path, query, fragment, backslash, space or control character (C0, DEL, C1). A path that normalizes to `/`
 * (`/.`, `//`) is not this. */
const ORIGIN_TEXT = /^https?:\/\/[^/?#@\\\s]+\/?$/i;

/** Whether `text` spells one server origin, before normalization (see ORIGIN_TEXT). */
export function isPlainOriginText(text) {
  return typeof text === "string" && !CONTROL_CHARACTER.test(text) && ORIGIN_TEXT.test(text);
}

/** Whether the link is meant for this handler: it names the `pair` host, even with a user name, a port or a path on it. There is
 * no length limit here: a link that is too long is invalid, and it must still be taken out of a command line. */
function claims(value) {
  if (typeof value !== "string") return false;
  if (/^seira:\/\/pair(?:[?/#:@]|$)/i.test(value)) return true;
  try { const url = new URL(value); return url.protocol === "seira:" && url.hostname === "pair"; } catch { return false; }
}

function readStrictly(value) {
  if (value.length > MAX_LINK_LENGTH || UNSAFE_CHARACTER.test(value) || !ACTION.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "seira:" || url.hostname !== "pair" || url.pathname !== "" || url.hash || url.username || url.password || url.port) return null;
  const seen = new Set();
  let address = "";
  for (const [key, text] of url.searchParams) {
    if (!PARAMETERS.has(key) || seen.has(key)) return null;
    seen.add(key);
    if (key === "address") address = text;
  }
  if (!isPlainOriginText(address)) return null;
  return { valid: true, address };
}

/** null for any link that is not a pair link; otherwise `{ valid: true, address }` or `{ valid: false }`. */
export function pairLinkIntent(value) {
  if (!claims(value)) return null;
  return readStrictly(value) ?? { valid: false };
}

/** The last pair link on a command line, taken out of the array so a relaunch with the same arguments does not open it again, however
 * long it is. This changes the array only: the process command line of this launch stays as the OS made it, so a link never
 * carries a secret. */
export function pairLinkFromCommandLine(argv) {
  let found = null;
  for (let index = argv.length - 1; index >= 0; index--) {
    const intent = pairLinkIntent(argv[index]);
    if (!intent) continue;
    found ??= intent;
    argv.splice(index, 1);
  }
  return found;
}

/**
 * Main's side of a pair link. One link is handled at a time and the rest are dropped, so a page that fires many links cannot
 * stack dialogs. `ready`: settles when a window can show a dialog. `connect(link)`: asks the person, then connects, and
 * resolves false when they decline. `invalid()`: the one fixed error for a link that is not exactly the action.
 * `fail(error)`: shows an error to the person.
 */
export function createPairLinks({ ready, reveal, connect, fail, invalid = () => new Error("invalid pair link") }) {
  let current = null;
  function request(intent) {
    if (current) return true;
    current = (async () => {
      try {
        await ready;
        reveal();
        if (!intent.valid) throw invalid();
        await connect({ address: intent.address });
      } catch (error) {
        await fail(error).catch(() => {});
      } finally {
        current = null;
      }
    })();
    return true;
  }
  return {
    fromUrl(url) { const intent = pairLinkIntent(url); return intent ? request(intent) : false; },
    fromArgs(argv) { const intent = pairLinkFromCommandLine(argv); return intent ? request(intent) : false; },
    idle: async () => { while (current) await current; },
  };
}
