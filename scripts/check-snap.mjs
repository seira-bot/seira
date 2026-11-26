// Checks a built .snap before it goes to the Snap Store: the name, the Chromium sandbox switches, and the setuid files.
//   node scripts/check-snap.mjs release/Seira-<version>-amd64.snap
// It reads the snap with unsquashfs and changes nothing.
import { readSnapFiles, assertSandboxOn, setuidEntries, SNAP_NAME } from "./finish-snap.mjs";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const snap = process.argv[2];
if (!snap || !existsSync(snap)) {
  console.error("usage: node scripts/check-snap.mjs <file.snap>");
  process.exit(2);
}

const files = readSnapFiles(snap, ["command.sh", "meta/snap.yaml"]);
if (!new RegExp(`^name: ${SNAP_NAME}$`, "m").test(files["meta/snap.yaml"])) throw new Error(`snap.yaml does not name the snap ${SNAP_NAME}`);
if (!/^confinement: classic$/m.test(files["meta/snap.yaml"])) throw new Error("snap.yaml does not say confinement: classic");
assertSandboxOn(files);
const listing = spawnSync("unsquashfs", ["-ll", snap], { encoding: "utf8" });
if (listing.error || listing.status !== 0) throw new Error(`unsquashfs failed: ${listing.error?.message ?? listing.stderr}`);
const setuid = setuidEntries(listing.stdout);
if (setuid.length > 0) throw new Error(`The snap ships setuid files: ${setuid.join(", ")}`);
console.log(`OK ${snap}: named ${SNAP_NAME}, classic, sandbox on, no setuid file.`);
