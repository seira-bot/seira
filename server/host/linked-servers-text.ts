// The text a server of another owner sends over a link, as this server takes it in.
import { guestFrameSchema, type Frame } from "../bot-link/protocol.ts";
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

const length = (text: string | undefined) => text?.length ?? 0;
const nameChars = (files: ReadonlyArray<{ name: string }> | undefined) => files?.reduce((sum, one) => sum + one.name.length, 0) ?? 0;

/** The characters farFrame cleans in a frame that parsed. */
function priceOf(frame: Frame): number {
  switch (frame.t) {
    case "hello":
      return frame.place.name.length + frame.bots.reduce((sum, bot) => sum + bot.name.length + length(bot.title) + length(bot.description) + length(bot.model), 0);
    case "handoff":
      return frame.text.length + length(frame.doneWhen) + frame.from.name.length + length(frame.origin.quote) + nameChars(frame.files);
    case "result":
      return frame.text.length + nameChars(frame.files);
    default:
      return 0;
  }
}

const UNREAD = { frame: null, price: 0 } as const;

/** A frame from a guest peer as this side reads it: priced in the characters farFrame will clean in
 * what parsed. Security invariant: nothing the schema drops (a key it does not know, the space around a name) is read
 * past the parse, and this never throws: a frame that does not parse is null, at no price, which the link drops. */
export function readFar(raw: unknown): { frame: Frame | null; price: number } {
  try {
    const parsed = guestFrameSchema.safeParse(raw);
    return parsed.success ? { frame: parsed.data, price: priceOf(parsed.data) } : UNREAD;
  } catch {
    return UNREAD;
  }
}
