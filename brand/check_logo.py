#!/usr/bin/env python3
"""Check the Seira logo files that brand/build_logo.py writes.

The logo face rule applies to seira-head.png.
It must show two eye blobs and one mouth blob in the official red, inside the visor.
A 2D face with pointed eyes and no mouth fails this check.
App icons must come from brand/logo/app-icon-source.png.
Each app icon must match that image and show the icon face: an open eye left of the centre,
a winking eye right of the centre, and a mouth below them.

Run: python3 brand/check_logo.py   Exit 0 on pass, 1 on fail.
"""
import base64
import functools
import io
import re
import struct
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

LANCZOS = Image.Resampling.LANCZOS

BRAND = Path(__file__).resolve().parent
ROOT = BRAND.parent
LOGO = BRAND / "logo"
DOCS_BRAND = ROOT / "docs/assets/brand"
VISOR = (277, 345, 752, 662)
ICON_SOURCE = LOGO / "app-icon-source.png"
MAX_SOURCE_DIFF = 1.0
OPAQUE_ICONS = {"public/apple-touch-icon.png"}

errors = []


def fail(message):
    errors.append(message)


def rel(path):
    return path.relative_to(ROOT).as_posix()


def open_image(path, size, mode):
    if not path.exists():
        fail(f"missing file: {rel(path)}")
        return None
    im = Image.open(path)
    if im.size != size:
        fail(f"{rel(path)}: size {im.size}, expected {size}")
    if im.mode != mode:
        fail(f"{rel(path)}: mode {im.mode}, expected {mode}")
    return im.convert("RGBA")


def red_blobs(im, min_area):
    a = np.asarray(im).astype(int)
    mask = (a[..., 3] > 200) & (a[..., 0] > 140) & (a[..., 0] - np.maximum(a[..., 1], a[..., 2]) > 70)
    h, w = mask.shape
    seen = np.zeros_like(mask)
    blobs = []
    for y, x in zip(*np.nonzero(mask)):
        if seen[y, x]:
            continue
        queue = deque([(y, x)])
        seen[y, x] = True
        pixels = []
        while queue:
            cy, cx = queue.popleft()
            pixels.append((cy, cx))
            for ny in range(max(cy - 1, 0), min(cy + 2, h)):
                for nx in range(max(cx - 1, 0), min(cx + 2, w)):
                    if mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        queue.append((ny, nx))
        if len(pixels) >= min_area:
            ys, xs = zip(*pixels)
            blobs.append((len(pixels), min(xs), min(ys), max(xs), max(ys)))
    return blobs


def check_face(im, label, visor, min_area):
    blobs = red_blobs(im, min_area)
    if len(blobs) != 3:
        fail(f"{label}: found {len(blobs)} red blobs, expected 3 (2 eyes and 1 mouth)")
        return
    blobs.sort(key=lambda b: (b[2] + b[4]) / 2)
    eyes = sorted(blobs[:2], key=lambda b: b[1])
    mouth = blobs[2]
    pad = max(1.5, im.width / 512)
    for blob in blobs:
        if blob[1] < visor[0] - pad or blob[2] < visor[1] - pad or blob[3] > visor[2] + pad or blob[4] > visor[3] + pad:
            fail(f"{label}: red pixels outside the visor")
    mid = im.width / 2
    if not (eyes[0][3] < mid < eyes[1][1]):
        fail(f"{label}: the eyes are not on both sides of the centre")
    if mouth[2] <= max(eyes[0][4], eyes[1][4]) or not eyes[0][3] < (mouth[1] + mouth[3]) / 2 < eyes[1][1]:
        fail(f"{label}: the mouth is not below and between the eyes")


def check_icon_face(im, label, min_area):
    blobs = red_blobs(im, min_area)
    if len(blobs) != 3:
        fail(f"{label}: found {len(blobs)} red blobs, expected 3 (open eye, winking eye, mouth)")
        return
    blobs.sort(key=lambda b: (b[2] + b[4]) / 2)
    eyes = sorted(blobs[:2], key=lambda b: b[1])
    mouth = blobs[2]
    mid = im.width / 2
    if not (eyes[0][3] < mid < eyes[1][1]):
        fail(f"{label}: the eyes are not on both sides of the centre")
    open_eye, wink = eyes
    if open_eye[4] - open_eye[2] <= open_eye[3] - open_eye[1]:
        fail(f"{label}: the left eye is not open (it must be taller than it is wide)")
    if wink[3] - wink[1] < 1.5 * (wink[4] - wink[2]):
        fail(f"{label}: the right eye does not wink (it must be at least 1.5 times as wide as it is tall)")
    if mouth[2] <= max(open_eye[4], wink[4]) or not open_eye[1] < (mouth[1] + mouth[3]) / 2 < wink[3]:
        fail(f"{label}: the mouth is not below and between the eyes")

@functools.cache
def load_source():
    if not ICON_SOURCE.exists():
        fail(f"missing file: {rel(ICON_SOURCE)}")
        return None
    im = Image.open(ICON_SOURCE)
    if im.size != (1024, 1024):
        fail(f"{rel(ICON_SOURCE)}: size {im.size}, expected (1024, 1024)")
    if im.mode != "RGB":
        fail(f"{rel(ICON_SOURCE)}: mode {im.mode}, expected RGB")
    return im.convert("RGB")


def check_icon(im, label, source):
    size = im.width
    a = np.asarray(im).astype(int)
    if label in OPAQUE_ICONS:
        if a[..., 3].min() != 255:
            fail(f"{label}: every alpha value must be 255")
    elif a[0, 0, 3] != 0:
        fail(f"{label}: corner pixel is not transparent, the tile must have rounded corners")
    if source is not None and size >= 64:
        ref = np.asarray(source.resize((size, size), LANCZOS)).astype(int)
        solid = a[..., 3] == 255
        diff = float(np.abs(a[..., :3] - ref)[solid].mean())
        if diff > MAX_SOURCE_DIFF:
            fail(f"{label}: does not match brand/logo/app-icon-source.png (mean difference {diff:.2f}, limit {MAX_SOURCE_DIFF})")
    if size >= 128:
        check_icon_face(im, label, 3 if size < 512 else 12)


def check_png_set():
    source = load_source()
    master = open_image(LOGO / "seira-head.png", (1024, 1024), "RGBA")
    if master:
        check_face(master, "seira-head.png", VISOR, 40)

    for size in (64, 128, 256, 512):
        open_image(LOGO / f"png/mark-{size}.png", (size, size), "RGBA")
    for size in (16, 32, 48):
        open_image(LOGO / f"png/favicon-{size}.png", (size, size), "RGBA")

    icons = [
        (LOGO / "png/icon-180.png", 180), (LOGO / "png/icon-192.png", 192),
        (LOGO / "png/icon-512.png", 512), (LOGO / "png/icon-1024.png", 1024),
        (ROOT / "build/icon-1024.png", 1024), (ROOT / "electron/resources/app-icon.png", 1024),
        (ROOT / "public/app-icon-512.png", 512), (ROOT / "public/app-icon-192.png", 192),
        (ROOT / "public/apple-touch-icon.png", 180), (ROOT / "apps/docs/public/app-icon-96.png", 96),
    ]
    for base in (16, 32, 64, 128, 256, 512):
        icons.append((ROOT / f"build/icon.iconset/icon_{base}x{base}.png", base))
        icons.append((ROOT / f"build/icon.iconset/icon_{base}x{base}@2x.png", base * 2))
    for path, size in icons:
        im = open_image(path, (size, size), "RGBA")
        if im:
            check_icon(im, rel(path), source)

    splash = ROOT / "electron/resources/splash-seira.webp"
    open_image(splash, (198, 232), "RGBA")


def check_appx():
    out = ROOT / "build/appx"
    squares = {"StoreLogo": 50, "Square150x150Logo": 150, "Square44x44Logo": 44}
    wanted = []
    for name, base in squares.items():
        for scale in (100, 200):
            wanted.append((out / f"{name}.scale-{scale}.png", base * scale // 100, base * scale // 100))
    for size in (16, 24, 32, 48, 256):
        wanted.append((out / f"Square44x44Logo.targetsize-{size}.png", size, size))
        wanted.append((out / f"Square44x44Logo.targetsize-{size}_altform-unplated.png", size, size))
    for scale in (100, 200):
        wanted.append((out / f"Wide310x150Logo.scale-{scale}.png", 310 * scale // 100, 150 * scale // 100))
    for path, width, height in wanted:
        im = open_image(path, (width, height), "RGBA")
        if im and height >= 128:
            left = (width - height) // 2
            square = im.crop((left, 0, left + height, height))
            check_icon_face(square, rel(path), 3)
    if out.exists():
        for path in sorted(out.iterdir()):
            if path.suffix != ".png":
                fail(f"{rel(path)}: build/appx holds only images")

def embedded_png(path):
    if not path.exists():
        fail(f"missing file: {rel(path)}")
        return None
    match = re.search(r'base64,([^"]+)"', path.read_text(encoding="utf-8"))
    if not match:
        fail(f"{rel(path)}: no embedded image")
        return None
    return Image.open(io.BytesIO(base64.b64decode(match.group(1)))).convert("RGBA")


def check_svgs():
    source = load_source()
    for path in (ROOT / "build/icon.svg", ROOT / "public/app-icon.svg"):
        im = embedded_png(path)
        if im:
            if im.size != (512, 512):
                fail(f"{rel(path)}: embedded image size {im.size}")
            else:
                check_icon(im, rel(path), source)
    for suffix in ("", "-reversed"):
        for path in (LOGO / f"svg/seira-lockup{suffix}.svg", DOCS_BRAND / f"seira-lockup{suffix}.svg",
                     LOGO / f"svg/seira-wordmark{suffix}.svg"):
            if not path.exists():
                fail(f"missing file: {rel(path)}")
        lockup, copy = LOGO / f"svg/seira-lockup{suffix}.svg", DOCS_BRAND / f"seira-lockup{suffix}.svg"
        if lockup.exists() and copy.exists() and lockup.read_bytes() != copy.read_bytes():
            fail(f"{rel(copy)} differs from {rel(lockup)}")
        if lockup.exists() and "<image" not in lockup.read_text(encoding="utf-8"):
            fail(f"{rel(lockup)}: no head image")


def check_containers():
    ico = ROOT / "build/icon.ico"
    if ico.exists():
        sizes = {(e[0] or 256, e[1] or 256) for e in (struct.unpack("<BBBBHHII", ico.read_bytes()[6 + 16 * i:6 + 16 * (i + 1)]) for i in range(struct.unpack("<H", ico.read_bytes()[4:6])[0]))}
        want = {(s, s) for s in (16, 24, 32, 48, 64, 128, 256)}
        if sizes != want:
            fail(f"build/icon.ico: sizes {sorted(sizes)}, expected {sorted(want)}")
    else:
        fail("missing file: build/icon.ico")

    fav = LOGO / "favicon.ico"
    if fav.exists():
        count = struct.unpack("<H", fav.read_bytes()[4:6])[0]
        if count != 3:
            fail(f"brand/logo/favicon.ico: {count} images, expected 3")
    else:
        fail("missing file: brand/logo/favicon.ico")

    icns = ROOT / "build/icon.icns"
    if icns.exists():
        found = {w * scale for w, _, scale in Image.open(icns).info["sizes"]}
        for size in (32, 64, 128, 256, 512, 1024):
            if size not in found:
                fail(f"build/icon.icns: no {size} px image")
    else:
        fail("missing file: build/icon.icns")


def check_no_flat_files():
    banned = [r"seira-mark.*\.svg", r"seira-icon\.svg", r"favicon\.svg", r"mark-reversed-.*", r"mark-(68|178|356|712)\.png", r"icon-288\.png"]
    for folder in (LOGO, DOCS_BRAND):
        for path in sorted(folder.rglob("*")):
            if path.is_file() and any(re.fullmatch(p, path.name) for p in banned):
                fail(f"old flat file remains: {rel(path)}")


def main():
    check_png_set()
    check_appx()
    check_svgs()
    check_containers()
    check_no_flat_files()
    if errors:
        for message in errors:
            print(f"FAIL: {message}")
        return 1
    print("logo files ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
