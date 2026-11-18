#!/usr/bin/env python3
"""Validate cast.json against the character config schema of brand/mascot/live/CONTRACT.md.

Usage: python3 brand/mascot/cast/tools/validate.py [path/to/cast.json]
Exit code 0 when every preset is valid, 1 otherwise.
The id lists below mirror CONTRACT.md. Update them when the contract changes.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CAST_DIR = os.path.dirname(HERE)

FEMALE_STYLES = ["seira-long", "bob", "twin-tails", "ponytail", "long-straight", "bun", "long-wavy"]
MALE_STYLES = ["short-neat", "center-part", "spiky", "slick-back", "long-tied", "long-loose", "buzz", "messy"]
# styles with recolor: false keep their native color, so hairColor must be null
NATIVE_STYLES = ["seira", "none"]
STYLES = NATIVE_STYLES + FEMALE_STYLES + MALE_STYLES  # 17 base styles

GENDERS = ["f", "m", "u"]
EYES = ["pill", "round", "sharp", "almond", "sleepy", "dot", "star", "square"]
MOUTHS = ["smile", "cat", "flat", "grin", "fang", "small-o", "smirk"]
BROWS = ["none", "thin", "thick", "angled"]
PERSONALITIES = ["calm", "cheerful", "cool", "playful", "shy", "proud"]
ACCESSORIES = ["earring", "glasses", "sunglasses", "headphones", "ribbon", "hairpin",
               "tiara", "cap", "antenna", "scarf", "bowtie", "headset-mic"]
MAX_ACCESSORIES = 3
MIN_PRESETS = 17  # Seira plus at least 16 more (AC-09)

REQUIRED = ["id", "name", "gender", "style", "hairColor", "shell", "screen", "eyes", "eyeColor",
            "lashes", "brows", "mouth", "blush", "accessories", "hands", "personality"]
OPTIONAL = ["sheet"]  # extra field that the Cast stream adds

HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")
KEBAB = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")

# Seira is the main character. Her preset is fixed by the contract.
SEIRA = {"id": "seira", "style": "seira", "hairColor": None, "eyes": "pill", "eyeColor": "#FF2A57",
         "mouth": "smile", "personality": "calm", "lashes": True, "gender": "f"}


def check_preset(p, index):
    """Return a list of error strings for one preset."""
    errs = []
    label = p.get("id", f"#{index}") if isinstance(p, dict) else f"#{index}"

    def err(msg):
        errs.append(f"{label}: {msg}")

    if not isinstance(p, dict):
        return [f"{label}: preset is not an object"]
    for key in REQUIRED:
        if key not in p:
            err(f"missing field '{key}'")
    for key in p:
        if key not in REQUIRED + OPTIONAL:
            err(f"unknown field '{key}'")
    if errs:
        return errs

    if not isinstance(p["id"], str) or not KEBAB.match(p["id"]):
        err("id must be kebab-case")
    if not isinstance(p["name"], str) or not p["name"].strip():
        err("name must be a non-empty string")

    if p["gender"] not in GENDERS:
        err(f"gender '{p['gender']}' not in {GENDERS}")
    if p["style"] not in STYLES:
        err(f"style '{p['style']}' is not one of the {len(STYLES)} base styles")
    else:
        if p["style"] in NATIVE_STYLES:
            if p["hairColor"] is not None:
                err(f"style '{p['style']}' keeps its native color, so hairColor must be null")
        elif not (isinstance(p["hairColor"], str) and HEX.match(p["hairColor"])):
            err("hairColor must be a #RRGGBB hex string for a recolor style")
        if p["style"] in FEMALE_STYLES + ["seira"] and p["gender"] != "f":
            err(f"style '{p['style']}' is a female style, gender must be 'f'")
        if p["style"] in MALE_STYLES and p["gender"] != "m":
            err(f"style '{p['style']}' is a male style, gender must be 'm'")

    for key in ("shell", "screen", "eyeColor"):
        if not (isinstance(p[key], str) and HEX.match(p[key])):
            err(f"{key} must be a #RRGGBB hex string")
    for key in ("lashes", "blush", "hands"):
        if not isinstance(p[key], bool):
            err(f"{key} must be true or false")

    if p["eyes"] not in EYES:
        err(f"eyes '{p['eyes']}' not in {EYES}")
    if p["mouth"] not in MOUTHS:
        err(f"mouth '{p['mouth']}' not in {MOUTHS}")
    if p["brows"] not in BROWS:
        err(f"brows '{p['brows']}' not in {BROWS}")
    if p["personality"] not in PERSONALITIES:
        err(f"personality '{p['personality']}' not in {PERSONALITIES}")

    acc = p["accessories"]
    if not isinstance(acc, list):
        err("accessories must be a list")
    else:
        if len(acc) > MAX_ACCESSORIES:
            err(f"at most {MAX_ACCESSORIES} accessories, found {len(acc)}")
        if len(set(acc)) != len(acc):
            err("accessories contain a duplicate")
        for a in acc:
            if a not in ACCESSORIES:
                err(f"accessory '{a}' not in the contract list")
    return errs


def check_seira(presets):
    errs = []
    first = presets[0] if presets else {}
    if first.get("id") != "seira":
        errs.append("seira: Seira must be the first preset")
    for key, want in SEIRA.items():
        if first.get(key, "<missing>") != want:
            errs.append(f"seira: {key} must be {want!r}, found {first.get(key, '<missing>')!r}")
    return errs


def main(argv):
    path = argv[1] if len(argv) > 1 else os.path.join(CAST_DIR, "cast.json")
    try:
        with open(path, encoding="utf-8") as fh:
            presets = json.load(fh)
    except (OSError, ValueError) as exc:
        print(f"FAIL: cannot read {os.path.basename(path)}: {exc}")
        return 1
    if not isinstance(presets, list):
        print("FAIL: cast.json must be an array of presets")
        return 1

    errors = []
    for i, p in enumerate(presets):
        errors += check_preset(p, i)
    errors += check_seira(presets)

    ids = [p.get("id") for p in presets if isinstance(p, dict)]
    for dup in sorted({i for i in ids if ids.count(i) > 1}):
        errors.append(f"{dup}: duplicate id")
    if len(presets) < MIN_PRESETS:
        errors.append(f"need at least {MIN_PRESETS} presets (Seira + 16), found {len(presets)}")

    # Concept sheets are produced after the presets, so a missing file is a warning only.
    warnings = []
    for p in presets:
        sheet = p.get("sheet") if isinstance(p, dict) else None
        if sheet and not os.path.isfile(os.path.join(CAST_DIR, "concept", sheet + ".png")):
            warnings.append(f"{p['id']}: concept sheet concept/{sheet}.png not found")

    for w in warnings:
        print("WARN:", w)
    if errors:
        for e in errors:
            print("ERROR:", e)
        print(f"FAIL: {len(errors)} error(s) in {len(presets)} presets")
        return 1

    females = sum(1 for p in presets if p["gender"] == "f")
    males = sum(1 for p in presets if p["gender"] == "m")
    styles = sorted({p["style"] for p in presets})
    print(f"OK: {len(presets)} presets valid ({females} female, {males} male, "
          f"{len(styles)} of {len(STYLES)} base styles used)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
