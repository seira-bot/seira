// Reviewed vendor assets hashed on 2026-11-21: update all pins together and run each platform's packaged offline browser
// smoke test. Chromium's headless shell, not full Chrome (which includes Widevine).
import { join } from "node:path";
import {
  agentBrowserReleaseUrl,
  agentBrowserReleaseVersion,
  resolveAgentBrowserReleaseAsset,
} from "./browser-engine-release.ts";

export const CHROME_VERSION = "158.0.8127.36";
export const SUPPORTED_BROWSER_TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"] as const;
export type BrowserBundleTarget = typeof SUPPORTED_BROWSER_TARGETS[number];

const CHROME_ASSETS = {
  "darwin-arm64": { platform: "mac-arm64", bytes: 105057133, sha256: "c24d40a3786322ff3a5e3ac6eed162226cbaf07ebe468715407827226b0f8897", executableSha256: "aadfb5b2866e701a4c7ca79077250c8bc8276f8e28a64bce5f91d1bf899511b7" },
  "darwin-x64": { platform: "mac-x64", bytes: 112306247, sha256: "e0c5d07d8f5bcc5bdd5ef370e7daf3770856b585fcc9eecf441c7e3bb2e3d1cf", executableSha256: "6111c68b267b637384ce8accfc566e3b5e61473b4798dc6247c8ab573ba77e62" },
  "linux-arm64": { platform: "linux-arm64", bytes: 129938239, sha256: "176ee5c55486c22de43128871189061365ea28e881fc96016fd18e7cb59437c8", executableSha256: "be17eb55973db1e498a78bc1baec89f200cf687b3da3f58f5d9607b7f79a3192" },
  "linux-x64": { platform: "linux64", bytes: 132087165, sha256: "2d3a23017323c54fd457a678e4351f895c4076d8050e39d5aa6247f93448b73a", executableSha256: "ed65d54a43663fa60ed8a277329fe73f307c31dd5b5db8dcfe91fda4274cf963" },
  "win32-x64": { platform: "win64", bytes: 127876264, sha256: "9655950dfeddf565561cd64cfe8ee716ccd6482fa3798503b632219efc65a71e", executableSha256: "c8522395b1e3c0cb9c86308b4a963abf6a2bb49d28acddb76ca26fe8b68a3be5" },
} as const;

export function browserBundleSpec(target: string) {
  if (!Object.hasOwn(CHROME_ASSETS, target)) throw new Error(`Unsupported desktop browser target: ${target}`);
  const pinned = CHROME_ASSETS[target as BrowserBundleTarget];
  const [platform, arch] = target.split("-");
  const engine = resolveAgentBrowserReleaseAsset(platform as NodeJS.Platform, arch)!;
  const suffix = platform === "win32" ? ".exe" : "";
  const directory = `chrome-headless-shell-${pinned.platform}`;
  return {
    schemaVersion: 1,
    target,
    engine: {
      version: agentBrowserReleaseVersion(engine),
      asset: engine.asset,
      url: agentBrowserReleaseUrl(engine),
      bytes: engine.bytes,
      sha256: engine.sha256,
      executable: `agent-browser${suffix}`,
    },
    chrome: {
      version: CHROME_VERSION,
      asset: `${directory}.zip`,
      url: `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${pinned.platform}/${directory}.zip`,
      bytes: pinned.bytes,
      sha256: pinned.sha256,
      executableSha256: pinned.executableSha256,
      executable: `chrome/${directory}/chrome-headless-shell${suffix}`,
      license: `chrome/${directory}/LICENSE.headless_shell`,
      about: `chrome/${directory}/ABOUT`,
    },
  };
}

export function browserBundlePaths(bundleDirectory: string, target: string) {
  const spec = browserBundleSpec(target);
  return {
    directory: bundleDirectory,
    manifest: join(bundleDirectory, "manifest.json"),
    engine: join(bundleDirectory, spec.engine.executable),
    chrome: join(bundleDirectory, spec.chrome.executable),
    licenses: join(bundleDirectory, "licenses"),
  };
}
