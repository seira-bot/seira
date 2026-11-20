import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkAssets, checkManifest } from "./check-appx.mjs";

const GOOD = `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">
  <Identity Name="seira"
    ProcessorArchitecture="x64"
    Publisher='CN=ms'
    Version="1.1.179.0" />
  <Properties>
    <DisplayName>Seira</DisplayName>
    <PublisherDisplayName>PT GLOBAL RAYA ORIS WIJAYA</PublisherDisplayName>
  </Properties>
  <Applications>
    <Application Id="Seira" Executable="Seira.exe" EntryPoint="Windows.FullTrustApplication">
      <Extensions>
        <uap:Extension Category="windows.protocol"><uap:Protocol Name="seira"><uap:DisplayName>Seira package install</uap:DisplayName></uap:Protocol></uap:Extension>
        <desktop:Extension Category="windows.startupTask" Executable="Seira.exe" EntryPoint="Windows.FullTrustApplication"><desktop:StartupTask TaskId="SeiraStartup" Enabled="false" DisplayName="Seira" /></desktop:Extension>
      </Extensions>
    </Application>
  </Applications>
  <Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities>
</Package>`;

const check = (xml) => checkManifest(xml, { version: "0.1.179" });

describe("checkManifest", () => {
  it("accepts the manifest and reports the identity", () => {
    expect(check(GOOD)).toEqual({ errors: [], identity: { name: "seira", publisher: "CN=ms" } });
  });

  it.each([
    ["the display name", GOOD.replace("<DisplayName>Seira</DisplayName>", "<DisplayName>Other</DisplayName>"), "DisplayName Seira"],
    ["the publisher name", GOOD.replace("PT GLOBAL RAYA ORIS WIJAYA", "Someone"), "PublisherDisplayName"],
    ["the version", GOOD.replace('Version="1.1.179.0"', 'Version="0.1.179.0"'), "Identity Version is 0.1.179.0, not 1.1.179.0"],
    ["the protocol", GOOD.replace('Protocol Name="seira"', 'Protocol Name="other"'), "windows.protocol"],
    ["the full trust capability", GOOD.replace('Name="runFullTrust"', 'Name="internetClient"'), "runFullTrust"],
    ["the start-up task", GOOD.replace('TaskId="SeiraStartup"', 'TaskId="Other"'), "startup task SeiraStartup"],
    ["the start-up task being off", GOOD.replace('Enabled="false"', 'Enabled="true"'), "not off by default"],
  ])("rejects a manifest without %s", (_name, xml, message) => {
    expect(check(xml).errors.join("\n")).toContain(message);
  });
});

describe("checkAssets", () => {
  const directories = [];
  afterEach(() => directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  function fixture(packaged) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "seira-check-appx-"));
    directories.push(dir);
    const source = path.join(dir, "source");
    const pack = path.join(dir, "package");
    mkdirSync(source);
    mkdirSync(path.join(pack, "assets"), { recursive: true });
    writeFileSync(path.join(source, "StoreLogo.scale-100.png"), "one");
    writeFileSync(path.join(source, "StoreLogo.scale-200.png"), "two");
    for (const [name, content] of Object.entries(packaged)) writeFileSync(path.join(pack, "assets", name), content);
    return { pack, source };
  }

  it("accepts identical files", () => {
    const { pack, source } = fixture({ "StoreLogo.scale-100.png": "one", "StoreLogo.scale-200.png": "two" });
    expect(checkAssets(pack, source)).toEqual([]);
  });

  it("rejects a missing file, a changed file, and a sample logo", () => {
    const { pack, source } = fixture({ "StoreLogo.scale-100.png": "other", "SampleAppx.150x150.png": "x" });
    expect(checkAssets(pack, source)).toEqual([
      "assets/StoreLogo.scale-100.png differs from build/appx/StoreLogo.scale-100.png",
      "assets/StoreLogo.scale-200.png is not in the package",
      "the package holds a sample logo: assets/SampleAppx.150x150.png",
    ]);
  });
});
