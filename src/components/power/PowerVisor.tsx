import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { usePowerVisor, type VisorFlag } from "@/lib/power";

const CLASS: Record<VisorFlag, string> = {
  instant: "v-instant",
  reduced: "v-reduced",
  closed: "v-closed",
  glint: "v-glint",
  eyes: "v-eyes",
  shut: "v-shut",
  wide: "v-wide",
  merge: "v-merge",
  out: "v-out",
  breathing: "v-breathing",
  text: "v-text",
  opening: "v-opening",
  leaving: "v-leaving",
};

function lines(kind: string | null, version: string): [string, string] {
  if (kind === "update") return [t("power.updating", { version }), t("power.visor.update")];
  if (kind === "shutdown") return [t("power.shuttingDown"), t("power.visor.shutdown")];
  if (kind === "restart") return [t("power.restarting"), t("power.visor.restart")];
  return ["", ""];
}

export function PowerVisor({ still = false }: { still?: boolean }) {
  const visor = usePowerVisor();
  const root = useRef<HTMLDivElement>(null);
  const on = visor.kind !== null;
  useEffect(() => {
    if (on) root.current?.focus({ preventScroll: true });
  }, [on]);
  if (!on) return null;
  const [line1, line2] = lines(visor.kind, visor.version);
  return createPortal(
    <div
      ref={root}
      data-power-visor={visor.kind}
      tabIndex={-1}
      className={cn("power-visor", still && "power-still", [...visor.flags].map((flag) => CLASS[flag]).join(" "))}
    >
      <div className="power-lid power-lid-top" />
      <div className="power-lid power-lid-bottom" />
      <div className="power-fill" />
      <div className="power-seam" />
      <svg className="power-eyes" viewBox="0 0 120 64" aria-hidden="true">
        <g>
          <g className="power-eye power-eye-l">
            <ellipse className="power-eye-white" cx="35" cy="29" rx="10" ry="11" />
            <ellipse className="power-eye-pupil" cx="36" cy="30.5" rx="5.6" ry="7" />
            <circle className="power-eye-glint" cx="32.2" cy="25" r="2.2" />
            <path className="power-eye-brow" d="M44.5 19.5 Q35 12.5 25 18 L21.5 14.8" />
          </g>
          <g className="power-eye power-eye-r">
            <ellipse className="power-eye-white" cx="85" cy="29" rx="10" ry="11" />
            <ellipse className="power-eye-pupil" cx="84" cy="30.5" rx="5.6" ry="7" />
            <circle className="power-eye-glint" cx="87.8" cy="25" r="2.2" />
            <path className="power-eye-brow" d="M75.5 19.5 Q85 12.5 95 18 L98.5 14.8" />
          </g>
          <path className="power-smile" d="M55 50 Q60 54.5 65 50" />
          <circle className="power-core" cx="60" cy="29" r="2.8" />
        </g>
      </svg>
      <div className="power-visor-text" role="status" aria-live="polite">
        <div className="power-visor-line-1">{line1}</div>
        <div className="power-visor-line-2">{line2}</div>
      </div>
    </div>,
    document.body,
  );
}
