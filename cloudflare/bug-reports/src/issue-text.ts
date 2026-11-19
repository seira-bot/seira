export const BODY_LIMIT = 60_000;
const ELLIPSIS = "\n…";
const FALLBACK_TITLE = "Bug report from the Seira app";

export const issueMarker = (hash: string) => `<!-- seira-fp:${hash} -->`;
export const commentMarker = (id: string) => `<!-- seira-report:${id} -->`;

export interface ReportText {
  title: string | undefined;
  description: string;
  diagnostics: string;
  appVersion: string;
  platform: string;
}

function fenced(content: string) {
  let longest = 0;
  for (const run of content.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${content}\n${fence}`;
}

const inline = (value: string) => {
  const clean = Array.from(value.replace(/[`|\r\n]/g, ""))
    .filter((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f)
    .join("")
    .trim();
  return clean || "unknown";
};

function clipTo(text: string, keep: number) {
  return keep >= text.length ? text : `${text.slice(0, keep)}${ELLIPSIS}`;
}

function fit(make: (description: string, diagnostics: string) => string, description: string, diagnostics: string) {
  let descriptionKeep = description.length;
  let diagnosticsKeep = diagnostics.length;
  for (;;) {
    const body = make(clipTo(description, descriptionKeep), clipTo(diagnostics, diagnosticsKeep));
    const over = body.length - BODY_LIMIT;
    if (over <= 0) return body;
    if (diagnosticsKeep > 0) diagnosticsKeep = Math.max(0, diagnosticsKeep - over - 4);
    else if (descriptionKeep > 0) descriptionKeep = Math.max(0, descriptionKeep - over - 4);
    else return body.slice(0, BODY_LIMIT);
  }
}

export function issueTitle(title: string | undefined, description: string) {
  const source = title ?? description.split(/\r?\n/).find((line) => line.trim()) ?? "";
  const line = Array.from(source.replace(/\s+/g, " "))
    .filter((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f)
    .join("")
    .trim();
  return line.slice(0, title === undefined ? 100 : 120) || FALLBACK_TITLE;
}

const sections = (description: string, diagnostics: string) =>
  `### What happened\n\n${fenced(description)}\n\n<details><summary>Diagnostics</summary>\n\n${fenced(diagnostics)}\n\n</details>\n`;

export function issueBody(hash: string, text: ReportText) {
  return fit(
    (description, diagnostics) =>
      [
        issueMarker(hash),
        "Sent from the Seira app.",
        "",
        "| | |",
        "|---|---|",
        `| App version | \`${inline(text.appVersion)}\` |`,
        `| Platform | \`${inline(text.platform)}\` |`,
        `| Error fingerprint | \`${hash}\` |`,
        "",
        sections(description, diagnostics),
      ].join("\n"),
    text.description,
    text.diagnostics,
  );
}

export function commentBody(id: string, text: ReportText) {
  return fit(
    (description, diagnostics) =>
      [
        commentMarker(id),
        "Another report of this error.",
        "",
        `App version \`${inline(text.appVersion)}\` · Platform \`${inline(text.platform)}\``,
        "",
        sections(description, diagnostics),
      ].join("\n"),
    text.description,
    text.diagnostics,
  );
}
