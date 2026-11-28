import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RELEASE_NOTES } from "../src/lib/release-notes";
import { FALLBACK, MAX_LENGTH, whatsNew } from "./store-whats-new.mjs";

const notesSource = readFileSync(new URL("../src/lib/release-notes.ts", import.meta.url), "utf8");
const locale = JSON.parse(readFileSync(new URL("../src/locales/en.json", import.meta.url), "utf8")) as Record<string, string>;
const script = new URL("./store-whats-new.mjs", import.meta.url).pathname;

describe("Store What's new text", () => {
  it.each(RELEASE_NOTES.map((note) => [note.version, note] as const))("lists the English titles of %s in order", (version, note) => {
    const text = whatsNew(version, { notesSource, locale });
    const expected = note.items.map((item) => `- ${locale[`releaseNotes.items.${item.id}.title`]}\n`).join("");
    expect(text.length).toBeLessThanOrEqual(MAX_LENGTH);
    expect(text).toBe(expected);
  });

  it("cuts a long list at a line boundary", () => {
    const ids = Array.from({ length: 30 }, (_, index) => `item${index}`);
    const longLocale = Object.fromEntries(ids.map((id, index) => [`releaseNotes.items.${id}.title`, `Title ${index} ${"x".repeat(90)}`]));
    const source = `{ version: "9.9.9", items: [ ${ids.map((id) => `{ id: "${id}", icon: Bug }`).join(", ")} ] }`;
    const text = whatsNew("9.9.9", { notesSource: source, locale: longLocale });
    const lines = text.split("\n").slice(0, -1);
    expect(text.length).toBeLessThanOrEqual(MAX_LENGTH);
    expect(text.endsWith("\n")).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(ids.length);
    lines.forEach((line, index) => expect(line).toBe(`- ${longLocale[`releaseNotes.items.item${index}.title`]}`));
  });

  it("gives the fixed line for a version with no entry", () => {
    expect(whatsNew("9.9.9", { notesSource, locale })).toBe("Bug fixes and improvements.\n");
    expect(FALLBACK).toBe("Bug fixes and improvements.\n");
  });

  it("fails for a version that has the wrong shape", () => {
    for (const version of [undefined, "", "1.2", "v1.2.3", "1.2.3-rc.1"]) {
      expect(() => whatsNew(version as string, { notesSource, locale })).toThrow(/1\.2\.3/);
    }
  });

  it("fails when an id has no English title", () => {
    const source = '{ version: "9.9.9", items: [ { id: "nope", icon: Bug } ] }';
    expect(() => whatsNew("9.9.9", { notesSource: source, locale })).toThrow(/"nope"/);
  });

  it("prints the text on the command line, and exits 1 for a bad version", () => {
    const good = spawnSync("node", [script, "--version", RELEASE_NOTES[0]!.version], { encoding: "utf8" });
    expect(good.status).toBe(0);
    expect(good.stdout).toBe(whatsNew(RELEASE_NOTES[0]!.version, { notesSource, locale }));
    for (const args of [[], ["--version"], ["--version", "latest"]]) {
      const bad = spawnSync("node", [script, ...args], { encoding: "utf8" });
      expect(bad.status, args.join(" ")).toBe(1);
      expect(bad.stderr).toContain("1.2.3");
    }
  });
});
