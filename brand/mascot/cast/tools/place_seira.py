#!/usr/bin/env python3
"""Put the real Seira art into cell 1 of the female lineup sheet.

The generator draws every head again, so cell 1 of raw/lineup-female.png is only a lookalike of Seira.
This script removes that head, cuts the head out of the reference art, and pastes it at the same place and height.
It then draws a soft floor shadow like the shadows of the other cells.

Usage: python3 brand/mascot/cast/tools/place_seira.py [raw.png] [out.png]
Defaults: raw/lineup-female.png -> concept/lineup-female.png
Needs Pillow, NumPy, and SciPy.
"""
import hashlib
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
CAST_DIR = os.path.dirname(HERE)
REF = os.path.join(CAST_DIR, "..", "options", "d-bot-pendamping.png")

DIFF = 9          # a pixel is part of an object when a channel differs from the background by more than this
ERASE_DIFF = 4    # the same limit against the smooth background, to find the whole old head and shadow
SHADOW_DEPTH = 57  # darkest shadow step below the background, measured in the raw sheet
SHADOW_SX = 0.25   # shadow half-size across, as a part of the head width
SHADOW_SY = 8.0    # shadow half-size down, in pixels

# Cell 1 of raw/lineup-female.png: head center x, head top y, lowest hair tip y, shadow center y.
# The raw sheet puts the hair tips into the floor shadow, so a script cannot find the tips. Measure them by eye.
CELL1 = {"center": 318, "top": 20, "tip": 292, "shadow": 298}
RAW_MD5 = "ef236cd67a128eee1b9a9186090fff4f"


def smooth_background(img, objects, sigma=40):
    """Return the background with the objects filled in from their neighbors."""
    keep = (~objects).astype(float)
    den = ndimage.gaussian_filter(keep, sigma)
    out = np.empty_like(img)
    for c in range(3):
        out[..., c] = ndimage.gaussian_filter(img[..., c] * keep, sigma) / np.maximum(den, 1e-6)
    return out


def object_mask(img, bg):
    return np.abs(img - bg).max(axis=2) > DIFF


def find_old_head(sheet, objects):
    """Return the box (x0, x1, y0, y1) of the head in the top-left cell, without its floor shadow."""
    h, w = objects.shape
    cell = np.zeros_like(objects)
    cell[: h // 3, : w // 3] = True
    lab, _ = ndimage.label(objects & cell)
    ids, counts = np.unique(lab[lab > 0], return_counts=True)
    if not len(ids):
        sys.exit("FAIL: no head found in the top-left cell")
    # The head is the biggest object in the top-left cell.
    head = lab == ids[np.argmax(counts)]
    ys, xs = np.where(head)
    y0, y1 = ys.min(), ys.max()
    # The width comes from the upper 75 % of the object, so the floor shadow does not count.
    upper = head[y0 : y0 + int(0.75 * (y1 - y0))]
    cols = np.where(upper.any(axis=0))[0]
    return int(cols.min()), int(cols.max()), int(y0), int(y1), head


def cut_reference(ref):
    """Return the reference head as RGB, an alpha matte, and its box.

    The light comes from the left, so the right side of the shell has almost the background color.
    The head is symmetric, so the matte is the union of the left-side mask and its mirror image.
    """
    border = np.concatenate([ref[:, :40].reshape(-1, 3), ref[:, -40:].reshape(-1, 3)])
    bg = np.median(border, axis=0)

    def biggest(mask):
        lab, _ = ndimage.label(mask)
        ids, counts = np.unique(lab[lab > 0], return_counts=True)
        return lab == ids[np.argmax(counts)]

    # The floor shadow is a separate object below the hair tips, so the biggest object is the head.
    head = biggest(object_mask(ref, bg))
    # The left edge has good contrast. Find the axis from the visor, which is dark and symmetric.
    visor = np.where((ref.max(axis=2) < 60).any(axis=0))[0]
    axis2 = int(visor.min() + visor.max())  # twice the axis x
    mirror = np.zeros_like(head)
    cols = np.arange(head.shape[1])
    src = axis2 - cols
    ok = (src >= 0) & (src < head.shape[1])
    mirror[:, cols[ok]] = head[:, src[ok]]
    head = biggest(head | mirror)
    head = ndimage.binary_closing(head, structure=np.ones((3, 3)), iterations=2)
    head = ndimage.binary_fill_holes(head)
    alpha = ndimage.gaussian_filter(head.astype(float), 0.8)
    ys, xs = np.where(head)
    return bg, alpha, (int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max()))


def main(argv):
    raw = argv[1] if len(argv) > 1 else os.path.join(CAST_DIR, "raw", "lineup-female.png")
    out = argv[2] if len(argv) > 2 else os.path.join(CAST_DIR, "concept", "lineup-female.png")
    sheet = np.asarray(Image.open(raw).convert("RGB")).astype(float)
    ref = np.asarray(Image.open(REF).convert("RGB")).astype(float)

    flat = np.median(sheet[:20].reshape(-1, 3), axis=0)
    bg_sheet = smooth_background(sheet, ndimage.binary_dilation(object_mask(sheet, flat), iterations=6))
    # Against the smooth background, a low limit also catches the faint edge of the old shadow.
    objects = np.abs(sheet - bg_sheet).max(axis=2) > ERASE_DIFF
    x0, x1, y0, y1, old = find_old_head(sheet, objects)
    width = x1 - x0

    # 1. The place of the old head, measured by hand in this raw sheet (see RAW_MD5).
    if hashlib.md5(open(raw, "rb").read()).hexdigest() != RAW_MD5:
        print("WARN: the raw sheet changed. Measure CELL1 again and update RAW_MD5.")
    center, top, tip, shadow_y = CELL1["center"], CELL1["top"], CELL1["tip"], CELL1["shadow"]

    # 2. Remove the old head and its shadow. Fill the hole with the smooth background.
    # Keep colored pixels in the lowest part of the cell: they belong to the head in the next row.
    erase = ndimage.binary_dilation(old, iterations=3)
    sat = sheet.max(axis=2) - sheet.min(axis=2)
    low = np.zeros_like(erase)
    low[y0 + int(0.85 * (y1 - y0)) :] = True
    keep = ndimage.binary_dilation(low & (sat > 24), iterations=2)  # the next head and its soft edge
    erase &= ~keep
    # The cell ends at one third of the sheet height, but the old shadow goes a little lower. Add its grey pixels.
    lum = sheet.mean(axis=2)
    near = np.zeros_like(erase)
    near[y0 : y1 + 30, max(x0 - 10, 0) : x1 + 10] = True
    grey_shadow = near & (sat < 12) & (lum < bg_sheet.mean(axis=2) - 3)
    erase |= grey_shadow & ~keep
    result = sheet.copy()
    result[erase] = bg_sheet[erase]

    # 3. Draw a soft floor shadow at the old place. Do not draw it on other heads.
    rbg, ralpha, (rx0, rx1, ry0, ry1) = cut_reference(ref)
    scale = (tip - top) / (ry1 - ry0)  # same height as the old head
    yy, xx = np.mgrid[0 : sheet.shape[0], 0 : sheet.shape[1]]
    shade = SHADOW_DEPTH * np.exp(-(((xx - center) / (SHADOW_SX * width)) ** 2 + ((yy - shadow_y) / SHADOW_SY) ** 2) / 2)
    shade[ndimage.binary_dilation(objects & ~old & ~erase, iterations=2) | keep] = 0
    result -= shade[..., None]

    # 4. Paste the reference head. Shift its colors so its background matches the sheet.
    shift = np.median(bg_sheet[erase], axis=0) - rbg
    rgb = np.clip(ref + shift, 0, 255)
    box = (rx0 - 4, ry0 - 4, rx1 + 5, ry1 + 5)
    w = int(round((box[2] - box[0]) * scale))
    h = int(round((box[3] - box[1]) * scale))
    head_rgb = np.asarray(Image.fromarray(rgb.astype(np.uint8)).crop(box).resize((w, h), Image.LANCZOS)).astype(float)
    a8 = Image.fromarray((ralpha * 255).astype(np.uint8)).crop(box).resize((w, h), Image.LANCZOS)
    head_a = (np.asarray(a8).astype(float) / 255)[..., None]
    px = int(round(center - (rx0 - box[0] + (rx1 - rx0) / 2) * scale))
    py = int(round(top - (ry0 - box[1]) * scale))
    ys, xs = slice(max(py, 0), py + h), slice(px, px + w)
    tile = result[ys, xs]
    sub_rgb = head_rgb[ys.start - py :, :][: tile.shape[0]]
    sub_a = head_a[ys.start - py :, :][: tile.shape[0]]
    result[ys, xs] = tile * (1 - sub_a) + sub_rgb * sub_a

    Image.fromarray(np.clip(result, 0, 255).round().astype(np.uint8)).save(out, optimize=True)
    print(f"OK: Seira placed in cell 1: center {center}, top {top}, hair tip {tip}, scale {scale:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
