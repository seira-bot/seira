// The spotlight of the place card (app_settings show_place). The card asks for it in the store, and this host in App draws
// it. The card cannot own it: the actions that open a page (Board, Files, Automations, Workflows) replace the chat page,
// and the card unmounts with it. The host stays mounted over that change, so the spotlight is there when the page is.
import { useEffect } from "react";

import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { findPlaceAnchor, placeSteps, uiPlaceById } from "@/lib/ui-place-open";
import { useStore } from "@/state/store";
import { Spotlight } from "./onboarding/Spotlight";

/** The page or panel takes a moment to draw after the action; the host looks for the control this long, then gives up. */
export const PLACE_LOOK_MS = 1500;
export const PLACE_LOOK_EVERY_MS = 50;

export function PlaceLookHost() {
  const { state, dispatch } = useStore();
  const advanced = useAdvancedMode();
  const look = state.placeLook;
  const place = uiPlaceById(look?.id);
  const nonce = look?.nonce;
  const looking = look?.phase === "looking";

  useEffect(() => {
    if (!looking || !place || nonce === undefined) return;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const find = () => {
      const anchor = findPlaceAnchor(place);
      if (anchor) dispatch({ type: "placeLookResult", nonce, phase: "spot", anchor });
      else if (Date.now() - started >= PLACE_LOOK_MS) dispatch({ type: "placeLookResult", nonce, phase: "missing" });
      else timer = setTimeout(find, PLACE_LOOK_EVERY_MS);
    };
    timer = setTimeout(find, 0);
    return () => clearTimeout(timer);
  }, [looking, place, nonce, dispatch]);

  if (!look || !place) return null;
  const close = () => dispatch({ type: "closePlaceLook" });
  const steps = <ol className="mt-1 list-decimal pl-5 text-[13px]">{placeSteps(place, advanced).map((step) => <li key={step} dir="auto">{step}</li>)}</ol>;
  if (look.phase === "spot" && look.anchor) {
    return (
      <Spotlight anchor={look.anchor.value} attr={look.anchor.attr} placement="below" primary={{ label: t("chat.placeCard.gotIt"), onClick: close }} onDone={close}>
        <span data-ui-place-hint>{t("chat.placeCard.hint")}</span>
        {steps}
      </Spotlight>
    );
  }
  // On the chat page the card itself says the control is not there. On another page the card is gone, so this says it.
  if (look.phase === "missing" && state.activeView !== "chat") {
    return (
      <Spotlight anchor={null} placement="below" primary={{ label: t("chat.placeCard.gotIt"), onClick: close }} onDone={close}>
        <span data-ui-place-lost>{t("chat.placeCard.notHere")}</span>
        {steps}
      </Spotlight>
    );
  }
  return null;
}
