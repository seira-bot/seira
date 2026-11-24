// seira://pair?address=<server origin>&code=<pairing code>: the Open in app button of a server's /pair page, and the QR
// a server prints. A link comes from outside the app, so it is data and never a decision: this file only reads it,
// strictly and without a network request. The person confirms the normalized server first (server-probe.mjs,
// connectFromLink), and the code stays in memory, out of every log.
const MAX_LINK_LENGTH = 2048;
const MAX_SECRET_LENGTH = 256;
const PARAMETERS = new Set(["address", "code", "token", "name"]);
const UNSAFE_CHARACTER = /[\s\p{Cc}\\]/u;

/** Whether the link is meant for this handler: it names the `pair` host, even with a user name, a port or a path on it. */
function claims(value) {
  if (typeof value !== "string" || value.length > MAX_LINK_LENGTH * 4) return false;
  if (/^seira:\/\/pair(?:[?/#:]|$)/i.test(value)) return true;
  try { const url = new URL(value); return url.protocol === "seira:" && url.hostname === "pair"; } catch { return false; }
}

function readStrictly(value) {
  if (value.length > MAX_LINK_LENGTH || UNSAFE_CHARACTER.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "seira:" || url.hostname !== "pair" || url.pathname !== "" || url.hash || url.username || url.password || url.port) return null;
  const seen = new Map();
  for (const [key, text] of url.searchParams) {
    if (!PARAMETERS.has(key) || seen.has(key)) return null;
    seen.set(key, text);
  }
  const address = seen.get("address") ?? "";
  if (!/^https?:\/\/[^/?#]/i.test(address)) return null;
  if (seen.has("code") && seen.has("token")) return null;
  const secret = seen.get("code") ?? seen.get("token") ?? null;
  if (secret !== null && (!secret || secret.length > MAX_SECRET_LENGTH)) return null;
  return { valid: true, address, secret };
}

/** null for any link that is not a pair link; otherwise `{ valid: true, address, secret }` or `{ valid: false }`. */
export function pairLinkIntent(value) {
  if (!claims(value)) return null;
  return readStrictly(value) ?? { valid: false };
}

/** The last pair link on a command line, taken out of it so a relaunch with the same arguments does not open it again. */
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
        await connect({ address: intent.address, secret: intent.secret });
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
