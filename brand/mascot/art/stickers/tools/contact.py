#!/usr/bin/env python3
"""Contact sheets from manifest.json: every sprite on mid-grey, on dark, and with pivot marks.

Usage: python3 tools/contact.py [--cell N]
Writes contact/contact-<group>-{grey,dark,pivots}.png for groups hands, acc, fx.
fx sprites are also shown at 48 px (the smallest size that they must stay readable at).
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

BACKS = {"grey": (128, 128, 128), "dark": (20, 22, 27), "pivots": (178, 182, 190)}


def font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def collect(m, group):
    items = []
    if group == "hands":
        for k, v in m["hands"].items():
            items.append((k, v["file"], v["pivot"]))
    elif group == "acc":
        for k, v in m["accessories"].items():
            items.append((k, v["file"], v["pivot"]))
            for view, f in v.get("files", {}).items():
                items.append((k + " " + view, f, v.get("pivots", {}).get(view)))
    else:
        for k, v in m["fx"].items():
            for i, f in enumerate(v["frames"]):
                items.append((k if len(v["frames"]) == 1 else "%s %d" % (k, i + 1), f, v["pivot"]))
    return items


def make(items, back, marks, cell, small):
    cols = max(1, min(len(items), 1600 // (cell + 16)))
    rows = (len(items) + cols - 1) // cols
    lab_h = 24
    cw, ch = cell + 16, cell + lab_h + 16
    W, H = cols * cw, rows * ch
    sheet = Image.new("RGB", (W, H), back)
    dr = ImageDraw.Draw(sheet)
    f = font(14)
    for i, (name, path, pivot) in enumerate(items):
        im = Image.open(os.path.join(C.BASE, path)).convert("RGBA")
        s = min(1.0, cell / max(im.size))
        view = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS) if s < 1 else im
        x = (i % cols) * cw + (cw - view.width) // 2
        y = (i // cols) * ch + 8 + (cell - view.height) // 2
        sheet.paste(view, (x, y), view)
        if marks and pivot:
            px, py = x + pivot[0] * s, y + pivot[1] * s
            dr.line([(px - 9, py), (px + 9, py)], fill=(255, 0, 255), width=2)
            dr.line([(px, py - 9), (px, py + 9)], fill=(255, 0, 255), width=2)
        if small:
            t = im.resize((max(1, round(48 * im.width / max(im.size))), max(1, round(48 * im.height / max(im.size)))), Image.LANCZOS)
            sheet.paste(t, ((i % cols) * cw + cw - 54, (i // cols) * ch + 8), t)
        dr.text(((i % cols) * cw + 8, (i // cols) * ch + cell + 14), "%s  %dx%d" % (name, im.width, im.height),
                fill=(255, 255, 255) if back[0] < 100 else (20, 20, 20), font=f)
    return sheet


def main(argv):
    cell = 280
    if "--cell" in argv:
        cell = int(argv[argv.index("--cell") + 1])
    with open(C.MANIFEST) as fh:
        m = json.load(fh)
    os.makedirs(os.path.join(C.BASE, "contact"), exist_ok=True)
    for group in ("hands", "acc", "fx"):
        items = collect(m, group)
        if not items:
            continue
        for bname, back in BACKS.items():
            sheet = make(items, back, marks=(bname == "pivots"), cell=cell if group != "fx" else min(cell, 220), small=(group == "fx"))
            out = os.path.join(C.BASE, "contact", "contact-%s-%s.png" % (group, bname))
            sheet.save(out)
            print(out.replace(C.BASE + os.sep, ""), sheet.size)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
