#!/usr/bin/env python3
"""Build the web assets of the SeiraCharacter component from the character kit.

Reads brand/mascot/art (bases and stickers), keeps only the frames and the
sprites that the component states use, scales them down, writes WebP files and
kit.json next to this script.

    python3 src/assets/seira-character/build.py
"""
import json
import shutil
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
ART = HERE.parents[2] / "brand" / "mascot" / "art"

STYLE = "seira"
VIEWS = ["front", "yaw20", "yaw45", "up", "down"]
HANDS = ["open", "wave", "chin", "fist"]
FX = ["star", "zzz", "exclaim"]

FRAME_SCALE = 0.75
HAND_SCALE = 0.5
FRAME_QUALITY = 80
STICKER_QUALITY = 82


def scaled(point, k):
    return [round(point[0] * k, 2), round(point[1] * k, 2)]


def save_color(src: Path, dst: Path, k: float, quality: int) -> None:
    im = Image.open(src).convert("RGBA")
    if k != 1:
        im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
    dst.parent.mkdir(parents=True, exist_ok=True)
    im.save(dst, "WEBP", quality=quality, alpha_quality=100, method=6)


def save_mask(src: Path, dst: Path, k: float) -> None:
    im = Image.open(src).convert("L")
    im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS).convert("RGBA")
    dst.parent.mkdir(parents=True, exist_ok=True)
    im.save(dst, "WEBP", lossless=True, method=6)


def main() -> None:
    for folder in ("frames", "hands", "fx"):
        shutil.rmtree(HERE / folder, ignore_errors=True)

    bases = json.loads((ART / "bases" / "manifest.json").read_text())
    stickers = json.loads((ART / "stickers" / "manifest.json").read_text())
    style = bases["styles"][STYLE]
    kit = {"views": {}, "hands": {}, "fx": {}}

    for name in VIEWS:
        view = style["views"][name]
        entry = {
            "file": f"frames/{name}.webp",
            "pivot": scaled(view["pivot"], FRAME_SCALE),
            "r": view["r"] * FRAME_SCALE,
            "visorBox": [round(n * FRAME_SCALE, 2) for n in view["visorBox"]],
            "measuredYaw": view.get("measuredYaw", 0),
            "anchors": {key: scaled(p, FRAME_SCALE) for key, p in view.get("anchors", {}).items()},
        }
        save_color(ART / "bases" / view["file"], HERE / entry["file"], FRAME_SCALE, FRAME_QUALITY)
        entry["hair"] = f"frames/{name}.hair.webp"
        save_mask(ART / "bases" / view["hair"], HERE / entry["hair"], FRAME_SCALE)
        entry["visor"] = f"frames/{name}.visor.webp"
        save_mask(ART / "bases" / view["visor"], HERE / entry["visor"], FRAME_SCALE)
        kit["views"][name] = entry

    for name in HANDS:
        hand = stickers["hands"][name]
        file = f"hands/{name}.webp"
        save_color(ART / "stickers" / hand["file"], HERE / file, HAND_SCALE, STICKER_QUALITY)
        kit["hands"][name] = {"file": file, "pivot": scaled(hand["pivot"], HAND_SCALE), "width": hand["width"]}

    for name in FX:
        fx = stickers["fx"][name]
        frames = []
        for index, frame in enumerate(fx["frames"]):
            file = f"fx/{name}-{index + 1}.webp"
            save_color(ART / "stickers" / frame, HERE / file, 1, STICKER_QUALITY)
            frames.append(file)
        kit["fx"][name] = {"frames": frames, "pivot": fx["pivot"], "mode": fx.get("mode", "single")}

    (HERE / "kit.json").write_text(json.dumps(kit, indent=2) + "\n")
    total = sum(p.stat().st_size for p in HERE.rglob("*") if p.suffix in (".webp", ".json"))
    print(f"{total / 1024:.0f} KB in total")


if __name__ == "__main__":
    main()
