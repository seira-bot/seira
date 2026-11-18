#!/usr/bin/env python3
"""Make contact sheets of the base frames for a visual review.

Usage (from any folder):
  python3 brand/mascot/art/bases/tools/contact.py

Output in brand/mascot/art/bases/contact/:
  front.png         the front view of every style
  yaw45.png         the yaw45 view of every style
  seira-views.png   the 7 views of Seira
  tall-hair.png     the 7 views of bun and spiky, with the frame edge drawn, to show the space above the hair
  masks.png         every style and view with overlays: hair (magenta), visor (cyan),
                    pivot and r = 300 circle (red), anchors (yellow)
"""
import json
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
BASES = os.path.dirname(HERE)
OUT = os.path.join(BASES, 'contact')
VIEWS = ['front', 'yaw20', 'yaw45', 'side', 'back', 'up', 'down']
BG = (58, 62, 70)
TEXT = (235, 235, 240)


def font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def load(path):
    return Image.open(os.path.join(BASES, path)).convert('RGBA')


def thumb(frame, size):
    bg = Image.new('RGBA', frame.size, BG + (255,))
    return Image.alpha_composite(bg, frame).convert('RGB').resize((size, size), Image.LANCZOS)


def overlay(entry, size):
    frame = load(entry['file'])
    bg = Image.new('RGBA', frame.size, BG + (255,))
    im = Image.alpha_composite(bg, frame)
    if entry.get('hair'):
        m = Image.open(os.path.join(BASES, entry['hair'])).convert('L').point(lambda v: v * 0.55)
        im = Image.composite(Image.new('RGBA', im.size, (255, 0, 255, 255)), im, m)
    if entry.get('visor'):
        m = Image.open(os.path.join(BASES, entry['visor'])).convert('L').point(lambda v: v * 0.55)
        im = Image.composite(Image.new('RGBA', im.size, (0, 220, 255, 255)), im, m)
    d = ImageDraw.Draw(im)
    px, py = entry['pivot']
    r = entry['r']
    d.ellipse((px - r, py - r, px + r, py + r), outline=(255, 60, 60, 255), width=4)
    d.line((px - 24, py, px + 24, py), fill=(255, 60, 60, 255), width=4)
    d.line((px, py - 24, px, py + 24), fill=(255, 60, 60, 255), width=4)
    for x, y in entry.get('anchors', {}).values():
        d.ellipse((x - 10, y - 10, x + 10, y + 10), fill=(255, 220, 0, 255))
    if entry.get('visorBox'):
        x, y, w, h = entry['visorBox']
        d.rectangle((x, y, x + w, y + h), outline=(0, 220, 255, 255), width=3)
    return im.convert('RGB').resize((size, size), Image.LANCZOS)


def grid(cells, cols, size, title, label_h=28):
    rows = (len(cells) + cols - 1) // cols
    head = 44
    sheet = Image.new('RGB', (cols * size, head + rows * (size + label_h)), BG)
    d = ImageDraw.Draw(sheet)
    d.text((12, 10), title, fill=TEXT, font=font(24))
    for i, (im, label) in enumerate(cells):
        x, y = (i % cols) * size, head + (i // cols) * (size + label_h)
        sheet.paste(im, (x, y))
        d.text((x + 8, y + size + 4), label, fill=TEXT, font=font(18))
    return sheet


def main():
    with open(os.path.join(BASES, 'manifest.json'), encoding='utf-8') as fh:
        man = json.load(fh)
    styles = man['styles']
    os.makedirs(OUT, exist_ok=True)
    written = []

    for view in ('front', 'yaw45'):
        cells = [(thumb(load(s['views'][view]['file']), 240), sid) for sid, s in styles.items() if view in s['views']]
        g = grid(cells, 6, 240, 'Bases: %s view of every style' % view)
        path = os.path.join(OUT, view + '.png')
        g.save(path, optimize=True)
        written.append(path)

    if 'seira' in styles:
        s = styles['seira']['views']
        cells = []
        for v in VIEWS:
            if v in s:
                e = s[v]
                lab = '%s (yaw %s%s)' % (v, e.get('measuredYaw', '?'),
                                          ', pitch %d' % e['measuredPitch'] if 'measuredPitch' in e else '')
                cells.append((thumb(load(e['file']), 360), lab))
        g = grid(cells, 4, 360, 'Seira: 7 views')
        path = os.path.join(OUT, 'seira-views.png')
        g.save(path, optimize=True)
        written.append(path)

    tall = [sid for sid in ('bun', 'spiky') if sid in styles]
    if tall:
        cells = []
        for sid in tall:
            for v in VIEWS:
                if v in styles[sid]['views']:
                    e = styles[sid]['views'][v]
                    im = thumb(load(e['file']), 240)
                    ImageDraw.Draw(im).rectangle((0, 0, 239, 239), outline=(150, 156, 168), width=1)
                    cells.append((im, '%s %s (pivot y %d)' % (sid, v, e['pivot'][1])))
        g = grid(cells, len(VIEWS), 240, 'Tall hair: 7 views of %s, frame edge in grey' % ' and '.join(tall))
        path = os.path.join(OUT, 'tall-hair.png')
        g.save(path, optimize=True)
        written.append(path)

    size, lw = 150, 130
    head = 70
    sheet = Image.new('RGB', (lw + size * len(VIEWS), head + size * len(styles)), BG)
    d = ImageDraw.Draw(sheet)
    d.text((12, 8), 'Masks: hair magenta, visor cyan, pivot and r circle red, anchors yellow', fill=TEXT, font=font(20))
    for j, v in enumerate(VIEWS):
        d.text((lw + j * size + 8, 40), v, fill=TEXT, font=font(18))
    for i, (sid, s) in enumerate(styles.items()):
        y = head + i * size
        d.text((8, y + size // 2 - 10), sid, fill=TEXT, font=font(16))
        for j, v in enumerate(VIEWS):
            if v in s['views']:
                sheet.paste(overlay(s['views'][v], size), (lw + j * size, y))
    path = os.path.join(OUT, 'masks.png')
    sheet.save(path, optimize=True)
    written.append(path)
    for p in written:
        print(os.path.relpath(p, BASES))


if __name__ == '__main__':
    main()
