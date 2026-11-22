import { t } from "@/lib/i18n";

/** The explicit step that lets an automation moved off a gone cloud computer run again (see lib/place-lost.ts). */
export function PlaceLostConfirm({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-warning/30 bg-warning/10 px-3.5 py-3 text-[12px] leading-relaxed text-ink" data-place-lost-confirm="">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{t("routines.placeLostConfirm")}</span>
    </label>
  );
}
