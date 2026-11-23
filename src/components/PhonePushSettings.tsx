import { phonePushEnabled } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import { productName } from "@/lib/brand";
import { useStore } from "@/state/store";
import { useConfigSave } from "./BrowserSettingsRows";
import { MoreText, SettingRow, SettingsGroup, SettingsRows, Switch } from "./SettingsPrimitives";

/** features.phonePush. Shown only where the server reports the flag: a server with no push relay leaves it out. */
export function PhonePushSettings() {
  const { state } = useStore();
  const on = phonePushEnabled(state.config);
  const { saving, error, save } = useConfigSave();
  if (state.config?.features?.phonePush === undefined) return null;

  return (
    <SettingsGroup block="phone-push">
      <SettingsRows>
        <div data-testid="phone-push-settings" className="contents">
          <SettingRow title={t("phone.push.title")}
            subtitle={<MoreText short={t("phone.push.short")} long={t("phone.push.detail", { app: productName() })} />}
            message={error ? <span role="alert" className="text-danger">{error}</span> : undefined}>
            <Switch
              checked={on}
              aria-label={t("phone.push.title")}
              disabled={saving}
              onClick={() => void save({ features: { phonePush: !on } })}
              className="disabled:cursor-wait disabled:opacity-50"
            />
          </SettingRow>
        </div>
      </SettingsRows>
    </SettingsGroup>
  );
}
