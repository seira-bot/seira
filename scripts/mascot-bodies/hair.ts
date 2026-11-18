/**
 * Seira's hair styles: the styles of `brand/mascot/art/bases/manifest.json` after "seira", as brand bodies. The body id
 * is the style id. Each style is Seira's head, shell, visor, and red eyes with other hair.
 *
 * The desktop app draws each one from its rendered picture in `src/assets/seira-hair/<style>/` and keeps only the eyes
 * and the visor clip from here. `brand/mascot/cast/tools/avatars.py` makes those pictures and `hair-geometry.json`: the
 * outlines and the face of each picture in the 240-unit square, for clients that have no picture.
 *
 * Loaded by `node --experimental-strip-types`, so only erasable type syntax.
 */

import { readFileSync } from "node:fs"

import { rings } from "./draw.ts"
import type { Def } from "./carved.ts"

type Loop = Array<[number, number]>

interface Geometry {
  eyes: { cx: number; cy: number; dx: number; w: number; h: number; round: number; mouthY: number }
  silhouette: Loop[]
  hair: Loop[]
  visor: Loop[]
}

// Seira's colors, the same as her own body in brand.ts. SILVER is her hair for the grey bot colors.
export const SHELL = "#e8ebef"
export const SCREEN = "#0c0f14"
export const EYE = "#e11d48"
export const SILVER = "#d3d8df"

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"))
const STYLES: Record<string, { label: string }> = read("../../brand/mascot/art/bases/manifest.json").styles
const GEOMETRY: Record<string, Geometry> = read("./hair-geometry.json")

export const HAIR_STYLES: Def[] = Object.entries(STYLES).filter(([id]) => id !== "seira").map(([id, style]) => {
  const g = GEOMETRY[id]
  if (!g) throw new Error(`hair-geometry.json has no ${id}: run brand/mascot/cast/tools/avatars.py`)
  const { mouthY, ...eyes } = g.eyes
  const visor = rings(g.visor)
  const parts: Def["parts"] = [[rings(g.silhouette), SHELL]]
  if (g.hair.length) parts.push([rings(g.hair), "body"])
  parts.push([visor, SCREEN])
  return { id, name: style.label, paint: "hair", bone: SILVER, face: visor, eyes: { ...eyes, ink: EYE, mouthY }, parts }
})
