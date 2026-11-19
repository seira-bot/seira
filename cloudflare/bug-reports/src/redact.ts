const MASK = "«redacted»";
const TOKEN_MASK = "«redacted token»";

const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const URL_PATTERN = /https?:\/\/[^\s"'<>\\]+/g;
const HEADER = /(authorization|proxy-authorization|cookie|set-cookie)(["']?\s*[:=]\s*)[^\r\n]+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const TOKEN_SHAPES = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /xox[abposr]-[A-Za-z0-9-]{10,}/g,
  /A(?:KIA|SIA)[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /ya29\.[0-9A-Za-z_-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
const LONG_RUN = /[A-Za-z0-9_-]{40,}/g;
const SECRET_PAIR =
  /(token|secret|password|passwd|pwd|api_key|apikey|api-key|access_key|private_key|client_secret)([A-Za-z0-9_.-]{0,40}["']?\s*[:=]\s*["']?)([^\s"',;&«]{6,})/gi;
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const WINDOWS_HOME = /[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)([^\\/\s"'<>:]+)/gi;
const UNIX_HOME = /(?:\/var\/home\/|\/home\/|\/Users\/)([^\\/\s"'<>:]+)/g;
const PHONE = /(?<![\w.:/+-])\+?\(?\d[\d ().\t-]{7,25}\d(?![\w.:/-])/g;

const SHARED_PROFILES = new Set(["shared", "public", "default", "all"]);

function redactUrl(url: string) {
  const parts = /^(https?:\/\/)([^/?#]*)([^?#]*)(.*)$/.exec(url);
  if (!parts) return url;
  const [, scheme = "", authority = "", path = "", rest = ""] = parts;
  const at = authority.lastIndexOf("@");
  const host = at >= 0 ? `${MASK}@${authority.slice(at + 1)}` : authority;
  return `${scheme}${host}${path}${rest ? `?${MASK}` : ""}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPhone(candidate: string) {
  const digits = candidate.replace(/\D/g, "").length;
  if (digits < 9 || digits > 15) return false;
  if (/\d{4}-\d{2}-\d{2}/.test(candidate)) return false;
  if (/^\d+(?:\.\d+)+$/.test(candidate)) return false;
  const separators = candidate.match(/[ ().-]/g)?.length ?? 0;
  return /^[+0(]/.test(candidate) || separators >= 2;
}

/** The user names in home paths across every text, so a name found in one field is hidden in all of them. */
export function homeUserNames(texts: readonly string[]) {
  const names = new Set<string>();
  for (const text of texts) {
    for (const pattern of [WINDOWS_HOME, UNIX_HOME]) {
      for (const match of text.matchAll(pattern)) {
        const name = match[1] ?? "";
        if (!SHARED_PROFILES.has(name.toLowerCase())) names.add(name);
      }
    }
  }
  return names;
}

export function redact(text: string, { installId, userNames }: { installId: string; userNames?: ReadonlySet<string> }) {
  const hideInstall = (value: string) => (installId ? value.split(installId).join("«install»") : value);
  let out = hideInstall(text);

  out = out.replace(PEM, "«redacted private key»");
  out = out.replace(URL_PATTERN, redactUrl);
  out = out.replace(HEADER, `$1$2${MASK}`);
  out = out.replace(BEARER, `Bearer ${MASK}`);
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, TOKEN_MASK);
  out = out.replace(LONG_RUN, (run) =>
    /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run) ? TOKEN_MASK : run,
  );
  out = out.replace(SECRET_PAIR, `$1$2${MASK}`);
  out = out.replace(EMAIL, "«email»");

  const names = new Set([...(userNames ?? []), ...homeUserNames([out])]);
  out = out.replace(WINDOWS_HOME, "~").replace(UNIX_HOME, "~");
  for (const name of Array.from(names).slice(0, 20)) {
    if (name.length < 3) continue;
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`, "gi"), "«user»");
  }

  out = out.replace(PHONE, (candidate) => (isPhone(candidate) ? "«phone»" : candidate));
  return hideInstall(out);
}
