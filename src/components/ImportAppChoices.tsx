import { useEffect, useState } from "react";

import { preloadConnectedApps } from "@/lib/connected-apps";
import { connectedApps, type ImportApp } from "@/lib/import-apps";
import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStore } from "@/state/store";
import { Switch } from "./SettingsPrimitives";

/** Import's preview: for each app the package needs that is already connected, whether the new bots may use it. Off by default. */
export function ImportAppChoices({ apps, chosen, onChange }: {
  apps: readonly ImportApp[];
  chosen: readonly string[];
  onChange: (slugs: string[]) => void;
}) {
  const admin = useOwnerOrAdmin();
  const allowed = useStore().state.config?.managedPolicy?.apps;
  const [shown, setShown] = useState<ImportApp[]>([]);
  useEffect(() => {
    let alive = true;
    setShown([]);
    if (!apps.length || admin !== true) return;
    void preloadConnectedApps().then(({ services }) => {
      if (alive) setShown(connectedApps(apps, services).filter((app) => !allowed || allowed.allowAll || allowed.allowlist.includes(app.slug)));
    }).catch(() => {});
    return () => { alive = false; };
  }, [apps, admin, allowed]);

  if (!shown.length) return null;
  return (
    <div data-import-app-choices="" className="mt-4 flex flex-col gap-2">
      {shown.map((app) => (
        <div key={app.slug} className="flex min-h-9 items-center gap-3">
          <span dir="auto" className="min-w-0 flex-1 text-[13px] text-ink">{t("template.letBotsUse", { app: app.label })}</span>
          <Switch
            checked={chosen.includes(app.slug)}
            aria-label={t("template.letBotsUse", { app: app.label })}
            onClick={() => onChange(chosen.includes(app.slug) ? chosen.filter((slug) => slug !== app.slug) : [...chosen, app.slug])}
          />
        </div>
      ))}
    </div>
  );
}
