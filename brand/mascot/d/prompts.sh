#!/usr/bin/env bash
# Reference sheets for mascot D (companion bot). gpt-image-2.6 through 9router only.
# Set SEIRA_IMAGE_CMD and the generator settings in brand/.env.local (see brand/.env.example).
set -u
BRAND=$(cd "$(dirname "$0")/../.." && pwd)
. "$BRAND/load-env.sh"
G=${SEIRA_IMAGE_CMD:?Set SEIRA_IMAGE_CMD in brand/.env.local. See brand/.env.example.}
cd "$(dirname "$0")"
REF="$BRAND/mascot/options/d-companion-bot.png"
KEEP="Keep this exact character from the reference image: same white matte head shell, same silver-white hair shell with a straight fringe split into 4 panels and two long flat side panels, same glossy near-black screen visor, same glowing crimson pill eyes with one white highlight and a small eyelash flick, same small smile. Same soft studio light and matte materials. Plain flat light grey background. No text, no letters, no watermark."
gen() { # name, prompt
  for try in 1 2; do
    if "$G" "$2 $KEEP" "$1.png" 1536x1024 "$REF"; then return 0; fi
    echo "retry $1 after 60 s"; sleep 60
  done
  echo "FAILED $1"
}
gen turnaround "Character turnaround sheet of the robot mascot in the reference image. Four views in one row at the same scale and the same height: front view, three-quarter view facing left, side view facing left, back view. Wide 16:9 image." &
sleep 20
gen expressions "Expression sheet of the robot mascot in the reference image, front view, six copies in a 3 by 2 grid at the same scale. Only the screen face changes: 1 calm smile, 2 blink with eyes closed as soft curved lines, 3 happy with eyes as upward arcs, 4 surprised with round eyes and a small round mouth, 5 wink, 6 thinking with eyes looking up to the side. Wide 16:9 image." &
wait
wc -c *.png
