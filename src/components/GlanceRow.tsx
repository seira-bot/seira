import { useEffect, useState } from "react";

import { t } from "@/lib/i18n";
import { SettingRow, Switch } from "./SettingsPrimitives";

/** Settings' switch for Glance, this desktop's choice; the View menu and the tray change it too, and the row follows. */
export function GlanceRow() {
  const bridge = typeof window === "undefined" ? undefined : window.ogb?.glance;
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    if (!bridge?.state) return;
    let alive = true;
    void bridge.state().then((next) => { if (alive) setOn(next.on); }).catch(() => {});
    const stop = bridge.onChange?.((next) => { if (alive) setOn(next.on); });
    return () => { alive = false; stop?.(); };
  }, [bridge]);
  const save = bridge?.set;
  if (!save || on === null) return null;
  const toggle = () => void save(!on).then((next) => setOn(next.on)).catch(() => {});
  return <SettingRow title={t("settings.glanceSwitch.title")} subtitle={t("settings.glanceSwitch.subtitle")}>
    <Switch checked={on} aria-label={t("settings.glanceSwitch.title")} onClick={toggle} />
  </SettingRow>;
}
