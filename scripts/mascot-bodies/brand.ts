/**
 * The brand pack: Seira, the shipped mascot. A blunt bob over a dark visor, with red eyes.
 *
 * The desktop app draws the rendered picture in `src/assets/seira-body/` and keeps only the eyes and the visor clip
 * from here. The paths match that picture, cropped to the 240-unit square, for clients that have no picture.
 *
 * Loaded by `node --experimental-strip-types`, so only erasable type syntax.
 */

import { box, circle, ellipse, intersect, mirror, smooth, stroke } from "./draw.ts"
import type { Def } from "./carved.ts"

const SHELL = "#e8ebef"
const SCREEN = "#0c0f14"
const EYE = "#e11d48"

const belowBangs = box(0, 66, 240, 240)
const lock = mirror(stroke([38, 104], [34, 160], [36, 205], [46, 236], 20, 10))
const hair = smooth(5, intersect(circle(120, 101, 101), box(0, 0, 240, 140)), lock)
const shell = intersect(ellipse(120, 110, 76, 74), belowBangs)
const visor = intersect(box(47, 20, 193, 164, 50), belowBangs)

export const BRAND: Def[] = [
  {
    id: "seira", name: "Seira", paint: "hair", bone: "#d3d8df", face: visor,
    eyes: { cx: 120, cy: 106, dx: 37, w: 20, h: 38, round: 32, ink: EYE, mouthY: 128 },
    parts: [[hair, "body"], [shell, SHELL], [visor, SCREEN], [lock, "body"]],
  },
]
