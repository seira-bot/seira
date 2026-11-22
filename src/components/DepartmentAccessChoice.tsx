import { t } from "@/lib/i18n";
import { openFolderDepartments } from "@/lib/department-access";
import { Select } from "./Select";

/** One person's reach: the whole team, or the departments ticked here (General is ""). */
export function DepartmentAccessChoice({ value, onChange, departments, limited, disabled = false, adminReason = false }: {
  value: string[] | null;
  onChange: (next: string[] | null) => void;
  departments: readonly string[];
  limited: ReadonlySet<string>;
  disabled?: boolean;
  /** The person is an admin, who always sees the whole team. */
  adminReason?: boolean;
}) {
  const names = ["", ...departments];
  const toggle = (name: string) => onChange(value?.includes(name) ? value.filter((item) => item !== name) : [...(value ?? []), name]);
  const open = value ? openFolderDepartments(value, limited) : [];
  return (
    <div data-department-access className="flex flex-col gap-2">
      <Select
        value={value && !adminReason ? "chosen" : "whole"}
        onChange={(event) => onChange(event.target.value === "chosen" ? value ?? [] : null)}
        aria-label={t("people.access.label")}
        disabled={disabled || adminReason}
      >
        <option value="whole">{t("people.access.whole")}</option>
        <option value="chosen">{t("people.access.chosen")}</option>
      </Select>
      {adminReason && <p className="text-[12px] text-ink-secondary">{t("people.access.adminReason")}</p>}
      {value && !adminReason && (
        <fieldset disabled={disabled} className="flex flex-wrap gap-x-4 gap-y-1">
          <legend className="sr-only">{t("people.access.chosen")}</legend>
          {names.map((name) => (
            <label key={name || "general"} className="flex items-center gap-2 text-[13px] text-ink">
              <input type="checkbox" checked={value.includes(name)} onChange={() => toggle(name)} />
              {name || t("settings.section.general")}
            </label>
          ))}
        </fieldset>
      )}
      {value?.includes("") && !adminReason && <p role="note" className="text-[12px] leading-relaxed text-warning">{t("people.access.generalWarning")}</p>}
      {open.map((name) => (
        <p key={name || "general"} role="note" className="text-[12px] leading-relaxed text-warning">
          {t("people.access.folderWarning", { department: name || t("settings.section.general") })}
        </p>
      ))}
    </div>
  );
}
