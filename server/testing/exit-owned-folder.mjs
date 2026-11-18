// Run by temp-folders.test.ts: makes two owned folders, hands one back to the caller, prints both paths, then exits normally.
const { makeOwnedTempFolder, releaseOwnedTempFolder } = await import("../temp-folders.ts");
const kept = makeOwnedTempFolder("omb-exit-check-");
const released = makeOwnedTempFolder("omb-exit-check-");
releaseOwnedTempFolder(released);
process.stdout.write(`${JSON.stringify({ kept, released })}\n`);
