#!/usr/bin/env python3
"""Build the cast avatar pictures that the desktop avatar picker shows.

Usage: python3 brand/mascot/cast/tools/avatars.py [id ...]
With ids, only those presets are rebuilt.

For each preset in cast.json except Seira, the script takes the front base frame of the preset's hair style,
recolors the hair and the shell the same way as runtime/recolor.js, puts the accessories on with the rules of
runtime/bot.js, and crops one square around the head. It writes:

  src/assets/cast-body/<id>/front-<px>.webp   the finished head, hair in the preset's own color
  src/assets/cast-body/<id>/hair-<px>.webp    the hair only, in neutral grey, for the bot-color tint
  scripts/mascot-bodies/cast-geometry.json    eyes, mouth, and outline rings in the 240-unit avatar square

The grey hair stores shade / SMAX. CarvedAvatar maps it back with a gradient map that uses the same SMAX and
PMAX, so keep the two in step. The base frames come from gpt-image-2.6 (art/bases), so this script makes no
new images.
"""
import json
import os
import sys

import numpy as np
from PIL import Image
from skimage import measure

HERE = os.path.dirname(os.path.abspath(__file__))
CAST_DIR = os.path.dirname(HERE)
MASCOT = os.path.dirname(CAST_DIR)
REPO = os.path.dirname(os.path.dirname(MASCOT))
BASES = os.path.join(MASCOT, "art", "bases")
STICKERS = os.path.join(MASCOT, "art", "stickers")
OUT = os.path.join(REPO, "src", "assets", "cast-body")
GEOMETRY = os.path.join(REPO, "scripts", "mascot-bodies", "cast-geometry.json")

HEAD_PX = [40, 56, 88, 128, 192, 256]
HAIR_PX = [88, 256]
UNIT = 240
# Grey hair = shade / SMAX. Above shade 1 the highlight rises to PMAX. CarvedAvatar.tsx uses the same values.
SMAX = 1.2
PMAX = 0.3
# Seira's crop is 778 px of the 1024 px frame. The cast keeps her scale unless the hair needs more room.
MIN_SIDE = 778
MARGIN = 10
PAD = 256

# Face canvas of runtime/face.js: the eyes sit at 45 % of FH, the mouth 8 units of 6 px under them.
FW, FH = 1024, 640
FACE_EYES_Y = 288
FACE_MOUTH_Y = 438
# Seira's static eyes (scripts/mascot-bodies/brand.ts) on her 475 px wide visor, in frame px.
SEIRA_VISOR_W = 475
EYE_DX = 120
STARTLED = 104
# Eye size for each eye style of the contract, in frame px on Seira's visor. Pill is Seira's own eye.
EYE_SIZE = {
    "pill": (65, 123), "sharp": (71, 97), "round": (81, 81), "almond": (88, 55),
    "sleepy": (68, 71), "dot": (45, 45), "star": (81, 81), "square": (71, 78),
}


def load(path, mode):
    return np.asarray(Image.open(path).convert(mode), dtype=np.float32)


def hex_rgb(h):
    return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.float32)


def recolor(rgba, mask, hair, shell):
    """Port of runtime/recolor.js. Returns the recolored frame and the hair shade of each pixel."""
    rgb, alpha = rgba[..., :3], rgba[..., 3]
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mk = mask / 255.0
    L = 0.3 * r + 0.59 * g + 0.11 * b
    mx = np.maximum(r, b)
    solid = alpha >= 200
    magenta_ref = (r - g > 60) & (b - g > 60)
    hs = np.where(magenta_ref, mx, L)[solid & (mk > 0.9)]
    ss = L[solid & (mk < 0.1) & (L > 90)]
    h_ref, s_ref = float(np.median(hs)), float(np.median(ss))

    magenta = (r - g > 40) & (b - g > 40)
    shade = np.where(magenta, mx / h_ref, L / h_ref)
    spec = np.where(magenta, np.minimum(1, g / np.maximum(1, mx)) * 0.9,
                    np.maximum(0, (L - h_ref) / max(1, 255 - h_ref)) * 0.55)
    T = hex_rgb(hair)
    c = np.minimum(255, T * shade[..., None])
    h = c + (255 - c) * spec[..., None]
    out = rgb + (h - rgb) * mk[..., None]

    S = hex_rgb(shell)
    sat = rgb.max(axis=-1) - rgb.min(axis=-1)
    k = (1 - mk) * np.clip((L - 70) / 60, 0, 1) * (sat < 40)
    s_shade = L / s_ref
    s_spec = np.maximum(0, (L - s_ref) / max(1, 255 - s_ref)) * 0.7
    sc = np.minimum(255, S * s_shade[..., None])
    t = sc + (255 - sc) * s_spec[..., None]
    out = out + (t - out) * k[..., None]
    return np.concatenate([out, alpha[..., None]], axis=-1), shade


def over(dst, src, x, y):
    """Alpha-composite the RGBA array src onto dst at the top-left corner (x, y)."""
    h, w = src.shape[:2]
    region = dst[y:y + h, x:x + w]
    sa = src[..., 3:4] / 255.0
    da = region[..., 3:4] / 255.0
    oa = sa + da * (1 - sa)
    rgb = (src[..., :3] * sa + region[..., :3] * da * (1 - sa)) / np.maximum(oa, 1e-6)
    region[..., :3] = rgb
    region[..., 3:4] = oa * 255


def place(frame, front, acc_id, defs, pt):
    """Draw one accessory sprite with its pivot on pt, sized as runtime/bot.js does (width x head radius)."""
    d = defs[acc_id]
    img = Image.open(os.path.join(STICKERS, d["file"])).convert("RGBA")
    scale = d.get("width", 1) * front["r"] / img.width
    pv = d.get("pivot") or [img.width / 2, img.height / 2]
    w, h = max(1, round(img.width * scale)), max(1, round(img.height * scale))
    sprite = np.asarray(img.resize((w, h), Image.LANCZOS), dtype=np.float32)
    x = round(pt[0] - pv[0] * scale) + PAD
    y = round(pt[1] - pv[1] * scale) + PAD
    over(frame, sprite, x, y)


def accessories(preset, defs):
    """The accessories the runtime draws: the first one of each slot wins."""
    seen, out = set(), []
    for acc_id in preset["accessories"]:
        d = defs.get(acc_id)
        if not d:
            continue
        slot = d.get("slot") or acc_id
        if slot in seen:
            continue
        seen.add(slot)
        out.append(acc_id)
    return out


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


def save(img, path, lossless=False):
    img.save(path, "WEBP", quality=90, method=6, lossless=lossless)


def build(preset, styles, defs):
    front = styles[preset["style"]]["views"]["front"]
    rgba = load(os.path.join(BASES, front["file"]), "RGBA")
    hair_mask = load(os.path.join(BASES, front["hair"]), "L")
    visor_mask = load(os.path.join(BASES, front["visor"]), "L")
    size = rgba.shape[0]
    pivot, r = front["pivot"], front["r"]
    vx, vy, vw, vh = front["visorBox"]
    k = vw / SEIRA_VISOR_W
    vcx, vcy = vx + vw / 2, vy + vh / 2
    eyes_y = vcy + (FACE_EYES_Y - FH / 2) * vw / FW
    mouth_y = vcy + (FACE_MOUTH_Y - FH / 2) * vw / FW

    painted, shade = recolor(rgba, hair_mask, preset["hairColor"], preset["shell"])
    frame = np.zeros((size + 2 * PAD, size + 2 * PAD, 4), np.float32)
    frame[PAD:PAD + size, PAD:PAD + size] = painted
    acc = np.zeros_like(frame)
    for acc_id in accessories(preset, defs):
        anchor = defs[acc_id].get("anchor", "top")
        if acc_id == "sunglasses":
            # The avatar keeps the eyes in view, so sunglasses rest on the hair above the visor.
            pt = (vcx, vy - 0.38 * r)
        elif anchor in ("eyes", "face"):
            pt = (vcx, eyes_y if anchor == "eyes" else vcy)
        else:
            pt = front["anchors"].get(anchor)
        if pt:
            place(acc, front, acc_id, defs, pt)
    acc_alpha = acc[..., 3] / 255.0
    over(frame, acc, 0, 0)

    # Grey hair: shade / SMAX, alpha = hair mask without what the accessories cover.
    grey = np.clip(shade / SMAX, 0, 1) * 255
    hair = np.zeros_like(frame)
    hair[PAD:PAD + size, PAD:PAD + size, :3] = grey[..., None]
    hair[PAD:PAD + size, PAD:PAD + size, 3] = hair_mask / 255.0 * rgba[..., 3]
    hair[..., 3] *= 1 - acc_alpha

    # Crop: centred on the pivot across, on the head and accessories down, never smaller than Seira's.
    solid = frame[..., 3] > 8
    ys, xs = np.nonzero(solid)
    x0, x1, y0, y1 = xs.min() - PAD, xs.max() - PAD, ys.min() - PAD, ys.max() - PAD
    cx = pivot[0]
    side = max(MIN_SIDE, (y1 - y0) + 2 * MARGIN, 2 * max(cx - x0, x1 - cx) + 2 * MARGIN)
    left, top = round(cx - side / 2), round((y0 + y1) / 2 - side / 2)
    box = (left + PAD, top + PAD, left + PAD + side, top + PAD + side)

    head_img = Image.fromarray(np.clip(frame, 0, 255).astype(np.uint8), "RGBA").crop(box)
    hair_img = Image.fromarray(np.clip(hair, 0, 255).astype(np.uint8), "RGBA").crop(box)
    folder = os.path.join(OUT, preset["id"])
    os.makedirs(folder, exist_ok=True)
    for px in HEAD_PX:
        save(head_img.resize((px, px), Image.LANCZOS), os.path.join(folder, f"front-{px}.webp"))
    for px in HAIR_PX:
        save(hair_img.resize((px, px), Image.LANCZOS), os.path.join(folder, f"hair-{px}.webp"))

    # Outlines for clients without the picture, and the visor that clips the eyes.
    def crop_mask(m):
        full = np.zeros(frame.shape[:2], np.float32)
        full[PAD:PAD + size, PAD:PAD + size] = m
        return full[box[1]:box[3], box[0]:box[2]]

    u = UNIT / side
    w, h = EYE_SIZE[preset["eyes"]]
    return {
        "side": int(side),
        "eyes": {
            "cx": round((cx - left) * u, 1), "cy": round((eyes_y - top) * u, 1), "dx": round(EYE_DX * k * u, 1),
            "w": round(w * k * u, 1), "h": round(h * k * u, 1),
            "round": round((STARTLED if preset["eyes"] != "dot" else 65) * k * u, 1),
            "mouthY": round((mouth_y - top) * u, 1),
        },
        "silhouette": rings(crop_mask(rgba[..., 3] / 255.0), side),
        "hair": rings(crop_mask(hair_mask / 255.0 * (rgba[..., 3] / 255.0)), side),
        "visor": rings(crop_mask(visor_mask / 255.0), side),
    }


def main(only):
    with open(os.path.join(CAST_DIR, "cast.json"), encoding="utf-8") as fh:
        presets = [p for p in json.load(fh) if p["id"] != "seira"]
    with open(os.path.join(BASES, "manifest.json"), encoding="utf-8") as fh:
        styles = json.load(fh)["styles"]
    with open(os.path.join(STICKERS, "manifest.json"), encoding="utf-8") as fh:
        defs = json.load(fh)["accessories"]
    geometry = {}
    if only and os.path.exists(GEOMETRY):
        with open(GEOMETRY, encoding="utf-8") as fh:
            geometry = json.load(fh)
    for preset in presets:
        if only and preset["id"] not in only:
            continue
        geometry[preset["id"]] = build(preset, styles, defs)
        g = geometry[preset["id"]]
        print(f"{preset['id']}: {preset['style']}, side {g['side']}, "
              f"rings {len(g['silhouette'])}/{len(g['hair'])}/{len(g['visor'])}")
    geometry = {p["id"]: geometry[p["id"]] for p in presets if p["id"] in geometry}
    with open(GEOMETRY, "w", encoding="utf-8") as fh:
        json.dump(geometry, fh, separators=(",", ":"))
        fh.write("\n")


if __name__ == "__main__":
    main(set(sys.argv[1:]))
