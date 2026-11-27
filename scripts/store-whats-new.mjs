import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MAX_LENGTH = 1500;
export const FALLBACK = "Bug fixes and improvements.\n";

const NOTES_FILE = new URL("../src/lib/release-notes.ts", import.meta.url);
const LOCALE_FILE = new URL("../src/locales/en.json", import.meta.url);

export function noteIds(source, version) {
  const start = source.indexOf(`{ version: "${version}", items: [`);
  if (start === -1) return null;
  const end = source.indexOf("] }", start);
  return [...source.slice(start, end).matchAll(/\bid: "([^"]+)"/g)].map(([, id]) => id);
}

export function fitLines(lines, maxLength = MAX_LENGTH) {
  const kept = [...lines];
  while (kept.length > 0 && kept.map((line) => `${line}\n`).join("").length > maxLength) kept.pop();
  return kept;
}

export function whatsNew(version, { notesSource, locale, maxLength = MAX_LENGTH }) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error(`The version must look like 1.2.3, not "${version ?? ""}".`);
  const ids = noteIds(notesSource, version);
  if (ids === null || ids.length === 0) return FALLBACK;
  const lines = ids.map((id) => {
    const title = locale[`releaseNotes.items.${id}.title`];
    if (typeof title !== "string" || title.trim() === "") throw new Error(`The release note "${id}" has no English title.`);
    return `- ${title.trim()}`;
  });
  const fitted = fitLines(lines, maxLength);
  return fitted.length === 0 ? FALLBACK : fitted.map((line) => `${line}\n`).join("");
}

function main(argv) {
  const at = argv.indexOf("--version");
  const version = at === -1 ? undefined : argv[at + 1];
  try {
    const text = whatsNew(version, {
      notesSource: readFileSync(NOTES_FILE, "utf8"),
      locale: JSON.parse(readFileSync(LOCALE_FILE, "utf8")),
    });
    process.stdout.write(text);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
