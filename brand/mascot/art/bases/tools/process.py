#!/usr/bin/env python3
"""Turn raw sheets into normalized base frames, masks, and manifest entries.

Usage (from any folder):
  python3 brand/mascot/art/bases/tools/process.py [--calibrate] STYLE [STYLE ...]
  --calibrate measures the shell radius per visor pixel again (out/calibration.json).

Input:  raw/STYLE-a.png  2 x 2: front, yaw20, yaw45, a turn of about 65 deg (not used).
        raw/STYLE-b.png  2 x 2: back, up, down, front.
        raw/STYLE-c.png  1 x 2: front, side (a true 90 deg profile).
Output: out/STYLE/VIEW.png (RGBA), VIEW.hair.png and VIEW.visor.png (L masks, white = mask),
        and the entry of STYLE in manifest.json.

Steps for each sheet:
1. Key out the chroma green background. Un-mix the edge colors from the green.
2. Split the sheet into cells at the emptiest column (and row) near the middle.
3. Find the visor (largest dark region) and the hair (magenta hue).
   The silver style `seira` gets its hair mask from its magenta twin `seira-long`.
4. Fit a circle to the shell outline where it meets the background: pivot and r.
5. Take the views from the fixed cell layout. Mirror a turned view that faces left.
6. Scale each frame so r = 300 px and move the pivot to (512, 452) on a 1024 x 1024 canvas.
   A style with tall hair gets a lower pivot, so that no frame touches the top edge.
7. Project head anchors from the measured yaw and pitch.
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

HERE = os.path.dirname(os.path.abspath(__file__))
BASES = os.path.dirname(HERE)
SIZE = 1024
R_OUT = 300.0
PIVOT_OUT = (512.0, 452.0)
EDGE_MARGIN = 16   # px of clear canvas between the content and each edge
VIEWS = ['front', 'yaw20', 'yaw45', 'side', 'back', 'up', 'down']
NOMINAL_YAW = {'front': 0, 'yaw20': 20, 'yaw45': 45, 'side': 90, 'back': 180, 'up': 0, 'down': 0}
NOMINAL_PITCH = {'up': 15, 'down': -15}

STYLES = {
    'seira': ('Seira', 'f', False),
    'seira-long': ('Seira long', 'f', True),
    'bob': ('Bob', 'f', True),
    'twin-tails': ('Twin tails', 'f', True),
    'ponytail': ('Ponytail', 'f', True),
    'long-straight': ('Long straight', 'f', True),
    'bun': ('Bun', 'f', True),
    'long-wavy': ('Long wavy', 'f', True),
    'short-neat': ('Short neat', 'm', True),
    'center-part': ('Center part', 'm', True),
    'spiky': ('Spiky', 'm', True),
    'slick-back': ('Slicked back', 'm', True),
    'long-tied': ('Long tied', 'm', True),
    'long-loose': ('Long loose', 'm', True),
    'buzz': ('Buzz cut', 'm', True),
    'messy': ('Messy', 'm', True),
    'none': ('No hair', 'u', False),
}

# Head-local anchor points (x right, y up, z toward the viewer), head radius = 1.
# L is the viewer's left in the front view.
ANCHORS3D = {
    'earL': (-1.0, -0.05, 0.0), 'earR': (1.0, -0.05, 0.0),
    'templeL': (-0.95, 0.2, 0.3), 'templeR': (0.95, 0.2, 0.3),
    'mouth': (0.0, -0.42, 0.98), 'cheekL': (-0.62, -0.3, 0.8), 'cheekR': (0.62, -0.3, 0.8),
    'neck': (0.0, -1.08, 0.0),
}



def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- keying

def load_rgb(path):
    return np.asarray(Image.open(path).convert('RGB'), dtype=np.float32)


def key_green(rgb):
    """Return (color, alpha). color is un-mixed from the green background."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    score = g - np.maximum(r, b)
    edge = np.concatenate([a.reshape(-1, 3) for a in (rgb[:6], rgb[-6:], rgb[:, :6], rgb[:, -6:])])
    bg = np.median(edge, axis=0)
    bg_score = max(60.0, bg[1] - max(bg[0], bg[2]))
    alpha = np.clip((1.0 - score / bg_score - 0.06) / 0.88, 0.0, 1.0)
    # Shaded green has a low absolute score but is still pure green: gate by the hue ratio.
    # The floor of 60 keeps near-black pixels (the visor) out of the gate, where noise rules the ratio.
    rel = 1.0 - score / np.maximum(g, 60.0)
    alpha = alpha * np.clip((rel - 0.06) / 0.12, 0.0, 1.0)
    alpha[alpha < 0.04] = 0.0
    a = np.maximum(alpha, 1e-3)[..., None]
    color = (rgb - (1.0 - a) * bg[None, None, :]) / a
    color = np.clip(color, 0, 255)
    # Remove the green spill that is left.
    mx = np.maximum(color[..., 0], color[..., 2])
    color[..., 1] = np.minimum(color[..., 1], mx + 4)
    color[alpha == 0] = 0
    return color, alpha


def split_cells(alpha, rows2=True):
    """Cell boxes (y0, y1, x0, x1): 2 x 2, or 1 x 2 when rows2 is False."""
    fg = alpha > 0.5
    h, w = fg.shape
    cols, rows = fg.sum(0), fg.sum(1)

    def cut(sums, n):
        lo, hi = int(n * 0.3), int(n * 0.7)
        seg = sums[lo:hi]
        best = np.flatnonzero(seg == seg.min())
        # Middle of the longest run of the minimum.
        runs, start = [], best[0]
        for i in range(1, len(best) + 1):
            if i == len(best) or best[i] != best[i - 1] + 1:
                runs.append((best[i - 1] - start, start, best[i - 1]))
                if i < len(best):
                    start = best[i]
        _, s, e = max(runs)
        return lo + (s + e) // 2, int(seg.min())

    cx, cxn = cut(cols, w)
    if not rows2:
        return [(0, h, 0, cx), (0, h, cx, w)], (['heads touch the cell split (%d px)' % cxn] if cxn else [])
    cy, cyn = cut(rows, h)
    warn = []
    if cxn or cyn:
        warn.append('heads touch the cell split (col %d px, row %d px)' % (cxn, cyn))
    boxes = [(0, cy, 0, cx), (0, cy, cx, w), (cy, h, 0, cx), (cy, h, cx, w)]
    return boxes, warn


# ---------------------------------------------------------------- analysis

def clean_components(mask, min_frac):
    lab, n = ndi.label(mask)
    if n == 0:
        return mask
    areas = ndi.sum(mask, lab, range(1, n + 1))
    keep = np.flatnonzero(areas >= areas.max() * min_frac) + 1
    return np.isin(lab, keep)


def magenta_soft(color, alpha):
    r, g, b = color[..., 0], color[..., 1], color[..., 2]
    return np.clip(((np.minimum(r, b) - g) - 15.0) / 45.0, 0, 1) * alpha


def find_visor(color, alpha, hair_hard):
    lum = 0.2126 * color[..., 0] + 0.7152 * color[..., 1] + 0.0722 * color[..., 2]
    dark = (lum < 62) & (alpha > 0.5) & ~hair_hard
    lab, n = ndi.label(dark)
    if n == 0:
        return np.zeros_like(dark)
    areas = ndi.sum(dark, lab, range(1, n + 1))
    i = int(np.argmax(areas)) + 1
    head_area = (alpha > 0.5).sum()
    if areas[i - 1] < head_area * 0.01:
        return np.zeros_like(dark)
    v = lab == i
    rad = max(3, int(math.sqrt(head_area) * 0.03))
    st = disk(rad)
    v = ndi.binary_closing(np.pad(v, rad + 2), structure=st)[rad + 2:-rad - 2, rad + 2:-rad - 2]
    v = ndi.binary_fill_holes(v)
    return v & (alpha > 0.5) & ~hair_hard


def disk(rad):
    y, x = np.ogrid[-rad:rad + 1, -rad:rad + 1]
    return x * x + y * y <= rad * rad


def fit_circle(pts):
    """Kasa least squares fit with outlier trimming. pts: N x 2 (x, y). Used for calibration."""
    if len(pts) < 30:
        return None
    p = pts.astype(np.float64)
    for _ in range(6):
        x, y = p[:, 0], p[:, 1]
        A = np.column_stack([x, y, np.ones_like(x)])
        sol, *_ = np.linalg.lstsq(A, x * x + y * y, rcond=None)
        cx, cy = sol[0] / 2, sol[1] / 2
        r = math.sqrt(max(1e-6, sol[2] + cx * cx + cy * cy))
        res = np.abs(np.hypot(x - cx, y - cy) - r)
        keep = res < max(2.0, 0.015 * r)
        if keep.all() or keep.sum() < 30:
            break
        p = p[keep]
    ang = np.degrees(np.arctan2(p[:, 1] - cy, p[:, 0] - cx))
    span = len(np.unique((ang // 6).astype(int))) * 6
    return cx, cy, r, len(p), span


def outline_points(alpha, hair_hard, visor):
    """Points where the bare shell meets the background (not next to hair or visor)."""
    body = (alpha > 0.5) & ~hair_hard & ~visor
    bgm = alpha < 0.15
    edge = body & ndi.binary_dilation(bgm, iterations=2)
    edge &= ~ndi.binary_dilation(hair_hard, iterations=5)
    edge &= ~ndi.binary_dilation(visor, iterations=3)
    ys, xs = np.nonzero(edge)
    return np.column_stack([xs, ys]).astype(np.float64)


def fit_fixed(pts, r, c0):
    """Center of a circle with a known radius r (Gauss-Newton, outlier trimming)."""
    if len(pts) < 40:
        return None
    c = np.array(c0, dtype=np.float64)
    p = pts
    for it in range(40):
        d = p - c
        L = np.maximum(np.hypot(d[:, 0], d[:, 1]), 1e-6)
        u = d / L[:, None]
        e = L - r
        if it in (10, 20, 30):
            keep = np.abs(e) < max(3.0, 2.5 * np.sqrt(np.mean(e * e)))
            if keep.sum() >= 40:
                p, u, e = p[keep], u[keep], e[keep]
        step, *_ = np.linalg.lstsq(u, e, rcond=None)
        c = c + step
        if np.hypot(*step) < 0.01 and it > 30:
            break
    d = p - c
    e = np.hypot(d[:, 0], d[:, 1]) - r
    ang = np.degrees(np.arctan2(d[:, 1], d[:, 0]))
    span = len(np.unique((ang // 6).astype(int))) * 6
    return float(c[0]), float(c[1]), float(np.sqrt(np.mean(e * e))), len(p), span


def analyze(color, alpha, hair_soft=None):
    """Return a dict with the masks and measures of one cell."""
    keep = clean_components(alpha > 0.5, 0.02)
    alpha = alpha * ndi.binary_dilation(keep, iterations=3)
    if hair_soft is None:
        hair_soft = magenta_soft(color, alpha)
    hard = clean_components(hair_soft > 0.5, 0.004) if (hair_soft > 0.5).any() else hair_soft > 0.5
    if (hair_soft > 0.5).sum() < (alpha > 0.5).sum() * 0.01:
        hard = np.zeros_like(hard)
    hair = hair_soft * ndi.binary_dilation(hard, iterations=2)
    visor = find_visor(color, alpha, hard)
    fg = alpha > 0.5
    body = fg & ~ndi.binary_dilation(hard | (hair > 0.15), iterations=3)
    body = clean_components(body, 0.2) if body.any() else body
    ys, xs = np.nonzero(fg)
    by = np.nonzero(body)[0]
    vbox = None
    if visor.any():
        vy, vx = np.nonzero(visor)
        vbox = (int(vx.min()), int(vy.min()), int(vx.max()), int(vy.max()))
    return {'color': color, 'alpha': alpha, 'hair': hair, 'hard': hard, 'visor': visor, 'vbox': vbox,
            'outline': outline_points(alpha, hard, visor), 'top': int(ys.min()),
            'chin': int(by.max()) if len(by) else int(ys.max()),
            'bbox': (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())), 'fit': None}


def centroid(mask):
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return None
    return float(xs.mean()), float(ys.mean())


# ---------------------------------------------------------------- yaw and pitch from the visor

def estimate_yaw(width, width0, r):
    """Yaw in degrees from the visor width. width0 is the visor width in the front view.
    A visor of half angle phi on a sphere, turned by yaw, shows the width
    r * (min(sin(yaw + phi), 1) - sin(yaw - phi)). The pivot does not enter."""
    phi = math.asin(min(0.95, width0 / (2.0 * r)))
    target = width / r
    best = 90.0
    for d in np.arange(0.0, 90.01, 0.5):
        a = math.radians(d)
        w = min(math.sin(a + phi), 1.0) - math.sin(a - phi)
        if w <= target:
            best = float(d)
            break
    return best


def estimate_pitch(dy, ref_dy):
    """Pitch in degrees (positive = the face looks up) from the visor centroid offset.
    dy and ref_dy are (centroid y - pivot y) / r in image space (y down), for the tilted
    view and for the front view of the same sheet."""
    e0 = math.asin(max(-1.0, min(1.0, -ref_dy)))
    e1 = math.asin(max(-1.0, min(1.0, -dy)))
    return math.degrees(e1 - e0)


# ---------------------------------------------------------------- output

def project(p3, yaw_deg, pitch_deg):
    x, y, z = p3
    a, p = math.radians(yaw_deg), math.radians(pitch_deg)
    x, z = x * math.cos(a) + z * math.sin(a), -x * math.sin(a) + z * math.cos(a)
    y, z = y * math.cos(p) + z * math.sin(p), -y * math.sin(p) + z * math.cos(p)
    return x, y, z


def resample(arr, px, py, r, pad, out):
    """Map a float array so that (px, py) goes to the canvas point out and r to R_OUT."""
    s = R_OUT / r
    a = np.pad(arr, pad).astype(np.float32)
    x0 = px + pad - out[0] / s
    y0 = py + pad - out[1] / s
    box = (x0, y0, x0 + SIZE / s, y0 + SIZE / s)
    im = Image.fromarray(a, mode='F').resize((SIZE, SIZE), Image.LANCZOS, box=box)
    return np.asarray(im)


def write_frame(style, view, cell, px, py, r, est, recolor, out=PIVOT_OUT):
    out_dir = os.path.join(BASES, 'out', style)
    os.makedirs(out_dir, exist_ok=True)
    color, alpha = cell['color'], cell['alpha']
    pad = int(max(alpha.shape) * 1.2)
    a = np.clip(resample(alpha, px, py, r, pad, out), 0, 1)
    rgb = [resample(color[..., i] * alpha, px, py, r, pad, out) for i in range(3)]
    safe = np.maximum(a, 1e-4)
    rgb = np.stack([np.clip(c / safe, 0, 255) for c in rgb], -1)
    if recolor:
        hair = np.clip(resample(cell['hair'], px, py, r, pad, out), 0, 1)
    else:
        hair = np.clip(resample(cell['hair'], px, py, r, pad, out), 0, 1) if cell['hair'] is not None else None
    # Neutralize magenta spill on the white shell outside the hair.
    if hair is not None and recolor:
        bare = hair < 0.35
        m = bare & (np.minimum(rgb[..., 0], rgb[..., 2]) > rgb[..., 1] + 3)
        v = rgb.mean(-1, keepdims=True)
        rgb = np.where(m[..., None], v + (rgb - v) * 0.15, rgb)
    a[a < 0.02] = 0
    rgba = np.dstack([rgb, a * 255]).round().clip(0, 255).astype(np.uint8)
    rgba[a == 0, :3] = 0
    Image.fromarray(rgba, 'RGBA').save(os.path.join(out_dir, view + '.png'), optimize=True)

    entry = {'file': 'out/%s/%s.png' % (style, view), 'pivot': [int(out[0]), int(out[1])], 'r': int(R_OUT)}
    clip = []
    edge = 16 / 255
    if a[0].max() > edge or a[-1].max() > edge or a[:, 0].max() > edge or a[:, -1].max() > edge:
        clip.append('content touches the canvas edge')
    if hair is not None and (hair > 0.5).sum() > 50:
        hm = (hair * 255).round().clip(0, 255).astype(np.uint8)
        Image.fromarray(hm, 'L').save(os.path.join(out_dir, view + '.hair.png'), optimize=True)
        entry['hair'] = 'out/%s/%s.hair.png' % (style, view)
    vis = resample(cell['visor'].astype(np.float32), px, py, r, pad, out) > 0.5
    if vis.sum() > 200:
        Image.fromarray((vis * 255).astype(np.uint8), 'L').save(os.path.join(out_dir, view + '.visor.png'), optimize=True)
        entry['visor'] = 'out/%s/%s.visor.png' % (style, view)
        ys, xs = np.nonzero(vis)
        entry['visorBox'] = [int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)]

    yaw, pitch = est
    anchors = {}
    fg = a > 0.5
    cx = int(out[0])
    col = fg[:, cx - 12:cx + 13].any(1)
    if col.any():
        anchors['top'] = [cx, int(np.argmax(col))]
    for name, p3 in ANCHORS3D.items():
        x, y, z = project(p3, yaw, pitch)
        if z < -0.12:
            continue
        anchors[name] = [int(round(out[0] + R_OUT * x)), int(round(out[1] - R_OUT * y))]
    entry['anchors'] = anchors
    entry['measuredYaw'] = int(round(yaw))
    if pitch:
        entry['measuredPitch'] = int(round(pitch))
    return entry, clip


# ---------------------------------------------------------------- twin transfer for the silver style

def register(src_alpha, dst_alpha):
    """Find (s, tx, ty) that maps src to dst (dst = s * src + t) with the best overlap."""
    def stats(a):
        m = a > 0.5
        ys, xs = np.nonzero(m)
        return m, xs.mean(), ys.mean(), math.sqrt(m.sum())
    sm, sx, sy, ss = stats(src_alpha)
    dm, dx, dy, ds = stats(dst_alpha)
    s0 = ds / ss
    k = 4  # work on a reduced grid
    dsm = dm[::k, ::k]
    ys, xs = np.nonzero(sm[::k, ::k])
    xs = xs * k; ys = ys * k
    best = (-1, s0, dx - s0 * sx, dy - s0 * sy)
    for s in s0 * np.linspace(0.96, 1.04, 9):
        for ox in range(-12, 13, 3):
            for oy in range(-12, 13, 3):
                tx = dx - s * sx + ox
                ty = dy - s * sy + oy
                u = ((xs * s + tx) / k).round().astype(int)
                v = ((ys * s + ty) / k).round().astype(int)
                ok = (u >= 0) & (v >= 0) & (u < dsm.shape[1]) & (v < dsm.shape[0])
                idx = np.unique(v[ok] * dsm.shape[1] + u[ok])
                hit = dsm.ravel()[idx].sum()
                iou = hit / (len(idx) + dsm.sum() - hit)
                if iou > best[0]:
                    best = (iou, s, tx, ty)
    return best


def warp(arr, s, tx, ty, shape):
    """dst(x, y) = src((x - tx) / s, (y - ty) / s)."""
    im = Image.fromarray(arr.astype(np.float32), mode='F')
    data = (1 / s, 0, -tx / s, 0, 1 / s, -ty / s)
    out = im.transform((shape[1], shape[0]), Image.AFFINE, data=data, resample=Image.BILINEAR)
    return np.asarray(out)


# ---------------------------------------------------------------- sheets

def load_sheet(style, sheet):
    path = os.path.join(BASES, 'raw', '%s-%s.png' % (style, sheet))
    im = Image.open(path)
    if 'A' in im.getbands() and im.getchannel('A').getextrema()[0] < 250:
        raise SystemExit('%s: the generator returned a transparent background, not chroma green. '
                         'Make the sheet again.' % os.path.relpath(path, BASES))
    color, alpha = key_green(load_rgb(path))
    boxes, warn = split_cells(alpha, rows2=(sheet != 'c'))
    cells = []
    for (y0, y1, x0, x1) in boxes:
        cells.append((color[y0:y1, x0:x1].copy(), alpha[y0:y1, x0:x1].copy()))
    return cells, warn


def mirror(cell):
    c = dict(cell)
    w = c['alpha'].shape[1]
    for k in ('color', 'alpha', 'hair', 'hard', 'visor'):
        if c.get(k) is not None:
            c[k] = c[k][:, ::-1].copy()
    if c['vbox']:
        x0, y0, x1, y1 = c['vbox']
        c['vbox'] = (w - 1 - x1, y0, w - 1 - x0, y1)
    x0, y0, x1, y1 = c['bbox']
    c['bbox'] = (w - 1 - x1, y0, w - 1 - x0, y1)
    if len(c['outline']):
        o = c['outline'].copy()
        o[:, 0] = w - 1 - o[:, 0]
        c['outline'] = o
    if c['fit']:
        cx, cy, r, n, span = c['fit']
        c['fit'] = (w - 1 - cx, cy, r, n, span)
    return c


def visor_offset(cell):
    cx, cy, r = cell['fit'][:3]
    c = centroid(cell['visor'])
    if c is None or cell['visor'].sum() < (cell['alpha'] > 0.5).sum() * 0.01:
        return None
    return (c[0] - cx) / r, (c[1] - cy) / r


# ---------------------------------------------------------------- scale calibration

CALIB = os.path.join(BASES, 'out', 'calibration.json')


def visor_size(cell):
    x0, y0, x1, y1 = cell['vbox']
    return x1 - x0 + 1, y1 - y0 + 1


def calibrate():
    """Shell radius per visor pixel, from the front view of `seira-long`.
    All hair styles share this visor. The bare `none` head has its own visor shape:
    process_style measures its radius directly (see FREE_FIT_SPAN)."""
    src = 'seira-long'
    cells, _ = load_sheet(src, 'a')
    c = analyze(*cells[0])
    w, h = visor_size(c)
    f = fit_circle(c['outline'])
    if src == 'none':
        r0 = f[2]
        how = 'free circle fit on the bare shell (%d points, %d deg)' % (f[3], f[4])
    else:
        r0 = min(f[2], (c['chin'] - c['top']) / 2.05)
        how = 'chin arc fit, limited so that the shell stays inside the hair dome'
    cal = {'source': src + ' front', 'method': how, 'visorW': w, 'visorH': h, 'r': round(r0, 2),
           'kW': r0 / w, 'kH': r0 / h}
    os.makedirs(os.path.dirname(CALIB), exist_ok=True)
    with open(CALIB, 'w', encoding='utf-8') as fh:
        json.dump(cal, fh, indent=1)
        fh.write('\n')
    log('calibration: r = %.1f px for a visor of %d x %d px (%s)' % (r0, w, h, cal['source']))
    return cal


def load_calibration(fresh=False):
    if fresh or not os.path.exists(CALIB):
        return calibrate()
    with open(CALIB, encoding='utf-8') as fh:
        return json.load(fh)


FREE_FIT_SPAN = 200   # degrees of bare shell outline that make a free circle fit reliable


def r_from_visor(cell, cal):
    """The visor width sets r. The visor height changes with the fringe and the visor design,
    but the hair never covers the sides of the visor in the front view."""
    return cal['kW'] * visor_size(cell)[0]


def place(cell, r, dtop=None):
    """Set cell['fit'] = (cx, cy, r, n, span). Return a note, or None for a good fit."""
    vb = cell['vbox']
    x0, y0, x1, y1 = cell['bbox']
    c0x = (vb[0] + vb[2]) / 2.0 if vb else (x0 + x1) / 2.0
    f = fit_fixed(cell['outline'], r, (c0x, cell['chin'] - r))
    good = f and f[3] >= 40 and f[4] >= 30 and f[2] < 0.03 * r and abs(f[1] - (cell['chin'] - r)) < 0.15 * r
    if dtop is None:
        if good:
            cell['fit'] = (f[0], f[1], r, f[3], f[4])
            return None
        cell['fit'] = (c0x, cell['chin'] - r, r, 0, 0)
        return 'pivot from the chin (short shell outline)'
    # Other views: fit the bare shell outline, starting from the middle of the head silhouette.
    # Hair on the back of a turned head pulls that middle away from the sphere center,
    # so the silhouette middle is only the fallback.
    fg = cell['alpha'] > 0.5
    mids = []
    for y in range(int(cell['top'] + 0.25 * r), int(cell['top'] + 0.75 * r)):
        if 0 <= y < fg.shape[0]:
            xs = np.flatnonzero(fg[y])
            if len(xs):
                mids.append((xs[0] + xs[-1]) / 2.0)
    cx = float(np.median(mids)) if mids else c0x
    cy = f[1] if good else float(cell['top'] + dtop)
    g = fit_fixed(cell['outline'], r, (cx, cy))
    if g and g[3] >= 100 and g[4] >= 40 and g[2] < 0.035 * r and abs(g[1] - cy) < 0.05 * r:
        cell['fit'] = (g[0], g[1], r, g[3], g[4])
        return None
    if good:
        cell['fit'] = (cx, f[1], r, f[3], f[4])
        return 'pivot x from the head silhouette (shell fit not reliable)'
    cell['fit'] = (cx, cy, r, 0, 0)
    return 'pivot x from the head silhouette, y from the head top (shell outline hidden)'


def canvas_pivot(cells):
    """PIVOT_OUT, or a lower pivot when the hair of a view reaches above the canvas."""
    top = bottom = 0.0
    for c in cells:
        px, py, r = c['fit'][:3]
        ys = np.flatnonzero((c['alpha'] > 16 / 255).any(1))
        top = max(top, (py - ys[0]) * R_OUT / r)
        bottom = max(bottom, (ys[-1] - py) * R_OUT / r)
    y = max(PIVOT_OUT[1], math.ceil(top + EDGE_MARGIN))
    if y + bottom > SIZE - 1 - EDGE_MARGIN:
        raise SystemExit('the content is %d px above and %d px below the pivot: it does not fit in %d px'
                         % (top, bottom, SIZE))
    return (PIVOT_OUT[0], float(y))


def process_style(style, twin=None, cal=None):
    label, gender, recolor = STYLES[style]
    cal = cal or load_calibration()
    notes = []
    sheets = {}
    have_c = os.path.exists(os.path.join(BASES, 'raw', '%s-c.png' % style))
    for sh in ('a', 'b', 'c') if have_c else ('a', 'b'):
        raw, warn = load_sheet(style, sh)
        notes += ['sheet %s: %s' % (sh, w) for w in warn]
        cells = []
        for i, (color, alpha) in enumerate(raw):
            hair_soft = None
            if twin is not None and sh in twin:
                tw = twin[sh][i]
                iou, s, tx, ty = register(tw['alpha'], alpha)
                hair_soft = np.clip(warp(tw['hair'], s, tx, ty, alpha.shape), 0, 1) * alpha
                notes.append('sheet %s cell %d: twin overlap %.3f' % (sh, i, iou))
            cells.append(analyze(color, alpha, hair_soft))
        # The front view (sheets a and c: first cell, sheet b: bottom right) sets the scale of the sheet.
        fi = 3 if sh == 'b' else 0
        front = cells[fi]
        if front['vbox'] is None:
            raise SystemExit('%s sheet %s: no visor in the front cell' % (style, sh))
        free = fit_circle(front['outline'])
        if free and free[4] >= FREE_FIT_SPAN:
            r = free[2]
            notes.append('sheet %s: r from a free circle fit on the bare shell (%d deg)' % (sh, free[4]))
        else:
            r = r_from_visor(front, cal)
        n = place(front, r)
        vb = front['vbox']
        vcx = (vb[0] + vb[2]) / 2.0
        if abs(front['fit'][0] - vcx) > 0.05 * r:
            front['fit'] = (vcx,) + tuple(front['fit'][1:])
            notes.append('sheet %s front: pivot x set to the visor center' % sh)
        if n:
            notes.append('sheet %s front: %s' % (sh, n))
        dtop = front['fit'][1] - front['top']
        for i, c in enumerate(cells):
            if i != fi:
                n = place(c, r, dtop)
                if n:
                    notes.append('sheet %s cell %d: %s' % (sh, i, n))
        notes.append('sheet %s: r = %.1f px (front visor %d x %d)' % ((sh, r) + visor_size(front)))
        for c in cells:
            c['w0'] = visor_size(front)[0]
        sheets[sh] = cells

    # Sheet a has a fixed layout: top left front, top right yaw20, bottom left yaw45.
    # The bottom right cell turns only about 65 deg, so it is not a true side view.
    views = {}
    cells = [('front', 'a', 0), ('yaw20', 'a', 1), ('yaw45', 'a', 2)]
    cells.append(('side', 'c', 1) if 'c' in sheets else ('side', 'a', 3))
    for name, sh, i in cells:
        c = sheets[sh][i]
        off = visor_offset(c)
        if off and off[0] < -0.04:
            c = mirror(c)
            notes.append('sheet %s cell %d: mirrored (faced left)' % (sh, i))
        if name == 'front':
            yaw = 0.0
        elif c['vbox'] and off:
            yaw = estimate_yaw(visor_size(c)[0], c['w0'], c['fit'][2])
        else:
            yaw = 90.0
        views[name] = (c, yaw, 0.0)
    if 'c' not in sheets:
        notes.append('side: sheet a cell 3 (about 65 deg); sheet c with a true profile is missing')

    # Sheet b has a fixed layout: top left back, top right up, bottom left down, bottom right front.
    up, down = sheets['b'][1], sheets['b'][2]
    ou, od, of = visor_offset(up), visor_offset(down), visor_offset(sheets['b'][3])
    ref_dy = of[1] if of else 0.0
    if ou and od and ou[1] > od[1]:
        up, down, ou, od = down, up, od, ou
        notes.append('sheet b: up and down cells swapped (visor height)')
    views['back'] = (sheets['b'][0], 180.0, 0.0)
    views['up'] = (up, 0.0, max(3.0, estimate_pitch(ou[1] if ou else ref_dy, ref_dy)))
    views['down'] = (down, 0.0, min(-3.0, estimate_pitch(od[1] if od else ref_dy, ref_dy)))

    out = canvas_pivot([views[v][0] for v in VIEWS])
    if out != PIVOT_OUT:
        notes.append('pivot moved to (%d, %d), so that the hair stays inside the frame' % out)
    entry_views = {}
    for name in VIEWS:
        c, yaw, pitch = views[name]
        px, py, r = c['fit'][:3]
        e, clip = write_frame(style, name, c, px, py, r, (yaw, pitch), recolor, out)
        notes += ['%s: %s' % (name, w) for w in clip]
        entry_views[name] = e
    entry = {'label': label, 'gender': gender, 'recolor': recolor, 'views': entry_views}
    return entry, notes, sheets


def update_manifest(new):
    path = os.path.join(BASES, 'manifest.json')
    man = {'version': 2, 'size': [SIZE, SIZE], 'styles': {}}
    if os.path.exists(path):
        with open(path, encoding='utf-8') as fh:
            man = json.load(fh)
    man['styles'].update(new)
    man['styles'] = {k: man['styles'][k] for k in STYLES if k in man['styles']}
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(man, fh, indent=1)
        fh.write('\n')
    os.replace(tmp, path)


def main(argv):
    args = argv[1:]
    fresh = '--calibrate' in args
    styles = [a for a in args if not a.startswith('--')]
    if not styles and not fresh:
        raise SystemExit(__doc__)
    cal = load_calibration(fresh)
    order = sorted(styles, key=lambda s: 0 if s == 'seira-long' else 1)
    twin_sheets = None
    new = {}
    for style in order:
        if style not in STYLES:
            raise SystemExit('unknown style: ' + style)
        twin = None
        if style == 'seira':
            if twin_sheets is None:
                _, _, twin_sheets = process_style('seira-long', cal=cal)
            twin = twin_sheets
        entry, notes, sheets = process_style(style, twin, cal)
        if style == 'seira-long':
            twin_sheets = sheets
        new[style] = entry
        rs = ', '.join('%s %d' % (v, e['measuredYaw']) for v, e in entry['views'].items())
        log('%s: ok (yaw: %s)' % (style, rs))
        for n in notes:
            log('  ' + n)
    if new:
        update_manifest(new)
        log('manifest.json updated: ' + ', '.join(new))


if __name__ == '__main__':
    main(sys.argv)
