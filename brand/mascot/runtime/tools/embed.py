#!/usr/bin/env python3
"""Build a runtime test page that renders alone (no sibling files).

The tool bundles runtime/demo.js with live/tools/bundle.py. It puts the bases
and stickers manifests into the page, and it changes every image path in them
to a data URL. Some browsers and headless renderers open a local page without
access to its sibling files, so the page must not fetch anything.

Usage:
  python3 runtime/tools/embed.py OUT.html [--styles seira,seira-long] [--scale 0.5] [--title TEXT]

- --styles: the base styles to embed (default: seira). Each style adds about 3 MB.
- --scale:  scale the base frames and masks down (needs Pillow). Pivots, radii,
            boxes and anchors scale with them. Default 1 (no change).
The page reads the query keys of demo.js (see runtime/README.md).
"""
import base64
import copy
import io
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
RUNTIME = os.path.dirname(HERE)
MASCOT = os.path.dirname(RUNTIME)
ART = os.path.join(MASCOT, 'art')
BUNDLE = os.path.join(MASCOT, 'live', 'tools', 'bundle.py')
IMAGE_EXT = ('.png', '.webp', '.jpg', '.jpeg')

SHELL = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
html,body{{margin:0;height:100%;background:#F2F4F1;font:13px/1.3 system-ui,sans-serif;color:#2A2F38}}
#stage{{position:fixed;inset:0}}
</style>
<script>window.__SEIRA_ASSETS = {assets};</script>
</head><body><div id="stage"></div>
<!--BUNDLE-->
</body></html>
"""


def data_url(path, scale):
    ext = os.path.splitext(path)[1].lower()
    mime = {'.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'}[ext]
    if scale != 1:
        from PIL import Image
        im = Image.open(path)
        im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format='PNG', optimize=True)
        raw, mime = buf.getvalue(), 'image/png'
    else:
        with open(path, 'rb') as fh:
            raw = fh.read()
    return 'data:%s;base64,%s' % (mime, base64.b64encode(raw).decode('ascii'))


def inline(node, root, scale):
    """Change every image path in node to a data URL. A missing file stays a path (the runtime skips it)."""
    if isinstance(node, dict):
        return {k: inline(v, root, scale) for k, v in node.items()}
    if isinstance(node, list):
        return [inline(v, root, scale) for v in node]
    if isinstance(node, str) and node.lower().endswith(IMAGE_EXT):
        path = os.path.join(root, node)
        return data_url(path, scale) if os.path.isfile(path) else node
    return node


def scale_view(view, k):
    v = dict(view)
    for key in ('pivot', 'visorBox'):
        if key in v:
            v[key] = [round(x * k, 2) for x in v[key]]
    if 'r' in v:
        v['r'] = round(v['r'] * k, 2)
    if 'anchors' in v:
        v['anchors'] = {n: [round(x * k, 2) for x in a] for n, a in v['anchors'].items()}
    return v


def main(argv):
    args = argv[1:]
    styles, scale, title = ['seira'], 1.0, 'Seira runtime'
    if '--styles' in args:
        i = args.index('--styles'); styles = args[i + 1].split(','); del args[i:i + 2]
    if '--scale' in args:
        i = args.index('--scale'); scale = float(args[i + 1]); del args[i:i + 2]
    if '--title' in args:
        i = args.index('--title'); title = args[i + 1]; del args[i:i + 2]
    if len(args) != 1:
        raise SystemExit(__doc__)
    out = args[0]

    with open(os.path.join(ART, 'bases', 'manifest.json'), encoding='utf-8') as fh:
        bases = json.load(fh)
    with open(os.path.join(ART, 'stickers', 'manifest.json'), encoding='utf-8') as fh:
        stickers = json.load(fh)

    missing = [s for s in styles if s not in bases.get('styles', {})]
    if missing:
        raise SystemExit('unknown style: ' + ', '.join(missing))
    bases = copy.deepcopy(bases)
    bases['styles'] = {s: bases['styles'][s] for s in styles}
    if scale != 1:
        bases['size'] = [round(x * scale) for x in bases.get('size', [1024, 1024])]
        for st in bases['styles'].values():
            st['views'] = {n: scale_view(v, scale) for n, v in st['views'].items()}
    bases = inline(bases, os.path.join(ART, 'bases'), scale)
    stickers = inline(stickers, os.path.join(ART, 'stickers'), 1.0)

    assets = json.dumps({'bases': bases, 'stickers': stickers})
    assets = assets.replace('</', '<\\/').replace('<!--', '<\\u0021--')
    with tempfile.TemporaryDirectory() as tmp:
        shell = os.path.join(tmp, 'shell.html')
        with open(shell, 'w', encoding='utf-8') as fh:
            fh.write(SHELL.format(title=title, assets=assets))
        subprocess.run([sys.executable, BUNDLE, os.path.join(RUNTIME, 'demo.js'), out, '--html', shell], check=True)


if __name__ == '__main__':
    main(sys.argv)
