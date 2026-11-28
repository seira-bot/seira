import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const STARTUP_TASK_ID = "SeiraStartup";

/** A program outside the package (an agent engine) may start the package's executable only through an app execution
 * alias: Windows refuses that program a start by the full path under WindowsApps. */
export const APP_EXECUTION_ALIAS = "seira-desktop.exe";

const UAP3_NAMESPACE = "http://schemas.microsoft.com/appx/manifest/uap/windows10/3";

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

function aliasExtension(executable) {
  return (
    `<uap3:Extension Category="windows.appExecutionAlias" Executable="${executable}" EntryPoint="Windows.FullTrustApplication">` +
    `<uap3:AppExecutionAlias><desktop:ExecutionAlias Alias="${APP_EXECUTION_ALIAS}" /></uap3:AppExecutionAlias>` +
    `</uap3:Extension>`
  );
}

function addExtension(xml, extension) {
  if (/<Extensions\s*\/>/.test(xml)) return xml.replace(/<Extensions\s*\/>/, `<Extensions>${extension}</Extensions>`);
  if (xml.includes("</Extensions>")) return xml.replace("</Extensions>", `${extension}</Extensions>`);
  if (xml.includes("</Application>")) return xml.replace("</Application>", `<Extensions>${extension}</Extensions></Application>`);
  throw new Error("AppxManifest.xml has no Application element");
}

export function rewriteManifest(xml, { version }) {
  const mapped = storeVersion(version);
  let out = xml.replace(/(<Identity\b[^>]*?\bVersion=")[^"]*(")/, `$1${mapped}$2`);
  if (!out.includes(`Version="${mapped}"`)) throw new Error("AppxManifest.xml has no Identity Version");

  const executable = /<Application\b[^>]*?\bExecutable="([^"]*)"/.exec(out)?.[1];
  if (!executable) throw new Error("AppxManifest.xml has no Application Executable");
  if (!/Category="windows\.startupTask"/.test(out)) out = addExtension(out, startupExtension(executable));
  if (!/Category="windows\.appExecutionAlias"/.test(out)) {
    if (!/\bxmlns:uap3=/.test(out)) out = out.replace(/<Package\b/, `<Package xmlns:uap3="${UAP3_NAMESPACE}"`);
    out = addExtension(out, aliasExtension(executable));
  }
  return out;
}

export default async function appxManifestCreated(manifestPath) {
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  writeFileSync(manifestPath, rewriteManifest(readFileSync(manifestPath, "utf8"), { version }));
}
