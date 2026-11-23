import { Check, LoaderCircle } from "lucide-react";
import { createPortal } from "react-dom";

import { t } from "@/lib/i18n";
import { cancelWait, runWaiting, usePowerToast, usePowerWait, type ToastAction } from "@/lib/power";

function Bar({ text, mark, actions, id }: { text: string; mark?: "ok" | "wait"; actions: ToastAction[]; id: string | number }) {
  return createPortal(
    <div key={id} role="status" data-power-toast="" data-quiet={actions.length === 0 ? "" : undefined} className="power-toast">
      {mark === "wait" && <span className="power-toast-mark"><LoaderCircle size={16} data-spin="" aria-hidden="true" /></span>}
      {mark === "ok" && <span className="power-toast-mark" data-ok=""><Check size={16} aria-hidden="true" /></span>}
      <span className="power-toast-text">{text}</span>
      {actions.map((action) => (
        <button key={action.label} type="button" data-quiet={action.quiet ? "" : undefined} className="power-toast-button" onClick={action.run}>{action.label}</button>
      ))}
    </div>,
    document.body,
  );
}

export function PowerToast({ working }: { working: number }) {
  const toast = usePowerToast();
  const wait = usePowerWait();
  if (wait) {
    const text = t(`power.wait.${wait.kind}.${working === 1 ? "one" : "many"}`, { count: working });
    return (
      <Bar
        id="wait"
        text={text}
        mark="wait"
        actions={[
          { label: t(wait.kind === "restart" ? "power.restartNow" : "power.shutdownNow"), run: () => runWaiting() },
          { label: t("common.cancel"), quiet: true, run: cancelWait },
        ]}
      />
    );
  }
  return toast ? <Bar id={toast.id} text={toast.text} mark={toast.ok ? "ok" : undefined} actions={toast.actions} /> : null;
}
