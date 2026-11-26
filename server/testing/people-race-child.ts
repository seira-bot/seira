// One process of server/people-limit-race.test.ts. It stands for the server (an address signs in through an @domain entry)
// or for `seira access add`, and it tries to take the same place as the other processes at the same moment, round after round.
// Arguments: base folder, role (admit | access), id, first start (epoch ms), rounds, gap between rounds (ms).
// Output: one JSON line, the answer of each round.
import { join } from "node:path";

import { accessChange, createPeopleLimit } from "../people-limit.ts";

const [base, role, id, firstStart, rounds, gap] = process.argv.slice(2);
const lists = { admins: ["@corp.test"], members: [] };
const answers: string[] = [];

for (let round = 0; round < Number(rounds); round += 1) {
  const dataDir = join(String(base), `round-${round}`);
  const start = Number(firstStart) + round * Number(gap);
  // The same instant for every process, so their checks and writes overlap: the sleep is coarse, the spin is exact.
  const wait = start - Date.now() - 5;
  if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  while (Date.now() < start) { /* spin */ }
  if (role === "admit") {
    const people = createPeopleLimit({ dataDir, env: {}, lists: () => lists, sessions: () => [], revoke() {}, applies: true, enterpriseUnlimited: () => false });
    answers.push(people.admit(`web${id}@corp.test`) ?? "in");
  } else {
    const change = await accessChange(dataDir, lists, { admins: [...lists.admins, `cli${id}@corp.test`], members: [] }, {}, () => null);
    answers.push(typeof change === "string" ? "full" : "in");
  }
}
process.stdout.write(`${JSON.stringify(answers)}\n`);
