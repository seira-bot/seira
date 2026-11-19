// Run by temp-folders.test.ts: makes three owned folders, hands one back to the caller and removes one through the helper,
// puts a folder of someone else at the removed path, prints the paths, then exits normally.
import { mkdirSync } from "node:fs";

const { makeOwnedTempFolder, releaseOwnedTempFolder, removeOwnedTempFolder } = await import("../temp-folders.ts");
const kept = makeOwnedTempFolder("omb-exit-check-");
const released = makeOwnedTempFolder("omb-exit-check-");
releaseOwnedTempFolder(released);
const removed = makeOwnedTempFolder("omb-exit-check-");
removeOwnedTempFolder(removed);
mkdirSync(removed);
process.stdout.write(`${JSON.stringify({ kept, released, removed })}\n`);
