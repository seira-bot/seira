import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteMaps, hasUploadAccess, runSymbols, SENTRY_CLI, uploadCommands } from "./crash-report-symbols.mjs";

const folders = [];
function tree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "seira-symbols-"));
  folders.push(base);
  const ui = path.join(base, "dist"), server = path.join(base, "dist-server");
  fs.mkdirSync(path.join(ui, "assets"), { recursive: true });
  fs.mkdirSync(path.join(server, "drivers"), { recursive: true });
  for (const file of ["assets/app.js", "assets/app.js.map", "assets/rail.js.map"]) fs.writeFileSync(path.join(ui, file), "x");
  for (const file of ["index.js", "index.js.map", "drivers/codex.js", "drivers/codex.js.map"]) fs.writeFileSync(path.join(server, file), "x");
  return { ui, server, dirs: [ui, server, path.join(base, "dist-missing")] };
}
const mapsIn = (dir) => fs.readdirSync(dir, { recursive: true }).filter((name) => String(name).endsWith(".map"));
afterEach(() => { for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });

const access = { SENTRY_AUTH_TOKEN: "fake-token", SENTRY_ORG: "fake-org", SENTRY_PROJECT: "fake-project" };

describe("crash report symbols", () => {
  it("only deletes the maps when there is no upload access (AC-34)", async () => {
    const { ui, server, dirs } = tree();
    const calls = [];
    const result = await runSymbols({ env: {}, dirs, version: "1.2.3", run: (args) => { calls.push(args); return 0; } });
    expect(calls).toEqual([]);
    expect(result).toEqual({ uploaded: false, deleted: 4 });
    expect(mapsIn(ui)).toEqual([]);
    expect(mapsIn(server)).toEqual([]);
    expect(fs.existsSync(path.join(ui, "assets", "app.js"))).toBe(true);
    expect(fs.existsSync(path.join(server, "drivers", "codex.js"))).toBe(true);
  });

  it("needs the token, the organization and the project together", () => {
    expect(hasUploadAccess(access)).toBe(true);
    expect(hasUploadAccess({ ...access, SENTRY_ORG: "" })).toBe(false);
    expect(hasUploadAccess({ SENTRY_AUTH_TOKEN: "fake-token" })).toBe(false);
  });

  it("injects the debug ids, then uploads for the release of the version, then deletes the maps", async () => {
    const { ui, server, dirs } = tree();
    const calls = [];
    const env = { ...access, SENTRY_URL: "https://127.0.0.1:9" };
    const result = await runSymbols({ env, dirs, version: "1.2.3", run: (args, runEnv) => { calls.push({ args, url: runEnv.SENTRY_URL, mapsLeft: mapsIn(ui).length + mapsIn(server).length }); return 0; } });
    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([["sourcemaps", "inject"], ["sourcemaps", "upload"]]);
    expect(calls[1].args).toContain("seira@1.2.3");
    expect(calls[0].args.slice(2)).toEqual([ui, server]);
    expect(calls.every((call) => call.url === "https://127.0.0.1:9" && call.mapsLeft === 4)).toBe(true);
    expect(result).toEqual({ uploaded: true, deleted: 4 });
    expect(mapsIn(ui).length + mapsIn(server).length).toBe(0);
  });

  it("deletes the maps and still fails when the upload fails", async () => {
    const { ui, server, dirs } = tree();
    await expect(runSymbols({ env: access, dirs, version: "1.2.3", run: () => 1 })).rejects.toThrow(/failed with status 1/);
    expect(mapsIn(ui).length + mapsIn(server).length).toBe(0);
  });

  it("pins the upload tool and builds both calls", () => {
    expect(SENTRY_CLI).toBe("@sentry/cli@3.8.2");
    expect(uploadCommands("9.9.9", ["a", "b"])).toEqual([["sourcemaps", "inject", "a", "b"], ["sourcemaps", "upload", "--release", "seira@9.9.9", "a", "b"]]);
  });

  it("counts nothing for a folder that does not exist", async () => {
    expect(await deleteMaps([path.join(os.tmpdir(), "seira-symbols-none")])).toBe(0);
  });
});
