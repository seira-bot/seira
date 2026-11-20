import { existsSync } from "node:fs";
import { join } from "node:path";

// Never installs the package itself: stock Ubuntu 24.04 hands a .deb to App Center, which may not install a local one.

/** Package types whose store updates the app: the app never checks, downloads or installs an update itself there. */
export const STORE_PACKAGE_TYPES = Object.freeze(["snap", "flatpak", "msix"]);

export function managedByStore(packageType) {
  return STORE_PACKAGE_TYPES.includes(packageType);
}

/** Electron sets process.windowsStore when the app runs from an AppX or MSIX package. */
export function windowsPackageType({ platform = process.platform, windowsStore = process.windowsStore } = {}) {
  return platform === "win32" && windowsStore === true ? "msix" : null;
}

/** A Flatpak sandbox sets FLATPAK_ID and mounts /.flatpak-info; a snap sets SNAP and runs from under that directory. */
function storePackageType({ env, exists, resourcesPath, execPath }) {
  if (env.FLATPAK_ID || exists("/.flatpak-info")) return "flatpak";
  const root = typeof env.SNAP === "string" ? env.SNAP.replace(/\/+$/, "") : "";
  if (!root) return null;
  const under = (file) => typeof file === "string" && file.startsWith(`${root}/`);
  return under(resourcesPath) || under(execPath) ? "snap" : null;
}

/** Resolved the way electron-updater resolves its installer: resources/package-type first, then the APPIMAGE env. A snap or a Flatpak is told from its sandbox, before any marker. */
export function linuxPackageType({
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  appImage = process.env.APPIMAGE,
  env = process.env,
  execPath = process.execPath,
  exists = existsSync,
  readMarker,
} = {}) {
  if (platform !== "linux") return null;
  const store = storePackageType({ env, exists, resourcesPath, execPath });
  if (store) return store;
  if (typeof resourcesPath !== "string" || resourcesPath.length === 0) {
    return appImage ? "AppImage" : null;
  }
  try {
    const declared = readMarker(join(resourcesPath, "package-type"));
    if (declared) return declared.trim() || null;
  } catch {
  }
  return appImage ? "AppImage" : null;
}

const BUILDERS = {
  // apt-get, never `dpkg -i`: only apt-get resolves dependencies, and Ubuntu satisfies ours through virtual Provides.
  deb: (file) => `sudo apt-get install -y ${file}`,
  rpm: (file) => `sudo rpm -Uvh ${file}`,
  pacman: (file) => `sudo pacman -U ${file}`,
};

export const HAND_OFF_PACKAGE_TYPES = Object.freeze(Object.keys(BUILDERS));

export function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function stagedInstallFile(files, exists = existsSync) {
  return files?.find((file) => typeof file === "string" && file.length > 0 && exists(file));
}

export function packageInstallCommand(packageType, file) {
  const build = Object.hasOwn(BUILDERS, packageType) ? BUILDERS[packageType] : undefined;
  if (!build) throw new Error(`No install command for package type ${JSON.stringify(packageType)}`);
  if (typeof file !== "string" || file.length === 0) {
    throw new Error("The downloaded package is no longer available. Try the update again.");
  }
  return build(shellQuote(file));
}
