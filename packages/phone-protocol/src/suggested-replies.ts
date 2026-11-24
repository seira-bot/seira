// Suggested replies on a finished bot turn: the chips a phone may show above its composer. A tap puts the model-written
// `prompt` in front of the person, who sends it; so the server and every client run the same cleaner on the list before
// a chip exists. The filter is best effort, not a security boundary: the boundary is the client rule that a tap only fills the
// composer and the person sends. This module only keeps or drops text. It never opens a link, runs a command or sends a message.

export const SUGGESTED_REPLIES_MAX = 4;
export const SUGGESTED_REPLY_TITLE_MAX = 40;
export const SUGGESTED_REPLY_PROMPT_MAX = 500;
/** How many entries of a list are read at most, so a huge list costs a bounded amount of work. */
const SUGGESTED_REPLIES_READ = 16;

/** One chip: `title` is its label, `prompt` is the text a tap puts in the composer. */
export interface SuggestedReply {
  title: string;
  prompt: string;
}

/** The optional field of a finished bot turn's last line. Absent: the client keeps its own chips. */
export interface SuggestedRepliesField {
  suggestedReplies?: SuggestedReply[];
}

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
/** A scheme, a `www.` address or a mail or telephone link: no link in a chip. */
const LINK = /(?:^|[^\p{L}\p{N}])(?:[a-z][a-z0-9+.-]*:\/\/|www\.|(?:javascript|data|vbscript|mailto|tel|sms|file|blob):)/iu;
/** The top-level domains that make a bare `name.tld` a web address. A short fixed list: a word such as `Node.js` or
 * `README.md` is no address, and an unlisted domain is not caught (the client rule holds: a tap only fills the composer). */
export const BARE_ADDRESS_TLDS = ["com", "net", "org", "io", "dev", "app", "ai", "co", "xyz", "info", "biz", "gov", "edu", "uk", "us", "de", "fr", "jp", "cn", "ru", "tv", "id", "me", "link", "site", "online", "top", "store", "tech", "cloud", "page"] as const;
/** A bare web address with no scheme and no `www.`: `example.com`, `a.b.example.co`, `x@example.org`, `localhost`, or an
 * IPv4 address, each with or without a port or a path. */
const BARE_ADDRESS = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])(?:(?:[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?\\.)+(?:${BARE_ADDRESS_TLDS.join("|")})(?![\\p{L}\\p{N}-])|localhost(?![\\p{L}\\p{N}-])|\\d{1,3}(?:\\.\\d{1,3}){3}(?![\\p{L}\\p{N}]))`,
  "iu",
);
/** A slash command at the start, as a command line reads it. */
const SLASH_COMMAND = /^\s*\/\S/u;
/** Shell syntax that has no place in a sentence: a backtick, `$(`, `${`, `&&`, `||`, `|`, a leading `$ `, `>>`, and `>` or `<` before a path. */
const SHELL_SYNTAX = /`|\$\(|\$\{|&&|\|\||\||^\s*\$\s|>>|(?:^|\s)\d?>\s*\/|(?:^|\s)<\s*\//u;
/** A first word that makes the text a command line. Only the first word is read: a command later in a sentence is not caught. */
export const SHELL_WORDS = new Set(["sudo", "rm", "curl", "wget", "chmod", "chown", "bash", "sh", "zsh", "npm", "npx", "pnpm", "yarn", "pip", "git", "ssh", "scp", "docker", "kubectl", "cd", "ls", "cat", "echo", "export", "eval", "exec", "kill", "dd", "mkfs"]);
/** A structured payload: JSON or a call written as an object. */
const ACTION_PAYLOAD = /^\s*[{[]|"(?:action|tool|command|cmd|url)"\s*:/iu;

const words = (value: string): number => [...value].length;

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(CONTROL, " ").replace(/\s+/gu, " ").trim();
  return text === "" ? null : text;
}

function plain(text: string): boolean {
  if (LINK.test(text) || BARE_ADDRESS.test(text) || SLASH_COMMAND.test(text) || SHELL_SYNTAX.test(text) || ACTION_PAYLOAD.test(text)) return false;
  return !SHELL_WORDS.has(text.split(" ", 1)[0]!);
}

/** The list a client may show: at most 4 entries, each plain text, with a title of at most 40 and a prompt of at most 500
 * characters. Control characters are replaced and whitespace is trimmed; an entry with an empty or over-limit part, a link,
 * a slash command, shell syntax or an action payload is dropped whole, never cut, because a prompt is sent as written.
 * Repeated prompts count once. `undefined` when no entry is left, so no field is sent. */
export function cleanSuggestedReplies(value: unknown): SuggestedReply[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept: SuggestedReply[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, SUGGESTED_REPLIES_READ)) {
    if (kept.length === SUGGESTED_REPLIES_MAX) break;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const title = clean((entry as { title?: unknown }).title);
    const prompt = clean((entry as { prompt?: unknown }).prompt);
    if (!title || !prompt) continue;
    if (words(title) > SUGGESTED_REPLY_TITLE_MAX || words(prompt) > SUGGESTED_REPLY_PROMPT_MAX) continue;
    if (!plain(title) || !plain(prompt)) continue;
    const key = prompt.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ title, prompt });
  }
  return kept.length ? kept : undefined;
}
