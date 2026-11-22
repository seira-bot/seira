import { botAvatarUrlFromStoredPath } from "../../shared/bot-avatar";
import { t } from "./i18n";
import { IMAGE_MAX_BYTES, imageAttachmentFromFile } from "./composer-attachments";

export const ROOM_PICTURE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

export type RoomPictureRefusal = "type" | "size" | "failed";
export type RoomPictureResult = { ok: true; avatarUrl: string } | { ok: false; refusal: RoomPictureRefusal };

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0) => signature.every((byte, index) => bytes[at + index] === byte);

/** The image type of a file's first bytes, or null. The name and the declared type are never read. */
export function sniffImageMime(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

export async function uploadRoomPicture(file: File): Promise<RoomPictureResult> {
  if (file.size > IMAGE_MAX_BYTES) return { ok: false, refusal: "size" };
  const mime = sniffImageMime(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
  if (!mime) return { ok: false, refusal: "type" };
  try {
    const saved = await imageAttachmentFromFile(new File([file], file.name, { type: mime }));
    const avatarUrl = saved ? botAvatarUrlFromStoredPath(saved.path) : null;
    return avatarUrl ? { ok: true, avatarUrl } : { ok: false, refusal: "failed" };
  } catch {
    return { ok: false, refusal: "failed" };
  }
}

export function roomPictureMessage(refusal: RoomPictureRefusal): string {
  return refusal === "type" ? t("roomPicture.typeRefused") : refusal === "size" ? t("roomPicture.tooBig") : t("roomPicture.failed");
}

/** Opens the file dialog from an input that lives outside the page, so a menu that closes on window blur cannot unmount it. */
export function chooseRoomPicture(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ROOM_PICTURE_ACCEPT;
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}
