#!/usr/bin/env bash
# Concept sheets for the cast. gpt-image-2.6 through 9router only.
# Set SEIRA_IMAGE_CMD and the generator settings in brand/.env.local (see brand/.env.example).
# Usage: prompts.sh [sheet-name ...]   (no argument = all sheets)
# Sheets: lineup-female lineup-male lineup-male-2 expressions-1 expressions-2
# Raw output goes to raw/, the finished sheet to concept/. Each try is logged in gen.log.
# After 3 failures in a row the script stops.
set -u
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
BRAND="$ROOT/brand"; . "$BRAND/load-env.sh"
G=${SEIRA_IMAGE_CMD:?Set SEIRA_IMAGE_CMD in brand/.env.local. See brand/.env.example.}
cd "$(dirname "$0")"
mkdir -p raw concept
REF="$ROOT/brand/mascot/options/d-bot-pendamping.png"

# --- shared style text ------------------------------------------------------
BODY="Every bot is a floating robot head in the exact style of the reference image: a round matte white head shell, a glossy near-black visor screen on the front, and a hair shell made of smooth matte plastic that sits on the head like the white hair shell in the reference. The eyes and the mouth are simple glowing shapes on the dark screen, as in the reference. No neck, no body, no hands. Same scale, same camera height, same soft studio light, front view, all heads straight to the camera."
TAIL="Plain flat light grey background, no floor line, only a very soft round shadow under each head. No text, no letters, no numbers, no labels, no watermark. Wide 16:9 image."

# --- lineups ----------------------------------------------------------------
P_FEMALE="Character lineup sheet of nine female robot companion heads in a 3 by 3 grid, with equal gaps between them. $BODY
Row 1, left to right:
(1) the exact character of the reference image: silver-white hair shell with a straight fringe in four panels and two long flat side panels, crimson pill eyes with one highlight and a small eyelash flick, tiny smile.
(2) long straight dark brown-black hair shell with side panels that fall past the shoulders and a hair pin on one side, round warm amber eyes with lashes, thin brows, small smile, soft pink cheek blush.
(3) chin-length rounded bob hair shell in deep turquoise, star-shaped bright aqua eyes with lashes, a cat-shaped mouth like a small w, pink cheek blush, a small headset with a thin microphone boom on one side, a small hoop earring.
Row 2, left to right:
(4) high ponytail hair shell in deep red, narrow sharp crimson eyes with lashes, angled brows, a short flat mouth, thin round glasses over the screen, a small hoop earring.
(5) long wavy hair shell in near-black with soft waves, almond-shaped glowing red eyes with lashes, angled brows, a small smile with one tiny fang, a small hoop earring and a hair pin.
(6) very long hair shell in lavender purple with a straight fringe and long side panels, round soft coral-pink eyes with lashes, thin brows, a small smile, pink cheek blush, a hair pin and a small ribbon.
Row 3, left to right:
(7) long straight hair shell in light caramel brown, narrow sharp bright pink eyes with lashes, angled brows, a smirk that lifts on one side, a small hoop earring.
(8) twin-tail hair shell in reddish copper brown, two long tails hanging on both sides, big round bright blue eyes with lashes, thin brows, a wide open grin, pink cheek blush, a small ribbon on one tail.
(9) glossy black hair shell swept up into a neat round bun on top of the head, almond-shaped crimson eyes with lashes, angled brows, a short flat mouth, a small silver tiara on the front of the hair.
Each head must look clearly different from the others in hair shape, hair color, eye shape and eye color. $TAIL"

P_MALE1="Character lineup sheet of eight male robot companion heads in 4 columns by 2 rows, with equal gaps between them. $BODY
Row 1, left to right:
(1) jet black hair shell with a center part and two side-swept curtains, almond-shaped scarlet eyes, thin brows, a short flat mouth, a small silver cross-shaped earring on one side. Calm and quiet.
(2) shoulder-length loose blond hair shell, almond-shaped bright blue eyes, angled brows, a confident smirk, thin glasses over the screen and a small bow tie under the head. Charming and mischievous.
(3) silver hair shell swept straight back with two thin dark streaks at the temples, narrow sharp crimson eyes, angled brows, a proud smirk, a small bow tie under the head.
(4) tousled messy silver-grey hair shell with one long lock over one side, narrow sharp pale grey eyes, angled brows, a short flat mouth, a small headset with a thin microphone boom on one side. Cool and guarded.
Row 2, left to right:
(5) neat short black hair shell cut like a bowl with a straight fringe, round bright turquoise eyes, thin brows, a wide relaxed grin, over-ear headphones and thin glasses. Carefree.
(6) very long deep violet hair shell tied into a ponytail that hangs behind and beside the head, round bright blue eyes, thick brows, a gentle smile, a small scarf under the head. Kind.
(7) bright red spiky hair shell with several sharp spikes, round bright blue eyes, thick brows, a wide energetic grin, over-ear headphones. Energetic.
(8) very short brown buzz-cut hair shell close to the head, round warm amber eyes, thin brows, a tiny round o-shaped mouth, a pink cheek blush, round glasses and a small antenna on top of the head. Nervous and nerdy.
Each head must look clearly different from the others in hair shape, hair color, eye shape and eye color. $TAIL"

P_MALE2="Character lineup sheet of nine male robot companion heads in a 3 by 3 grid, with equal gaps between them. $BODY
Row 1, left to right:
(1) neat short golden blond hair shell with a side-swept fringe, narrow sharp crimson eyes, angled brows, a playful smirk, a small bow tie under the head. Haughty and cheeky.
(2) pure white hair shell swept straight back and smooth, narrow sharp crimson eyes, thick brows, a stern flat mouth. No accessory. Elderly, strict, short-tempered.
(3) long loose grey hair shell falling to the shoulders, narrow sharp pale grey eyes, thick brows, a wide confident grin. No accessory. Strong and calm.
Row 2, left to right:
(4) long bright blond hair shell tied loosely at the back with loose strands in front, star-shaped crimson eyes, thin brows, a wide boastful grin, dark sunglasses pushed up on the head screen edge and a small hoop earring. Eccentric and showy.
(5) messy medium brown hair shell with a ragged fringe, narrow sharp crimson eyes, angled brows, a short flat mouth, a small hoop earring. Serious and cold.
(6) long loose dark red hair shell past the shoulders, narrow sharp crimson eyes, angled brows, an angry mouth with one small fang, a small hoop earring. Loud and jealous.
Row 3, left to right:
(7) light grey spiky mohawk-like hair shell, square-shaped amber-brown eyes, thick brows, a wide mouth with fangs. No accessory. Big, rough and proud.
(8) neat slicked-back grey hair shell, almond-shaped golden amber eyes, thin brows, a quiet smirk, thin rectangular glasses over the screen. Calm and mysterious scientist.
(9) neat blond hair shell with a center part, almond-shaped golden-yellow eyes, thin brows, a polite smile, thin glasses and a small bow tie under the head. Polite and precise.
Each head must look clearly different from the others in hair shape, hair color, eye shape and eye color. $TAIL"

# --- expressions of Seira ---------------------------------------------------
SEIRA_KEEP="Every cell shows the exact same robot head from the reference image: same white matte head shell, same silver-white hair shell with a straight fringe in four panels and two long flat side panels, same glossy near-black screen visor with glowing crimson shapes. Only the face on the screen changes, and small effect symbols may float beside the head. Same scale, front view, same soft studio light."
P_EXPR1="Expression sheet of the robot head in the reference image: twelve copies in a 4 by 3 grid at the same scale. Face on the screen in each cell: (1) happy, eyes as upward arcs and a gentle smile; (2) laugh, eyes as upward arcs, a wide open mouth and two small tear drops; (3) giggle, squeezed arc eyes, a small open mouth and a pink cheek blush; (4) love, eyes as two small hearts; (5) shy, eyes looking down and aside, a tiny wavy mouth and a strong pink cheek blush; (6) proud, half-closed eyes looking up with a lifted smirk; (7) surprised, big round eyes and a small round o mouth with a small exclamation mark above; (8) confused, one eye bigger than the other, a wavy mouth and a small question mark above; (9) thinking, eyes looking up to one side, a flat mouth and a small thought dot trail; (10) sad, eyes tilted down with a tiny frown; (11) cry, eyes with streaming tears and a wobbly mouth; (12) pout, eyes narrowed and a small puffed flat mouth with a small anger mark. $SEIRA_KEEP No text, no letters, no labels. Plain flat light grey background. Wide 16:9 image."
P_EXPR2="Expression sheet of the robot head in the reference image: twelve copies in a 4 by 3 grid at the same scale. Face on the screen in each cell: (1) angry, sharp slanted eyes and a hard frown with a small anger mark; (2) sleepy, half-closed heavy eyes and a tiny yawn mouth; (3) asleep, eyes closed as soft curved lines and a small z symbol above; (4) wink, one eye open and one closed as a curve, with a small smile; (5) bored, flat half-lidded eyes and a flat line mouth; (6) determined, firm eyes with a small spark and a straight confident mouth; (7) dizzy, eyes as spirals and a wobbly mouth with small stars around the head (this is the only face with spiral eyes); (8) smug, narrowed eyes and a one-sided smirk; (9) scared, small shaking dot eyes, a wavy mouth and a small blue sweat drop; (10) cold, tight shut eyes, chattering wavy mouth and small snowflakes beside the head; (11) hot, droopy eyes, a panting open mouth and a sweat drop; (12) sick, heavy half-closed droopy eyes with no spirals, a small queasy wavy mouth, a pale green glow on the lower half of the screen, a small thermometer symbol and a small green drop beside the head. $SEIRA_KEEP No text, no letters, no labels. Plain flat light grey background. Wide 16:9 image."

# --- runner -----------------------------------------------------------------
FAILS=0
publish() { # name: copy the raw sheet to concept/. The female lineup gets the real Seira art in cell 1.
  if [ "$1" = lineup-female ]; then
    python3 tools/place_seira.py "raw/$1.png" "concept/$1.png"
  else
    cp "raw/$1.png" "concept/$1.png"
  fi
}
gen() { # name, prompt
  local name=$1 prompt=$2 try t0 t1 size
  for try in 1 2 3; do
    t0=$(date +%s)
    if "$G" "$prompt" "raw/$name.png" 1536x1024 "$REF" && [ -s "raw/$name.png" ]; then
      t1=$(date +%s); size=$(wc -c < "raw/$name.png")
      echo "$(date -u +%FT%TZ) $name ok bytes=$size seconds=$((t1 - t0)) tries=$try" >> gen.log
      FAILS=0
      publish "$name"
      return 0
    fi
    t1=$(date +%s)
    echo "$(date -u +%FT%TZ) $name fail seconds=$((t1 - t0)) try=$try" >> gen.log
    FAILS=$((FAILS + 1))
    if [ "$FAILS" -ge 3 ]; then
      echo "STOP: 3 failures in a row. Check the generator, then run again." >&2
      echo "$(date -u +%FT%TZ) $name STOPPED after 3 failures in a row" >> gen.log
      exit 1
    fi
    echo "retry $name after 60 s" >&2
    sleep 60
  done
}

run() { # name, prompt variable name
  local name=$1 var=$2
  if [ "${#SELECTED[@]}" -eq 0 ] || printf '%s\n' "${SELECTED[@]}" | grep -qx "$name"; then
    gen "$name" "${!var}"
  fi
}
SELECTED=("$@")

# At most 2 generations run at the same time.
run lineup-female P_FEMALE &
sleep 20
run lineup-male P_MALE1 &
wait
run lineup-male-2 P_MALE2 &
sleep 20
run expressions-1 P_EXPR1 &
wait
run expressions-2 P_EXPR2
wc -c raw/*.png
