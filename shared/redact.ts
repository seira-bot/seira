// Keeping secrets out of text that crosses a trust boundary: the native
// protocol log, tool titles, activity chips. The log keeps the shape (the
// name, the length) and loses the values.

/** Keep repeated redaction byte-for-byte stable. Persisted payloads can pass
 * through both a content scrub and the store-wide scrub; re-masking our own
 * marker would change its reported length (and any hash over the payload). */
const REDACTION_MARKER = /^«redacted \d+ chars»$/;

export const mask = (value: string) => (REDACTION_MARKER.test(value) ? value : `«redacted ${value.length} chars»`);

// High precision on purpose: a generic "long hex/base64" heuristic would
// rewrite real code in the transcript, so only shapes that are unmistakably
// credentials match.

const KEY_PREFIXES: RegExp[] = [
  /\bom[dg]_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, // desktop device and model-only credentials
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, // anthropic / openai
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // stripe secret and restricted keys
  /\bxai-[A-Za-z0-9_-]{20,}/g, // xai (grok)
  /\bgsk_[A-Za-z0-9]{40,}/g, // groq
  /\bcsk-[A-Za-z0-9]{32,}/g, // cerebras
  /\bLLM\|\d{6,}\|[A-Za-z0-9_-]{16,}/g, // meta model api
  /\bhf_[A-Za-z0-9]{30,}/g, // hugging face
  /\bpypi-AgE[A-Za-z0-9_-]{82,}/g, // pypi and testpypi api tokens (macaroons)
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // github classic
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // github fine-grained
  /\bgl(?:pat|dt|rtr?)-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*/g, // gitlab personal, deploy and runner tokens (routable ones carry .-parts)
  /\bxox[abposr]-[A-Za-z0-9-]{20,}/g, // slack
  /\bxapp-\d-[A-Za-z0-9-]{20,}/g, // slack app-level (socket mode) tokens
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // aws access key id, long-term (AKIA) or temporary STS (ASIA)
  /\bAIza[0-9A-Za-z_-]{30,}/g, // google api key
  /\bnpm_[A-Za-z0-9]{20,}/g, // npm
  /\bntn_[A-Za-z0-9]{46}(?![A-Za-z0-9_-])/g, // notion integration tokens
  /\bpplx-[A-Za-z0-9]{48}(?![A-Za-z0-9_-])/g, // perplexity api keys
  /\bwhsec_[A-Za-z0-9_-]{20,}/g, // webhook secrets, alone or in an automation's address
  /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, // sendgrid api keys
  /\bbak_[A-Za-z0-9_-]{20,}/g, // Bot API keys
];
const KEY_PREFIX_TESTS = KEY_PREFIXES.map((re) => new RegExp(re.source));
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** Only shapes that are unmistakably a credential (a provider's key prefix, a private key block), never a name or a
 * placeholder: text holding one is a credential store, not instructions. */
export function holdsCredential(text: string): boolean {
  return PRIVATE_KEY_BLOCK.test(text) || KEY_PREFIX_TESTS.some((re) => re.test(text)) || jwtSpans(text).length > 0;
}

// Security invariant: text from any source (a web page, a file, another bot) reaches every pattern below on the
// server's one thread, so each one runs in time linear in the text. A name or scheme is found from its end
// (`=`, `://`), never retried from each word start inside a long run.

const isTokenChar = (code: number) =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 45;
const isWordChar = (code: number) => code !== 45 && isTokenChar(code);
const JWT_PART = 8;

/** The [start, end) of each match of /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, in one pass. */
function jwtSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  if (!text.includes("eyJ")) return spans;
  const runEnd = (from: number) => {
    let at = from;
    while (isTokenChar(text.charCodeAt(at))) at++;
    return at;
  };
  let at = 0;
  scan: while (at < text.length) {
    if (!isTokenChar(text.charCodeAt(at))) {
      at++;
      continue;
    }
    const end = runEnd(at);
    // Every start in one run shares the rest of the match, so the first start with room for a part is the only one to try.
    let start = -1;
    for (let candidate = at; candidate + 3 + JWT_PART <= end; candidate++) {
      if (text.startsWith("eyJ", candidate) && !isWordChar(text.charCodeAt(candidate - 1))) {
        start = candidate;
        break;
      }
    }
    if (start >= 0 && text.charCodeAt(end) === 46) {
      const second = runEnd(end + 1);
      if (second - end - 1 >= JWT_PART && text.charCodeAt(second) === 46) {
        const third = runEnd(second + 1);
        for (let stop = third; stop >= second + 1 + JWT_PART; stop--) {
          if (isWordChar(text.charCodeAt(stop - 1)) !== isWordChar(text.charCodeAt(stop))) {
            spans.push([start, stop]);
            at = stop;
            continue scan;
          }
        }
      }
    }
    at = end;
  }
  return spans;
}

function maskJwts(text: string): string {
  let out = "";
  let from = 0;
  for (const [start, end] of jwtSpans(text)) {
    out += `${text.slice(from, start)}${mask(text.slice(start, end))}`;
    from = end;
  }
  return from === 0 ? text : out + text.slice(from);
}

const PEM_BEGIN = "-----BEGIN [A-Z ]*PRIVATE KEY-----";
const PEM_END = "-----END [A-Z ]*PRIVATE KEY-----";

/** Each BEGIN line through the first END line after it; no END after one BEGIN means none after any later BEGIN. */
function maskPemBlocks(text: string): string {
  const begin = new RegExp(PEM_BEGIN, "g");
  const finish = new RegExp(PEM_END, "g");
  let out = "";
  let from = 0;
  for (let open = begin.exec(text); open; open = begin.exec(text)) {
    finish.lastIndex = begin.lastIndex;
    const close = finish.exec(text);
    if (!close) break;
    out += `${text.slice(from, open.index)}${open[0]}\n${mask(text.slice(begin.lastIndex, close.index).trim())}\n${close[0]}`;
    from = begin.lastIndex = finish.lastIndex;
  }
  return from === 0 ? text : out + text.slice(from);
}
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/g;
/** `Authorization: Basic dXNlcjpwYXNz`: the base64 is `user:password` in the clear. Only after an
 * Authorization header, so prose like "Basic configuration" stays. */
const BASIC_AUTH = /(\bAuthorization["']?\s*[:=]\s*["']?Basic\s+)([A-Za-z0-9+/]{4,}={0,2})(?![A-Za-z0-9._~+/=-])/gi;
/** key=value / key: value / key="value" where the key is secret-shaped, alone or after `name_`.
 * The value must be a single token of some length; prose after a colon
 * ("password: leave blank…") has spaces and does not match. */
const KEY_VALUE =
  /(?<![A-Za-z0-9])((?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)s?)(["']?\s*[=:]\s*)(["']?)([A-Za-z0-9._~+/=-]{8,})\3/gi;
/** `X_KEY=value`, `xai-key=value`: an assignment to a name that ENDS in key
 * is a credential whatever the value looks like, so no length floor. The
 * separator before `key` is what keeps `hotkey=` and `keyboard=` out. */
const KEY_SUFFIX_ASSIGNMENT = /([_-]key)s?(=)(?<=(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9_-]*[_-]keys?=)(["']?)([A-Za-z0-9._~+/=-]+)\3/gi;
/** `--token abc`, `--password=abc`: the flag names a secret; the value is
 * whatever single token follows, never another flag. */
const SECRET_FLAG = /(--(?:token|password|passwd|api-key|apikey|secret|access-key|auth-token)(?:=|\s+))(["']?)(?!-)([A-Za-z0-9._~+/=-]+)\2/gi;
/** `scheme://user:secret@host` — the password in a URL's userinfo. */
const URL_USERINFO = /(:\/\/(?<=(?<![A-Za-z0-9_])[a-z][a-z0-9+.-]*:\/\/)[^\s/:@'"]+:)([^\s/@'"«»]+)(@)/gi;

// A saved website password has no shape: it is known by value. The server
// registers a scrubber for the values it holds, and every redaction below
// runs it first. Nothing registers one in a client, where this is a no-op.

/** What a held secret becomes wherever it would have appeared. */
export const HELD_SECRET_MASK = "••••••";

const heldSecretScrubbers = new Set<(text: string) => string>();

/** Register a scrubber for held secret values; returns its removal. */
export function addHeldSecretScrubber(scrub: (text: string) => string): () => void {
  heldSecretScrubbers.add(scrub);
  return () => { heldSecretScrubbers.delete(scrub); };
}

export function scrubHeldSecrets(text: string): string {
  if (!text || heldSecretScrubbers.size === 0) return text;
  let out = text;
  for (const scrub of heldSecretScrubbers) out = scrub(out);
  return out;
}

export function redactSecretsInText(text: string): string {
  if (!text) return text;
  // Held values first: a short one-time code is still a secret.
  const held = scrubHeldSecrets(text);
  if (held.length < 8) return held;
  let out = held;
  out = maskPemBlocks(out);
  for (const re of KEY_PREFIXES) out = out.replace(re, (m) => mask(m));
  out = maskJwts(out);
  out = out.replace(BEARER, (_m, lead: string, tok: string) => `${lead}${mask(tok)}`);
  out = out.replace(BASIC_AUTH, (_m, lead: string, creds: string) => `${lead}${mask(creds)}`);
  out = out.replace(KEY_VALUE, (_m, key: string, sep: string, quote: string, value: string) => `${key}${sep}${quote}${mask(value)}${quote}`);
  out = out.replace(KEY_SUFFIX_ASSIGNMENT, (_m, key: string, sep: string, quote: string, value: string) => `${key}${sep}${quote}${mask(value)}${quote}`);
  out = out.replace(SECRET_FLAG, (_m, flag: string, quote: string, value: string) => `${flag}${quote}${mask(value)}${quote}`);
  out = out.replace(URL_USERINFO, (_m, lead: string, secret: string, at: string) => `${lead}${mask(secret)}${at}`);
  return out;
}

/** Security invariant: a sentence's params are scrubbed like the English they fill, so a secret survives in neither. */
export function redactParams<T extends Record<string, string | number>>(params: T): T {
  return Object.fromEntries(Object.entries(params).map(([name, value]) => [name, typeof value === "string" ? redactSecretsInText(value) : value])) as T;
}
