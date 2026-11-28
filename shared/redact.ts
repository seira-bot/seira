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
/** A jwt is found from its first dot, never from its `eyJ` start. A pattern that starts at `eyJ` and then runs over the
 * header re-scans the same unbroken run from each `eyJ` in it (`eyJ-eyJ-eyJ-…`), which costs quadratic time. The cheap
 * `(?=\.)` test comes first, so the look-behind runs only at a dot, and a dot ends the run it reads back over. */
const JWT_TAIL = /(?=\.)(?<=\beyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const KEY_PREFIX_TESTS = [...KEY_PREFIXES.map((re) => new RegExp(re.source)), new RegExp(JWT_TAIL.source)];
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** Only shapes that are unmistakably a credential (a provider's key prefix, a private key block), never a name or a
 * placeholder: text holding one is a credential store, not instructions. */
export function holdsCredential(text: string): boolean {
  return PRIVATE_KEY_BLOCK.test(text) || KEY_PREFIX_TESTS.some((re) => re.test(text));
}
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/g;
/** `Authorization: Basic dXNlcjpwYXNz`: the base64 is `user:password` in the clear. Only after an
 * Authorization header, so prose like "Basic configuration" stays. */
const BASIC_AUTH = /(\bAuthorization["']?\s*[:=]\s*["']?Basic\s+)([A-Za-z0-9+/]{4,}={0,2})(?![A-Za-z0-9._~+/=-])/gi;
const PEM_OPEN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PEM_CLOSE = /-----END [A-Z ]*PRIVATE KEY-----/g;
/** key=value / key: value / key="value" where the key is secret-shaped.
 * The value must be a single token of some length; prose after a colon
 * ("password: leave blank…") has spaces and does not match.
 * Cost: the key starts at a word boundary or after an underscore. A pattern that first reads a free-length name prefix
 * re-reads the same run from each boundary in it (`a-a-a-…`), which costs quadratic time. The text before the key word
 * stays in place either way, because the replacement writes the key back unchanged. */
const KEY_VALUE =
  /((?:\b|(?<=_))(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)s?)(["']?\s*[=:]\s*)(["']?)([A-Za-z0-9._~+/=-]{8,})\3/gi;
/** `X_KEY=value`, `xai-key=value`: an assignment to a name that ENDS in key
 * is a credential whatever the value looks like, so no length floor. The
 * separator before `key` is what keeps `hotkey=` and `keyboard=` out.
 * Cost: the name is read backwards, and only where an `=` follows. A `=` ends the run it reads back over, so each
 * character is read at most one time. */
const KEY_SUFFIX_ASSIGNMENT = /(?=s?=)(?<=\b[A-Za-z][A-Za-z0-9_-]*[_-]key)s?(=)(["']?)([A-Za-z0-9._~+/=-]+)\2/gi;
/** `--token abc`, `--password=abc`: the flag names a secret; the value is
 * whatever single token follows, never another flag. */
const SECRET_FLAG = /(--(?:token|password|passwd|api-key|apikey|secret|access-key|auth-token)(?:=|\s+))(["']?)(?!-)([A-Za-z0-9._~+/=-]+)\2/gi;
/** `scheme://user:secret@host` — the password in a URL's userinfo. The scheme is read backwards from `://`, so a long
 * `a.a.a.…` run is never re-read from each of its boundaries. */
const URL_USERINFO = /(?<=\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@'"]+:)([^\s/@'"«»]+)(@)/gi;

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

/** Private key blocks, found by scanning forward once. An END that no BEGIN has used is searched from where the last
 * search stopped, so a text with many BEGIN lines and no END costs linear time, not one scan to the end per BEGIN.
 * A block with no END at all is left as it is, like before. */
function maskPemBlocks(text: string): string {
  if (!text.includes("-----BEGIN ")) return text;
  const open = new RegExp(PEM_OPEN.source, "g");
  const close = new RegExp(PEM_CLOSE.source, "g");
  let out = "";
  let pos = 0;
  for (;;) {
    open.lastIndex = pos;
    const start = open.exec(text);
    if (!start) break;
    const bodyStart = start.index + start[0].length;
    close.lastIndex = bodyStart;
    const end = close.exec(text);
    if (!end) break; // no END after this BEGIN, so none after a later BEGIN
    out += `${text.slice(pos, start.index)}${start[0]}\n${mask(text.slice(bodyStart, end.index).trim())}\n${end[0]}`;
    pos = end.index + end[0].length;
  }
  return pos === 0 ? text : out + text.slice(pos);
}

const isWordCode = (code: number) => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || code === 95 || (code >= 97 && code <= 122);
const isTokenCode = (code: number) => isWordCode(code) || code === 45;

/** Jwt tokens: `JWT_TAIL` finds the two last segments, then the start of the header is the first `eyJ` in the
 * unbroken run before the dot that sits on a word boundary and leaves at least 8 header characters. */
function maskJwts(text: string): string {
  if (!text.includes("eyJ")) return text;
  const tail = new RegExp(JWT_TAIL.source, "g");
  let out = "";
  let last = 0;
  for (const m of text.matchAll(tail)) {
    const dot = m.index;
    let runStart = dot;
    while (runStart > last && isTokenCode(text.charCodeAt(runStart - 1))) runStart--;
    let head = -1;
    for (let i = text.indexOf("eyJ", runStart); i !== -1 && i + 3 + 8 <= dot; i = text.indexOf("eyJ", i + 1)) {
      if (i === 0 || !isWordCode(text.charCodeAt(i - 1))) { head = i; break; }
    }
    if (head < 0) continue;
    const end = dot + m[0].length;
    out += text.slice(last, head) + mask(text.slice(head, end));
    last = end;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** The most text one call reads. Every matcher below reads its input in time linear in its length. This limit is a
 * second guard on the total work of the whole call, held-secret scrubbers included. Text over it is not skipped: it is
 * masked whole, before any stage runs, so nothing in it can pass through. */
export const REDACT_SCAN_LIMIT = 2 * 1024 * 1024;

/** UTF-8 size of a string, counted without a copy (shared code also runs where `Buffer` does not exist). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? (i++, 4) : 3;
  }
  return bytes;
}

/** `head` plus a fill so the result has exactly `units` UTF-16 units and `bytes` UTF-8 bytes; null when that cannot be. */
function fillTo(head: string, units: number, bytes: number): string | null {
  const room = units - head.length;
  const extra = bytes - utf8Length(head) - room; // bytes past one per unit
  if (room < 0 || extra < 0 || extra > 2 * room) return null;
  const wide = extra >> 1, mid = extra & 1; // `€` adds 2 bytes, `é` adds 1
  return head + "x".repeat(room - wide - mid) + (mid ? "é" : "") + "€".repeat(wide);
}

/** An oversize text becomes a marker and a fill with the SAME length and the SAME UTF-8 size as the text. A caller that
 * counts the redacted text (a size limit, a page of rows, a file cap) then counts what it counted before, so the mask
 * cannot move a limit. The result is a pure function of the length and size, so a second pass returns it unchanged. */
function maskOversize(text: string): string {
  const units = text.length, bytes = utf8Length(text);
  // The marker is plain ASCII: the usual `«` takes 2 bytes, which an all-ASCII text has no room for. Without the marker
  // only when almost every character takes 3 bytes: the fill alone always fits.
  return fillTo(`[redacted ${units} chars]`, units, bytes) ?? fillTo("", units, bytes) ?? "";
}

function redactWithinLimit(text: string): string {
  let out = maskPemBlocks(text);
  for (const re of KEY_PREFIXES) out = out.replace(re, (m) => mask(m));
  out = maskJwts(out);
  out = out.replace(BEARER, (_m, lead: string, tok: string) => `${lead}${mask(tok)}`);
  out = out.replace(BASIC_AUTH, (_m, lead: string, creds: string) => `${lead}${mask(creds)}`);
  out = out.replace(KEY_VALUE, (_m, key: string, sep: string, quote: string, value: string) => `${key}${sep}${quote}${mask(value)}${quote}`);
  out = out.replace(KEY_SUFFIX_ASSIGNMENT, (_m, sep: string, quote: string, value: string) => `${sep}${quote}${mask(value)}${quote}`);
  out = out.replace(SECRET_FLAG, (_m, flag: string, quote: string, value: string) => `${flag}${quote}${mask(value)}${quote}`);
  out = out.replace(URL_USERINFO, (_m, user: string, secret: string, at: string) => `${user}${mask(secret)}${at}`);
  return out;
}

export function redactSecretsInText(text: string): string {
  if (!text) return text;
  if (text.length > REDACT_SCAN_LIMIT) return maskOversize(text);
  // Held values first: a short one-time code is still a secret.
  const held = scrubHeldSecrets(text);
  if (held.length < 8) return held;
  return redactWithinLimit(held);
}

/** Security invariant: a sentence's params are scrubbed like the English they fill, so a secret survives in neither. */
export function redactParams<T extends Record<string, string | number>>(params: T): T {
  return Object.fromEntries(Object.entries(params).map(([name, value]) => [name, typeof value === "string" ? redactSecretsInText(value) : value])) as T;
}
