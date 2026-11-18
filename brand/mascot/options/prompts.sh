#!/usr/bin/env bash
# Mascot options for seira.bot. Images come from gpt-image-2.6 through 9router only.
# Set SEIRA_IMAGE_CMD and the generator settings in brand/.env.local (see brand/.env.example).
set -u
BRAND=$(cd "$(dirname "$0")/../.." && pwd)
. "$BRAND/load-env.sh"
G=${SEIRA_IMAGE_CMD:?Set SEIRA_IMAGE_CMD in brand/.env.local. See brand/.env.example.}
cd "$(dirname "$0")"
BASE="Original mascot character design for a friendly AI assistant bot. The character is a female android: calm, elegant, kind, with a small gentle smile. Long straight silver-white hair down to the waist with a blunt straight fringe. Large crimson red eyes with one white highlight and a small upward eyelash flick at the outer corner. Strict colour palette: near-black #0E1116, silver #E9ECEF, white, and crimson #E11D48 as the only accent. Plain flat pale grey background, character centred with margin, no text, no letters, no watermark, no logo, no extra characters. Square 1:1 image."
gen() { # name, style
  for try in 1 2; do
    if "$G" "$BASE $2" "$1.png" 1024x1024; then return 0; fi
    echo "retry $1 after 60 s"; sleep 60
  done
  echo "FAILED $1"
}
gen a-geometric "Style: flat vector illustration, bold simple geometric shapes, no outlines, no gradients, like a modern tech brand mascot. Head and shoulders only. The hair is one smooth dome shape that falls straight down both sides. The face is a dark near-black screen (visor) and the two eyes are glowing crimson vertical pills on that screen. Silver hair."
gen b-vinyl-3d "Style: cute 3D render of a collectible vinyl designer toy, chibi proportions (big head, small body), soft studio light, smooth matte plastic. Full body, standing. Her face is a glossy near-black screen visor with two glowing crimson pill-shaped eyes. She wears a tidy near-black uniform dress with a white collar and one crimson ribbon. Visible robot joints at the neck and wrists."
gen c-anime-android "Style: clean 2D anime cel-shading, crisp line art, flat colours, key visual quality. Bust portrait, three-quarter view. A human-like android girl with soft pale face, thin panel seams on the cheeks and neck, a small crimson status light on a headset antenna. Noble, composed posture. Near-black high-collar uniform with silver trim and a crimson brooch."
gen d-companion-bot "Style: soft 3D render, friendly product-design look, matte materials, soft studio light. A small floating companion robot, not a human body: one rounded capsule body, the top shaped like a silver hair dome with a straight fringe and two long silver side panels like hair. The front is a glossy near-black screen face with two glowing crimson pill eyes and tiny eyelash flicks. No arms or very small floating hands. A soft shadow below it."
wc -c *.png
