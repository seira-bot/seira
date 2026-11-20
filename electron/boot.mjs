// The app name decides the settings folder and the saved-key store item, so it is chosen here, before main.mjs or any
// module it imports asks Electron for the settings folder.
import { app, safeStorage } from "electron";

import { LEGACY_APP_NAME } from "./legacy-names.mjs";
import { OLD_KEY_READER, runOldKeyReader } from "./old-key.mjs";
import { chooseSettingsFolder } from "./settings-folder.mjs";

if (process.argv.some(entry => entry.startsWith(`${OLD_KEY_READER}=`))) {
  runOldKeyReader({ app, safeStorage });
} else {
  const choice = chooseSettingsFolder({ appData: app.getPath("appData"), name: app.getName(), log: line => console.warn(`[desktop] ${line}`) });
  if (choice.name === LEGACY_APP_NAME) app.setName(LEGACY_APP_NAME);
  await import("./main.mjs");
}
