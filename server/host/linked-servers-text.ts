// The text a server of another owner sends over a link, as this server takes it in.
import { clean, defuse } from "../records-block.ts";

const FAR_BOT = "Teammate";
const FAR_PLACE = "Another Seira";

type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const line = (max: number, fallback: string) => (text: string) => clean(text, max) || fallback;

/** `value` with each named string field passed through its cleaner. A field that is not there stays away. */
function cleaned(value: unknown, cleaners: Record<string, (text: string) => string>): unknown {
  if (!isFields(value)) return value;
  const out: Fields = { ...value };
  for (const [key, cleaner] of Object.entries(cleaners)) {
    const field = out[key];
    if (typeof field === "string") out[key] = cleaner(field);
  }
  return out;
}

/** A file name from the other side. The exchange gives the name that comes with a file's bytes the same form, so both
 * name the same waiting file. */
export const farFileName = line(255, "file");
const withFiles = (frame: Fields) => ("files" in frame && Array.isArray(frame.files) ? { files: frame.files.map((one) => cleaned(one, { name: farFileName })) } : {});

/** Security invariant: no invisible or control character in what a guest peer says (its place and bots, a hand-off's
 * sender, words and file names, a result's words and file names) reaches a bot or the app here. */
export function farFrame(raw: unknown): unknown {
  if (!isFields(raw)) return raw;
  switch (raw.t) {
    case "hello":
      return { ...raw, place: cleaned(raw.place, { name: line(120, FAR_PLACE) }),
        bots: Array.isArray(raw.bots) ? raw.bots.map((bot) => cleaned(bot, { name: line(120, FAR_BOT), title: line(200, ""), description: line(400, ""), model: line(200, "") })) : raw.bots };
    case "handoff":
      return { ...cleaned(raw, { text: defuse, doneWhen: defuse }) as Fields, from: cleaned(raw.from, { name: line(120, FAR_BOT) }), origin: cleaned(raw.origin, { quote: defuse }), ...withFiles(raw) };
    case "result":
      return { ...cleaned(raw, { text: defuse }) as Fields, ...withFiles(raw) };
    default:
      return raw;
  }
}
