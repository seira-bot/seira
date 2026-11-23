// The text a server of another owner sends over a link, as this server takes it in.
import { guestFrameSchema } from "../bot-link/protocol.ts";
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

// The ids a place makes: UUIDs, hex digests, bot ids and `room-` plus a group id, all of word characters and hyphens.
const SAFE_ID = /^[\w-]{1,200}$/;
const safeId = (value: unknown): boolean => typeof value !== "string" || SAFE_ID.test(value);
const idsOf = (frame: Fields): unknown[] => {
  const from = isFields(frame.from) ? frame.from : {};
  return frame.t === "handoff" ? [frame.id, frame.to, frame.thread, from.botId, from.threadId] : frame.t === "result" || frame.t === "done" || frame.t === "cancel" ? [frame.id] : [];
};

/** Security invariant: no invisible or control character in what a guest peer says (its place and bots, a hand-off's
 * sender, words and file names, a result's words and file names) reaches a bot or the app here. A frame whose id holds
 * anything but word characters and hyphens becomes `null`, which the link drops as a frame that does not parse. An id is
 * never rewritten, so it cannot come to match another one. */
export function farFrame(raw: unknown): unknown {
  if (!isFields(raw)) return raw;
  if (!idsOf(raw).every(safeId)) return null;
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

/** What cleaning `raw` costs, in characters: none for a frame that does not parse or has no words to clean, else the
 * size of the frame. The schema checks a length without reading the text. */
export function farCost(raw: unknown): number {
  if (!guestFrameSchema.safeParse(raw).success) return 0;
  const { t } = raw as { t: string };
  return t === "done" || t === "cancel" || t === "bye" ? 0 : JSON.stringify(raw).length;
}

/** A frame as this side takes it in: cleaned only once it parses, so no text longer than the schema allows is read. A
 * frame that does not parse becomes `null`, which the link drops. */
export const takeFarFrame = (raw: unknown): unknown => (guestFrameSchema.safeParse(raw).success ? farFrame(raw) : null);
