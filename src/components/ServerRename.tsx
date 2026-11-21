import { useState } from "react";
import { t } from "@/lib/i18n";
import { SETTINGS_INPUT } from "./SettingsPrimitives";

export type RenameOutcome = "saved" | "name" | "taken" | "gone" | "failed";

/** Rename under a saved server's row in Settings: its name in a field, saved on Enter or Save; Escape or Cancel leaves it as it was. */
export function ServerRename({ id, name, onRename, onDone }: { id: string; name: string; onRename: (id: string, name: string) => Promise<RenameOutcome>; onDone: () => void }) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<"name" | "taken" | "failed" | null>(null);
  const save = () => {
    const next = value.trim();
    if (!next || busy) return;
    if (next === name) { onDone(); return; }
    setBusy(true); setSaid(null);
    void onRename(id, next).then((outcome) => {
      setBusy(false);
      if (outcome === "saved") { onDone(); return; }
      setSaid(outcome === "taken" || outcome === "name" ? outcome : "failed");
    });
  };
  return <form data-server-rename-form className="mt-2 flex flex-col gap-1.5" onSubmit={(event) => { event.preventDefault(); save(); }}>
    <input autoFocus value={value} maxLength={60} disabled={busy} aria-label={t("servers.renameName", { name })} aria-invalid={said ? true : undefined}
      onChange={(event) => { setValue(event.target.value); setSaid(null); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onDone(); } }}
      className={SETTINGS_INPUT} />
    {said && <p role="alert" className="text-[12px] text-danger">{t(said === "taken" ? "rail.localTaken" : said === "name" ? "rail.renameName" : "rail.localFailed")}</p>}
    <div className="flex gap-2">
      <button type="submit" data-server-rename-save className="ui-button ui-button-primary" disabled={busy || !value.trim()}>{t("rail.renameSave")}</button>
      <button type="button" className="ui-button" disabled={busy} onClick={onDone}>{t("common.cancel")}</button>
    </div>
  </form>;
}
