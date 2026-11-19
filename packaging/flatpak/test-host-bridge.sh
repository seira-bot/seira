#!/bin/sh
# Start-up under Xvfb, then the host bridge with a dummy program. Needs the app installed as bot.seira.Seira.
set -eu
data=$(mktemp -d)
trap 'rm -rf "$data"' EXIT

echo "start-up"
dbus-run-session -- xvfb-run -a timeout 70 flatpak run \
  --env=OMB_DATA_DIR="$data" --env=OMB_PORT=18799 bot.seira.Seira >"$data/run.log" 2>&1 &
i=0
until (exec 3<>/dev/tcp/127.0.0.1/18799) 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "FAIL: port 18799 did not open"
    tail -40 "$data/run.log"
    exit 1
  fi
  sleep 1
done
echo "PASS: port 18799 open"

echo "host bridge"
bin="$HOME/.local/bin"
mkdir -p "$bin"
printf '#!/bin/sh\necho seira-dummy-ok "$@"\n' >"$bin/codex"
chmod +x "$bin/codex"
trap 'rm -f "$bin/codex"; rm -rf "$data"' EXIT
out=$(flatpak run --command=flatpak-spawn bot.seira.Seira --host "$bin/codex" ping)
[ "$out" = "seira-dummy-ok ping" ] && echo "PASS: host program ran" || { echo "FAIL: $out"; exit 1; }
