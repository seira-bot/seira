import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import kit from "../../assets/seira-character/kit.json";

const folder = fileURLToPath(new URL("../../assets/seira-character/", import.meta.url));
const BUDGET_BYTES = 700 * 1024;

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]);
}

const listed = [
  ...Object.values(kit.views).flatMap((view) => [view.file, view.hair, view.visor]),
  ...Object.values(kit.hands).map((hand) => hand.file),
  ...Object.values(kit.fx).flatMap((sprite) => sprite.frames),
];

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

  it("stays under 700 KB", () => {
    const total = filesUnder(folder)
      .filter((file) => /\.(webp|json)$/.test(file))
      .reduce((sum, file) => sum + statSync(file).size, 0);
    expect(total).toBeLessThan(BUDGET_BYTES);
  });

  it("has the frames, hands and effects that the states use", () => {
    expect(Object.keys(kit.views).sort()).toEqual(["down", "front", "up", "yaw20", "yaw45"]);
    expect(Object.keys(kit.hands).sort()).toEqual(["chin", "fist", "open", "wave"]);
    expect(Object.keys(kit.fx).sort()).toEqual(["exclaim", "star", "zzz"]);
  });

  it("places each frame by one pivot and one head radius", () => {
    const radii = new Set(Object.values(kit.views).map((view) => view.r));
    const pivots = new Set(Object.values(kit.views).map((view) => view.pivot.join(",")));
    expect(radii.size).toBe(1);
    expect(pivots.size).toBe(1);
  });
});
