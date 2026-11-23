import { Pause, Play, Power, RotateCw } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";

import { productName } from "@/lib/brand";
import { t } from "@/lib/i18n";
import { HOLD_MS, type PowerKind, type PowerUpdate } from "@/lib/power";

export type PillAction = "shutdown" | "restart" | "pause";

export interface PillPlace {
  top: number;
  left: number;
  rtl: boolean;
}

const manyBots = (key: "power.status.stillWorking" | "power.after", count: number) =>
  count === 1 ? t(`${key}.one`) : t(`${key}.many`, { count });

function actionLabel(kind: PillAction, update: PowerUpdate | null, paused: boolean): [string, string] {
  if (kind === "shutdown") return [t("power.shutdown"), t("power.holdNote")];
  if (kind === "restart") {
    return update ? [t("power.restartToUpdate"), t("power.holdNoteVersion", { version: update.version })] : [t("power.restart"), t("power.holdNote")];
  }
  return paused ? [t("pause.resumeAll"), t("power.resumeNote")] : [t("pause.pauseAll"), t("power.pauseNote")];
}

export function PowerPill({ open, place, actions, update, working, paused, waiting, onComplete, onPause }: {
  open: boolean;
  place: PillPlace;
  actions: readonly PillAction[];
  update: PowerUpdate | null;
  working: number;
  paused: boolean;
  waiting: PowerKind | null;
  onComplete: (kind: PowerKind) => void;
  onPause: () => void;
}) {
  const [holding, setHolding] = useState<PowerKind | null>(null);
  const [done, setDone] = useState<PowerKind | null>(null);
  const [pointed, setPointed] = useState<PillAction | null>(null);
  const [focused, setFocused] = useState<PillAction | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const items = useRef(new Map<PillAction, HTMLButtonElement>());

  useEffect(() => {
    items.current.get("restart")?.focus({ preventScroll: true });
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const cancelHold = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(null);
  };
  const startHold = (kind: PowerKind) => {
    if (timer.current || done) return;
    setHolding(kind);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(null);
      setDone(kind);
      onComplete(kind);
    }, HOLD_MS);
  };

  const app = productName();
  const status = (): [string, string] => {
    if (waiting) return [t(waiting === "restart" ? "power.status.restartWaiting" : "power.status.shutdownWaiting"), manyBots("power.status.stillWorking", working)];
    if (update) return [t("power.status.on", { app }), t("power.status.update", { version: update.version })];
    if (paused) return [t("power.status.on", { app }), t("power.status.paused")];
    return [t("power.status.on", { app }), working > 0 ? (working === 1 ? t("power.status.working.one") : t("power.status.working.many", { count: working })) : t("power.status.none")];
  };
  const label = (): [string, string] => {
    if (done) {
      const note = working > 0 ? manyBots("power.after", working) : undefined;
      return done === "restart"
        ? [update ? t("power.updating", { version: update.version }) : t("power.restarting"), note ?? t("power.backSoon")]
        : [t("power.shuttingDown"), note ?? t("power.stopping")];
    }
    if (holding) return [actionLabel(holding, update, paused)[0], t("power.keepHolding")];
    const kind = pointed ?? focused;
    return kind ? actionLabel(kind, update, paused) : status();
  };
  const [line1, line2] = label();

  const move = (event: KeyboardEvent<HTMLElement>) => {
    const buttons = actions.map((kind) => items.current.get(kind)).filter((button): button is HTMLButtonElement => Boolean(button));
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const forward = place.rtl ? "ArrowLeft" : "ArrowRight";
    const back = place.rtl ? "ArrowRight" : "ArrowLeft";
    let next: number | null = null;
    if (event.key === forward || event.key === "ArrowDown") next = (at + 1) % buttons.length;
    else if (event.key === back || event.key === "ArrowUp") next = (Math.max(at, 0) + buttons.length - 1) % buttons.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    if (next === null) return;
    event.preventDefault();
    buttons[next]?.focus();
  };

  const holdKeys = (kind: PowerKind) => ({
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button > 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      startHold(kind);
    },
    onPointerUp: cancelHold,
    onPointerCancel: cancelHold,
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      if (!event.repeat) startHold(kind);
    },
    onKeyUp: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      cancelHold();
    },
    onClick: (event: { preventDefault: () => void }) => event.preventDefault(),
  });

  const style: CSSProperties = { top: place.top, ...(place.rtl ? { right: place.left } : { left: place.left }) };
  Object.assign(style, { "--power-open": `${188 + 40 * actions.length}px` });

  return createPortal(
    <div
      data-power-pill=""
      data-open={open}
      role="menu"
      aria-label={t("power.menu")}
      aria-orientation="horizontal"
      tabIndex={-1}
      style={style}
      className="power-pill"
      onKeyDown={move}
      onPointerLeave={() => setPointed(null)}
    >
      {actions.map((kind, slot) => {
        const [name] = actionLabel(kind, update, paused);
        const state = done === kind ? "done" : holding === kind ? "holding" : undefined;
        return (
          <button
            key={kind}
            ref={(button) => {
              if (button) items.current.set(kind, button);
              else items.current.delete(kind);
            }}
            type="button"
            role="menuitem"
            data-power-action={kind}
            data-slot={slot}
            data-state={state}
            data-paused={kind === "pause" ? paused : undefined}
            aria-label={name}
            aria-describedby={kind === "pause" ? undefined : "power-hold-note"}
            style={{ "--i": slot } as CSSProperties}
            className="power-action"
            onPointerEnter={() => setPointed(kind)}
            onFocus={(event) => {
              let visible = false;
              try {
                visible = event.currentTarget.matches(":focus-visible");
              } catch {
                visible = false;
              }
              if (visible) setFocused(kind);
            }}
            onBlur={() => {
              setFocused(null);
              if (kind !== "pause") cancelHold();
            }}
            {...(kind === "pause" ? { onClick: onPause } : holdKeys(kind))}
          >
            {kind === "shutdown" && <svg className="power-ring" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="19" /></svg>}
            {kind === "restart" && <svg className="power-ring" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="19" /></svg>}
            {kind === "shutdown" && <Power aria-hidden="true" />}
            {kind === "restart" && <RotateCw aria-hidden="true" />}
            {kind === "restart" && update && <span className="power-dot" aria-hidden="true" />}
            {kind === "pause" && <><Pause className="power-pause" aria-hidden="true" /><Play className="power-play" aria-hidden="true" /></>}
          </button>
        );
      })}
      <span id="power-hold-note" hidden>{t("power.holdNote")}</span>
      <div className="power-label" aria-hidden="true">
        <div key={`${line1}|${line2}`} className="power-label-swap">
          <div className="power-label-1">{line1}</div>
          <div className="power-label-2">{line2}</div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
