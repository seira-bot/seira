"""Shared definitions for the sticker tools: sheets, ids, labels, size limits, pivot rules."""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)  # brand/mascot/art/stickers
RAW = os.path.join(BASE, "raw")
OUT = os.path.join(BASE, "out")
MANIFEST = os.path.join(BASE, "manifest.json")

PAD = 8          # padding around the trimmed content, in px
MAX_SIDE = 512   # contract limit for any sticker side

# Sheets. "rows" gives the number of items in each row (reading order = id order).
SHEETS = {
    "hands-a": {"kind": "hands", "rows": [3, 3],
                "ids": ["open", "wave", "fist", "point", "peace", "thumbs-up"]},
    "hands-b": {"kind": "hands", "rows": [3, 2],
                "ids": ["ok", "chin", "fan", "hold", "pat"]},
    "acc-a": {"kind": "acc", "rows": [3, 3],
              "ids": ["earring", "glasses", "sunglasses", "headphones", "ribbon", "hairpin"]},
    "acc-b": {"kind": "acc", "rows": [3, 3],
              "ids": ["tiara", "cap", "antenna", "scarf-ring", "bowtie", "headset-mic"]},
    "acc-fix": {"kind": "acc", "rows": [1],
                "ids": ["scarf"]},
    "acc-yaw45": {"kind": "acc-yaw45", "rows": [2, 2],
                  "ids": ["glasses", "sunglasses", "headphones", "cap"]},
    "fx-a": {"kind": "fx", "rows": [4, 4, 4],
             "ids": ["snowflake-1", "snowflake-2", "snowflake-3", "raindrop",
                     "splash-1", "splash-2", "splash-3", "sweat-drop",
                     "tickle-sparkle", "frost", "breath-puff", "steam-puff"]},
    "fx-b": {"kind": "fx", "rows": [4, 4, 4],
             "ids": ["heat-wave", "sun-sparkle", "lightning", "fog-puff",
                     "umbrella", "heart-1", "heart-2", "zzz",
                     "note-1", "note-2", "star", "idea-bulb"]},
    "fx-c": {"kind": "fx", "rows": [4, 4, 4],
             "ids": ["question", "exclaim", "anger-mark", "tear",
                     "dizzy-star", "sneeze-cloud", "blush", "confetti-1",
                     "confetti-2", "confetti-3", "confetti-4", "confetti-5"]},
}

# Hands. wrist = the side of the sprite where the wrist stub is.
HAND_IDS = ["open", "wave", "fist", "point", "peace", "thumbs-up", "ok", "chin", "fan", "hold", "pat"]
HAND_WRIST = {h: "bottom" for h in HAND_IDS}
HAND_WRIST.update({"chin": "bottom", "pat": "left"})
# The raw art shows left-hand poses (thumb outward at the viewer's left). Mirror them, so that the
# sprites are right hands. "pat" already points toward the middle (to the right) and stays as drawn.
HAND_FLIP = set(HAND_IDS) - {"pat"}
HAND_MAX_SIDE = 320
HAND_NOMINAL_WIDTH_PX = 240   # a hand sprite of this width is drawn 0.8 head radii wide
HAND_NOMINAL_WIDTH_R = 0.8

# Accessories. slot / anchor / design width (head radii) / label / pivot rule.
ACC = {
    "earring":     dict(label="Earring", slot="ear", anchor="earR", width=0.22, pivot="top"),
    "glasses":     dict(label="Glasses", slot="face", anchor="eyes", width=1.75, pivot="bridge"),
    "sunglasses":  dict(label="Sunglasses", slot="face", anchor="eyes", width=1.75, pivot="bridge"),
    "headphones":  dict(label="Headphones", slot="ear", anchor="top", width=2.3, pivot="band-top"),
    "ribbon":      dict(label="Ribbon", slot="hair", anchor="top", width=0.9, pivot="knot"),
    "hairpin":     dict(label="Hairpin", slot="hair", anchor="templeR", width=0.4, pivot="center"),
    "tiara":       dict(label="Tiara", slot="hair", anchor="top", width=1.1, pivot="run-bottom"),
    "cap":         dict(label="Cap", slot="top", anchor="top", width=2.1, pivot="cap"),
    "antenna":     dict(label="Antenna", slot="top", anchor="top", width=0.35, pivot="bottom-center"),
    "scarf":       dict(label="Scarf", slot="neck", anchor="neck", width=1.9, pivot="neck-band"),
    "bowtie":      dict(label="Bow tie", slot="neck", anchor="neck", width=0.8, pivot="knot"),
    "headset-mic": dict(label="Headset with microphone", slot="ear", anchor="top", width=2.3, pivot="band-top"),
}
ACC_IDS = list(ACC)
ACC_YAW45 = ["glasses", "sunglasses", "headphones", "cap"]
FRONT_VIEWS = ["front", "yaw20", "up", "down"]
YAW45_VIEWS = ["front", "yaw20", "yaw45", "up", "down"]
ALLOWED_ANCHORS = {"mouth", "top", "earL", "earR", "neck", "templeL", "templeR", "eyes"}
ALLOWED_SLOTS = {"ear", "face", "hair", "top", "neck"}

# Effects. id -> (label, group id, frames order). Particles are small; props are bigger.
FX = {
    "snowflake":      dict(label="Snowflake", frames=["snowflake-1", "snowflake-2", "snowflake-3"], mode="variants", cap=128),
    "raindrop":       dict(label="Raindrop", frames=["raindrop"], mode="single", cap=128),
    "splash":         dict(label="Water splash", frames=["splash-1", "splash-2", "splash-3"], mode="sequence", cap=128),
    "sweat-drop":     dict(label="Sweat drop", frames=["sweat-drop"], mode="single", cap=128),
    "frost":          dict(label="Frost", frames=["frost"], mode="single", cap=160),
    "breath-puff":    dict(label="Breath puff", frames=["breath-puff"], mode="single", cap=192),
    "steam-puff":     dict(label="Steam puff", frames=["steam-puff"], mode="single", cap=192),
    "heat-wave":      dict(label="Heat wave", frames=["heat-wave"], mode="single", cap=192),
    "sun-sparkle":    dict(label="Sun sparkle", frames=["sun-sparkle"], mode="single", cap=128),
    "lightning":      dict(label="Lightning bolt", frames=["lightning"], mode="single", cap=256),
    "fog-puff":       dict(label="Fog puff", frames=["fog-puff"], mode="single", cap=256),
    "umbrella":       dict(label="Umbrella", frames=["umbrella"], mode="single", cap=256),
    "heart":          dict(label="Heart", frames=["heart-1", "heart-2"], mode="variants", cap=128),
    "zzz":            dict(label="Sleep Z", frames=["zzz"], mode="single", cap=160),
    "note":           dict(label="Music note", frames=["note-1", "note-2"], mode="variants", cap=128),
    "confetti":       dict(label="Confetti piece", frames=["confetti-1", "confetti-2", "confetti-3", "confetti-4", "confetti-5"], mode="variants", cap=96),
    "star":           dict(label="Star", frames=["star"], mode="single", cap=128),
    "idea-bulb":      dict(label="Idea light bulb", frames=["idea-bulb"], mode="single", cap=160),
    "question":       dict(label="Question mark", frames=["question"], mode="single", cap=160),
    "exclaim":        dict(label="Exclamation mark", frames=["exclaim"], mode="single", cap=160),
    "anger-mark":     dict(label="Anger mark", frames=["anger-mark"], mode="single", cap=128),
    "tear":           dict(label="Tear", frames=["tear"], mode="single", cap=128),
    "dizzy-star":     dict(label="Dizzy star", frames=["dizzy-star"], mode="single", cap=128),
    "tickle-sparkle": dict(label="Tickle sparkle", frames=["tickle-sparkle"], mode="single", cap=128),
    "sneeze-cloud":   dict(label="Sneeze cloud", frames=["sneeze-cloud"], mode="single", cap=256),
    "blush":          dict(label="Blush patch", frames=["blush"], mode="single", cap=128),
}
# fx whose pivot is not the center
FX_PIVOT = {"umbrella": "grip", "lightning": "top"}

REQUIRED_FX = [
    "snowflake", "raindrop", "splash", "sweat-drop", "frost", "breath-puff", "steam-puff", "heat-wave",
    "sun-sparkle", "lightning", "fog-puff", "umbrella", "heart", "zzz", "note", "confetti", "star",
    "idea-bulb", "question", "exclaim", "anger-mark", "tear", "dizzy-star", "tickle-sparkle",
    "sneeze-cloud", "blush",
]
FX_MIN_FRAMES = {"snowflake": 3, "heart": 2, "note": 2, "confetti": 5}
