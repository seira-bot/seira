#!/usr/bin/env python3
"""Build the seira.bot logo files (SVG, PNG, ICO) from one set of Fibonacci parameters.

The logo is the face of a female bot: long hair with a fringe, a face window,
and two eyes with a highlight and a lash wing.

Run: python3 brand/build_logo.py [output_dir]
The script is deterministic. Two runs give identical files.
"""
import math
import os
import struct
import sys

import numpy as np
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from PIL import Image, ImageFont, features

# ---------------------------------------------------------------------------
# PARAMETERS (all tunable values live in this block)
# ---------------------------------------------------------------------------
MASTER_KS = [6, 7, 8, 9, 10, 11]      # master R = F(k): 8, 13, 21, 34, 55, 89
DETAIL_MIN_K = 9                      # highlight and lash wing only from this k
MAIN_K = 11                           # master used for the SVG files

INK = "#0E1116"
SILVER = "#E9ECEF"
RED = "#E11D48"
WHITE = "#FFFFFF"

SS = 16                               # samples per pixel on each axis (16 x 16)
STRIP_ROWS = 4                        # pixel rows per strip (limits peak memory)

# Opaque face variant (favicons): name, k, scale, N, ox, oy
FACE_RASTERS = [
    ("favicon-16.png", 6, 1, 16, 0, 0),
    ("favicon-32.png", 7, 1, 32, 3, 3),
    ("favicon-48.png", 8, 1, 48, 3, 3),
]
# Transparent marks: name, k, scale, N, ox, oy, hair colour
MARK_RASTERS = [
    ("mark-68.png", 9, 1, 68, 0, 0, INK),
    ("mark-178.png", 11, 1, 178, 0, 0, INK),
    ("mark-356.png", 11, 2, 356, 0, 0, INK),
    ("mark-712.png", 11, 4, 712, 0, 0, INK),
    ("mark-reversed-178.png", 11, 1, 178, 0, 0, SILVER),
    ("mark-reversed-356.png", 11, 2, 356, 0, 0, SILVER),
]
# Opaque tiles (INK ground, SILVER hair): name, k, scale, N, ox, oy
TILE_RASTERS = [
    ("icon-180.png", 10, 1, 180, 35, 35),
    ("icon-192.png", 10, 1, 192, 41, 41),
    ("icon-288.png", 11, 1, 288, 55, 55),
    ("icon-512.png", 11, 2, 512, 78, 78),
]
ICO_SOURCES = ["favicon-16.png", "favicon-32.png", "favicon-48.png"]

# Animation (units are user units of the 178 master)
ANIM_STYLE = (
    ".eye{transform-box:fill-box;transform-origin:center;animation:blink 8s infinite}"
    ".eyes{animation:look 8s infinite cubic-bezier(.4,0,.2,1)}"
    "@keyframes blink{0%,22%,26%,60%,64%,68%,100%{transform:scaleY(1)}"
    "24%,62%,66%{transform:scaleY(.1)} }"
    "@keyframes look{0%,30%,60%,100%{transform:translate(0,0)}"
    "34%,46%{transform:translate(5px,0)}50%,56%{transform:translate(-5px,3px)} }"
    "@media (prefers-reduced-motion:reduce){.eye,.eyes{animation:none} }"
)

# Icon
ICON_SIZE = 288
ICON_RADIUS = 55
ICON_OFFSET = 55

# Lockup
# Geist Sans TTF folder: SEIRA_FONT_DIR from the environment or from brand/.env.local.
# Without it, the script searches FONT_SEARCH. See brand/.env.example.
FONT_ENV = "SEIRA_FONT_DIR"
FONT_SEARCH = ["~/.local/share/fonts", "~/.fonts", "~/Library/Fonts",
               "/usr/local/share/fonts", "/usr/share/fonts"]
FONT_WEIGHTS = ["Medium", "SemiBold", "Bold", "ExtraBold"]
LOCKUP_TEXT = "seira.bot"
LOCKUP_HEIGHT = 178
BASELINE_Y = 144
XHEIGHT_Y = 55
TEXT_X0 = 233                         # x of the first glyph bbox xMin
TARGET_STEM = 21                      # target stem width of glyph "i" in px
PERIOD_DIAMETER = 21

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logo")


# ---------------------------------------------------------------------------
# Fibonacci masters
# ---------------------------------------------------------------------------
def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a


F = [fib(n) for n in range(20)]


def master(k):
    """Return the geometry of one master (all values in master units)."""
    R = F[k]
    m = dict(
        k=k, R=R, W=2 * R,
        lock=F[k - 2], r=F[k - 1], fringe=F[k - 1],
        ew=F[k - 3], eh=F[k - 2], og=F[k - 3], hg=F[k - 4], chin=F[k - 2],
        detail=k >= DETAIL_MIN_K,
    )
    # Bands must add up to W on both axes.
    assert 2 * (m["lock"] + m["og"] + m["ew"] + m["hg"]) == m["W"]
    assert m["fringe"] + m["ew"] + m["eh"] + m["chin"] + m["chin"] == m["W"]
    assert m["R"] - m["lock"] == m["r"]
    m["eye_y"] = m["fringe"] + m["ew"]
    m["eye_xl"] = m["lock"] + m["og"]
    m["eye_xr"] = R + m["hg"]
    if m["detail"]:
        m["hd"] = F[k - 5]
        m["hi"] = F[k - 6]            # highlight gap to the top and right eye edge
        m["wa"], m["wb"], m["wc"], m["wd"] = F[k - 6], F[k - 7], F[k - 5], F[k - 4]
    return m


def num(v):
    """Format a number for SVG. Integers have no decimal point."""
    if float(v) == int(v):
        return str(int(v))
    return repr(float(v))


# ---------------------------------------------------------------------------
# Shapes (as numbers, shared by the SVG writer and the rasteriser)
# ---------------------------------------------------------------------------
def eye_shapes(m, side):
    """Return the pill, hole, and wing of one eye. side is 'l' or 'r'."""
    x0 = m["eye_xl"] if side == "l" else m["eye_xr"]
    y0 = m["eye_y"]
    ew, eh = m["ew"], m["eh"]
    pill = (x0, y0, ew, eh)
    if not m["detail"]:
        return pill, None, None
    hd = m["hd"]
    # Inner upper side: left eye highlight sits right, right eye highlight sits left.
    cx = x0 + ew - m["hi"] - hd / 2 if side == "l" else x0 + m["hi"] + hd / 2
    cy = y0 + m["hi"] + hd / 2
    a, b, c, d = m["wa"], m["wb"], m["wc"], m["wd"]
    if side == "r":
        ox = x0 + ew
        wing = [(ox - a, y0 + b), (ox + c, y0), (ox, y0 + d)]
    else:
        ox = x0
        wing = [(ox + a, y0 + b), (ox, y0 + d), (ox - c, y0)]
    return pill, (cx, cy, hd / 2), wing


def hair_path(m):
    R, W, lock, r, fr = m["R"], m["W"], m["lock"], m["r"], m["fringe"]
    n = num
    return (
        f"M0 {n(W)}V{n(R)}A{n(R)} {n(R)} 0 0 1 {n(W)} {n(R)}V{n(W)}Z "
        f"M{n(lock)} {n(fr)}H{n(W - lock)}V{n(R)}A{n(r)} {n(r)} 0 0 1 {n(lock)} {n(R)}Z"
    )


def pill_path(x, y, ew, eh):
    rr = ew / 2
    n = num
    return (
        f"M{n(x)} {n(y + rr)}A{n(rr)} {n(rr)} 0 0 1 {n(x + ew)} {n(y + rr)}"
        f"V{n(y + eh - rr)}A{n(rr)} {n(rr)} 0 0 1 {n(x)} {n(y + eh - rr)}Z"
    )


def hole_path(cx, cy, hr):
    n = num
    return (
        f"M{n(cx - hr)} {n(cy)}A{n(hr)} {n(hr)} 0 1 0 {n(cx + hr)} {n(cy)}"
        f"A{n(hr)} {n(hr)} 0 1 0 {n(cx - hr)} {n(cy)}Z"
    )


def wing_path(pts):
    n = num
    (x1, y1), (x2, y2), (x3, y3) = pts
    return f"M{n(x1)} {n(y1)}L{n(x2)} {n(y2)}L{n(x3)} {n(y3)}Z"


def eye_markup(m, side):
    pill, hole, wing = eye_shapes(m, side)
    d = pill_path(*pill)
    if hole is None:
        return f'<g class="eye"><path d="{d}"/></g>'
    d += " " + hole_path(*hole)
    return (f'<g class="eye"><path fill-rule="evenodd" d="{d}"/>'
            f'<path d="{wing_path(wing)}"/></g>')


# Reference strings from the spec for the R = 89 master.
_m = master(11)
assert hair_path(_m) == ("M0 178V89A89 89 0 0 1 178 89V178Z "
                         "M34 55H144V89A55 55 0 0 1 34 89Z")
assert " ".join(p for p in (
    pill_path(*eye_shapes(_m, "l")[0]),
    hole_path(*eye_shapes(_m, "l")[1]),
    wing_path(eye_shapes(_m, "l")[2]))) == (
    "M55 86.5A10.5 10.5 0 0 1 76 86.5V99.5A10.5 10.5 0 0 1 55 99.5Z "
    "M63 85A4 4 0 1 0 71 85A4 4 0 1 0 63 85Z M60 79L55 89L47 76Z")
assert " ".join(p for p in (
    pill_path(*eye_shapes(_m, "r")[0]),
    hole_path(*eye_shapes(_m, "r")[1]),
    wing_path(eye_shapes(_m, "r")[2]))) == (
    "M102 86.5A10.5 10.5 0 0 1 123 86.5V99.5A10.5 10.5 0 0 1 102 99.5Z "
    "M107 85A4 4 0 1 0 115 85A4 4 0 1 0 107 85Z M118 79L131 76L123 89Z")
del _m


# ---------------------------------------------------------------------------
# Rasteriser (exact integer arithmetic, no float rounding at edges)
# ---------------------------------------------------------------------------
def coverage(k, sc, N, ox, oy):
    """Return int arrays (N, N) of sample counts (0..256): tombstone, hair, eyes.

    Sample (pixel p, sub-sample i) has centre u = p + (i + 0.5) / SS in pixel space.
    The master coordinate is x = (u - ox) / sc. Integer unit: 1 / (2 * SS * sc).
    """
    m = master(k)
    q = 2 * SS * sc

    def Q(v):
        iv = int(round(v * q))
        assert abs(v * q - iv) < 1e-9
        return iv

    R, W = Q(m["R"]), Q(m["W"])
    lock, r, fr = Q(m["lock"]), Q(m["r"]), Q(m["fringe"])
    xs = 2 * np.arange(N * SS, dtype=np.int64) + 1 - 2 * SS * ox
    dxR2 = (xs - R) ** 2
    in_x = (xs >= 0) & (xs <= W)
    win_x = (xs >= lock) & (xs <= W - lock)

    eyes = []
    for side in "lr":
        pill, hole, wing = eye_shapes(m, side)
        x0, y0, ew, eh = pill
        rr = ew / 2
        eyes.append(dict(
            x0=Q(x0), x1=Q(x0 + ew), cx=Q(x0 + rr), rr2=Q(rr) ** 2,
            ya=Q(y0 + rr), yb=Q(y0 + eh - rr),
            hole=None if hole is None else (Q(hole[0]), Q(hole[1]), Q(hole[2]) ** 2),
            wing=None if wing is None else [(Q(px), Q(py)) for px, py in wing],
        ))

    shape = (N, N)
    cov_t = np.zeros(shape, dtype=np.int64)
    cov_h = np.zeros(shape, dtype=np.int64)
    cov_e = np.zeros(shape, dtype=np.int64)
    for p0 in range(0, N, STRIP_ROWS):
        p1 = min(N, p0 + STRIP_ROWS)
        ys = 2 * np.arange(p0 * SS, p1 * SS, dtype=np.int64) + 1 - 2 * SS * oy
        dyR2 = (ys - R) ** 2
        d_main = dxR2[None, :] + dyR2[:, None]
        top = (ys <= R)[:, None] & (d_main <= R * R)
        body = (ys > R)[:, None] & in_x[None, :] & (ys <= W)[:, None]
        tomb = top | body
        rect = ((ys >= fr) & (ys <= R))[:, None] & win_x[None, :]
        disc = (ys > R)[:, None] & (d_main <= r * r)
        hair = tomb & ~(rect | disc)

        eye = np.zeros(d_main.shape, dtype=bool)
        for e in eyes:
            inx = (xs >= e["x0"]) & (xs <= e["x1"])
            pill = ((ys >= e["ya"]) & (ys <= e["yb"]))[:, None] & inx[None, :]
            dx2 = ((xs - e["cx"]) ** 2)[None, :]
            pill |= (dx2 + ((ys - e["ya"]) ** 2)[:, None]) <= e["rr2"]
            pill |= (dx2 + ((ys - e["yb"]) ** 2)[:, None]) <= e["rr2"]
            if e["hole"] is not None:
                hx, hy, hr2 = e["hole"]
                pill &= ~((((xs - hx) ** 2)[None, :] + ((ys - hy) ** 2)[:, None]) <= hr2)
            if e["wing"] is not None:
                (ax, ay), (bx, by), (cx_, cy_) = e["wing"]

                def cross(px, py, qx, qy):
                    return (qx - px) * (ys[:, None] - py) - (qy - py) * (xs[None, :] - px)

                c1, c2, c3 = cross(ax, ay, bx, by), cross(bx, by, cx_, cy_), cross(cx_, cy_, ax, ay)
                tri = ((c1 >= 0) & (c2 >= 0) & (c3 >= 0)) | ((c1 <= 0) & (c2 <= 0) & (c3 <= 0))
                pill |= tri
            eye |= pill
        eye &= ~hair
        rows = p1 - p0
        for dst, src in ((cov_t, tomb), (cov_h, hair), (cov_e, eye)):
            dst[p0:p1] = src.reshape(rows, SS, N, SS).sum(axis=(1, 3))
    return cov_t, cov_h, cov_e


def hex_rgb(h):
    return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.int64)


def alpha_of(total):
    return (255 * total + SS * SS // 2) // (SS * SS)


def render_mark(k, sc, N, ox, oy, hair_col):
    """Transparent mark: hair in hair_col, eyes red, window transparent. RGBA uint8."""
    _, ch, ce = coverage(k, sc, N, ox, oy)
    total = ch + ce
    hc, rc = hex_rgb(hair_col), hex_rgb(RED)
    safe = np.maximum(total, 1)
    out = np.zeros((N, N, 4), dtype=np.uint8)
    for c in range(3):
        v = (hc[c] * ch + rc[c] * ce + safe // 2) // safe
        out[..., c] = np.where(total > 0, v, 0)
    out[..., 3] = alpha_of(total)
    return out


def render_face(k, sc, N, ox, oy):
    """Opaque face: hair ink, window white, eyes red, outside transparent. RGBA uint8."""
    ct, ch, ce = coverage(k, sc, N, ox, oy)
    cw = ct - ch - ce
    assert cw.min() >= 0
    hc, rc, wc = hex_rgb(INK), hex_rgb(RED), hex_rgb(WHITE)
    safe = np.maximum(ct, 1)
    out = np.zeros((N, N, 4), dtype=np.uint8)
    for c in range(3):
        v = (hc[c] * ch + rc[c] * ce + wc[c] * cw + safe // 2) // safe
        out[..., c] = np.where(ct > 0, v, 0)
    out[..., 3] = alpha_of(ct)
    return out


def render_tile(k, sc, N, ox, oy):
    """Opaque tile: ink ground, silver hair, red eyes. RGB uint8."""
    _, ch, ce = coverage(k, sc, N, ox, oy)
    n = SS * SS
    cg = n - ch - ce
    assert cg.min() >= 0
    ic, sv, rc = hex_rgb(INK), hex_rgb(SILVER), hex_rgb(RED)
    out = np.zeros((N, N, 3), dtype=np.uint8)
    for c in range(3):
        out[..., c] = (ic[c] * cg + sv[c] * ch + rc[c] * ce + n // 2) // n
    return out


def save_png(arr, path):
    Image.fromarray(arr).save(path, format="PNG", compress_level=9)


# ---------------------------------------------------------------------------
# SVG files
# ---------------------------------------------------------------------------
def svg_doc(w, h, body, extra=""):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
        f'width="{w}" height="{h}" role="img" aria-label="seira.bot">'
        f'<title>seira.bot</title>{extra}{body}</svg>\n'
    )


def face_markup(k, hair_fill, eye_fill, hair_class=None):
    m = master(k)
    cls = f' class="{hair_class}"' if hair_class else ""
    return (
        f'<path{cls} fill="{hair_fill}" fill-rule="evenodd" d="{hair_path(m)}"/>'
        f'<g class="eyes" fill="{eye_fill}">{eye_markup(m, "l")}{eye_markup(m, "r")}</g>'
    )


def mark_svg(hair_fill, eye_fill=RED, style=""):
    w = master(MAIN_K)["W"]
    extra = f"<style>{ANIM_STYLE}</style>" if style else ""
    return svg_doc(w, w, face_markup(MAIN_K, hair_fill, eye_fill), extra=extra)


def icon_svg():
    body = (
        f'<rect width="{ICON_SIZE}" height="{ICON_SIZE}" rx="{ICON_RADIUS}" fill="{INK}"/>'
        f'<g transform="translate({ICON_OFFSET} {ICON_OFFSET})">'
        f'{face_markup(MAIN_K, SILVER, RED)}</g>'
    )
    return svg_doc(ICON_SIZE, ICON_SIZE, body)


def favicon_svg():
    style = f"<style>@media (prefers-color-scheme: dark){{.hair{{fill:{SILVER}}}}}</style>"
    w = master(MASTER_KS[0])["W"]
    return svg_doc(w, w, face_markup(MASTER_KS[0], INK, RED, hair_class="hair"), extra=style)


# ---------------------------------------------------------------------------
# Lockup
# ---------------------------------------------------------------------------
def fmt2(v):
    """Round to 2 decimals and drop trailing zeros."""
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def local_env(name):
    """Return the value of name from brand/.env.local, or None."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env.local")
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            key, sep, value = line.strip().partition("=")
            if sep and key.removeprefix("export ").strip() == name:
                return value.strip().strip("'\"") or None
    return None


_font_dir = []


def font_dir():
    """Return the folder that holds Geist-<weight>.ttf for each FONT_WEIGHTS."""
    if _font_dir:
        return _font_dir[0]
    want = [f"Geist-{w}.ttf" for w in FONT_WEIGHTS]
    found = os.environ.get(FONT_ENV) or local_env(FONT_ENV)
    if not found:
        for root in FONT_SEARCH:
            for dirpath, _, files in sorted(os.walk(os.path.expanduser(root))):
                if all(w in files for w in want):
                    found = dirpath
                    break
            if found:
                break
    if not found or not all(os.path.isfile(os.path.join(found, w)) for w in want):
        sys.exit(f"Geist Sans TTF files not found. Set {FONT_ENV} to the folder that "
                 f"holds {', '.join(want)}. See brand/.env.example.")
    _font_dir.append(found)
    return found


def font_path(weight):
    return os.path.join(font_dir(), f"Geist-{weight}.ttf")


def stem_width_px(font, s):
    """Width of the lower contour of glyph i (the stem), in px."""
    gs = font.getGlyphSet()
    rec = RecordingPen()
    gs[font.getBestCmap()[ord("i")]].draw(rec)
    contours, cur = [], []
    for op, args in rec.value:
        if op == "moveTo" and cur:
            contours.append(cur)
            cur = []
        cur.append((op, args))
    if cur:
        contours.append(cur)
    best = None
    for cn in contours:
        bp = BoundsPen(gs)
        for op, args in cn:
            getattr(bp, op)(*args)
        x0, y0, x1, y1 = bp.bounds
        if best is None or y0 < best[0]:
            best = (y0, (x1 - x0) * s)
    return best[1]


def x_scale(font):
    gs = font.getGlyphSet()
    bp = BoundsPen(gs)
    gs[font.getBestCmap()[ord("x")]].draw(bp)
    return (BASELINE_Y - XHEIGHT_Y) / bp.bounds[3]


def choose_weight():
    rows = []
    for wt in FONT_WEIGHTS:
        f = TTFont(font_path(wt))
        s = x_scale(f)
        rows.append((abs(stem_width_px(f, s) - TARGET_STEM), wt, stem_width_px(f, s), s))
    rows.sort()
    return rows[0][1], rows[0][2], rows[0][3]


def kern_table(path, upem, text):
    """Pair kerning in font units. Use raqm when it is available."""
    if not features.check("raqm"):
        return (lambda a, b: 0.0), "zero"
    ft = ImageFont.truetype(path, size=upem, layout_engine=ImageFont.Layout.RAQM)

    def kern(a, b):
        return ft.getlength(a + b) - ft.getlength(a) - ft.getlength(b)

    return kern, "raqm"


def floor_half(x):
    return math.floor(x + 0.5)


def build_lockup(weight, s):
    path = font_path(weight)
    font = TTFont(path)
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    upem = font["head"].unitsPerEm
    kern, kern_method = kern_table(path, upem, LOCKUP_TEXT)

    def bounds(name):
        bp = BoundsPen(gs)
        gs[name].draw(bp)
        return bp.bounds

    names = [cmap[ord(ch)] for ch in LOCKUP_TEXT]
    xmin0 = bounds(names[0])[0]
    pen = TEXT_X0 - xmin0 * s
    parts = {"seira": SVGPathPen(gs, ntos=fmt2), "bot": SVGPathPen(gs, ntos=fmt2)}
    circle = None
    right_edge = 0.0
    for i, ch in enumerate(LOCKUP_TEXT):
        if i > 0:
            pen += kern(LOCKUP_TEXT[i - 1], ch) * s
        adv = font["hmtx"][names[i]][0] * s
        if ch == ".":
            left = floor_half(pen + adv / 2 - PERIOD_DIAMETER / 2)
            circle = (left + PERIOD_DIAMETER / 2, BASELINE_Y - PERIOD_DIAMETER / 2)
        else:
            xmin, _, xmax, _ = bounds(names[i])
            off = floor_half(pen + xmin * s) - xmin * s
            target = parts["seira"] if i < LOCKUP_TEXT.index(".") else parts["bot"]
            gs[names[i]].draw(TransformPen(target, (s, 0, 0, -s, off, BASELINE_Y)))
            right_edge = max(right_edge, off + xmax * s)
        pen += adv
    width = math.ceil(round(right_edge, 6))
    return dict(
        seira=parts["seira"].getCommands(), bot=parts["bot"].getCommands(),
        circle=circle, width=width, kern=kern_method, right=right_edge,
    )


def lockup_svg(lk, hair_fill, text_fill):
    cx, cy = lk["circle"]
    body = (
        f'{face_markup(MAIN_K, hair_fill, RED)}'
        f'<path fill="{text_fill}" d="{lk["seira"]}"/>'
        f'<circle cx="{num(cx)}" cy="{num(cy)}" r="{num(PERIOD_DIAMETER / 2)}" fill="{RED}"/>'
        f'<path fill="{text_fill}" d="{lk["bot"]}"/>'
    )
    return svg_doc(lk["width"], LOCKUP_HEIGHT, body)


# ---------------------------------------------------------------------------
# ICO (PNG-compressed entries, pixels unchanged)
# ---------------------------------------------------------------------------
def build_ico(png_dir, names, out_path):
    blobs = []
    for nm in names:
        with open(os.path.join(png_dir, nm), "rb") as fh:
            data = fh.read()
        wd, ht = struct.unpack(">II", data[16:24])
        blobs.append((wd, ht, data))
    head = struct.pack("<HHH", 0, 1, len(blobs))
    offset = 6 + 16 * len(blobs)
    entries = b""
    for wd, ht, data in blobs:
        entries += struct.pack("<BBBBHHII", wd % 256, ht % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    with open(out_path, "wb") as fh:
        fh.write(head + entries + b"".join(b[2] for b in blobs))


# ---------------------------------------------------------------------------
def write(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def main(out_dir=OUT_DIR):
    svg_dir = os.path.join(out_dir, "svg")
    png_dir = os.path.join(out_dir, "png")
    os.makedirs(svg_dir, exist_ok=True)
    os.makedirs(png_dir, exist_ok=True)

    def sv(name, text):
        write(os.path.join(svg_dir, name), text)

    sv("seira-mark.svg", mark_svg(INK))
    sv("seira-mark-reversed.svg", mark_svg(SILVER))
    sv("seira-mark-mono-ink.svg", mark_svg(INK, INK))
    sv("seira-mark-mono-white.svg", mark_svg(WHITE, WHITE))
    sv("seira-mark-animated.svg", mark_svg(INK, style=ANIM_STYLE))
    sv("seira-mark-animated-reversed.svg", mark_svg(SILVER, style=ANIM_STYLE))
    sv("seira-icon.svg", icon_svg())
    sv("favicon.svg", favicon_svg())

    weight, stem, s = choose_weight()
    lk = build_lockup(weight, s)
    sv("seira-lockup.svg", lockup_svg(lk, INK, INK))
    sv("seira-lockup-reversed.svg", lockup_svg(lk, SILVER, WHITE))
    print(f"weight={weight} stem={stem:.3f}px scale={s:.6f} kerning={lk['kern']} "
          f"right_edge={lk['right']:.3f} viewBox_width={lk['width']} "
          f"dot=(cx={num(lk['circle'][0])}, cy={num(lk['circle'][1])}, "
          f"r={num(PERIOD_DIAMETER / 2)})")

    for name, k, sc, N, ox, oy in FACE_RASTERS:
        save_png(render_face(k, sc, N, ox, oy), os.path.join(png_dir, name))
    for name, k, sc, N, ox, oy, col in MARK_RASTERS:
        save_png(render_mark(k, sc, N, ox, oy, col), os.path.join(png_dir, name))
    for name, k, sc, N, ox, oy in TILE_RASTERS:
        save_png(render_tile(k, sc, N, ox, oy), os.path.join(png_dir, name))
    build_ico(png_dir, ICO_SOURCES, os.path.join(out_dir, "favicon.ico"))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else OUT_DIR)
