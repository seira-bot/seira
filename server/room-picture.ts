import { botAvatarUrlSchema } from "../shared/bot-avatar.ts";

function refuse(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

/** The room PATCH's `avatarUrl` field, checked. An empty string or null clears the picture (key present, value undefined). */
export function roomPicturePatch(body: Record<string, unknown>, room: { dm?: boolean }): { avatarUrl?: string | undefined } {
  if (!Object.prototype.hasOwnProperty.call(body, "avatarUrl") || body.avatarUrl === undefined) return {};
  if (room.dm) refuse("direct-message channels cannot have a picture");
  const value = body.avatarUrl;
  if (value === null || value === "") return { avatarUrl: undefined };
  const parsed = botAvatarUrlSchema.safeParse(value);
  if (!parsed.success) refuse("picture must be a stored PNG, JPEG, GIF, or WebP attachment");
  return { avatarUrl: parsed.data };
}

/** True when the PATCH would set a picture different from the room's current one. */
export function roomPictureChanges(body: unknown, room: { avatarUrl?: string | null }): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const next = (body as Record<string, unknown>).avatarUrl;
  if (next === undefined) return false;
  return (next || null) !== (room.avatarUrl ?? null);
}
