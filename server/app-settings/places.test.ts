import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SETTINGS_PLACES, type SettingsPlace } from "../../shared/settings-places.ts";
import { findPlaces, placePath, placesList } from "./places.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ARROW = " → ";

describe("places", () => {
  it("name a place by its path, with when only Advanced mode or one kind of place shows it", () => {
    expect(placePath("keys")).toBe("Settings → AI → Other services");
    expect(placePath("language")).toBe("Settings → General → Language (in Simple mode it is at Settings → This app → Language)");
    expect(placePath("send-key")).toBe("Settings → General → Send messages with (shown in Advanced mode only; app_settings set appearance.advanced true turns it on)");
    expect(placePath("wifi")).toMatch(/\(only in the desktop app, on this computer's own page\)$/);
  });

  it("find a place by the person's words", () => {
    expect(findPlaces("api key")[0]).toBe("Settings → AI → Other services");
    expect(findPlaces("pair my phone")[0]).toMatch(/^Settings → Phone & devices/);
    expect(findPlaces("connect gmail")[0]).toMatch(/^the Apps panel/);
    expect(findPlaces("zz")).toEqual([]);
  });

  it("list every place after how Settings opens", () => {
    const lines = placesList().split("\n");
    expect(lines[0]).toMatch(/^Settings opens from/);
    expect(lines).toHaveLength(SETTINGS_PLACES.length + 1);
  });
});

/** Every path a place's own path starts with, after "Settings → ", longest first. */
const REAL = [...new Set((SETTINGS_PLACES as readonly SettingsPlace[]).flatMap(({ path, simplePath }) => [path, simplePath ?? ""]).flatMap((path) => {
  if (!path.startsWith(`Settings${ARROW}`)) return [];
  const parts = path.slice(`Settings${ARROW}`.length).replace(/ \(.*\)$/, "").split(ARROW);
  return parts.map((_, index) => parts.slice(0, index + 1).join(ARROW));
}))].sort((a, b) => b.length - a.length);
/** Another app's settings named in our text: the system's, ChatGPT's, a provider's own site. */
const OTHER_APP = /(?:System|ChatGPT|GitHub|Postiz (?:→|under)|Windows|macOS|iOS|Android|phone's|(?:iPhone|phone) app's|Chrome|Bot|bot's) $/;
/** Where people and bots read our words: code, skills, and the English catalog (its translations follow it). */
const SCANNED = ["server", "shared", "packages/phone-protocol/src", "skills", "electron", "src"];
const SOURCE = /\.(?:ts|tsx|mjs|md)$|(?:^|\/)en\.json$/;
const TEST = /\.(?:test|node-test|dom\.test|e2e\.test)\.[cm]?[jt]sx?$|\/testing\/|\.test\.tsx?$/;
/** The docs site and the repository's guides. A dated plan or design record keeps the names of its day. */
const DOCS = ["apps/docs/content", "docs", "README.md"];
const DOC = /\.mdx?$/;
const DATED = /^docs\/(?:plans|superpowers)\//;
/** The ways our text draws a menu path. */
const SEPARATOR = / (?:→|->|›|>) /g;

function* files(path: string, wanted: (path: string) => boolean): Generator<string> {
  if (!statSync(path).isDirectory()) { if (wanted(path)) yield path; return; }
  for (const name of readdirSync(path)) if (name !== "node_modules") yield* files(join(path, name), wanted);
}

/** A "Settings → …" (or "›", ">", "->") in text a bot or a person reads whose whole path is no real place. A `{name}`
 * the app fills in is read as a place it names. */
function inventedPaths(text: string): string[] {
  return pathsIn(text.split("\n").filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line)));
}

/** The same for a Markdown doc, which has no comments: emphasis and code marks go, and a paragraph is one line, so a
 * path that wraps or is bold in parts is read whole. */
function inventedDocPaths(text: string): string[] {
  return pathsIn(text.replace(/\*\*|__|`/g, "").replace(/[ \t]*\n[ \t]*(?=\S)/g, " ").split("\n"));
}

function pathsIn(lines: string[]): string[] {
  const found: string[] = [];
  for (const line of lines) {
    for (const match of line.matchAll(/\bSettings (?:→|->|›|>) /g)) {
      if (OTHER_APP.test(line.slice(0, match.index))) continue;
      const rest = line.slice(match.index + match[0].length).replace(SEPARATOR, ARROW);
      if (/^\{\w+\}/.test(rest)) continue;
      const hit = REAL.find((path) => rest.startsWith(path) && !/^[\p{L}\p{N}]/u.test(rest.slice(path.length)));
      if (!hit || rest.slice(hit.length).startsWith(ARROW)) found.push(`Settings → ${rest.slice(0, 60)}`);
    }
  }
  return found;
}

describe("menu paths in our own text", () => {
  it("tell a stale path from a real one", () => {
    expect(inventedPaths('"Add it in Settings → API keys."')).toEqual(["Settings → API keys.\""]);
    expect(inventedPaths('"Sign in again in Settings → AI to keep using it."')).toEqual([]);
    expect(inventedPaths('"open Settings → Phone & devices → Your other computers in Seira"')).toEqual([]);
    expect(inventedPaths('"open Settings → AI → API keys"')).toEqual(["Settings → AI → API keys\""]);
    expect(inventedPaths('"in System Settings → Privacy & Security"')).toEqual([]);
    expect(inventedPaths("// Settings → Computers, a comment only")).toEqual([]);
    expect(inventedPaths('"turn it on in Settings > Seira Cloud (Advanced mode)"')).toEqual(["Settings → Seira Cloud (Advanced mode)\""]);
    expect(inventedPaths('"Settings › Desktops & browser › Built-in browser"')).toEqual([]);
    expect(inventedPaths('"open Settings → {section} and choose {open}"')).toEqual([]);
    expect(inventedPaths('  "call.live.needsKey": "Add it in Settings → API keys.",')).toEqual(["Settings → API keys.\","]);
  });

  it("name only places Settings has, so a bot never sends the person to a menu that does not exist", () => {
    const invented = SCANNED.flatMap((dir) => [...files(join(ROOT, dir), (path) => SOURCE.test(path) && !TEST.test(path))].flatMap((path) =>
      inventedPaths(readFileSync(path, "utf8")).map((found) => `${relative(ROOT, path)}: ${found}`)));
    expect(invented).toEqual([]);
  });

  it("read a doc's path whole, past bold marks, code marks, list stars and line breaks", () => {
    expect(inventedDocPaths("Open **Settings → AI → Other services** and paste it.")).toEqual([]);
    expect(inventedDocPaths("Open **Settings** → **AI** → **Providers**.")).toEqual([]);
    expect(inventedDocPaths("Open **Settings → API keys** and paste it.")).toEqual(["Settings → API keys and paste it."]);
    expect(inventedDocPaths("* `Settings → Engines`, a list item")).toEqual(["Settings → Engines, a list item"]);
    expect(inventedDocPaths("open **Settings → Remote\n  access** on the host")).toEqual(["Settings → Remote access on the host"]);
    expect(inventedDocPaths("open Settings → AI\n\n→ Providers is the next paragraph")).toEqual([]);
    expect(inventedDocPaths("With a second input source and System\n    Settings → Keyboard → Input Sources")).toEqual([]);
    expect(inventedDocPaths("An admin sets them in GitHub **Settings → Actions → General**:")).toEqual([]);
  });

  it("name only places Settings has in the docs, so a reader never looks for a menu that does not exist", () => {
    const invented = DOCS.flatMap((top) => [...files(join(ROOT, top), (path) => DOC.test(path) && !DATED.test(relative(ROOT, path)))].flatMap((path) =>
      inventedDocPaths(readFileSync(path, "utf8")).map((found) => `${relative(ROOT, path)}: ${found}`)));
    expect(invented).toEqual([]);
  });
});
