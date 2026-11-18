import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { speechHelperBundle } from "./build-speech-helper.mjs";

const root = new URL("../", import.meta.url);
const read = (file) => readFileSync(new URL(file, root), "utf8");
const config = parse(read("electron-builder.yml"));
const bundle = path.basename(speechHelperBundle);

describe("the macOS dictation helper", () => {
  it("is copied into Resources under the name that the build writes", () => {
    expect(config.mac.extraResources).toContainEqual({ from: `electron/resources/${bundle}`, to: bundle });
  });

  it("is loaded from Resources under the same name", () => {
    expect(read("electron/speech.mjs")).toContain(`path.join(process.resourcesPath, ${JSON.stringify(bundle)})`);
  });

  it("stays out of app.asar", () => {
    expect(config.files).toContain(`!electron/resources/${bundle}/**`);
  });

  it("is removed by pnpm clean", () => {
    expect(read("scripts/clean.mjs")).toContain(JSON.stringify(`electron/resources/${bundle}`));
  });
});
