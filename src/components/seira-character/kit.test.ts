import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import kit from "../../assets/seira-character/kit.json";
import placement from "../../assets/seira-accessory/placement.json";
import bases from "../../../brand/mascot/art/bases/manifest.json";

const folder = fileURLToPath(new URL("../../assets/seira-character/", import.meta.url));
const accessoryFolder = fileURLToPath(new URL("../../assets/seira-accessory/", import.meta.url));
const SEIRA_BUDGET_BYTES = 700 * 1024;
const STYLE_BUDGET_BYTES = 180 * 1024;
const KIT_JSON_BUDGET_BYTES = 120 * 1024;

type View = { file: string; hair?: string; visor: string; pivot: number[]; r: number };
const styles = kit.styles as Record<string, { views: Record<string, View> }>;
const viewFiles = (view: View) => [view.file, view.hair, view.visor].filter((file): file is string => Boolean(file));
const styleFiles = (id: string) => Object.values(styles[id]!.views).flatMap(viewFiles);
const handFiles = Object.values(kit.hands).map((hand) => hand.file);
const fxFiles = Object.values(kit.fx).flatMap((sprite) => sprite.frames);

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]);
}

const bytes = (files: string[]) => files.reduce((sum, file) => sum + statSync(join(folder, file)).size, 0);
const listed = [...Object.keys(styles).flatMap(styleFiles), ...handFiles, ...fxFiles];

describe("Seira character assets", () => {
  it("ships every file that the kit lists, as WebP", () => {
    for (const file of listed) {
      expect(file, file).toMatch(/\.webp$/);
      expect(existsSync(join(folder, file)), file).toBe(true);
    }
  });

  it("ships only the files that the kit lists", () => {
    const shipped = filesUnder(folder).filter((file) => file.endsWith(".webp")).map((file) => relative(folder, file).split(sep).join("/")).sort();
    expect(shipped).toEqual([...listed].sort());
  });

  it("keeps Seira's own frames, the hands and the effects under 700 KB", () => {
    expect(bytes([...styleFiles("seira"), ...handFiles, ...fxFiles])).toBeLessThan(SEIRA_BUDGET_BYTES);
  });

  it("keeps each other style under its budget", () => {
    for (const id of Object.keys(styles).filter((name) => name !== "seira")) {
      expect(bytes(styleFiles(id)), id).toBeLessThan(STYLE_BUDGET_BYTES);
    }
  });

  it("keeps the kit file small", () => {
    expect(statSync(join(folder, "kit.json")).size).toBeLessThan(KIT_JSON_BUDGET_BYTES);
  });

  it("has every style of the base art, in order", () => {
    expect(Object.keys(styles)).toEqual(Object.keys(bases.styles));
  });

  it("has the five views in every style", () => {
    for (const [id, style] of Object.entries(styles)) {
      expect(Object.keys(style.views).sort(), id).toEqual(["down", "front", "up", "yaw20", "yaw45"]);
    }
  });

  it("gives a hair mask to every style that has hair", () => {
    for (const [id, style] of Object.entries(styles)) {
      for (const [name, view] of Object.entries(style.views)) {
        expect(Boolean(view.hair), `${id}/${name}`).toBe(id !== "none");
      }
    }
  });

  it("has the hands and effects that the states use", () => {
    expect(Object.keys(kit.hands).sort()).toEqual(["chin", "fist", "open", "wave"]);
    expect(Object.keys(kit.fx).sort()).toEqual(["exclaim", "star", "zzz"]);
  });

  it("places the frames of a style by one pivot and one head radius", () => {
    for (const [id, style] of Object.entries(styles)) {
      const views = Object.values(style.views);
      expect(new Set(views.map((view) => view.r)).size, id).toBe(1);
      expect(new Set(views.map((view) => view.pivot.join(","))).size, id).toBe(1);
    }
  });

  it("ships the sprites of every accessory", () => {
    const accessories = Object.entries(placement.accessories as Record<string, { file: string; files?: Record<string, string> }>);
    expect(accessories.length).toBeGreaterThan(0);
    for (const [id, accessory] of accessories) {
      for (const file of [accessory.file, ...Object.values(accessory.files ?? {})]) {
        expect(existsSync(join(accessoryFolder, file)), `${id}: ${file}`).toBe(true);
      }
    }
  });
});
