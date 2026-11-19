#!/bin/sh
# Start-up under Xvfb, then the host bridge with a dummy agent program.
# Needs the app installed as bot.seira.Seira and no other Seira on port 8799.
set -eu
log="$HOME/.var/app/bot.seira.Seira/config/openmausbot/logs/server.log"
bin="$HOME/.local/bin"
run=$(mktemp)
before=$(wc -l <"$log" 2>/dev/null || echo 0)
made=0
[ ! -e "$bin/cline" ] || { echo "FAIL: $bin/cline exists; the test will not replace a real program"; exit 1; }
trap 'if [ "$made" = 1 ]; then rm -f "$bin/cline"; fi; rm -f "$run"; kill "$app" 2>/dev/null || true; flatpak kill bot.seira.Seira 2>/dev/null || true' EXIT

echo "start-up"
dbus-run-session -- xvfb-run -a timeout 120 flatpak run bot.seira.Seira >"$run" 2>&1 &
app=$!
i=0
until tail -n +"$((before + 1))" "$log" 2>/dev/null | grep -q "server ready"; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "FAIL: the server did not start in 60 s"
    tail -30 "$run"
    exit 1
  fi
  sleep 1
done
ss -ltn | grep -q ":8799" || { echo "FAIL: port 8799 closed"; exit 1; }
echo "PASS: server ready, port 8799 open"

api=http://127.0.0.1:8799
echo "host bridge: program installed"
mkdir -p "$bin"
made=1
printf '#!/bin/sh\necho "9.9.9 (cline dummy)"\n' >"$bin/cline"
chmod +x "$bin/cline"
sleep 4
found=$(curl -fsS "$api/api/cli-candidates?name=cline")
echo "$found"
case "$found" in *"$bin/cline"*) echo "PASS: dummy found on the host" ;; *) echo "FAIL: dummy not found"; exit 1 ;; esac
state=$(curl -fsS "$api/api/instances?fresh=1" | jq -r '.instances[] | select(.instanceId=="cline") | .snapshot.state + " " + (.snapshot.reason // "")')
echo "engine state with the dummy: $state"
case "$state" in available*) echo "PASS: dummy launched on the host, engine is available" ;; *) echo "FAIL: engine not available"; exit 1 ;; esac

echo "host bridge: program removed"
rm -f "$bin/cline"
sleep 4
found=$(curl -fsS "$api/api/cli-candidates?name=cline")
echo "$found"
case "$found" in *"$bin/cline"*) echo "FAIL: removed dummy still listed"; exit 1 ;; *) echo "PASS: removed dummy not listed" ;; esac
