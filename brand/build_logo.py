#!/usr/bin/env python3
"""Build the Seira logo files and the app icons.

The logo files come from one master: the 3D head with the official face.
The master is brand/mascot/art/bases/out/seira/front.png with the resting face of
brand/mascot/runtime/face.js drawn on the visor.
The app icons come from brand/logo/app-icon-source.png, the same image as the mobile app icon.

Run: python3 brand/build_logo.py
The output is byte-identical on every run.
"""
import base64
import io
import math
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

BRAND = Path(__file__).resolve().parent
ROOT = BRAND.parent
BASE = BRAND / "mascot/art/bases/out/seira"
LOGO = BRAND / "logo"
ICON_SOURCE = LOGO / "app-icon-source.png"
DOCS_BRAND = ROOT / "docs/assets/brand"

LANCZOS = Image.Resampling.LANCZOS

SCREEN = (12, 15, 20)
EYE_COLOR = (255, 42, 87)

# Face unit and layout of brand/mascot/runtime/face.js (Fibonacci numbers times U).
U = 6
FW, FH = 1024, 640
EW, EH = 21 * U, 34 * U
GAP = 2 * 13 * U
EYE_TOP = FH * 0.45 - EH / 2
EYE_CY = EYE_TOP + EH / 2
EYE_CX = (FW / 2 - GAP / 2 - EW / 2, FW / 2 + GAP / 2 + EW / 2)
MOUTH_Y = EYE_TOP + EH + 8 * U
GLOW_BLUR = 5 * U

# bot.js scales the face canvas to the width of the front visor box and centres it there.
VISOR_BOX = (277, 345, 475, 317)
SS = 4
REGION = (256, 320, 768, 688)

ICON_RADIUS = 0.2246
ICON_SIZE = 1024
MARK_FILL = 0.92
SPLASH_SIZE = (198, 232)
SPLASH_BOX = (190, 224)

ICNS_SIZES = (16, 32, 64, 128, 256, 512, 1024)
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
ICONSET_SIZES = ((16, 1), (16, 2), (32, 1), (32, 2), (64, 1), (64, 2), (128, 1), (128, 2),
                (256, 1), (256, 2), (512, 1), (512, 2))

WORDMARK_X = 233
LOCKUP_GAP = 56
LOCKUP_HEIGHT = 178


def mix(rgb, other, k):
    return tuple(c * (1 - k) + o * k for c, o in zip(rgb, other))


def region_shape():
    x0, y0, x1, y1 = REGION
    return (y1 - y0) * SS, (x1 - x0) * SS


def to_layer(fx, fy):
    k = VISOR_BOX[2] / FW
    cx = VISOR_BOX[0] + VISOR_BOX[2] / 2
    cy = VISOR_BOX[1] + VISOR_BOX[3] / 2
    return ((cx + (fx - FW / 2) * k - REGION[0]) * SS, (cy + (fy - FH / 2) * k - REGION[1]) * SS)


def layer_scale():
    return VISOR_BOX[2] / FW * SS


def face_grid():
    h, w = region_shape()
    k = layer_scale()
    cx = VISOR_BOX[0] + VISOR_BOX[2] / 2
    cy = VISOR_BOX[1] + VISOR_BOX[3] / 2
    xs = ((np.arange(w) + 0.5) / SS + REGION[0] - cx) / (k / SS) + FW / 2
    ys = ((np.arange(h) + 0.5) / SS + REGION[1] - cy) / (k / SS) + FH / 2
    return np.meshgrid(xs, ys)


def quad(p0, p1, p2, n=48):
    t = np.linspace(0, 1, n)[:, None]
    p0, p1, p2 = map(np.array, (p0, p1, p2))
    return (1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t ** 2 * p2


def draw_screen(shape):
    """The glass of face.js drawScreen: a vertical gradient and a soft shade near the rim."""
    fx, fy = face_grid()
    top = np.array(mix(SCREEN, (255, 255, 255), 0.04))
    bottom = np.array(mix(SCREEN, (0, 0, 0), 0.55))
    t = np.clip(fy / FH, 0, 1)[..., None]
    rgb = top * (1 - t) + bottom * t

    c0, r0 = np.array([FW / 2, FH * 0.45]), FH * 0.32
    c1, r1 = np.array([FW / 2, FH * 0.5]), FW * 0.62
    dx, dy = fx - c0[0], fy - c0[1]
    cd, dr = c1 - c0, r1 - r0
    a = cd @ cd - dr * dr
    b = dx * cd[0] + dy * cd[1] + r0 * dr
    c = dx * dx + dy * dy - r0 * r0
    disc = np.sqrt(np.maximum(b * b - a * c, 0))
    s = np.clip(np.where(abs(a) < 1e-9, c / (2 * b), (b + disc) / a), 0, 1)
    shade = (0.5 * s)[..., None]
    rgb = rgb * (1 - shade)
    return rgb


def stroke_arc(draw, center, radius, a0, a1, width, scale):
    n = max(int(abs(a1 - a0) * radius * scale / 0.4), 8)
    for ang in np.linspace(a0, a1, n):
        x, y = to_layer(center[0] + math.cos(ang) * radius, center[1] + math.sin(ang) * radius)
        r = width / 2 * scale
        draw.ellipse((x - r, y - r, x + r, y + r), fill=255)


def pill_mask(shape, cx, cy):
    img = Image.new("L", (shape[1], shape[0]), 0)
    x0, y0 = to_layer(cx - EW / 2, cy - EH / 2)
    x1, y1 = to_layer(cx + EW / 2, cy + EH / 2)
    ImageDraw.Draw(img).rounded_rectangle((x0, y0, x1, y1), radius=min(EW, EH) / 2 * layer_scale(), fill=255)
    return img


def lash_mask(shape, ex, ey, out):
    img = Image.new("L", (shape[1], shape[0]), 0)
    first = quad((ex - out * 5 * U, ey + 3 * U), (ex + out * 2 * U, ey - 0.5 * U), (ex + out * 8 * U, ey - 1 * U))
    second = quad((ex + out * 8 * U, ey - 1 * U), (ex + out * 3 * U, ey + 5 * U), (ex, ey + 13 * U))
    pts = [to_layer(*p) for p in np.vstack([first, second])]
    ImageDraw.Draw(img).polygon(pts, fill=255)
    return img


def mouth_mask(shape):
    img = Image.new("L", (shape[1], shape[0]), 0)
    stroke_arc(ImageDraw.Draw(img), (FW / 2, MOUTH_Y - 4 * U), 7 * U, math.pi * 0.2, math.pi * 0.8, 2 * U, layer_scale())
    return img


def highlight_mask(shape, cx, out):
    img = Image.new("L", (shape[1], shape[0]), 0)
    r = 6 * U / 2
    hx = cx - out * max(0, EW / 2 - 5 * U - r)
    hy = EYE_TOP + 5 * U + r
    x, y = to_layer(hx, hy)
    pr = r * layer_scale()
    ImageDraw.Draw(img).ellipse((x - pr, y - pr, x + pr, y + pr), fill=255)
    return img


def over(canvas, mask, rgb, alpha=1.0):
    a = (np.asarray(mask, dtype=np.float32) / 255.0 * alpha)[..., None]
    canvas[:] = canvas * (1 - a) + np.array(rgb, dtype=np.float32) * a


def glow(mask):
    sigma = GLOW_BLUR / 2 * layer_scale()
    return mask.filter(ImageFilter.GaussianBlur(sigma))


def draw_face_region():
    """The resting face as face.js draws it: both eyes open, gaze ahead, lashes, smile."""
    shape = region_shape()
    canvas = draw_screen(shape).astype(np.float32)

    shapes = []
    for i, cx in enumerate(EYE_CX):
        out = -1 if i == 0 else 1
        shapes.append(("eye", pill_mask(shape, cx, EYE_CY), cx, out))
        shapes.append(("lash", lash_mask(shape, cx + out * EW / 2, EYE_TOP, out), cx, out))
    shapes.append(("mouth", mouth_mask(shape), None, 0))

    for kind, mask, cx, out in shapes:
        over(canvas, glow(mask), EYE_COLOR, 0.85)
        over(canvas, mask, EYE_COLOR)
        if kind == "eye":
            over(canvas, highlight_mask(shape, cx, out), (255, 255, 255))

    fx, fy = face_grid()
    inside = (((fx - FW * 0.5) / (FW * 0.42)) ** 2 + ((fy - FH * 0.06) / (FH * 0.24)) ** 2) <= 1
    ramp = np.clip((fy - FH * 0.02) / (FH * 0.28), 0, 1)
    gloss = np.where(inside, 0.10 * (1 - ramp), 0.0)[..., None]
    canvas[:] = canvas * (1 - gloss) + 255 * gloss
    return canvas


def build_master():
    base = Image.open(BASE / "front.png").convert("RGBA")
    visor = Image.open(BASE / "front.visor.png").convert("L")
    region = np.clip(draw_face_region() + 0.5, 0, 255).astype(np.uint8)
    face = Image.fromarray(region, "RGB").resize((REGION[2] - REGION[0], REGION[3] - REGION[1]), LANCZOS)
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    layer.paste(face.convert("RGBA"), REGION[:2])
    mask = visor.copy()
    layer.putalpha(Image.fromarray(np.minimum(np.asarray(mask), np.asarray(layer.getchannel("A"))), "L"))
    return Image.alpha_composite(base, layer)


def head_box(im):
    return im.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()


def fit(im, box_w, box_h):
    scale = min(box_w / im.width, box_h / im.height)
    return im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), LANCZOS)


def centred(im, size, fill):
    inner = fit(im.crop(head_box(im)), round(size * fill), round(size * fill))
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(inner, ((size - inner.width) // 2, (size - inner.height) // 2))
    return canvas


def load_icon_source():
    im = Image.open(ICON_SOURCE).convert("RGBA")
    if im.size != (ICON_SIZE, ICON_SIZE):
        im = im.resize((ICON_SIZE, ICON_SIZE), LANCZOS)
    return im


def app_icon_master():
    tile = load_icon_source()
    big = ICON_SIZE * 4
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, big - 1, big - 1), radius=ICON_RADIUS * big, fill=255)
    tile.putalpha(mask.resize((ICON_SIZE, ICON_SIZE), LANCZOS))
    return tile


def touch_icon():
    # iOS fills transparent pixels of an apple-touch-icon with black and applies its own corner mask.
    return load_icon_source().resize((180, 180), LANCZOS)


def sharpen(im):
    return im.filter(ImageFilter.UnsharpMask(radius=0.6, percent=60, threshold=0))


def png_bytes(im):
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def write_png(path, im):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png_bytes(im))


def write_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.encode("utf-8"))


def icon_svg(tile512):
    data = base64.b64encode(png_bytes(tile512)).decode("ascii")
    return ('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            'viewBox="0 0 512 512" width="512" height="512"><title>Seira</title>'
            f'<image width="512" height="512" xlink:href="data:image/png;base64,{data}"/></svg>\n')


def wordmark_body(name):
    text = (DOCS_BRAND / name).read_text(encoding="utf-8")
    match = re.search(r"</title>(.*)</svg>", text, re.S)
    return match.group(1)


def lockup_svg(master, wordmark_name):
    box = head_box(master)
    head = master.crop(box)
    height = LOCKUP_HEIGHT
    width = round(head.width * height / head.height)
    pixels = fit(head, width * 2, height * 2)
    data = base64.b64encode(png_bytes(pixels)).decode("ascii")
    shift = width + LOCKUP_GAP - WORDMARK_X
    total = 924 + shift
    return (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            f'viewBox="0 0 {total} {height}" width="{total}" height="{height}" role="img" aria-label="seira.bot">'
            f'<title>seira.bot</title>'
            f'<image x="0" y="0" width="{width}" height="{height}" xlink:href="data:image/png;base64,{data}"/>'
            f'<g transform="translate({shift} 0)">{wordmark_body(wordmark_name)}</g></svg>\n')


def build_splash(master):
    head = master.crop(head_box(master))
    inner = fit(head, *SPLASH_BOX)
    canvas = Image.new("RGBA", SPLASH_SIZE, (0, 0, 0, 0))
    canvas.alpha_composite(inner, ((SPLASH_SIZE[0] - inner.width) // 2, (SPLASH_SIZE[1] - inner.height) // 2))
    return canvas


def main():
    master = build_master()
    write_png(LOGO / "seira-head.png", master)

    for size in (64, 128, 256, 512):
        write_png(LOGO / f"png/mark-{size}.png", centred(master, size, MARK_FILL))

    tile = app_icon_master()
    tiles = {size: tile if size == tile.width else tile.resize((size, size), LANCZOS)
             for size in sorted({16, 24, 32, 48, 64, 128, 180, 192, 256, 512, 1024})}
    for size in (180, 192, 512, 1024):
        write_png(LOGO / f"png/icon-{size}.png", tiles[size])

    favicons = {}
    for size in (16, 32, 48):
        icon = tiles[size]
        favicons[size] = sharpen(icon) if size <= 32 else icon
        write_png(LOGO / f"png/favicon-{size}.png", favicons[size])
    favicons[48].save(LOGO / "favicon.ico", format="ICO", sizes=[(s, s) for s in favicons],
                      append_images=[favicons[s] for s in (16, 32)])

    for suffix in ("", "-reversed"):
        write_text(LOGO / f"svg/seira-wordmark{suffix}.svg", (DOCS_BRAND / f"seira-wordmark{suffix}.svg").read_text(encoding="utf-8"))
        lockup = lockup_svg(master, f"seira-wordmark{suffix}.svg")
        write_text(LOGO / f"svg/seira-lockup{suffix}.svg", lockup)
        write_text(DOCS_BRAND / f"seira-lockup{suffix}.svg", lockup)

    write_png(ROOT / "build/icon-1024.png", tiles[1024])
    write_png(ROOT / "electron/resources/app-icon.png", tiles[1024])
    for base, scale in ICONSET_SIZES:
        write_png(ROOT / f"build/icon.iconset/icon_{base}x{base}{'@2x' if scale == 2 else ''}.png", tiles[base * scale])
    ico_tiles = [tiles[s] for s in ICO_SIZES]
    ico_tiles[-1].save(ROOT / "build/icon.ico", format="ICO", sizes=[(s, s) for s in ICO_SIZES],
                       append_images=ico_tiles[:-1])
    tiles[1024].save(ROOT / "build/icon.icns", format="ICNS", append_images=[tiles[s] for s in ICNS_SIZES[:-1]])

    svg = icon_svg(tiles[512])
    write_text(ROOT / "build/icon.svg", svg)
    write_text(ROOT / "public/app-icon.svg", svg)
    write_png(ROOT / "public/app-icon-512.png", tiles[512])
    write_png(ROOT / "public/app-icon-192.png", tiles[192])
    write_png(ROOT / "public/apple-touch-icon.png", touch_icon())

    splash = build_splash(master)
    splash.save(ROOT / "electron/resources/splash-seira.webp", format="WEBP", quality=92, alpha_quality=100, method=6)
    return 0


if __name__ == "__main__":
    sys.exit(main())
