import { ImagePlus, Trash2 } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { MENU_ITEM } from "./menu-recipe";
import { chooseRoomPicture, roomPictureMessage, uploadRoomPicture } from "@/lib/room-picture";
import { useStoreDispatch } from "@/state/store-select";
import type { Group } from "@/state/store";

/** The room menu's picture rows. The menu closes when the file dialog takes focus, so the work runs here, not in the menu. */
export function RoomPictureMenuItems({ group, onClose }: { group: Group; onClose: () => void }) {
  const dispatch = useStoreDispatch();
  const groupId = group.id;
  const change = () => {
    const chosen = chooseRoomPicture();
    onClose();
    void chosen.then(async (file) => {
      if (!file) return;
      const result = await uploadRoomPicture(file);
      if (result.ok) dispatch({ type: "patchGroup", groupId, patch: { avatarUrl: result.avatarUrl } });
      else dispatch({ type: "error", message: roomPictureMessage(result.refusal) });
    });
  };
  const className = cn(MENU_ITEM, "text-ink hover:bg-menu-hover");
  return (
    <>
      <button role="menuitem" onClick={change} className={className}>
        <ImagePlus size={16} className="text-ink-secondary" />
        {t("roomPicture.change")}
      </button>
      {group.avatarUrl && (
        <button role="menuitem" onClick={() => { dispatch({ type: "patchGroup", groupId, patch: { avatarUrl: null } }); onClose(); }} className={className}>
          <Trash2 size={16} className="text-ink-secondary" />
          {t("roomPicture.remove")}
        </button>
      )}
    </>
  );
}
