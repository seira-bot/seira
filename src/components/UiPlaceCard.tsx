// A place of the app in the conversation (app_settings show_place). The row holds a place id and the map's own fixed text.
// The label and the clicks come from the UI map by id, never from the row text. The person clicks the button, and the app
// then puts the spotlight on the control; the app never clicks the control, and the bot never hears what the person does.
import { MapPin } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { findPlaceAnchor, openActions, placeMode, placeSteps, uiPlaceById, type PlaceAnchor } from "@/lib/ui-place-open";
import type { LocaleKey } from "@/locales";
import { useStore, type Message } from "@/state/store";
import { ASK_PRIMARY_BUTTON } from "./AskCard";
import { Spotlight } from "./onboarding/Spotlight";

/** The page or panel takes a moment to draw after the action; the card looks for the control this long, then gives up. */
const LOOK_MS = 1500;
const LOOK_EVERY_MS = 50;

type Phase = { name: "idle" } | { name: "looking" } | { name: "spot"; anchor: PlaceAnchor } | { name: "missing" };

export function UiPlaceCard({ message }: { message: Message }) {
  const place = uiPlaceById(message.uiPlace?.id);
  const { dispatch } = useStore();
  const advanced = useAdvancedMode();
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const open = useCallback(() => {
    if (!place) return;
    clearTimeout(timer.current);
    setPhase({ name: "looking" });
    for (const action of openActions(place)) dispatch(action);
    const started = Date.now();
    const look = () => {
      const anchor = findPlaceAnchor(place);
      if (anchor) setPhase({ name: "spot", anchor });
      else if (Date.now() - started >= LOOK_MS) setPhase({ name: "missing" });
      else timer.current = setTimeout(look, LOOK_EVERY_MS);
    };
    timer.current = setTimeout(look, 0);
  }, [place, dispatch]);

  // A client that does not know the id (an older map) shows the row's fixed text.
  if (!place) return <p dir="auto" className="max-w-[600px] text-[15px] leading-relaxed text-ink">{message.text}</p>;

  const mode = placeMode(place, advanced);
  const label = place.labelKey ? t(place.labelKey as LocaleKey) : place.label;
  const steps = placeSteps(place, advanced);
  const showSteps = !mode.button || phase.name === "missing";
  return (
    <div data-ui-place-card={place.id} role="group" aria-label={t("chat.placeCard.aria", { label })} className="flex w-full max-w-[600px] flex-col gap-2 rounded-2xl border border-hairline/50 bg-panel p-3.5 text-[15px] leading-relaxed text-ink">
      <p dir="auto" className="flex items-center gap-1.5 font-medium"><MapPin aria-hidden="true" size={15} className="shrink-0 text-ink-secondary" /><bdi>{label}</bdi></p>
      <p dir="auto" data-ui-place-position className="text-[13px] text-ink-secondary">{place.position}</p>
      {!mode.button && <p dir="auto" data-ui-place-mode className="text-[13px] text-ink-secondary">{t("chat.placeCard.advancedOnly")}</p>}
      {phase.name === "missing" && <p dir="auto" role="status" data-ui-place-missing className="text-[13px] text-ink-secondary">{t("chat.placeCard.notHere")}</p>}
      {showSteps && <ol data-ui-place-steps className="list-decimal pl-5 text-[13px] text-ink">{steps.map((step) => <li key={step} dir="auto">{step}</li>)}</ol>}
      {mode.button && <div><button type="button" data-ui-place-open onClick={open} disabled={phase.name === "looking"} className={ASK_PRIMARY_BUTTON}>{t("chat.placeCard.open")}</button></div>}
      {phase.name === "spot" && (
        <Spotlight anchor={phase.anchor.value} attr={phase.anchor.attr} placement="below" primary={{ label: t("chat.placeCard.gotIt"), onClick: () => setPhase({ name: "idle" }) }} onDone={() => setPhase({ name: "idle" })}>
          <span data-ui-place-hint>{t("chat.placeCard.hint")}</span>
          <ol className="mt-1 list-decimal pl-5 text-[13px]">{steps.map((step) => <li key={step} dir="auto">{step}</li>)}</ol>
        </Spotlight>
      )}
    </div>
  );
}
