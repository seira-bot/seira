// One process of server/config-write-race.test.ts: Settings saving config.json, or `seira access` adding and then removing
// addresses in it. SEIRA_DATA_DIR names the data folder. Arguments: role (settings | access), rounds, process number.
import { accessListsOf, readAccessConfig, saveAccessLists } from "../access-config.ts";
import { saveConfig } from "../config.ts";
import { accessChange } from "../people-limit.ts";

const [role, rounds, id] = process.argv.slice(2).map(String);
const dataDir = String(process.env.SEIRA_DATA_DIR);
// No free limit: the writes are the point here, not the places.
const env = { SEIRA_CLOUD_ROLE: "home" };

async function change(edit: (admins: string[]) => string[]): Promise<void> {
  const raw = readAccessConfig(dataDir);
  const before = accessListsOf(raw);
  const next = { admins: edit(before.admins), members: before.members };
  const answer = await accessChange(dataDir, before, next, env, () => {
    const saved = saveAccessLists(dataDir, before, next, "seira access");
    return typeof saved === "string" ? saved : null;
  });
  if (typeof answer === "string") throw new Error(answer);
}

if (role === "settings") {
  for (let round = 0; round < Number(rounds); round += 1) saveConfig({ language: `l${id}-${round}` });
} else {
  for (let round = 0; round < Number(rounds); round += 1) await change((admins) => [...admins, `c${round}@corp.test`]);
  for (let round = 0; round < Number(rounds); round += 2) await change((admins) => admins.filter((entry) => entry !== `c${round}@corp.test`));
}
