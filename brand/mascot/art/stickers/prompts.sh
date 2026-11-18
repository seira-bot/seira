#!/usr/bin/env bash
# Sticker sheets for the Seira character: hands, accessories, effect sprites.
# Generator: gpt-image-2.6 through $SEIRA_IMAGE_CMD (see brand/.env.example). Images go through one provider only.
# Usage: ./prompts.sh SHEET [SHEET ...]     (at most 2 sheets run at the same time)
#        FORCE=1 ./prompts.sh SHEET         (keep the old raw file as *.rejected-*.png, then make a new one)
# Sheets: hands-a hands-b acc-a acc-b acc-fix acc-yaw45 fx-a fx-b fx-c
# Each result is logged in gen.log. Raw sheets go to raw/. Process them with tools/process.py.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../../.." && pwd)
BRAND="$ROOT/brand"; . "$BRAND/load-env.sh"
G=${SEIRA_IMAGE_CMD:?Set SEIRA_IMAGE_CMD in brand/.env.local. See brand/.env.example.}
REF="$ROOT/brand/mascot/options/d-companion-bot.png"
LOG="$HERE/gen.log"
mkdir -p "$HERE/raw"

STYLE="Style: the same art style as the first reference image. Matte-to-satin white vinyl toy, soft studio light from the top left, rounded chunky shapes, soft shading, cute and clean. The white shell color is #ECEEF1, the accent color is crimson #E11D48, dark parts are glossy near-black #0C0F14. Use the reference image only for style, material and color. Do not draw the robot head, a face, or hair from the reference image."
SHEET="Make a sprite sheet on ONE flat, pure chroma green background (#00FF00). The background has no floor, no ground shadow, no drop shadow, no gradient, no vignette, no glow, no noise. Every item is a separate sticker, fully visible and not cropped, and has wide empty green space around it (at least one quarter of the item size) and from the image edge. Items do not touch and do not overlap. The items have no outline of green and no green light on them. No text, no letters, no numbers, no labels, no captions, no grid lines, no frames, no watermark. Wide 3:2 image. Do not use green in any item."

HANDS="Each item is ONE floating right hand: simple and toy-like, like a soft glove or mitt. White vinyl, rounded chubby shapes, four short thick fingers and one thumb, smooth surface, no fingernails, no wrinkles, no lines on the palm. No arm and no sleeve: each hand ends at the wrist in a smooth, short, rounded stub. All hands have the same size, the same wrist width, and the same style. Every hand is a right hand seen from the front, with the wrist at the bottom, unless the item says otherwise."
WORN="Each accessory is drawn alone, in the way that it looks when it is worn, but WITHOUT any head, face, hair or neck: where the head would be, the picture is empty flat green. Each accessory is seen straight from the front, flat and symmetrical, like a game sticker."

# name; prompt; optional extra reference files
declare -A PROMPT
declare -A EXTRA

PROMPT[hands-a]="Sprite sheet of 6 hand gestures in 3 columns and 2 rows (3 hands in the top row, 3 hands in the bottom row). $HANDS Order, from left to right, top row first: 1 open: open palm facing the viewer, fingers up and slightly spread, thumb out to the side. 2 wave: open palm facing the viewer, tilted 20 degrees to the side as in a greeting wave, fingers spread. 3 fist: a closed fist seen from the front, fingers curled, thumb across the fingers. 4 point: the index finger points straight up, the other fingers are curled, the thumb is tucked. 5 peace: index finger and middle finger up in a V sign, the other fingers curled. 6 thumbs-up: a fist with the thumb straight up. $STYLE $SHEET"

PROMPT[hands-b]="Sprite sheet of 5 hand gestures: 3 hands in the top row and 2 hands in the bottom row, the bottom row centered. $HANDS Order, from left to right, top row first: 1 ok: the thumb and the index finger touch and form a circle, the other three fingers are up. 2 chin: a hand pose for resting under a chin: the fingers are curled loosely together, the thumb is tucked under, the back of the curled fingers forms a smooth, flat, slightly tilted top surface, seen from the side, wrist at the bottom right. 3 fan: a flat open hand with the fingers together, palm facing the viewer, tilted 35 degrees as if it is fanning the air, wrist at the bottom. 4 hold: a cupped hand with the palm up and the fingers together and curled slightly upward, as if it holds a small ball, seen from the front and a little from above, wrist at the bottom. 5 pat: a flat hand seen from the side with the palm down, the fingers together and pointing to the right, the thumb on the near side, as if it gently pats a head, wrist at the left. $STYLE $SHEET"

PROMPT[acc-a]="Sprite sheet of 6 accessories in 3 columns and 2 rows (3 in the top row, 3 in the bottom row). $WORN Order, from left to right, top row first: 1 earring: ONE single earring, a small round silver stud on top and one small dangling crimson round bead on a thin silver chain. 2 glasses: round thin white vinyl frame glasses, both lenses completely empty (plain green seen through the lenses, no lens fill), a small bridge, the frame is about 2.4 times wider than high, tiny hinge stubs at both ends. 3 sunglasses: the same shape as the glasses but chunky rounded-square frames in white vinyl with glossy near-black opaque lenses and one tiny white highlight on each lens, about 2.4 times wider than high. 4 headphones: over-ear headphones: a wide curved white headband that arches over empty space, a round ear cup at each end (white vinyl with a crimson ring), the middle between the cups is empty green, total width about 1.2 times the height. 5 ribbon: a cute bow ribbon in crimson, a round center knot, two puffy loops and two short tails. 6 hairpin: a small hair clip in white vinyl with one tiny crimson star on it. $STYLE $SHEET"

PROMPT[acc-b]="Sprite sheet of 6 accessories in 3 columns and 2 rows (3 in the top row, 3 in the bottom row). $WORN Order, from left to right, top row first: 1 tiara: a small silver tiara crown with three rounded points and one crimson gem in the center, a thin curved base band. 2 cap: a baseball cap seen from the front: a white vinyl dome crown with a short crimson brim in front, no logo, no text. 3 antenna: a short antenna: a small round base disc, a thin stalk, and a round crimson ball on top, about 3 times higher than wide. 4 scarf: a chunky knitted scarf worn around a neck, front view, without neck and head: a thick curved U-shaped band with a knot on the right side and two short tails that hang down from the knot, crimson with white stripes, the space above the band is empty green. 5 bowtie: a small crimson bow tie with a small center knot. 6 headset-mic: a headset worn on a head: a thin white headband arching over empty space, one round ear cup on the left end (white vinyl with a crimson ring), and a thin boom microphone arm that curves from this ear cup down and toward the center, ending in a small round black mic tip, the middle is empty green. $STYLE $SHEET"

PROMPT[acc-yaw45]="Sprite sheet of 4 accessories in 2 columns and 2 rows. $WORN Each accessory is seen from a three-quarter view, as when it is worn on a head that is turned 45 degrees toward the viewer's right: the front of the accessory faces the lower right, the far side is foreshortened, and the near side on the left of the picture shows its side arm or ear cup. Order, from left to right, top row first: 1 glasses: round thin white vinyl frame glasses, both lenses completely empty (plain green seen through the lenses), one side arm visible on the left. 2 sunglasses: chunky rounded-square white vinyl frames with glossy near-black opaque lenses and one tiny white highlight on each lens, one side arm visible on the left. 3 headphones: over-ear headphones: a curved white headband arching over empty space, two round ear cups (white vinyl with a crimson ring), the near cup on the left seen from the side and the far cup foreshortened, the middle is empty green. 4 cap: a baseball cap: a white vinyl dome crown with a crimson brim that points to the lower right, no logo, no text. $STYLE $SHEET"

# acc-b made the scarf as a ring seen from above, and a first redo came out photo-real. This is the second redo.
PROMPT[acc-fix]="Sprite sheet with ONE accessory in the center: a scarf worn around a neck, drawn as a flat, cute game sticker in the same toy style as the first reference image (soft rounded vinyl-like shapes, soft shading, not photo-real, no fur, no fringe, no fine knit threads, only a gentle rib texture). Shape: seen straight from the front at eye level, NOT from above: a thick crescent-shaped band with a gentle downward curve, like a wide smile, with a round knot on the right side and two short tails hanging down from the knot. There is no hole and no inside of a ring visible. Crimson #E11D48 with two white stripes on the band and one white stripe on each tail. $WORN $STYLE $SHEET"

FXCOMMON="Each item is ONE game effect sprite: cute, clean, toy-like, simple chunky shapes, soft shading, readable when it is shown very small (48 pixels). No outline of green. Each item sits in its own grid cell, centered, and uses about two thirds of the cell."

PROMPT[fx-a]="Sprite sheet of 12 effect sprites in a grid of 4 columns and 3 rows. $FXCOMMON Order, from left to right, top row first: 1 snowflake: a six-armed snowflake, icy white with a faint light-blue tint and soft pale blue shading, crystal pattern A (simple arms with small side branches). 2 snowflake: another six-armed snowflake, crystal pattern B (arms with round tips). 3 snowflake: another six-armed snowflake, crystal pattern C (a star with a hexagon center). 4 raindrop: one glossy blue raindrop in a teardrop shape, with one white highlight. 5 splash: a small water ripple ring with 3 tiny droplets, blue (first stage of a splash). 6 splash: a bigger crown-shaped water splash, blue (middle stage). 7 splash: a wide, thin, fading water splash with scattered small droplets, blue (last stage). 8 sweat-drop: a cartoon sweat drop, light blue teardrop with a white highlight. 9 tickle-sparkle: a cluster of three small four-point sparkles in yellow and pink. 10 frost: a patch of frost: a jagged ice-crystal pattern radiating from a center, white and light cyan. 11 breath-puff: a small round cartoon puff of cold breath: a soft white cloud with three rounded lobes and light blue-grey shading. 12 steam-puff: a wispy warm steam puff: a small S-shaped swirl cloud with a soft warm pink-grey tint. $STYLE $SHEET"

PROMPT[fx-b]="Sprite sheet of 12 effect sprites in a grid of 4 columns and 3 rows. $FXCOMMON Order, from left to right, top row first: 1 heat-wave: three wavy vertical lines that rise, orange to red, with rounded line ends. 2 sun-sparkle: a bright four-pointed sparkle star in warm yellow and white, with a small round center. 3 lightning: a bold yellow zig-zag lightning bolt, vertical, with a white-yellow center. 4 fog-puff: a big soft fluffy fog cloud in pale grey (#D5DBE3), wide, with rounded lobes. 5 umbrella: an open umbrella with a crimson canopy and a white scalloped edge, a thin silver shaft, and a curved white handle, seen from the front and a little from the side. 6 heart: a plump glossy crimson-pink heart with one white highlight. 7 heart: a smaller soft pink heart, slightly tilted, with a white highlight. 8 zzz: three sleeping letters Z in a diagonal stack, small, medium, and large, rising to the upper right, pale lavender-blue vinyl. 9 note: a single music note (eighth note) in purple-blue. 10 note: a pair of music notes joined by a beam, in pink. 11 star: a chunky five-point star with rounded corners, golden yellow, with a small white highlight. 12 idea-bulb: a light bulb with a yellow glass bulb and a white vinyl base cap, and three short yellow ray lines above it. $STYLE $SHEET"

PROMPT[fx-c]="Sprite sheet of 12 effect sprites in a grid of 4 columns and 3 rows. $FXCOMMON Order, from left to right, top row first: 1 question: a chunky question mark symbol, blue-violet with a white highlight. 2 exclaim: a chunky exclamation mark symbol, crimson with a white highlight. 3 anger-mark: an anime anger mark: four curved crimson arc strokes arranged in a cross shape around an empty center. 4 tear: a single glossy light-blue tear drop with a white highlight. 5 dizzy-star: a small orange-yellow star with two short curved motion arcs next to it. 6 sneeze-cloud: a puffy white spray cloud with several small droplets that fly out to the right, as in a sneeze burst, wide shape. 7 blush: a pink blush patch: a rounded oval in soft pink with three short slanted darker pink lines on it. 8 confetti: one small crimson rectangle confetti piece, slightly bent. 9 confetti: one yellow curly confetti streamer. 10 confetti: one sky-blue round confetti dot. 11 confetti: one hot-pink triangle confetti piece. 12 confetti: one orange small ribbon strip confetti piece with a twist. $STYLE $SHEET"

clean_err() { head -c 120 "$HERE/raw/.err.$1" 2>/dev/null | tr '\n' ' ' | sed -E 's#server-[A-Za-z0-9-]+#host#g'; }

gen() { # sheet name
  local name=$1 out="$HERE/raw/$1.png" try t0 t1 refs
  refs=("$REF")
  for f in ${EXTRA[$name]:-}; do refs+=("$f"); done
  if [ -s "$out" ]; then
    if [ -z "${FORCE:-}" ]; then echo "skip $name (raw exists; use FORCE=1)"; return 0; fi
    mv "$out" "$HERE/raw/$name.rejected-$(date +%H%M%S).png"
    echo "$(date -u +%FT%TZ) $name previous-raw-rejected" >> "$LOG"
  fi
  for try in 1 2 3; do
    t0=$(date +%s)
    if "$G" "${PROMPT[$name]}" "$out" 1536x1024 "${refs[@]}" >/dev/null 2>"$HERE/raw/.err.$name" && [ -s "$out" ]; then
      t1=$(date +%s)
      echo "$(date -u +%FT%TZ) $name ok try=$try secs=$((t1 - t0)) bytes=$(wc -c < "$out")" >> "$LOG"
      return 0
    fi
    t1=$(date +%s)
    echo "$(date -u +%FT%TZ) $name fail try=$try secs=$((t1 - t0)) err=$(clean_err "$name")" >> "$LOG"
    [ "$try" -lt 3 ] && sleep 60
  done
  echo "$name FAILED 3 times in a row. Stop and report." >&2
  return 1
}

[ $# -gt 0 ] || { echo "Usage: $0 SHEET [SHEET ...]. Sheets: ${!PROMPT[*]}"; exit 2; }
for s in "$@"; do
  [ -n "${PROMPT[$s]:-}" ] || { echo "Unknown sheet: $s" >&2; exit 2; }
  while [ "$(jobs -rp | wc -l)" -ge 2 ]; do wait -n; done
  gen "$s" &
done
wait
for s in "$@"; do [ -s "$HERE/raw/$s.png" ] && echo "$s $(wc -c < "$HERE/raw/$s.png") bytes"; done
