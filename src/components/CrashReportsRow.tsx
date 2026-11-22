import { useState } from "react";
import { crashReportsBridge } from "@/lib/crash-reports";
import { t } from "@/lib/i18n";
import { SettingRow, Switch } from "./SettingsPrimitives";

const CRASH_REPORTS_DOC_URL = "https://github.com/seira-bot/seira/blob/main/docs/crash-reports.md";

/** The switch for crash reports. Where the window cannot send a report (a browser tab, a build without the service), the row is not there. */
export function CrashReportsRow() {
  const bridge = crashReportsBridge();
  const [on, setOn] = useState(() => bridge?.enabled() === true);
  if (!bridge) return null;
  const subtitle = (
    <>
      {t("settings.crashReports.subtitle")}{" "}
      <a href={CRASH_REPORTS_DOC_URL} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
        {t("settings.crashReports.link")}
      </a>
    </>
  );
  return (
    <SettingRow title={t("settings.crashReports.title")} subtitle={subtitle}>
      <Switch
        checked={on}
        aria-label={t("settings.crashReports.aria")}
        onClick={() => {
          const next = !on;
          setOn(next);
          void Promise.resolve(bridge.set(next)).catch(() => setOn(!next));
        }}
      />
    </SettingRow>
  );
}
