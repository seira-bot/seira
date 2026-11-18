#!/usr/bin/env python3
"""Check the seira.bot logo files. Exit 0 only when every check passes.

Run: python3 brand/check_logo.py
This script does not import build_logo.py. It holds its own copy of the spec.
Check 9 runs build_logo.py as a subprocess.
"""
import hashlib
import math
import os
import re
import struct
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
LOGO_DIR = os.path.join(HERE, "logo")
SVG_DIR = os.path.join(LOGO_DIR, "svg")
PNG_DIR = os.path.join(LOGO_DIR, "png")
ICO_PATH = os.path.join(LOGO_DIR, "favicon.ico")

# Spec copy
F = [0, 1]
while len(F) < 30:
    F.append(F[-1] + F[-2])
FIBS = set(F)
KS = range(6, 12)
INK_RGB = (0x0E, 0x11, 0x16)
SILVER_RGB = (0xE9, 0xEC, 0xEF)
WHITE_RGB = (0xFF, 0xFF, 0xFF)


def dims(k):
    return dict(R=F[k], W=2 * F[k], lock=F[k - 2], r=F[k - 1], fringe=F[k - 1],
                ew=F[k - 3], eh=F[k - 2], og=F[k - 3], hg=F[k - 4], chin=F[k - 2])


# name -> (k, scale, N, ox, oy, variant)   variant: face | mark | tile
RASTERS = {
    "favicon-16.png": (6, 1, 16, 0, 0, "face"),
    "favicon-32.png": (7, 1, 32, 3, 3, "face"),
    "favicon-48.png": (8, 1, 48, 3, 3, "face"),
    "mark-68.png": (9, 1, 68, 0, 0, "mark"),
    "mark-178.png": (11, 1, 178, 0, 0, "mark"),
    "mark-356.png": (11, 2, 356, 0, 0, "mark"),
    "mark-712.png": (11, 4, 712, 0, 0, "mark"),
    "mark-reversed-178.png": (11, 1, 178, 0, 0, "mark"),
    "mark-reversed-356.png": (11, 2, 356, 0, 0, "mark"),
    "icon-180.png": (10, 1, 180, 35, 35, "tile"),
    "icon-192.png": (10, 1, 192, 41, 41, "tile"),
    "icon-288.png": (11, 1, 288, 55, 55, "tile"),
    "icon-512.png": (11, 2, 512, 78, 78, "tile"),
}
GRID_SVGS = ["seira-mark.svg", "seira-mark-reversed.svg", "seira-mark-mono-ink.svg",
             "seira-mark-mono-white.svg", "seira-mark-animated.svg",
             "seira-mark-animated-reversed.svg", "seira-icon.svg", "favicon.svg"]


def load(name):
    return np.array(Image.open(os.path.join(PNG_DIR, name)))


def read_svg(name):
    with open(os.path.join(SVG_DIR, name), encoding="utf-8") as fh:
        return fh.read()


def hair_cov(arr, variant):
    """Hair coverage 0..255 (eye pixels are not valid here)."""
    if variant == "mark":
        return arr[..., 3].astype(np.int64)
    if variant == "face":
        b = arr[..., 2].astype(np.int64)
        c = ((255 - b) * 255 + 116) // (255 - INK_RGB[2])
        return np.where(arr[..., 3] == 0, 0, c)
    red = arr[..., 0].astype(np.int64)
    return ((red - INK_RGB[0]) * 255 + 109) // (SILVER_RGB[0] - INK_RGB[0])


# ---------------------------------------------------------------------------
# Check 1
def check_fibonacci():
    bad = []
    for k in KS:
        d = dims(k)
        for key, v in d.items():
            if key != "W" and v not in FIBS:
                bad.append(f"k={k} {key}={v} not Fibonacci")
        if k >= 9:
            for lab, v in (("hd", F[k - 5]), ("gap", F[k - 6]), ("wa", F[k - 6]),
                           ("wb", F[k - 7]), ("wc", F[k - 5]), ("wd", F[k - 4])):
                if v not in FIBS:
                    bad.append(f"k={k} {lab}={v} not Fibonacci")
        hor = [d["lock"], d["og"], d["ew"], d["hg"], d["hg"], d["ew"], d["og"], d["lock"]]
        ver = [d["fringe"], d["ew"], d["eh"], d["chin"], d["chin"]]
        if sum(hor) != d["W"]:
            bad.append(f"k={k} horizontal bands {hor} sum {sum(hor)} != {d['W']}")
        if sum(ver) != d["W"]:
            bad.append(f"k={k} vertical bands {ver} sum {sum(ver)} != {d['W']}")
        if d["R"] - d["lock"] != d["r"]:
            bad.append(f"k={k} window half width != chin radius")
    return bad, "6 masters (R = 8, 13, 21, 34, 55, 89)"


# ---------------------------------------------------------------------------
# Path parser (shared by checks 2, 5, 7)
def parse_segments(d):
    """Parse M L H V A Q C Z into a list of subpaths. Each subpath is a list of
    segments: ('L', p0, p1) or ('A', p0, p1, r, large, sweep) or ('Q'/'C', pts...)."""
    toks = re.findall(r"[MLHVAQCZ]|-?\d+(?:\.\d+)?", d)
    i, cur, start = 0, None, None
    subs, seg = [], None

    def num():
        nonlocal i
        v = float(toks[i])
        i += 1
        return v

    while i < len(toks):
        cmd = toks[i]
        i += 1
        if cmd == "M":
            cur = (num(), num())
            start = cur
            seg = []
            subs.append(seg)
        elif cmd == "L":
            p = (num(), num())
            seg.append(("L", cur, p))
            cur = p
        elif cmd == "H":
            p = (num(), cur[1])
            seg.append(("L", cur, p))
            cur = p
        elif cmd == "V":
            p = (cur[0], num())
            seg.append(("L", cur, p))
            cur = p
        elif cmd == "A":
            rx, ry = num(), num()
            num()
            large, sweep = int(num()), int(num())
            p = (num(), num())
            assert rx == ry
            seg.append(("A", cur, p, rx, large, sweep))
            cur = p
        elif cmd == "Q":
            p1, p = (num(), num()), (num(), num())
            seg.append(("Q", cur, p1, p))
            cur = p
        elif cmd == "C":
            p1, p2, p = (num(), num()), (num(), num()), (num(), num())
            seg.append(("C", cur, p1, p2, p))
            cur = p
        elif cmd == "Z":
            if cur != start:
                seg.append(("L", cur, start))
            cur = start
        else:
            raise ValueError(cmd)
    return subs


def arc_centre(p0, p1, r, large, sweep):
    x1, y1 = (p0[0] - p1[0]) / 2, (p0[1] - p1[1]) / 2
    dd = x1 * x1 + y1 * y1
    sq = max(0.0, (r * r - dd) / dd)
    co = (-1 if large == sweep else 1) * math.sqrt(sq)
    return co * y1 + (p0[0] + p1[0]) / 2, -co * x1 + (p0[1] + p1[1]) / 2


def flatten_arc(p0, p1, r, large, sweep):
    cx, cy = arc_centre(p0, p1, r, large, sweep)
    t1 = math.atan2(p0[1] - cy, p0[0] - cx)
    t2 = math.atan2(p1[1] - cy, p1[0] - cx)
    dt = t2 - t1
    if sweep == 0 and dt > 0:
        dt -= 2 * math.pi
    if sweep == 1 and dt < 0:
        dt += 2 * math.pi
    if large == 1 and abs(dt) < math.pi - 1e-9:
        dt = dt - 2 * math.pi if dt > 0 else dt + 2 * math.pi
    n = max(16, math.ceil(720 * abs(dt) / (2 * math.pi)))
    return [(cx + r * math.cos(t1 + dt * j / n), cy + r * math.sin(t1 + dt * j / n))
            for j in range(1, n + 1)]


def is_grid(v):
    return abs(v * 2 - round(v * 2)) < 1e-9


def is_int(v):
    return abs(v - round(v)) < 1e-9


# Check 2
def check_svg_grid():
    bad, count = [], 0
    for fn in GRID_SVGS:
        svg = read_svg(fn)
        for m in re.finditer(r'\bd="([^"]*)"', svg):
            for t in re.findall(r"-?\d+(?:\.\d+)?", m.group(1)):
                count += 1
                if not is_grid(float(t)):
                    bad.append(f"{fn}: path number {t} is off grid")
            for sub in parse_segments(m.group(1)):
                for sg in sub:
                    if sg[0] == "L":
                        _, a, b = sg
                        if a[0] == b[0] and not is_int(a[0]):
                            bad.append(f"{fn}: vertical edge x={a[0]} not integer")
                        elif a[1] == b[1] and not is_int(a[1]):
                            bad.append(f"{fn}: horizontal edge y={a[1]} not integer")
                        elif a[0] != b[0] and a[1] != b[1]:
                            for p in (a, b):
                                if not (is_int(p[0]) and is_int(p[1])):
                                    bad.append(f"{fn}: polygon vertex {p} not integer")
                    elif sg[0] == "A":
                        _, a, b, r, large, sweep = sg
                        cx, cy = arc_centre(a, b, r, large, sweep)
                        for lab, e in (("cx-r", cx - r), ("cx+r", cx + r),
                                       ("cy-r", cy - r), ("cy+r", cy + r)):
                            if not is_int(e):
                                bad.append(f"{fn}: arc extent {lab}={e} not integer")
        for m in re.finditer(r'(?<![\w-])(cx|cy|r|rx|width|height)="([^"]*)"', svg):
            count += 1
            if not is_grid(float(m.group(2))):
                bad.append(f"{fn}: {m.group(1)}={m.group(2)} is off grid")
        for m in re.finditer(r'transform="translate\(([^)]*)\)', svg):
            for t in m.group(1).split():
                count += 1
                if not is_grid(float(t)):
                    bad.append(f"{fn}: translate {t} is off grid")
    return bad, f"{len(GRID_SVGS)} files, {count} numbers"


# Check 3
def check_bbox():
    bad = []
    for fn, (k, sc, N, ox, oy, var) in RASTERS.items():
        W = dims(k)["W"]
        arr = load(fn)
        if arr.shape[:2] != (N, N):
            bad.append(f"{fn}: size {arr.shape[:2]} != {(N, N)}")
            continue
        if var == "tile":
            mask = np.any(arr[..., :3] != np.array(INK_RGB, dtype=np.uint8), axis=2)
        else:
            mask = arr[..., 3] > 0
        ys, xs = np.nonzero(mask)
        got = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
        want = (ox, oy, ox + sc * W, oy + sc * W)
        if got != want:
            bad.append(f"{fn}: bbox {got} != {want}")
    return bad, f"{len(RASTERS)} PNG files"


# Check 4
def check_flat_edges():
    bad = []
    for fn, (k, sc, N, ox, oy, var) in RASTERS.items():
        d = dims(k)
        R, W, lock, fr = d["R"], d["W"], d["lock"], d["fringe"]
        arr = load(fn)
        cov = hair_cov(arr, var)

        def full(r_, c_, lab):
            sub = cov[r_, c_]
            if np.any(sub != 255):
                bad.append(f"{fn}: {lab} inside not full ({int(sub.min())})")

        def zero(r_, c_, lab):
            sub = cov[r_, c_]
            if np.any(sub != 0):
                bad.append(f"{fn}: {lab} outside not empty ({int(sub.max())})")

        x0, x1 = ox, ox + sc * W
        y0, y1 = oy, oy + sc * W
        # hair base
        full(y1 - 1, slice(x0, x1), "base")
        if y1 < N:
            zero(y1, slice(x0, x1), "base")
        # hair sides below y = R
        rows = slice(oy + sc * R, y1)
        full(rows, x0, "left side")
        full(rows, x1 - 1, "right side")
        if x0 - 1 >= 0:
            zero(rows, x0 - 1, "left side")
        if x1 < N:
            zero(rows, x1, "right side")
        # fringe line: hair above, face below
        cols = slice(ox + sc * lock, ox + sc * (W - lock))
        full(oy + sc * fr - 1, cols, "fringe")
        zero(oy + sc * fr, cols, "fringe")
        # mirror symmetry of the full mark (hair and eyes)
        crop = arr[y0:y1, x0:x1]
        if not np.array_equal(crop, crop[:, ::-1]):
            n = int(np.count_nonzero(np.any(crop != crop[:, ::-1], axis=2)))
            bad.append(f"{fn}: face is not left-right symmetric ({n} pixels differ)")
    return bad, f"{len(RASTERS)} PNG files, 3 flat edges + full-mark symmetry"


# Check 5: independent path flattener and even-odd scanline rasteriser
def rasterise_evenodd(polys, size, big):
    """Return a bool (size*big, size*big) mask; sample centres, even-odd rule."""
    n = size * big
    mask = np.zeros((n, n), dtype=bool)
    edges = []
    for poly in polys:
        for a, b in zip(poly, poly[1:] + poly[:1]):
            if a[1] != b[1]:
                edges.append((a[0], a[1], b[0], b[1]))
    e = np.array(edges, dtype=np.float64)
    for j in range(n):
        yc = (j + 0.5) / big
        sel = (e[:, 1] <= yc) != (e[:, 3] <= yc)
        if not sel.any():
            continue
        ee = e[sel]
        xs = np.sort(ee[:, 0] + (yc - ee[:, 1]) * (ee[:, 2] - ee[:, 0]) / (ee[:, 3] - ee[:, 1]))
        for a, b in zip(xs[0::2], xs[1::2]):
            lo = max(0, math.ceil(a * big - 0.5))
            hi = min(n, math.ceil(b * big - 0.5))
            if hi > lo:
                mask[j, lo:hi] = True
    return mask


def path_polys(d):
    polys = []
    for sub in parse_segments(d):
        pts = []
        for sg in sub:
            if sg[0] == "L":
                pts.append(sg[1])
                pts.append(sg[2])
            elif sg[0] == "A":
                pts.append(sg[1])
                pts.extend(flatten_arc(sg[1], sg[2], sg[3], sg[4], sg[5]))
        clean = [p for i, p in enumerate(pts) if i == 0 or p != pts[i - 1]]
        if len(clean) > 1 and clean[0] == clean[-1]:
            clean.pop()
        polys.append(clean)
    return polys


def check_independent():
    svg = read_svg("seira-mark.svg")
    ds = re.findall(r'<path[^>]* d="([^"]*)"', svg)
    size, big = 178, 16
    union = np.zeros((size * big, size * big), dtype=bool)
    npts = 0
    for d in ds:
        polys = path_polys(d)
        npts += sum(len(p) for p in polys)
        union |= rasterise_evenodd(polys, size, big)
    ref = union.reshape(size, big, size, big).mean(axis=(1, 3)) * 255
    alpha = load("mark-178.png")[..., 3].astype(np.float64)
    diff = np.abs(ref - alpha)
    mx, mean = float(diff.max()), float(diff.mean())
    bad = []
    if not mx < 40:
        bad.append(f"max diff {mx:.2f} >= 40")
    if not mean < 1.0:
        bad.append(f"mean diff {mean:.4f} >= 1.0")
    return bad, f"{len(ds)} paths, {npts} points, max diff {mx:.2f}/255, mean diff {mean:.4f}"


# Check 6
def check_ico():
    bad = []
    with open(ICO_PATH, "rb") as fh:
        data = fh.read()
    rsv, typ, n = struct.unpack("<HHH", data[:6])
    if (rsv, typ) != (0, 1):
        bad.append("bad ICO header")
    sizes = []
    for i in range(n):
        wd, ht, _, _, _, _, ln, off = struct.unpack("<BBBBHHII", data[6 + 16 * i:22 + 16 * i])
        wd = wd or 256
        sizes.append(wd)
        src = os.path.join(PNG_DIR, f"favicon-{wd}.png")
        if os.path.exists(src):
            with open(src, "rb") as fh:
                if fh.read() != data[off:off + ln]:
                    bad.append(f"ICO entry {wd} differs from favicon-{wd}.png")
    if sizes != [16, 32, 48]:
        bad.append(f"sizes {sizes} != [16, 32, 48]")
    return bad, f"sizes {sizes}"


# Check 7
def check_lockup():
    bad, info = [], ""
    for fn in ("seira-lockup.svg", "seira-lockup-reversed.svg"):
        svg = read_svg(fn)
        ds = re.findall(r'<path[^>]* d="([^"]*)"', svg)
        # ds[0] is the hair, ds[1..] eye paths, then the two text paths.
        seira, bot = ds[-2], ds[-1]
        contours = []
        for sub in parse_segments(seira):
            xs, ys = [], []
            for sg in sub:
                pts = {"L": sg[1:], "Q": sg[1:], "C": sg[1:]}.get(sg[0], sg[1:3])
                for p in pts:
                    xs.append(p[0])
                    ys.append(p[1])
            contours.append((min(xs), min(ys), max(xs), max(ys)))
        # Keep outer contours only (drop counters such as the hole of e and a).
        contours = [c for c in contours if not any(
            o is not c and o[0] <= c[0] and o[1] <= c[1] and o[2] >= c[2] and o[3] >= c[3]
            for o in contours)]
        # Skip the dot of the i (it ends far above the baseline).
        base = min(c[3] for c in contours if c[3] > 100)
        on_base = [c for c in contours if abs(c[3] - base) < 0.011]
        xline = max(c[1] for c in on_base)
        x_start = min(c[0] for c in contours)
        if abs(base - 144) > 0.011:
            bad.append(f"{fn}: baseline {base} != 144")
        if abs(xline - 55) > 0.011:
            bad.append(f"{fn}: x-height line {xline} != 55")
        if abs(x_start - 233) > 0.011:
            bad.append(f"{fn}: text start {x_start} != 233")
        circ = re.search(r"<circle\b([^>]*)>", svg)
        a = dict(re.findall(r'(\w+)="([^"]*)"', circ.group(1)))
        cx, cy, r = float(a["cx"]), float(a["cy"]), float(a["r"])
        if r != 10.5:
            bad.append(f"{fn}: circle r={r} != 10.5")
        for lab, e in (("left", cx - r), ("right", cx + r), ("top", cy - r), ("bottom", cy + r)):
            if not is_int(e):
                bad.append(f"{fn}: circle {lab} edge {e} not integer")
        if cy + r != 144:
            bad.append(f"{fn}: circle bottom {cy + r} != baseline 144")
        info = f"baseline {base:g}, x-height {xline:g}, text x {x_start:g}, dot ({cx:g}, {cy:g}, {r:g})"
    return bad, info


# Check 8
def check_animation():
    bad = []
    ref = re.findall(r'<path[^>]* d="([^"]*)"', read_svg("seira-mark.svg"))
    for fn in ("seira-mark-animated.svg", "seira-mark-animated-reversed.svg"):
        svg = read_svg(fn)
        for need in ("@keyframes blink", "@keyframes look", "8s", "prefers-reduced-motion",
                     "animation:none"):
            if need not in svg:
                bad.append(f"{fn}: missing {need}")
        if "prefers-reduced-motion" in svg and "animation:none" not in svg.split(
                "prefers-reduced-motion", 1)[1]:
            bad.append(f"{fn}: reduced-motion rule has no animation:none")
        if re.findall(r'<path[^>]* d="([^"]*)"', svg) != ref:
            bad.append(f"{fn}: path data differs from seira-mark.svg")
    return bad, "2 animated files, 8s loop, reduced motion rule, same paths"


# Check 9
def tree_hashes(root):
    out = {}
    for dp, _, fns in os.walk(root):
        for fn in sorted(fns):
            p = os.path.join(dp, fn)
            with open(p, "rb") as fh:
                out[os.path.relpath(p, root)] = hashlib.sha256(fh.read()).hexdigest()
    return out


def check_determinism():
    bad = []
    with tempfile.TemporaryDirectory() as ta, tempfile.TemporaryDirectory() as tb:
        for t in (ta, tb):
            subprocess.run([sys.executable, os.path.join(HERE, "build_logo.py"), t],
                           check=True, stdout=subprocess.DEVNULL)
        ha, hb, hc = tree_hashes(ta), tree_hashes(tb), tree_hashes(LOGO_DIR)
    for name in sorted(set(ha) | set(hb)):
        if ha.get(name) != hb.get(name):
            bad.append(f"{name}: run 1 and run 2 differ")
        if ha.get(name) != hc.get(name):
            bad.append(f"{name}: build output differs from files on disk")
    for name in sorted(set(hc) - set(ha)):
        bad.append(f"{name}: file on disk is not produced by the build")
    return bad, f"{len(ha)} files, SHA-256 equal in 2 runs"


CHECKS = [
    ("1 Fibonacci", check_fibonacci),
    ("2 SVG grid", check_svg_grid),
    ("3 PNG bounding box", check_bbox),
    ("4 Flat edges + mirror", check_flat_edges),
    ("5 Independent path", check_independent),
    ("6 ICO sizes", check_ico),
    ("7 Lockup", check_lockup),
    ("8 Animation", check_animation),
    ("9 Determinism", check_determinism),
]


def main():
    ok_all, details = True, []
    print(f"{'check':<24}{'result':<8}detail")
    print("-" * 78)
    for name, fn in CHECKS:
        try:
            bad, info = fn()
        except Exception as exc:  # a crash counts as FAIL
            bad, info = [f"error: {exc!r}"], ""
        res = "PASS" if not bad else "FAIL"
        ok_all &= not bad
        print(f"{name:<24}{res:<8}{info}")
        details += [f"  [{name}] {b}" for b in bad[:20]]
    for line in details:
        print(line)
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
