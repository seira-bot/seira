"""Chroma key for sheets on flat green, with edge color recovery (no green fringe).

Method:
1. Read the key color from the sheet border.
2. Pixels that are clearly green are background. Pixels that are clearly not green and
   are away from the edge are "core" foreground.
3. Each edge pixel takes the color of the nearest core pixel (C). Its background share is
   the projection of (pixel - C) on (key - C). Alpha = 1 - that share.
4. Remaining spill on core pixels is removed with a simple despill (g <= max(r, b)).
"""
import numpy as np
from PIL import Image
from scipy import ndimage as ndi


def key_color(a):
    b = 6
    border = np.concatenate([a[:b].reshape(-1, 3), a[-b:].reshape(-1, 3),
                             a[:, :b].reshape(-1, 3), a[:, -b:].reshape(-1, 3)])
    return np.median(border, axis=0)


def key_image(im, core_erode=2, min_speck=60):
    """Return (RGBA uint8 array, key color)."""
    a = np.asarray(im.convert("RGB")).astype(np.float32)
    K = key_color(a)
    if K[1] - max(K[0], K[2]) < 120:
        raise ValueError("The sheet border is not green: key color %s" % K.astype(int).tolist())
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    d = g - np.maximum(r, b)
    bg_sure = d > 140
    fg = d < 4
    core = ndi.binary_erosion(fg, iterations=core_erode) & ~bg_sure
    # thin parts (chains, strokes) have no pixel left after the erosion: keep a thinner core there
    thin = ndi.binary_erosion(fg, iterations=1) & ~bg_sure & ~ndi.binary_dilation(core, iterations=3)
    core = core | thin
    if not core.any():
        raise ValueError("No foreground found")
    idx = ndi.distance_transform_edt(~core, return_distances=False, return_indices=True)
    C = a[idx[0], idx[1]]
    KC = K[None, None, :] - C
    PC = a - C
    denom = (KC ** 2).sum(-1) + 1e-6
    t = np.clip((PC * KC).sum(-1) / denom, 0.0, 1.0)  # background share
    alpha = 1.0 - t
    alpha[bg_sure] = 0.0
    alpha[core] = 1.0
    alpha = np.clip((alpha - 0.10) / 0.80, 0.0, 1.0)
    # color: edge pixels take the nearest core color; the others get despilled
    rgb = a.copy()
    edge = (alpha < 0.97) & ~core
    rgb[edge] = C[edge]
    rr, gg, bb = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    rgb[..., 1] = np.minimum(gg, np.maximum(rr, bb))
    # remove specks
    mask = alpha > 0.5
    lab, n = ndi.label(mask)
    if n:
        sizes = ndi.sum(mask, lab, index=np.arange(1, n + 1))
        small = np.isin(lab, np.where(sizes < min_speck)[0] + 1)
        alpha[small] = 0.0
    alpha[alpha < 0.02] = 0.0
    out = np.dstack([np.clip(rgb, 0, 255), alpha * 255.0]).astype(np.uint8)
    return out, K


def premult_resize(rgba, size):
    """Resize an RGBA uint8 array with premultiplied alpha (no halo)."""
    f = rgba.astype(np.float32)
    al = f[..., 3:4] / 255.0
    pm = np.dstack([f[..., :3] * al, f[..., 3:4]])
    chans = []
    for i in range(4):
        im = Image.fromarray(pm[..., i], mode="F")
        chans.append(np.asarray(im.resize(size, Image.LANCZOS)))
    pm = np.dstack(chans)
    a2 = np.clip(pm[..., 3:4], 0, 255)
    rgb = np.where(a2 > 0.5, pm[..., :3] / np.maximum(a2 / 255.0, 1e-3), 0)
    out = np.dstack([np.clip(rgb, 0, 255), a2])
    return out.astype(np.uint8)
