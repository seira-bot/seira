#!/usr/bin/env bash
# Base frames for the seira.bot character (CONTRACT.md v2). Model: gpt-image-2.6.
# Set SEIRA_IMAGE_CMD and the generator settings in brand/.env.local (see brand/.env.example).
#
# Usage: brand/mascot/art/bases/prompts.sh STYLE:SHEET [STYLE:SHEET ...]
#   Sheet a: 2 x 2 grid with front, yaw20, yaw45, side.
#   Sheet b: 2 x 2 grid with back, up, down, front.
#   Sheet c: 2 heads side by side: front (for the scale) and a true 90 degree side profile.
#   Output: raw/STYLE-SHEET.png. Each run appends one line to gen.log.
# Order: seira:a, seira:b, then seira-long (a twin of seira), then the other styles.
# Sheet a of each style uses raw/seira-a.png as the reference. Sheets b and c use sheet a of the same style.
# At most 2 generations run at the same time. A failed call waits 60 s, then tries again (3 tries).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../../.." && pwd)
BRAND="$ROOT/brand"; . "$BRAND/load-env.sh"
G=${SEIRA_IMAGE_CMD:?Set SEIRA_IMAGE_CMD in brand/.env.local. See brand/.env.example.}
cd "$HERE"
mkdir -p raw

STYLE_REF="$ROOT/brand/mascot/options/d-companion-bot.png"

HEAD="A cute floating robot head mascot, 3D vinyl toy render: a round matte white head shell (a sphere), a hard hair shell, and a glossy black visor screen across the face. Smooth matte-to-satin vinyl, soft rounded bevels, chunky simple shapes, no hair strands, no hair texture. The head floats: no body, no neck, no ears."
SCREEN="The visor screen is switched off: plain glossy near-black glass with soft studio reflections. No eyes, no face, no mouth, no glow, no light on the screen."
RULE="The hair never covers the visor screen: the fringe stops at the top edge of the screen, and the side hair stays beside the screen."
BG="Flat pure chroma green background (#00FF00) everywhere around the heads. No floor, no shadow, no vignette, no gradient. Soft even studio light. No text, no letters, no numbers, no labels, no lines between the heads."
MAGENTA="The hair shell is flat magenta (#FF00FF) plastic with soft shading, so that it can be recolored later. Only the hair is magenta. The head shell stays white and the screen stays black."
SILVER="The hair shell is silver-white vinyl, a little cooler and glossier than the white head shell, with soft grey shading in the grooves."
NOHAIR="There is no hair shell. The whole head shell is white."

GRID_A="Square image. A 2 by 2 grid of the same head at the same scale and the same height. Each head is centered in its quarter with green space around it. The head turns step by step toward the viewer's right. Top left: front view, the face looks straight at the viewer. Top right: the head is turned 20 degrees toward the viewer's right. Bottom left: three-quarter view, turned 45 degrees toward the viewer's right. Bottom right: side profile, turned 90 degrees, the face looks to the viewer's right."
GRID_C="Square image. Two heads side by side, at the same scale and the same height, each centered in its half with green space around it. Left: front view, the face looks straight at the viewer. Right: an exact side profile, turned a full 90 degrees, the face points to the viewer's right, so we see the left side of the head. In the profile the screen is seen edge-on: it shows only as a thin dark curved strip along the right edge of the head, and the white head shell and the hair fill the rest of the head."
GRID_B="Square image. A 2 by 2 grid of the same head at the same scale and the same height. Each head is centered in its quarter with green space around it. Top left: back view, we see only the back of the head and the hair, no screen. Top right: front view with the head tilted back about 15 degrees, so the face looks up. Bottom left: front view with the head tilted forward about 15 degrees, so the face looks down. Bottom right: front view, the face looks straight at the viewer."

KEEP_NEW="Use the same head shell, the same screen shape, the same scale, and the same render style as the reference image. Only the hair changes."
KEEP_SAME="Keep this exact character from the reference image: the same head shell, the same hair shape and hair color, the same screen, and the same render style."
TWIN="Make the same image as the reference: the same heads, the same poses, the same positions and sizes, and the same hair shapes. Change only the color of the hair."

# Hair shapes. Female: seira-long bob twin-tails ponytail long-straight bun long-wavy.
# Male: short-neat center-part spiky slick-back long-tied long-loose buzz messy. Unisex: none.
declare -A HAIR=(
  [seira]="Hair: the hair of the reference character. A smooth dome, a straight blunt fringe split into 4 panels by soft grooves, and two long flat side panels. The side panels start under the dome edge, hug the sides of the head, and end a little below the chin."
  [seira-long]="Hair: a smooth dome, a straight blunt fringe split into 4 panels by soft grooves, and two long flat side panels that start under the dome edge, hug the sides of the head, and end a little below the chin."
  [bob]="Hair: a chin-length bob. A rounded dome, a straight blunt fringe at the screen top, and sides that curve in under the jaw in one smooth rounded shell and end at chin level. The back is a smooth rounded helmet shape."
  [twin-tails]="Hair: twin tails. A dome with a straight split fringe, and two thick tails tied high on each side of the head with small round ties. The tails hang down to a little below the chin and curve outward a little."
  [ponytail]="Hair: a high ponytail. A smooth dome swept back, a short side-swept fringe at the screen top, a band at the back of the crown, and one thick tapered tail that hangs down behind the head in a soft S-curve to the chin level."
  [long-straight]="Hair: long straight hair with a side fringe. A dome, an angled fringe swept to one side above the screen, and long straight flat panels down both sides and the back that end below the chin with a straight cut."
  [bun]="Hair: a top bun. A smooth dome pulled up, a short straight fringe, one round bun on top of the head with a ring band, and two short wisps at the temples."
  [long-wavy]="Hair: long wavy hair. A dome with a soft center-parted fringe, and thick wavy shells that fall to below the chin on both sides and at the back, with two or three big soft S-waves."
  [short-neat]="Hair: short neat male hair with a falling fringe. A low dome close to the head, a fringe of three soft chunky locks that falls forward just above the screen, and short tapered sides and back."
  [center-part]="Hair: center-parted male hair. A dome with a clear center part line, and two curtain fringe panels that curve down and outward on each side of the forehead above the screen. The sides reach the middle of the head height."
  [spiky]="Hair: spiky male hair. A short dome with 7 to 9 big chunky rounded cone spikes that point up and back, like the hair piece of an anime hero in toy form."
  [slick-back]="Hair: slicked back male hair. A smooth swept-back shell with 3 or 4 soft parallel grooves from front to back, a small pompadour lift at the front hairline, tapered at the nape."
  [long-tied]="Hair: long male hair tied at the nape. A dome, a parted fringe with two locks that frame the screen, and the long hair gathered into one low tail at the back of the head with a band. The tail falls down the back to below the chin level."
  [long-loose]="Hair: long loose male hair. A center-parted dome, long straight panels to a little below the chin on both sides and at the back, slightly layered tips, and framing locks beside the screen."
  [buzz]="Hair: a buzz cut. A thin even shell close to the head, only a few millimeters thick, with a crisp hairline above the screen and around the sides."
  [messy]="Hair: messy male hair. A dome with many chunky soft locks that point in different directions, a scruffy fringe of uneven locks above the screen, and tufts at the crown and the sides."
  [none]="No hair: the bare white head shell with soft engraved panel lines. One seam runs around the head above the screen like a helmet line, one seam runs from the front to the back over the top, and a small flat round cap sits on each side where ears would be."
)

prompt_for() { # style sheet
  local s=$1 sh=$2 grid color keep
  case "$sh" in a) grid=$GRID_A ;; b) grid=$GRID_B ;; c) grid=$GRID_C ;; *) return 2 ;; esac
  case "$s" in
    seira) color=$SILVER ;;
    none) color=$NOHAIR ;;
    *) color=$MAGENTA ;;
  esac
  if [ "$s" = seira ] && [ "$sh" = a ]; then keep=$KEEP_SAME
  elif [ "$s" = seira-long ]; then keep=$TWIN
  elif [ "$sh" = a ]; then keep=$KEEP_NEW
  else keep=$KEEP_SAME; fi
  printf '%s' "$grid $HEAD ${HAIR[$s]} $color $RULE $SCREEN $BG $keep"
}

ref_for() { # style sheet
  local s=$1 sh=$2
  if [ "$s" = seira ] && [ "$sh" = a ]; then echo "$STYLE_REF"
  elif [ "$s" = seira ]; then echo "raw/seira-a.png"
  elif [ "$s" = seira-long ]; then echo "raw/seira-$sh.png"
  elif [ "$sh" = a ]; then echo "raw/seira-a.png"
  else echo "raw/$s-a.png"; fi
}

gen() { # style:sheet
  local s=${1%%:*} sh=${1##*:} out ref t0 t1 try
  [ -n "${HAIR[$s]:-}" ] || { echo "unknown style: $s" >&2; return 2; }
  out="raw/$s-$sh.png"; ref=$(ref_for "$s" "$sh")
  [ -f "$ref" ] || { echo "missing reference $ref for $1" >&2; return 2; }
  [ -f "$out" ] && mv "$out" "raw/$s-$sh.$(date +%H%M%S).old.png"   # keep the previous take
  t0=$(date +%s)
  for try in 0 1 2; do
    if "$G" "$(prompt_for "$s" "$sh")" "$out" 1536x1024 "$ref" >/dev/null 2>&1 && [ -s "$out" ]; then
      t1=$(date +%s)
      printf '%s %s %s %s bytes %ss retries=%s ok\n' "$(date -u +%FT%TZ)" "$out" \
        "$(python3 -c "from PIL import Image; print('%dx%d' % Image.open('$out').size)")" \
        "$(wc -c < "$out" | tr -d ' ')" "$((t1 - t0))" "$try" >> gen.log
      echo "$out"
      return 0
    fi
    [ "$try" -lt 2 ] && sleep 60
  done
  printf '%s %s failed after 3 tries\n' "$(date -u +%FT%TZ)" "$out" >> gen.log
  echo "FAILED $out" >&2
  return 1
}

[ $# -gt 0 ] || { sed -n '5,10p' "$0"; exit 2; }
rc=0
for job in "$@"; do
  while [ "$(jobs -rp | wc -l)" -ge 2 ]; do wait -n || rc=1; done
  gen "$job" &
  sleep 5
done
while [ "$(jobs -rp | wc -l)" -gt 0 ]; do wait -n || rc=1; done
exit $rc
