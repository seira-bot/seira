#!/usr/bin/env bash
# Take a screenshot of a bundled WebGL page with headless Chromium (SwiftShader).
# Use it when your browser has no WebGL, or to check a pose or frame by script.
#
# Usage: tools/shot.sh PAGE.html OUT.png [WIDTHxHEIGHT] [WAIT_MS] [QUERY]
#   WAIT_MS  virtual time in ms before the screenshot (default 2500).
#   QUERY    appended to the page URL, for example "?expr=laugh".
#
# Environment:
#   SHOT_HOST      optional SSH host that renders the page. Unset = this machine.
#   SHOT_CHROMIUM  Chromium binary (default: chromium).
#   SHOT_MEM       memory cap for systemd-run on the render host (default: 2G).
# The script reads these values from brand/.env.local too (see brand/.env.example).
set -euo pipefail
BRAND=$(cd "$(dirname "$0")/../../.." && pwd)
. "$BRAND/load-env.sh"   # SHOT_* values from brand/.env.local
page=$1; out=$2; size=${3:-900x900}; wait=${4:-2500}; query=${5:-}
chromium=${SHOT_CHROMIUM:-chromium}
mem=${SHOT_MEM:-2G}
name="$(basename "$page" .html)-$$"
dir='.cache/seira-shot'

render='cd ~/'"$dir"' && run=""; command -v systemd-run >/dev/null && run="systemd-run --user --scope -q -p MemoryMax='"$mem"' -p MemorySwapMax=0";
  $run timeout 90 '"$chromium"' --headless=new --no-sandbox --hide-scrollbars \
  --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist \
  --window-size='"${size/x/,}"' --virtual-time-budget='"$wait"' \
  --screenshot="$HOME/'"$dir/$name"'.png" "file://$HOME/'"$dir/$name"'.html'"$query"'" >/dev/null 2>&1;
  rm -f '"$name"'.html'

if [ -n "${SHOT_HOST:-}" ]; then
  ssh -o ConnectTimeout=15 "$SHOT_HOST" "mkdir -p ~/$dir"
  scp -q "$page" "$SHOT_HOST:$dir/$name.html"
  ssh "$SHOT_HOST" "bash -lc '$render'"
  scp -q "$SHOT_HOST:$dir/$name.png" "$out"
  ssh "$SHOT_HOST" "rm -f ~/$dir/$name.png"
else
  mkdir -p ~/"$dir"
  cp "$page" ~/"$dir/$name.html"
  bash -c "$render"
  mv ~/"$dir/$name.png" "$out"
fi
echo "$out"
