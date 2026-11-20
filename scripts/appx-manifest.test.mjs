import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import appxManifestCreated, { rewriteManifest, storeVersion } from "./appx-manifest.mjs";

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10" xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10" xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities">
  <Identity Name="seira" Publisher="CN=ms" Version="0.1.179.0" ProcessorArchitecture="x64" />
  <Applications>
    <Application Id="Seira" Executable="Seira.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Seira" />
      EXTENSIONS
    </Application>
  </Applications>
</Package>`;

const PROTOCOL = `<Extensions><uap:Extension Category="windows.protocol"><uap:Protocol Name="seira" /></uap:Extension></Extensions>`;

function count(text, needle) {
  return text.split(needle).length - 1;
}

describe("storeVersion", () => {
  it("raises the major part and ends with zero", () => {
    expect(storeVersion("0.1.179")).toBe("1.1.179.0");
    expect(storeVersion("2.10.3")).toBe("3.10.3.0");
  });

  it.each(["0.1", "0.1.179.1", "0.1.179-beta.1", "v0.1.179", "", "0.1.x", "65535.0.0", "0.65536.0", "0.0.65536"])(
    "rejects %j and names it",
    (version) => {
      expect(() => storeVersion(version)).toThrow(new RegExp(version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    },
  );
});

describe("rewriteManifest", () => {
  it("sets the Identity version", () => {
    const out = rewriteManifest(MANIFEST.replace("EXTENSIONS", PROTOCOL), { version: "0.1.179" });
    expect(out).toContain('Publisher="CN=ms" Version="1.1.179.0"');
  });

  it("adds one start-up task that is off, inside the existing Extensions", () => {
    const out = rewriteManifest(MANIFEST.replace("EXTENSIONS", PROTOCOL), { version: "0.1.179" });
    expect(count(out, "windows.startupTask")).toBe(1);
    expect(count(out, "<Extensions>")).toBe(1);
    expect(out).toContain(
      '<desktop:Extension Category="windows.startupTask" Executable="Seira.exe" EntryPoint="Windows.FullTrustApplication"><desktop:StartupTask TaskId="SeiraStartup" Enabled="false" DisplayName="Seira" /></desktop:Extension></Extensions>',
    );
  });

  it("creates Extensions before the end of Application when it is missing", () => {
    const out = rewriteManifest(MANIFEST.replace("EXTENSIONS", ""), { version: "0.1.179" });
    expect(out).toMatch(/<Extensions><desktop:Extension Category="windows.startupTask"[\s\S]*<\/Extensions><\/Application>/);
  });

  it("gives the same output when it runs twice", () => {
    const once = rewriteManifest(MANIFEST.replace("EXTENSIONS", PROTOCOL), { version: "0.1.179" });
    expect(rewriteManifest(once, { version: "0.1.179" })).toBe(once);
  });

  it("stops on a version it cannot map", () => {
    expect(() => rewriteManifest(MANIFEST, { version: "0.1.179-rc.1" })).toThrow("0.1.179-rc.1");
  });
});

describe("appxManifestCreated", () => {
  it("rewrites the file with the version of package.json", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "seira-appx-"));
    try {
      const file = path.join(dir, "AppxManifest.xml");
      writeFileSync(file, MANIFEST.replace("EXTENSIONS", PROTOCOL));
      await appxManifestCreated(file);
      const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      expect(readFileSync(file, "utf8")).toContain(`Version="${storeVersion(version)}"`);
      expect(readFileSync(file, "utf8")).toContain("SeiraStartup");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
