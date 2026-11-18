import { mkdirSync, rmSync, utimesSync, writeFileSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_COOKIE_DB_BYTES, detectProfiles } from "./profiles.ts";
import { makeFakeHome, writeFakeBrowser } from "./testing/fake-profile.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const home = () => { const path = makeFakeHome(); homes.push(path); return path; };
const cookie = { hostKey: ".example.com", name: "sid", value: "v" };

describe("detecting browser profiles on Linux", () => {
  it("lists Chrome, Edge, Brave and Chromium profiles, the last-used profile first", () => {
    const h = home();
    writeFakeBrowser(join(h, ".config", "google-chrome"), [{ dir: "Default", name: "Personal", cookies: [cookie] }, { dir: "Profile 2", name: "Work", cookies: [cookie] }], "Profile 2");
    writeFakeBrowser(join(h, ".config", "microsoft-edge"), [{ cookies: [cookie] }]);
    writeFakeBrowser(join(h, ".config", "BraveSoftware", "Brave-Browser"), [{ cookies: [cookie], layout: "legacy" }]);
    writeFakeBrowser(join(h, ".config", "chromium"), [{ cookies: [cookie] }]);
    const profiles = detectProfiles({ home: h, env: {}, platform: "linux" });
    expect(profiles[0]).toMatchObject({ id: "chrome:Profile 2", name: "Work", browserName: "Chrome", lastUsed: true });
    expect(profiles.map((profile) => profile.id).sort()).toEqual(["brave:Default", "chrome:Default", "chrome:Profile 2", "chromium:Default", "edge:Default"]);
    expect(profiles.find((profile) => profile.id === "chrome:Default")).toMatchObject({ name: "Personal", lastUsed: false });
  });

  it("finds Flatpak and Snap installs, honours XDG_CONFIG_HOME, and marks the variant in the id", () => {
    const h = home();
    writeFakeBrowser(join(h, ".var", "app", "com.google.Chrome", "config", "google-chrome"), [{ cookies: [cookie] }]);
    writeFakeBrowser(join(h, "snap", "chromium", "common", "chromium"), [{ cookies: [cookie] }]);
    writeFakeBrowser(join(h, "xdg", "chromium"), [{ cookies: [cookie] }]);
    const ids = detectProfiles({ home: h, env: { XDG_CONFIG_HOME: join(h, "xdg") }, platform: "linux" }).map((profile) => profile.id).sort();
    expect(ids).toEqual(["chrome:Default:Flatpak", "chromium:Default", "chromium:Default:Snap"]);
  });

  it("accepts only Default and Profile N folders that hold a cookie file", () => {
    const h = home();
    const root = join(h, ".config", "google-chrome");
    writeFakeBrowser(root, [{ dir: "Default", cookies: [cookie] }, { dir: "Profile 1", cookies: [cookie] }, { dir: "Guest Profile", cookies: [cookie] }, { dir: "System Profile", cookies: [cookie] }]);
    mkdirSync(join(root, "Profile 3"));
    expect(detectProfiles({ home: h, env: {}, platform: "linux" }).map((profile) => profile.id).sort()).toEqual(["chrome:Default", "chrome:Profile 1"]);
  });

  it("detects macOS roots and nothing on Windows", () => {
    const h = home();
    writeFakeBrowser(join(h, "Library", "Application Support", "Google", "Chrome"), [{ cookies: [cookie] }]);
    expect(detectProfiles({ home: h, env: {}, platform: "darwin" }).map((profile) => profile.id)).toEqual(["chrome:Default"]);
    expect(detectProfiles({ home: h, env: {}, platform: "win32" })).toEqual([]);
  });

  it("falls back to the folder name without Local State and orders others by newest cookie file", () => {
    const h = home();
    const root = join(h, ".config", "google-chrome");
    writeFakeBrowser(root, [{ dir: "Default", cookies: [cookie] }, { dir: "Profile 1", cookies: [cookie] }]);
    rmSync(join(root, "Local State"));
    utimesSync(join(root, "Profile 1", "Network", "Cookies"), new Date(2030, 0, 1), new Date(2030, 0, 1));
    expect(detectProfiles({ home: h, env: {}, platform: "linux" }).map((profile) => [profile.id, profile.name, profile.lastUsed]))
      .toEqual([["chrome:Profile 1", "Profile 1", false], ["chrome:Default", "Default", false]]);
  });

  it("flags a cookie database over 64 MiB, counting its journal", () => {
    const h = home();
    const root = join(h, ".config", "google-chrome");
    writeFakeBrowser(root, [{ dir: "Default", cookies: [cookie] }, { dir: "Profile 1", cookies: [cookie] }]);
    truncateSync(join(root, "Default", "Network", "Cookies"), MAX_COOKIE_DB_BYTES + 1);
    writeFileSync(join(root, "Profile 1", "Network", "Cookies-wal"), Buffer.alloc(0));
    truncateSync(join(root, "Profile 1", "Network", "Cookies-wal"), MAX_COOKIE_DB_BYTES + 1);
    const flags = Object.fromEntries(detectProfiles({ home: h, env: {}, platform: "linux" }).map((profile) => [profile.id, profile.tooLarge]));
    expect(flags).toEqual({ "chrome:Default": true, "chrome:Profile 1": true });
  });
});
