import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const STARTUP_TASK_ID = "SeiraStartup";

const PART_MAX = 65535;

export function storeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!match) throw new Error(`Cannot map version "${version}" to a Store version: expected <major>.<minor>.<patch>`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major + 1 > PART_MAX || minor > PART_MAX || patch > PART_MAX) {
    throw new Error(`Cannot map version "${version}" to a Store version: a part is over ${PART_MAX}`);
  }
  return `${major + 1}.${minor}.${patch}.0`;
}

function startupExtension(executable) {
  return (
    `<desktop:Extension Category="windows.startupTask" Executable="${executable}" EntryPoint="Windows.FullTrustApplication">` +
    `<desktop:StartupTask TaskId="${STARTUP_TASK_ID}" Enabled="false" DisplayName="Seira" />` +
    `</desktop:Extension>`
  );
}

export function rewriteManifest(xml, { version }) {
  const mapped = storeVersion(version);
  let out = xml.replace(/(<Identity\b[^>]*?\bVersion=")[^"]*(")/, `$1${mapped}$2`);
  if (!out.includes(`Version="${mapped}"`)) throw new Error("AppxManifest.xml has no Identity Version");
  if (/Category="windows\.startupTask"/.test(out)) return out;

  const executable = /<Application\b[^>]*?\bExecutable="([^"]*)"/.exec(out)?.[1];
  if (!executable) throw new Error("AppxManifest.xml has no Application Executable");
  const extension = startupExtension(executable);

  if (/<Extensions\s*\/>/.test(out)) out = out.replace(/<Extensions\s*\/>/, `<Extensions>${extension}</Extensions>`);
  else if (out.includes("</Extensions>")) out = out.replace("</Extensions>", `${extension}</Extensions>`);
  else if (out.includes("</Application>")) out = out.replace("</Application>", `<Extensions>${extension}</Extensions></Application>`);
  else throw new Error("AppxManifest.xml has no Application element");
  return out;
}

export default async function appxManifestCreated(manifestPath) {
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  writeFileSync(manifestPath, rewriteManifest(readFileSync(manifestPath, "utf8"), { version }));
}
