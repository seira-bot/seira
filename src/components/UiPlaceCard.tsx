// A place of the app in the conversation (app_settings show_place). The row holds a place id and the map's own fixed text.
// The label and the clicks come from the UI map by id, never from the row text. The person clicks the button, and the app
// then puts the spotlight on the control; the app never clicks the control, and the bot never hears what the person does.
import { MapPin } from "lucide-react";
import { useCallback } from "react";

import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { openActions, placeMode, placeSteps, uiPlaceById } from "@/lib/ui-place-open";
import type { LocaleKey } from "@/locales";
import { useStore, type Message } from "@/state/store";
import { ASK_PRIMARY_BUTTON } from "./AskCard";

// The spotlight itself lives in PlaceLookHost (App): the page change this button asks for unmounts the card.
export function UiPlaceCard({ message }: { message: Message }) {
  const place = uiPlaceById(message.uiPlace?.id);
  const { state, dispatch } = useStore();
  const advanced = useAdvancedMode();
  const phase = place && state.placeLook?.id === place.id ? state.placeLook.phase : "idle";

  const open = useCallback(() => {
    if (!place) return;
    for (const action of openActions(place)) dispatch(action);
    dispatch({ type: "lookForPlace", id: place.id });
  }, [place, dispatch]);

  // A client that does not know the id (an older map) shows the row's fixed text.
  if (!place) return <p dir="auto" className="max-w-[600px] text-[15px] leading-relaxed text-ink">{message.text}</p>;

  const mode = placeMode(place, advanced);
  const label = place.labelKey ? t(place.labelKey as LocaleKey) : place.label;
  const steps = placeSteps(place, advanced);
  const showSteps = !mode.button || phase === "missing";
  return (
    <div data-ui-place-card={place.id} role="group" aria-label={t("chat.placeCard.aria", { label })} className="flex w-full max-w-[600px] flex-col gap-2 rounded-2xl border border-hairline/50 bg-panel p-3.5 text-[15px] leading-relaxed text-ink">
      <p dir="auto" className="flex items-center gap-1.5 font-medium"><MapPin aria-hidden="true" size={15} className="shrink-0 text-ink-secondary" /><bdi>{label}</bdi></p>
      <p dir="auto" data-ui-place-position className="text-[13px] text-ink-secondary">{place.position}</p>
      {!mode.button && <p dir="auto" data-ui-place-mode className="text-[13px] text-ink-secondary">{t("chat.placeCard.advancedOnly")}</p>}
      {phase === "missing" && <p dir="auto" role="status" data-ui-place-missing className="text-[13px] text-ink-secondary">{t("chat.placeCard.notHere")}</p>}
      {showSteps && <ol data-ui-place-steps className="list-decimal pl-5 text-[13px] text-ink">{steps.map((step) => <li key={step} dir="auto">{step}</li>)}</ol>}
      {mode.button && <div><button type="button" data-ui-place-open onClick={open} disabled={phase === "looking"} className={ASK_PRIMARY_BUTTON}>{t("chat.placeCard.open")}</button></div>}
    </div>
  );
}
