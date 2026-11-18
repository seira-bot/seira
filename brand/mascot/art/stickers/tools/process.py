#!/usr/bin/env python3
"""Slice, key, scale, and name the sticker sprites; write manifest.json.

Usage:
  python3 tools/process.py slice SHEET [SHEET ...]   key a raw sheet and cut it into sprites (raw/slices/)
  python3 tools/process.py finalize                   scale, pad, find pivots, write out/ and manifest.json
  python3 tools/process.py all                        slice every sheet in raw/, then finalize

Sheets are defined in tools/common.py. Run it with python3 -I is not needed: it reads only this repo.
"""
import json
import os
import re
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
from keying import key_image, premult_resize  # noqa: E402

SLICES = os.path.join(C.RAW, "slices")
DEBUG = os.path.join(C.RAW, "debug")
RHOS = [3, 5, 8, 12, 16, 22, 30, 40, 52, 66, 84, 104]
MIN_ITEM_AREA = 300


# ---------------------------------------------------------------- slicing
def find_items(mask, n_expected):
    dist = ndi.distance_transform_edt(~mask)
    seen = []
    for rho in RHOS:
        lab, n = ndi.label(dist <= rho)
        keep = []
        for l in range(1, n + 1):
            area = int(((lab == l) & mask).sum())
            if area >= MIN_ITEM_AREA:
                keep.append(l)
        seen.append((rho, len(keep)))
        if len(keep) == n_expected:
            return lab, keep, rho
    raise ValueError("cannot find %d items; counts by dilation radius: %s" % (n_expected, seen))


def order_items(lab, keep, mask, rows):
    cents = []
    for l in keep:
        ys, xs = np.nonzero((lab == l) & mask)
        cents.append((l, ys.mean(), xs.mean()))
    cents.sort(key=lambda t: t[1])
    ordered, i = [], 0
    for count in rows:
        row = sorted(cents[i:i + count], key=lambda t: t[2])
        ordered.extend(row)
        i += count
    return ordered


def trim(rgba, thr=8):
    ys, xs = np.nonzero(rgba[..., 3] > thr)
    return rgba[ys.min():ys.max() + 1, xs.min():xs.max() + 1], (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)


def slice_sheet(name):
    cfg = C.SHEETS[name]
    path = os.path.join(C.RAW, name + ".png")
    im = Image.open(path)
    rgba, K = key_image(im)
    mask = rgba[..., 3] > 127
    lab, keep, rho = find_items(mask, len(cfg["ids"]))
    ordered = order_items(lab, keep, mask, cfg["rows"])
    os.makedirs(os.path.join(SLICES, name), exist_ok=True)
    os.makedirs(DEBUG, exist_ok=True)
    dbg = im.convert("RGB")
    dr = ImageDraw.Draw(dbg)
    for (l, cy, cx), sid in zip(ordered, cfg["ids"]):
        piece = rgba.copy()
        piece[..., 3] = np.where(lab == l, piece[..., 3], 0)
        crop, box = trim(piece)
        Image.fromarray(crop, "RGBA").save(os.path.join(SLICES, name, sid + ".png"))
        dr.rectangle(box, outline=(255, 0, 255), width=3)
        dr.text((box[0] + 4, box[1] + 4), sid, fill=(255, 0, 255))
    dbg.save(os.path.join(DEBUG, name + "-slices.png"))
    print("%s: key=%s dilation=%d items=%d" % (name, K.astype(int).tolist(), rho, len(ordered)))


# ---------------------------------------------------------------- helpers
def load_slice(sheet, sid):
    im = np.asarray(Image.open(os.path.join(SLICES, sheet, sid + ".png")).convert("RGBA"))
    if sheet.startswith("hands") and sid in C.HAND_FLIP:
        im = np.ascontiguousarray(im[:, ::-1])
    return im


def despill(rgba):
    out = rgba.copy()
    out[..., 1] = np.minimum(out[..., 1], np.maximum(out[..., 0], out[..., 2]))
    return out


def scale_content(rgba, s):
    rgba = despill(rgba)
    if abs(s - 1.0) < 1e-3:
        return rgba
    h, w = rgba.shape[:2]
    size = (max(1, round(w * s)), max(1, round(h * s)))
    out = premult_resize(rgba, size)
    return trim(out, thr=2)[0]


def pad(rgba, p=C.PAD, canvas=None):
    rgba = despill(rgba)
    h, w = rgba.shape[:2]
    if canvas is None:
        canvas = (w + 2 * p, h + 2 * p)
    out = np.zeros((canvas[1], canvas[0], 4), np.uint8)
    ox, oy = (canvas[0] - w) // 2, (canvas[1] - h) // 2
    out[oy:oy + h, ox:ox + w] = rgba
    return out, (ox, oy)


def alpha_of(rgba):
    return rgba[..., 3] > 127


def run_center_y(a, x):
    col = a[:, x]
    ys = np.nonzero(col)[0]
    if len(ys) == 0:
        return a.shape[0] // 2
    start = ys[0]
    end = start
    while end + 1 < len(col) and col[end + 1]:
        end += 1
    return (start + end) / 2.0


def pivot_for(rule, rgba):
    a = alpha_of(rgba)
    ys, xs = np.nonzero(a)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    w, h = x1 - x0 + 1, y1 - y0 + 1
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    strip = max(3, int(h * 0.04))
    if rule == "center":
        return cx, cy
    if rule == "knot":
        # the thickest point near the center column is the knot of a bow
        dist = ndi.distance_transform_edt(a)
        lo, hi = int(cx - 0.04 * w), int(cx + 0.04 * w) + 1
        sub = dist[:, lo:hi]
        yy, _ = np.unravel_index(int(np.argmax(sub)), sub.shape)
        return cx, float(yy)
    if rule == "top":
        sel = a[y0:y0 + strip]
        return float(np.nonzero(sel)[1].mean()), y0 + 2
    if rule == "bottom-center":
        sel = a[y1 - strip + 1:y1 + 1]
        return float(np.nonzero(sel)[1].mean()), y1 - 2
    if rule == "bridge":
        lo, hi = int(x0 + 0.30 * w), int(x0 + 0.70 * w)
        colsum = a[:, lo:hi].sum(axis=0)
        return float(lo + int(np.argmin(colsum))), cy
    if rule in ("band-top", "neck-band"):
        return cx, run_center_y(a, int(round(cx)))
    if rule == "run-bottom":
        col = a[:, int(round(cx))]
        ys = np.nonzero(col)[0]
        end = ys[0]
        while end + 1 < len(col) and col[end + 1]:
            end += 1
        return cx, float(end)
    if rule == "cap":
        return cx, y0 + 0.10 * h
    if rule == "grip":
        sel = a[int(y0 + 0.62 * h):int(y0 + 0.72 * h)]
        return float(np.nonzero(sel)[1].mean()), y0 + 0.78 * h
    raise ValueError(rule)


def wrist_pivot(rgba, side):
    a = alpha_of(rgba)
    ys, xs = np.nonzero(a)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    w, h = x1 - x0 + 1, y1 - y0 + 1
    if side == "bottom":
        t = max(3, int(h * 0.04))
        sel = a[y1 - t + 1:y1 + 1]
        return float(np.nonzero(sel)[1].mean()), y1 - 3
    if side == "left":
        t = max(3, int(w * 0.04))
        sel = a[:, x0:x0 + t]
        return x0 + 3, float(np.nonzero(sel)[0].mean())
    if side == "right":
        t = max(3, int(w * 0.04))
        sel = a[:, x1 - t + 1:x1 + 1]
        return x1 - 3, float(np.nonzero(sel)[0].mean())
    raise ValueError(side)


def wrist_width(rgba, side):
    a = alpha_of(rgba)
    ys, xs = np.nonzero(a)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    w, h = x1 - x0 + 1, y1 - y0 + 1
    if side == "bottom":
        sel = a[int(y1 - 0.10 * h):int(y1 - 0.03 * h)]
        c = np.nonzero(sel.any(axis=0))[0]
    else:
        sel = a[:, int(x0 + 0.03 * w):int(x0 + 0.10 * w)] if side == "left" else a[:, int(x1 - 0.10 * w):int(x1 - 0.03 * w)]
        c = np.nonzero(sel.any(axis=1))[0]
    return float(c.max() - c.min() + 1)


def save(rgba, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.fromarray(rgba, "RGBA").save(path, optimize=True)


def rel(path):
    return os.path.relpath(path, C.BASE).replace(os.sep, "/")


def pv(p):
    return [int(round(p[0])), int(round(p[1]))]


# ---------------------------------------------------------------- finalize
def sheet_of(sid, kind):
    for name, cfg in C.SHEETS.items():
        if cfg["kind"] == kind and sid in cfg["ids"]:
            return name
    return None


def finalize():
    manifest = {"version": 2, "hands": {}, "accessories": {}, "fx": {}}
    # --- hands: one scale for all hands, set by the wrist width of each sheet
    hands = {}
    for hid in C.HAND_IDS:
        sh = sheet_of(hid, "hands")
        if sh and os.path.exists(os.path.join(SLICES, sh, hid + ".png")):
            hands[hid] = (sh, load_slice(sh, hid))
    if hands:
        med = {}
        for sh in {s for s, _ in hands.values()}:
            ws = [wrist_width(im, C.HAND_WRIST[h]) for h, (s, im) in hands.items() if s == sh]
            med[sh] = float(np.median(ws))
        relscale = {h: 1.0 / med[s] for h, (s, _) in hands.items()}
        big = max(max(im.shape[:2]) * relscale[h] for h, (_, im) in hands.items())
        wk = min((C.HAND_MAX_SIDE - 2 * C.PAD) / big, 1.0 / max(relscale.values()))
        for hid, (sh, im) in hands.items():
            out, _ = pad(scale_content(im, relscale[hid] * wk))
            path = os.path.join(C.OUT, "hands", hid + ".png")
            save(out, path)
            p = wrist_pivot(out, C.HAND_WRIST[hid])
            manifest["hands"][hid] = {
                "file": rel(path), "pivot": pv(p), "side": "right",
                "width": round(out.shape[1] * C.HAND_NOMINAL_WIDTH_R / C.HAND_NOMINAL_WIDTH_PX, 3),
            }
    # --- accessories
    front_size = {}
    for aid in C.ACC_IDS:
        sh = sheet_of(aid, "acc")
        if not sh or not os.path.exists(os.path.join(SLICES, sh, aid + ".png")):
            continue
        im = load_slice(sh, aid)
        s = min(1.0, (C.MAX_SIDE - 2 * C.PAD) / max(im.shape[:2]))
        content = scale_content(im, s)
        out, _ = pad(content)
        path = os.path.join(C.OUT, "acc", aid + ".png")
        save(out, path)
        front_size[aid] = content.shape[:2]
        spec = C.ACC[aid]
        manifest["accessories"][aid] = {
            "label": spec["label"], "slot": spec["slot"], "file": rel(path),
            "pivot": pv(pivot_for(spec["pivot"], out)), "anchor": spec["anchor"],
            "width": spec["width"], "views": list(C.FRONT_VIEWS),
        }
    for aid in C.ACC_YAW45:
        sh = "acc-yaw45"
        p = os.path.join(SLICES, sh, aid + ".png")
        if aid not in manifest["accessories"] or not os.path.exists(p):
            continue
        im = load_slice(sh, aid)
        fh, fw = front_size[aid]
        # same drawing scale as the front sprite: match the content height of the front sprite
        s = min(1.0, (C.MAX_SIDE - 2 * C.PAD) / max(im.shape[:2]))
        content = scale_content(im, s)
        out, _ = pad(content)
        path = os.path.join(C.OUT, "acc", aid + ".yaw45.png")
        save(out, path)
        spec = C.ACC[aid]
        m = manifest["accessories"][aid]
        yh, yw = content.shape[:2]
        m["files"] = {"yaw45": rel(path)}
        m["pivots"] = {"yaw45": pv(pivot_for(spec["pivot"], out))}
        m["widths"] = {"yaw45": round(spec["width"] * (yw * fh / yh) / fw, 3)}
        m["views"] = list(C.YAW45_VIEWS)
    # --- fx
    for fid, spec in C.FX.items():
        frames = []
        for f in spec["frames"]:
            sh = sheet_of(f, "fx")
            if sh and os.path.exists(os.path.join(SLICES, sh, f + ".png")):
                frames.append(load_slice(sh, f))
        if len(frames) != len(spec["frames"]):
            continue
        smax = max(max(f.shape[:2]) for f in frames)
        s = min(1.0, (spec["cap"] - 2 * C.PAD) / smax)
        contents = [scale_content(f, s) for f in frames]
        cw = max(c.shape[1] for c in contents) + 2 * C.PAD
        ch = max(c.shape[0] for c in contents) + 2 * C.PAD
        files = []
        for i, c in enumerate(contents):
            h, w = c.shape[:2]
            out = np.zeros((ch, cw, 4), np.uint8)
            c = despill(c)
            ox = (cw - w) // 2
            oy = (ch - h) if fid == "splash" else (ch - h) // 2   # splash frames sit on a common base line
            if fid == "splash":
                oy = ch - C.PAD - h
            out[oy:oy + h, ox:ox + w] = c
            name = fid + ("-%d" % (i + 1) if len(frames) > 1 else "") + ".png"
            path = os.path.join(C.OUT, "fx", name)
            save(out, path)
            files.append(rel(path))
            last = out
        rule = C.FX_PIVOT.get(fid, "center")
        if fid == "splash":
            pivot = [cw // 2, ch - C.PAD]
        elif len(frames) == 1 and rule != "center":
            pivot = pv(pivot_for(rule, last))
        else:
            pivot = [cw // 2, ch // 2]
        manifest["fx"][fid] = {"label": spec["label"], "frames": files, "pivot": pivot, "mode": spec["mode"]}
    text = json.dumps(manifest, indent=2)
    text = re.sub(r"\[\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]", r"[\1, \2]", text)   # keep pivots on one line
    with open(C.MANIFEST, "w") as fh:
        fh.write(text + "\n")
    print("manifest: %d hands, %d accessories, %d fx" % (
        len(manifest["hands"]), len(manifest["accessories"]), len(manifest["fx"])))


def main(argv):
    if len(argv) < 2 or argv[1] not in ("slice", "finalize", "all"):
        print(__doc__)
        return 2
    if argv[1] == "slice":
        for n in argv[2:]:
            slice_sheet(n)
    elif argv[1] == "finalize":
        finalize()
    else:
        for n in C.SHEETS:
            if os.path.exists(os.path.join(C.RAW, n + ".png")):
                slice_sheet(n)
        finalize()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
