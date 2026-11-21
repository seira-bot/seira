import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { compareSources, lockIntegrities, sourceHashes } from "./check-flatpak-sources.mjs";

const hex = (byte) => Buffer.alloc(64, byte).toString("hex");
const b64 = (byte) => Buffer.alloc(64, byte).toString("base64");

const lock = [
  "lockfileVersion: '9.0'",
  "",
  "importers:",
  "  .:",
  "    dependencies:",
  "      next:",
  `        integrity: sha512-${b64(9)}`,
  "",
  "packages:",
  "",
  "  next@16.4.6:",
  `    resolution: {integrity: sha512-${b64(1)}}`,
  "",
  "  '@scope/pkg@1.0.0':",
  `    resolution: {integrity: sha512-${b64(2)}}`,
  "",
  "snapshots:",
  "",
  "  next@16.4.6:",
  `    resolution: {integrity: sha512-${b64(8)}}`,
  "",
].join("\n");

const source = (byte, url) => ({ type: "archive", url, sha512: hex(byte) });

describe("flatpak sources against the lockfile", () => {
  it("reads only the packages section", () => {
    expect([...lockIntegrities(lock)]).toEqual([
      [hex(1), "next@16.4.6"],
      [hex(2), "@scope/pkg@1.0.0"],
    ]);
  });

  it("finds no difference when every package has a source", () => {
    const result = compareSources(lock, [source(1, "https://x/next.tgz"), source(2, "https://x/pkg.tgz")]);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it("lists a lockfile package that has no source", () => {
    expect(compareSources(lock, [source(2, "https://x/pkg.tgz")]).missing).toEqual(["next@16.4.6"]);
  });

  it("lists a source that the lockfile does not have", () => {
    const sources = [source(1, "https://x/next.tgz"), source(2, "https://x/pkg.tgz"), source(7, "https://x/old.tgz")];
    expect(compareSources(lock, sources).extra).toEqual(["https://x/old.tgz"]);
  });

  it("ignores entries without a sha512", () => {
    const sources = [source(1, "https://x/next.tgz"), source(2, "https://x/pkg.tgz"), { type: "inline", contents: "x" }, { type: "script", commands: [] }];
    expect([...sourceHashes(sources).values()]).toEqual(["https://x/next.tgz", "https://x/pkg.tgz"]);
    expect(compareSources(lock, sources)).toMatchObject({ missing: [], extra: [] });
  });

  it("matches the files of this repository", () => {
    const text = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
    const sources = JSON.parse(readFileSync(new URL("../packaging/flatpak/generated-sources.json", import.meta.url), "utf8"));
    expect(compareSources(text, sources)).toMatchObject({ missing: [], extra: [] });
  });
});
