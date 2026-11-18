/**
 * The cast: the 25 presets of `brand/mascot/cast/cast.json` after Seira, as brand bodies.
 *
 * The desktop app draws each one from its rendered picture in `src/assets/cast-body/<id>/` and keeps only the eyes and
 * the visor clip from here. `brand/mascot/cast/tools/avatars.py` makes those pictures and `cast-geometry.json`: the
 * outlines and the face of each picture in the 240-unit square, for clients that have no picture.
 *
 * Loaded by `node --experimental-strip-types`, so only erasable type syntax.
 */

import { readFileSync } from "node:fs"

import { rings } from "./draw.ts"
import type { Def } from "./carved.ts"

type Loop = Array<[number, number]>

interface Preset {
  id: string
  name: string
  hairColor: string | null
  shell: string
  screen: string
  eyeColor: string
}

interface Geometry {
  eyes: { cx: number; cy: number; dx: number; w: number; h: number; round: number; mouthY: number }
  silhouette: Loop[]
  hair: Loop[]
  visor: Loop[]
}

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"))
const PRESETS: Preset[] = read("../../brand/mascot/cast/cast.json")
const GEOMETRY: Record<string, Geometry> = read("./cast-geometry.json")

export const CAST: Def[] = PRESETS.filter((p) => p.id !== "seira").map((p) => {
  const g = GEOMETRY[p.id]
  if (!g) throw new Error(`cast-geometry.json has no ${p.id}: run brand/mascot/cast/tools/avatars.py`)
  const { mouthY, ...eyes } = g.eyes
  const visor = rings(g.visor)
  return {
    id: p.id,
    name: p.name,
    paint: "hair",
    bone: p.hairColor,
    face: visor,
    eyes: { ...eyes, ink: p.eyeColor, mouthY },
    parts: [[rings(g.silhouette), p.shell], [rings(g.hair), "body"], [visor, p.screen]],
  }
})
