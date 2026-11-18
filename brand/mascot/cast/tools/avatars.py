#!/usr/bin/env python3
"""Build Seira's hair styles and accessory sprites for the desktop avatar.

Usage: python3 brand/mascot/cast/tools/avatars.py [style ...]
With style ids, only those hair styles are rebuilt. The accessory sprites and placement.json are always rebuilt.

A bot wears Seira's head with one hair style of art/bases. For each style except "seira", the script takes the front
base frame, paints the hair in Seira's silver the same way as runtime/recolor.js, and crops one square around the head.
Seira keeps her own pictures in src/assets/seira-body. The script writes:

  src/assets/seira-hair/<style>/front-<px>.webp    the head with an empty visor, hair in Seira's silver
  src/assets/seira-hair/<style>/hair-<px>.webp     the hair only, in neutral grey, for the bot-color tint
  scripts/mascot-bodies/hair-geometry.json         eyes, mouth, and outline rings in the 240-unit avatar square
  src/assets/seira-accessory/<id>[.<view>].webp    the accessory sprites of art/stickers
  src/assets/seira-accessory/placement.json        the head radius and anchors of each style, and each sprite

The grey hair stores shade / SMAX. CarvedAvatar maps it back with a gradient map that uses the same SMAX and
PMAX, so keep the two in step. The base frames and stickers come from gpt-image-2.6 (art/bases, art/stickers), so this
script makes no new images.
"""
import json
import os
import sys

import numpy as np
from PIL import Image
from skimage import measure

HERE = os.path.dirname(os.path.abspath(__file__))
MASCOT = os.path.dirname(os.path.dirname(HERE))
REPO = os.path.dirname(os.path.dirname(MASCOT))
BASES = os.path.join(MASCOT, "art", "bases")
STICKERS = os.path.join(MASCOT, "art", "stickers")
OUT = os.path.join(REPO, "src", "assets", "seira-hair")
ACC_OUT = os.path.join(REPO, "src", "assets", "seira-accessory")
GEOMETRY = os.path.join(REPO, "scripts", "mascot-bodies", "hair-geometry.json")

HEAD_PX = [40, 56, 88, 128, 192, 256]
HAIR_PX = [88, 256]
UNIT = 240
# Grey hair = shade / SMAX. Above shade 1 the highlight rises to PMAX. src/lib/seira-hair.ts uses the same values.
SMAX = 1.2
PMAX = 0.3
# The median color of Seira's own hair. Silver and chrome bots show it on every other style.
SEIRA_HAIR = "#DADADF"
# The crop of src/assets/seira-body in the 1024 px front frame: left, top, side.
SEIRA_CROP = (123, 131, 778)
# Other styles keep Seira's scale unless the hair needs more room.
MIN_SIDE = SEIRA_CROP[2]
MARGIN = 2
PAD = 256
ACC_QUALITY = 86

# Face canvas of runtime/face.js: the eyes sit at 45 % of FH, the mouth 8 units of 6 px under them.
FW, FH = 1024, 640
FACE_EYES_Y = 288
FACE_MOUTH_Y = 438
# Seira's pill eyes (scripts/mascot-bodies/brand.ts) on her 475 px wide visor, in frame px.
SEIRA_VISOR_W = 475
EYE_DX = 120
EYE_W, EYE_H = 65, 123
STARTLED = 104
ANCHORS = ["top", "earL", "earR", "templeL", "templeR", "mouth", "cheekL", "cheekR", "neck"]


def load(path, mode):
    return np.asarray(Image.open(path).convert(mode), dtype=np.float32)


def hex_rgb(h):
    return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.float32)


def recolor(rgba, mask, hair):
    """Port of the hair part of runtime/recolor.js. Returns the recolored frame and the hair shade of each pixel."""
    rgb, alpha = rgba[..., :3], rgba[..., 3]
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mk = mask / 255.0
    L = 0.3 * r + 0.59 * g + 0.11 * b
    mx = np.maximum(r, b)
    solid = alpha >= 200
    magenta_ref = (r - g > 60) & (b - g > 60)
    h_ref = float(np.median(np.where(magenta_ref, mx, L)[solid & (mk > 0.9)]))

    magenta = (r - g > 40) & (b - g > 40)
    shade = np.where(magenta, mx / h_ref, L / h_ref)
    spec = np.where(magenta, np.minimum(1, g / np.maximum(1, mx)) * 0.9,
                    np.maximum(0, (L - h_ref) / max(1, 255 - h_ref)) * 0.55)
    T = hex_rgb(hair)
    c = np.minimum(255, T * shade[..., None])
    h = c + (255 - c) * spec[..., None]
    out = rgb + (h - rgb) * mk[..., None]
    return np.concatenate([out, alpha[..., None]], axis=-1), shade


def rings(mask, side):
    """Outline rings of a 0..1 mask in the 240-unit square, simplified to half a unit."""
    m = np.pad(mask, 1)
    k = UNIT / side
    out = []
    for c in measure.find_contours(m, 0.5):
        c = measure.approximate_polygon(c, tolerance=0.5 / k)
        pts = [[round((p[1] - 1) * k, 1), round((p[0] - 1) * k, 1)] for p in c[:-1]]
        if len(pts) < 3:
            continue
        xs, ys = np.array([p[0] for p in pts]), np.array([p[1] for p in pts])
        area = 0.5 * abs(np.dot(xs, np.roll(ys, 1)) - np.dot(ys, np.roll(xs, 1)))
        if area >= 6:
            out.append(pts)
    return out


def save(img, path, lossless=False, quality=90):
    img.save(path, "WEBP", quality=quality, method=6, lossless=lossless)


def placement(front, left, top, side):
    """The head radius and the named points of a front frame, in the 240-unit square of its crop."""
    u = UNIT / side
    point = lambda p: [round((p[0] - left) * u, 1), round((p[1] - top) * u, 1)]
    return {
        "r": round(front["r"] * u, 2),
        "anchors": {name: point(front["anchors"][name]) for name in ANCHORS if name in front["anchors"]},
    }


def build(style_id, style):
    front = style["views"]["front"]
    rgba = load(os.path.join(BASES, front["file"]), "RGBA")
    hair_mask = load(os.path.join(BASES, front["hair"]), "L") if front.get("hair") else None
    visor_mask = load(os.path.join(BASES, front["visor"]), "L")
    size = rgba.shape[0]
    pivot, r = front["pivot"], front["r"]
    vx, vy, vw, vh = front["visorBox"]
    k = vw / SEIRA_VISOR_W
    vcx, vcy = vx + vw / 2, vy + vh / 2
    eyes_y = vcy + (FACE_EYES_Y - FH / 2) * vw / FW
    mouth_y = vcy + (FACE_MOUTH_Y - FH / 2) * vw / FW

    painted, shade = recolor(rgba, hair_mask, SEIRA_HAIR) if hair_mask is not None else (rgba, None)
    frame = np.zeros((size + 2 * PAD, size + 2 * PAD, 4), np.float32)
    frame[PAD:PAD + size, PAD:PAD + size] = painted

    # Crop: centred on the pivot across and on the head down, never smaller than Seira's.
    ys, xs = np.nonzero(rgba[..., 3] > 8)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    cx = pivot[0]
    side = int(max(MIN_SIDE, (y1 - y0) + 2 * MARGIN, 2 * max(cx - x0, x1 - cx) + 2 * MARGIN))
    left, top = round(cx - side / 2), round((y0 + y1) / 2 - side / 2)
    box = (left + PAD, top + PAD, left + PAD + side, top + PAD + side)

    folder = os.path.join(OUT, style_id)
    os.makedirs(folder, exist_ok=True)
    for name in os.listdir(folder):
        os.remove(os.path.join(folder, name))
    head_img = Image.fromarray(np.clip(frame, 0, 255).astype(np.uint8), "RGBA").crop(box)
    for px in HEAD_PX:
        save(head_img.resize((px, px), Image.LANCZOS), os.path.join(folder, f"front-{px}.webp"))
    if hair_mask is not None:
        hair = np.zeros_like(frame)
        hair[PAD:PAD + size, PAD:PAD + size, :3] = (np.clip(shade / SMAX, 0, 1) * 255)[..., None]
        hair[PAD:PAD + size, PAD:PAD + size, 3] = hair_mask / 255.0 * rgba[..., 3]
        hair_img = Image.fromarray(np.clip(hair, 0, 255).astype(np.uint8), "RGBA").crop(box)
        for px in HAIR_PX:
            save(hair_img.resize((px, px), Image.LANCZOS), os.path.join(folder, f"hair-{px}.webp"))

    # Outlines for clients without the picture, and the visor that clips the eyes.
    def crop_mask(m):
        full = np.zeros(frame.shape[:2], np.float32)
        full[PAD:PAD + size, PAD:PAD + size] = m
        return full[box[1]:box[3], box[0]:box[2]]

    u = UNIT / side
    geometry = {
        "side": side,
        "eyes": {
            "cx": round((cx - left) * u, 1), "cy": round((eyes_y - top) * u, 1), "dx": round(EYE_DX * k * u, 1),
            "w": round(EYE_W * k * u, 1), "h": round(EYE_H * k * u, 1), "round": round(STARTLED * k * u, 1),
            "mouthY": round((mouth_y - top) * u, 1),
        },
        "silhouette": rings(crop_mask(rgba[..., 3] / 255.0), side),
        "hair": rings(crop_mask(hair_mask / 255.0 * (rgba[..., 3] / 255.0)), side) if hair_mask is not None else [],
        "visor": rings(crop_mask(visor_mask / 255.0), side),
    }
    return geometry, placement(front, left, top, side)


def sprites(defs):
    """Copy the accessory stickers as WebP. The entries keep the sticker manifest's fields, with local file names."""
    os.makedirs(ACC_OUT, exist_ok=True)
    for name in os.listdir(ACC_OUT):
        if name.endswith(".webp"):
            os.remove(os.path.join(ACC_OUT, name))
    out = {}
    for acc_id, d in defs.items():
        entry = {key: value for key, value in d.items() if key not in ("file", "files")}
        img = Image.open(os.path.join(STICKERS, d["file"])).convert("RGBA")
        entry["file"] = f"{acc_id}.webp"
        entry["size"] = [img.width, img.height]
        save(img, os.path.join(ACC_OUT, entry["file"]), quality=ACC_QUALITY)
        files = {}
        for view, path in (d.get("files") or {}).items():
            files[view] = f"{acc_id}.{view}.webp"
            save(Image.open(os.path.join(STICKERS, path)).convert("RGBA"), os.path.join(ACC_OUT, files[view]),
                 quality=ACC_QUALITY)
        if files:
            entry["files"] = files
        out[acc_id] = entry
    return out


def main(only):
    with open(os.path.join(BASES, "manifest.json"), encoding="utf-8") as fh:
        styles = json.load(fh)["styles"]
    with open(os.path.join(STICKERS, "manifest.json"), encoding="utf-8") as fh:
        defs = json.load(fh)["accessories"]
    geometry, places = {}, {}
    if only and os.path.exists(GEOMETRY):
        with open(GEOMETRY, encoding="utf-8") as fh:
            geometry = json.load(fh)
    for style_id, style in styles.items():
        if style_id == "seira":
            places[style_id] = placement(style["views"]["front"], *SEIRA_CROP)
            continue
        if only and style_id not in only:
            front = style["views"]["front"]
            g = geometry[style_id]
            ys, xs = np.nonzero(load(os.path.join(BASES, front["file"]), "RGBA")[..., 3] > 8)
            places[style_id] = placement(front, round(front["pivot"][0] - g["side"] / 2),
                                         round((ys.min() + ys.max()) / 2 - g["side"] / 2), g["side"])
            continue
        geometry[style_id], places[style_id] = build(style_id, style)
        g = geometry[style_id]
        print(f"{style_id}: side {g['side']}, rings {len(g['silhouette'])}/{len(g['hair'])}/{len(g['visor'])}")
    geometry = {s: geometry[s] for s in styles if s in geometry}
    with open(GEOMETRY, "w", encoding="utf-8") as fh:
        json.dump(geometry, fh, separators=(",", ":"))
        fh.write("\n")
    accessories = sprites(defs)
    with open(os.path.join(ACC_OUT, "placement.json"), "w", encoding="utf-8") as fh:
        json.dump({"styles": places, "accessories": accessories}, fh, separators=(",", ":"))
        fh.write("\n")


if __name__ == "__main__":
    main(set(sys.argv[1:]))
