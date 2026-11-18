#!/usr/bin/env python3
"""Check the sticker set against CONTRACT.md, section "Stickers". Exit 0 when all checks pass.

Checks:
  - every required hand, accessory, and fx id exists in manifest.json (variants and slots included)
  - every listed file exists, is a PNG with an alpha channel that has transparent and opaque pixels
  - no side is larger than 512 px; every pivot lies inside a sensible range
  - no green fringe: no visible pixel is clearly green
  - fx sprites are light enough for 300 live particles (total decoded bytes of all frames, largest sprite)
"""
import json
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

REQUIRED_HANDS = ["open", "wave", "fist", "point", "peace", "thumbs-up", "ok", "chin", "fan", "hold", "pat"]
REQUIRED_ACC = {"earring": "ear", "glasses": "face", "sunglasses": "face", "headphones": "ear", "ribbon": "hair",
                "hairpin": "hair", "tiara": "hair", "cap": "top", "antenna": "top", "scarf": "neck",
                "bowtie": "neck", "headset-mic": "ear"}
YAW45_ACC = ["glasses", "sunglasses", "headphones", "cap"]
ANCHORS = C.ALLOWED_ANCHORS
MAX_PARTICLE_FRAME_BYTES = 256 * 256 * 4   # largest decoded fx frame
BUDGET_300_PARTICLES = 24 * 1024 * 1024    # memory budget: all fx frames decoded, in bytes

errors = []
notes = []


def err(msg):
    errors.append(msg)


def check_png(path, what, pivot=None, need_alpha=True):
    full = os.path.join(C.BASE, path)
    if not os.path.isfile(full):
        err("%s: file missing: %s" % (what, path))
        return None
    try:
        im = Image.open(full)
        im.load()
    except Exception as e:  # noqa: BLE001
        err("%s: cannot read %s: %s" % (what, path, e))
        return None
    if im.mode != "RGBA":
        err("%s: %s is %s, expected RGBA" % (what, path, im.mode))
        return None
    w, h = im.size
    if max(w, h) > C.MAX_SIDE:
        err("%s: %s is %dx%d, larger than %d" % (what, path, w, h, C.MAX_SIDE))
    a = np.asarray(im)
    al = a[..., 3]
    if need_alpha and not ((al == 0).any() and (al > 200).any()):
        err("%s: %s has no transparent or no opaque pixels" % (what, path))
    # green fringe: visible pixel where green clearly dominates
    vis = al > 8
    r, g, b = a[..., 0].astype(int), a[..., 1].astype(int), a[..., 2].astype(int)
    green = vis & ((g - np.maximum(r, b)) > 24)
    if green.sum() > 0:
        err("%s: %s has %d green-tinted visible pixels" % (what, path, int(green.sum())))
    # padding: the first and last rows and columns should stay clear
    if (al[0] > 8).any() or (al[-1] > 8).any() or (al[:, 0] > 8).any() or (al[:, -1] > 8).any():
        err("%s: %s touches the image edge (cut off or no padding)" % (what, path))
    if pivot is not None:
        if not (isinstance(pivot, list) and len(pivot) == 2 and all(isinstance(v, (int, float)) for v in pivot)):
            err("%s: bad pivot %r" % (what, pivot))
        elif not (-w <= pivot[0] <= 2 * w and -h <= pivot[1] <= 2 * h):
            err("%s: pivot %r is far outside %dx%d" % (what, pivot, w, h))
    return im


def main():
    if not os.path.isfile(C.MANIFEST):
        print("FAIL: manifest.json is missing")
        return 1
    with open(C.MANIFEST) as fh:
        m = json.load(fh)
    if m.get("version") != 2:
        err("manifest version must be 2")
    n_files = 0

    for h in REQUIRED_HANDS:
        e = m.get("hands", {}).get(h)
        if not e:
            err("hand missing: %s" % h)
            continue
        if e.get("side") != "right":
            err("hand %s: side must be right" % h)
        check_png(e["file"], "hand " + h, e.get("pivot"))
        n_files += 1

    for aid, slot in REQUIRED_ACC.items():
        e = m.get("accessories", {}).get(aid)
        if not e:
            err("accessory missing: %s" % aid)
            continue
        if e.get("slot") != slot:
            err("accessory %s: slot %r, expected %r" % (aid, e.get("slot"), slot))
        if e.get("anchor") not in ANCHORS:
            err("accessory %s: anchor %r not allowed" % (aid, e.get("anchor")))
        if not e.get("label"):
            err("accessory %s: no label" % aid)
        if not isinstance(e.get("width"), (int, float)) or e["width"] <= 0:
            err("accessory %s: bad width" % aid)
        if not e.get("views"):
            err("accessory %s: no views" % aid)
        check_png(e["file"], "accessory " + aid, e.get("pivot"))
        n_files += 1
        if aid in YAW45_ACC:
            f = e.get("files", {}).get("yaw45")
            if not f:
                err("accessory %s: yaw45 file missing" % aid)
            else:
                check_png(f, "accessory %s yaw45" % aid, e.get("pivots", {}).get("yaw45"))
                n_files += 1
            if "yaw45" not in e.get("views", []):
                err("accessory %s: views lacks yaw45" % aid)

    total_bytes, biggest = 0, 0
    for fid in C.REQUIRED_FX:
        e = m.get("fx", {}).get(fid)
        if not e:
            err("fx missing: %s" % fid)
            continue
        if not e.get("label"):
            err("fx %s: no label" % fid)
        frames = e.get("frames", [])
        need = C.FX_MIN_FRAMES.get(fid, 1)
        if len(frames) < need:
            err("fx %s: %d frames, expected at least %d" % (fid, len(frames), need))
        sizes = set()
        for f in frames:
            im = check_png(f, "fx " + fid, e.get("pivot"))
            n_files += 1
            if im is not None:
                sizes.add(im.size)
                total_bytes += im.width * im.height * 4
                biggest = max(biggest, im.width * im.height * 4)
        if len(sizes) > 1:
            err("fx %s: frames differ in size %s (one pivot needs one size)" % (fid, sorted(sizes)))

    if biggest > MAX_PARTICLE_FRAME_BYTES:
        err("largest fx frame is %d bytes decoded, limit %d" % (biggest, MAX_PARTICLE_FRAME_BYTES))
    if total_bytes > BUDGET_300_PARTICLES:
        err("fx frames use %d bytes decoded, budget %d" % (total_bytes, BUDGET_300_PARTICLES))
    # 300 live particles draw from a few shared images, so the cost is draw calls and the largest frame size
    notes.append("fx decoded memory: %.2f MB for all frames, largest frame %d bytes" % (total_bytes / 1048576.0, biggest))

    for k in ("hands", "accessories", "fx"):
        notes.append("%s: %d ids" % (k, len(m.get(k, {}))))
    notes.append("files checked: %d" % n_files)

    for n in notes:
        print(n)
    if errors:
        print("FAIL: %d problem(s)" % len(errors))
        for e in errors:
            print("  - " + e)
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
