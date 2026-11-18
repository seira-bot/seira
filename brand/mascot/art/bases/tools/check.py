#!/usr/bin/env python3
"""Check the base frames against CONTRACT.md. Exit 0 when every check passes.

Usage (from any folder):
  python3 brand/mascot/art/bases/tools/check.py [STYLE ...]

Checks for each style:
  coverage   the manifest has all 7 views, and every listed file exists (1024 x 1024)
  scale      r = 300 and one pivot for all views of a style: x 512, y 452 or lower (tall hair);
             the measured shell radius is 300 +/- 6
  visor      a visor mask for front, yaw20, yaw45, up, down
  hair       a hair mask for every view of a recolor style
  center     front: the visor centroid x is 512 +/- 20, and the visorBox is symmetric about the pivot
  turn       the visor centroid moves right from front to yaw20 to yaw45 to side;
             measuredYaw is near the view name
  pitch      up has measuredPitch > 0, down has measuredPitch < 0
  pivot      every other view: a circle of r = 300 on the bare shell outline is centered on the
             pivot +/- 12 px (skipped where hair hides too much of the shell)
  clear      no hair inside the visor outline (the fringe stops at the visor top)
  edge       no alpha above 16 (of 255) in the outer 1 px row or column of a frame
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
VIEWS = ['front', 'yaw20', 'yaw45', 'side', 'back', 'up', 'down']
VISOR_VIEWS = ['front', 'yaw20', 'yaw45', 'up', 'down']
YAW_RANGE = {'yaw20': (10, 30), 'yaw45': (30, 60), 'side': (70, 90)}
STYLE_IDS = ['seira', 'seira-long', 'bob', 'twin-tails', 'ponytail', 'long-straight', 'bun', 'long-wavy',
             'short-neat', 'center-part', 'spiky', 'slick-back', 'long-tied', 'long-loose', 'buzz', 'messy', 'none']
PIVOT = (512, 452)   # pivot y can be lower for a style with tall hair
R = 300
R_TOL = 6
PIVOT_TOL = 12
EDGE_ALPHA = 16


def mask(path):
    return np.asarray(Image.open(os.path.join(BASES, path)).convert('L'), dtype=np.float32) / 255.0


def alpha(path):
    return np.asarray(Image.open(os.path.join(BASES, path)).convert('RGBA'), dtype=np.float32)[..., 3] / 255.0


def fit_circle(pts):
    """Kasa least squares fit with outlier trimming. Return (cx, cy, r, span in degrees)."""
    p = pts.astype(np.float64)
    for _ in range(6):
        x, y = p[:, 0], p[:, 1]
        A = np.column_stack([x, y, np.ones_like(x)])
        sol, *_ = np.linalg.lstsq(A, x * x + y * y, rcond=None)
        cx, cy = sol[0] / 2, sol[1] / 2
        r = math.sqrt(max(1e-6, sol[2] + cx * cx + cy * cy))
        keep = np.abs(np.hypot(x - cx, y - cy) - r) < max(2.0, 0.015 * r)
        if keep.all() or keep.sum() < 30:
            break
        p = p[keep]
    ang = np.degrees(np.arctan2(p[:, 1] - cy, p[:, 0] - cx))
    return cx, cy, r, len(np.unique((ang // 6).astype(int))) * 6


def shell_radius(entry, pivot):
    """Measure the shell radius in the front frame.
    Bare shell (long outline): a free circle fit. Otherwise: the median distance from the
    pivot to the shell outline below the pivot (the chin arc)."""
    a = alpha(entry['file']) > 0.5
    hair = mask(entry['hair']) > 0.15 if entry.get('hair') else np.zeros_like(a)
    visor = mask(entry['visor']) > 0.5 if entry.get('visor') else np.zeros_like(a)
    body = a & ~ndi.binary_dilation(hair, iterations=4) & ~visor
    edge = body & ndi.binary_dilation(~a, iterations=2)
    ys, xs = np.nonzero(edge)
    if len(xs) > 200:
        cx, cy, r, span = fit_circle(np.column_stack([xs, ys]))
        if span >= 200:
            return r, 'free fit (%d deg)' % span
    low = ys > pivot[1] + 0.3 * R
    if low.sum() < 50:
        return None, 'short chin arc (%d points)' % low.sum()
    d = np.hypot(xs[low] - pivot[0], ys[low] - pivot[1])
    return float(np.median(d)), 'chin arc (%d points)' % low.sum()


def shell_outline(entry):
    """Points where the bare shell (not hair, not visor) meets the background."""
    a = alpha(entry['file'])
    hair = mask(entry['hair']) > 0.15 if entry.get('hair') else np.zeros(a.shape, bool)
    visor = mask(entry['visor']) > 0.5 if entry.get('visor') else np.zeros(a.shape, bool)
    edge = (a > 0.5) & ~hair & ~visor & ndi.binary_dilation(a < 0.15, iterations=2)
    edge &= ~ndi.binary_dilation(hair, iterations=5) & ~ndi.binary_dilation(visor, iterations=3)
    ys, xs = np.nonzero(edge)
    return np.column_stack([xs, ys]).astype(np.float64)


def fit_center(pts, r, c0):
    """Center of a circle with the known radius r. Return (cx, cy, rms, n, span in degrees)."""
    if len(pts) < 40:
        return None
    c = np.array(c0, dtype=np.float64)
    p = pts
    for it in range(40):
        d = p - c
        n = np.maximum(np.hypot(d[:, 0], d[:, 1]), 1e-6)
        e = n - r
        u = d / n[:, None]
        if it in (10, 20, 30):
            med = np.median(e)
            keep = np.abs(e - med) < max(3.0, 4.5 * np.median(np.abs(e - med)))
            if keep.sum() >= 40:
                p, u, e = p[keep], u[keep], e[keep]
        step, *_ = np.linalg.lstsq(u, e, rcond=None)
        c = c + step
        if np.hypot(*step) < 0.01 and it > 30:
            break
    d = p - c
    e = np.hypot(d[:, 0], d[:, 1]) - r
    span = len(np.unique((np.degrees(np.arctan2(d[:, 1], d[:, 0])) // 6).astype(int))) * 6
    return float(c[0]), float(c[1]), float(np.sqrt(np.mean(e * e))), len(p), span


def ortho_fill(m):
    """Fill each row and each column of m between its first and last pixel; keep the overlap."""
    rows = np.zeros_like(m)
    cols = np.zeros_like(m)
    for y in np.flatnonzero(m.any(1)):
        xs = np.flatnonzero(m[y])
        rows[y, xs[0]:xs[-1] + 1] = True
    for x in np.flatnonzero(m.any(0)):
        ys = np.flatnonzero(m[:, x])
        cols[ys[0]:ys[-1] + 1, x] = True
    return rows & cols


def check_style(sid, s):
    fails, warns, info = [], [], []
    views = s.get('views', {})
    missing = [v for v in VIEWS if v not in views]
    if missing:
        fails.append('coverage: missing views %s' % ', '.join(missing))
    for v, e in views.items():
        for k in ('file', 'hair', 'visor'):
            if e.get(k) and not os.path.exists(os.path.join(BASES, e[k])):
                fails.append('coverage: %s file not found: %s' % (v, e[k]))
        if os.path.exists(os.path.join(BASES, e['file'])):
            size = Image.open(os.path.join(BASES, e['file'])).size
            if size != (1024, 1024):
                fails.append('coverage: %s is %d x %d' % ((v,) + size))
        if e.get('r') != R:
            fails.append('scale: %s has r %s, expected %d' % (v, e.get('r'), R))
    if missing and 'front' not in views:
        return fails, warns, info
    P = tuple(views['front'].get('pivot') or (0, 0))
    if P[0] != PIVOT[0] or P[1] < PIVOT[1]:
        fails.append('scale: pivot %s, expected x %d and y %d or more' % (list(P), PIVOT[0], PIVOT[1]))
    other = sorted(v for v, e in views.items() if tuple(e.get('pivot') or ()) != P)
    if other:
        fails.append('scale: the pivot of %s differs from the front pivot %s' % (', '.join(other), list(P)))
    if P != PIVOT:
        info.append('pivot %s' % list(P))

    r, how = shell_radius(views['front'], P)
    if r is None or abs(r - R) > R_TOL:
        fails.append('scale: front shell radius %s (%s), expected %d +/- %d' % (
            'n/a' if r is None else '%.1f' % r, how, R, R_TOL))
    info.append('r %.1f (%s)' % (r, how) if r is not None else 'r n/a')

    for v in VISOR_VIEWS:
        if v in views and not views[v].get('visor'):
            fails.append('visor: no visor mask in %s' % v)
    if s.get('recolor'):
        for v in VIEWS:
            if v in views and not views[v].get('hair'):
                fails.append('hair: no hair mask in %s' % v)

    cen = {}
    for v in VIEWS:
        if v in views and views[v].get('visor'):
            m = mask(views[v]['visor']) > 0.5
            ys, xs = np.nonzero(m)
            if len(xs):
                cen[v] = (float(xs.mean()), float(ys.mean()))
    f = views['front']
    if 'front' in cen:
        if abs(cen['front'][0] - P[0]) > 20:
            fails.append('center: front visor centroid x %.0f, expected %d +/- 20' % (cen['front'][0], P[0]))
        x, y, w, h = f['visorBox']
        left, right = P[0] - x, x + w - P[0]
        if abs(left - right) > 20:
            fails.append('center: front visorBox reaches %d px left and %d px right of the pivot' % (left, right))
        info.append('front visor x %.0f' % cen['front'][0])

    seq = [v for v in ('front', 'yaw20', 'yaw45', 'side') if v in cen]
    for a, b in zip(seq, seq[1:]):
        if cen[b][0] < cen[a][0] + 10:
            fails.append('turn: visor centroid x %s %.0f is not right of %s %.0f' % (b, cen[b][0], a, cen[a][0]))
    info.append('visor x ' + ' < '.join('%s %.0f' % (v, cen[v][0]) for v in seq))
    for v, (lo, hi) in YAW_RANGE.items():
        if v in views:
            y = views[v].get('measuredYaw')
            if y is None or not lo <= y <= hi:
                fails.append('turn: %s measuredYaw %s, expected %d..%d' % (v, y, lo, hi))
    info.append('yaw ' + ', '.join('%s %s' % (v, views[v].get('measuredYaw')) for v in ('yaw20', 'yaw45', 'side') if v in views))
    if 'up' in views and not views['up'].get('measuredPitch', 0) > 0:
        fails.append('pitch: up has measuredPitch %s' % views['up'].get('measuredPitch'))
    if 'down' in views and not views['down'].get('measuredPitch', 0) < 0:
        fails.append('pitch: down has measuredPitch %s' % views['down'].get('measuredPitch'))

    unsure = []
    for v in VIEWS[1:]:
        if v not in views:
            continue
        f = fit_center(shell_outline(views[v]), R, P)
        if not (f and f[3] >= 150 and f[4] >= 40 and f[2] < 0.035 * R and abs(f[1] - P[1]) < 15):
            unsure.append(v)
        elif max(abs(f[0] - P[0]), abs(f[1] - P[1])) > PIVOT_TOL:
            fails.append('pivot: the shell in %s is centered at (%.0f, %.0f), expected (%d, %d) +/- %d' % (
                v, f[0], f[1], P[0], P[1], PIVOT_TOL))
    if unsure:
        info.append('pivot not measured in ' + ', '.join(unsure))

    for v in VISOR_VIEWS:
        e = views.get(v)
        if not e or not e.get('visor') or not e.get('hair'):
            continue
        vis = mask(e['visor']) > 0.5
        hull = ortho_fill(vis)
        hair = mask(e['hair']) > 0.5
        over = (hull & hair).sum() / max(1, vis.sum())
        if over > 0.03:
            fails.append('clear: hair covers %.1f%% of the visor outline in %s' % (100 * over, v))
        elif over > 0.01:
            warns.append('clear: hair touches %.1f%% of the visor outline in %s' % (100 * over, v))

    for v, e in views.items():
        a = alpha(e['file']) * 255
        sides = [n for n, row in (('top', a[0]), ('bottom', a[-1]), ('left', a[:, 0]), ('right', a[:, -1]))
                 if row.max() > EDGE_ALPHA]
        if sides:
            fails.append('edge: %s touches the %s edge' % (v, ', '.join(sides)))
    return fails, warns, info


def main(argv):
    with open(os.path.join(BASES, 'manifest.json'), encoding='utf-8') as fh:
        man = json.load(fh)
    styles = man.get('styles', {})
    wanted = argv[1:] or STYLE_IDS
    total = 0
    for sid in wanted:
        if sid not in styles:
            print('FAIL %-14s missing from manifest.json' % sid)
            total += 1
            continue
        fails, warns, info = check_style(sid, styles[sid])
        print('%s %-14s %s' % ('FAIL' if fails else 'ok  ', sid, '; '.join(info)))
        for f in fails:
            print('       fail: ' + f)
        for w in warns:
            print('       warn: ' + w)
        total += len(fails)
    extra = sorted(set(styles) - set(STYLE_IDS))
    if extra:
        print('FAIL unknown styles in manifest.json: ' + ', '.join(extra))
        total += 1
    print('%d styles checked, %d failures' % (len(wanted), total))
    return 1 if total else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
