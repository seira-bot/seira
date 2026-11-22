import { useRef, useState } from "react";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";

import { t } from "@/lib/i18n";
import { ROOM_PICTURE_ACCEPT, roomPictureMessage, uploadRoomPicture } from "@/lib/room-picture";
import { useStore, type Group } from "@/state/store";

const BUTTON = "flex items-center gap-1.5 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50";

/** Change and remove for a room's picture, under the room panel's hero. */
export function RoomPictureControls({ group, align = "center" }: { group: Group; align?: "center" | "start" }) {
  const { dispatch } = useStore();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  if (group.dm) return null;

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError("");
    const result = await uploadRoomPicture(file);
    if (result.ok) dispatch({ type: "patchGroup", groupId: group.id, patch: { avatarUrl: result.avatarUrl } });
    else setError(roomPictureMessage(result.refusal));
    setUploading(false);
    if (input.current) input.current.value = "";
  };

  return (
    <div data-room-picture-controls="" className={align === "center" ? "mt-3 flex flex-col items-center gap-1.5" : "mt-3 flex flex-col items-start gap-1.5"}>
      <div className="flex gap-2">
        <input ref={input} type="file" accept={ROOM_PICTURE_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(event) => void choose(event.target.files?.[0])} />
        <button type="button" data-room-picture-change="" disabled={uploading} onClick={() => input.current?.click()} className={BUTTON}>
          {uploading ? <Loader2 size={14} aria-hidden="true" className="animate-spin" /> : <ImagePlus size={14} aria-hidden="true" />}
          {t("roomPicture.change")}
        </button>
        {group.avatarUrl && (
          <button type="button" data-room-picture-remove="" disabled={uploading} onClick={() => dispatch({ type: "patchGroup", groupId: group.id, patch: { avatarUrl: null } })} className={BUTTON}>
            <Trash2 size={14} aria-hidden="true" />
            {t("roomPicture.remove")}
          </button>
        )}
      </div>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </div>
  );
}
