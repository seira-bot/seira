#!/bin/sh
# Start-up under Xvfb, then the host bridge with a dummy agent program.
# Needs the app installed as bot.seira.Seira and no other Seira on port 8799.
set -eu
log="$HOME/.var/app/bot.seira.Seira/config/openmausbot/logs/server.log"
bin="$HOME/.local/bin"
run=$(mktemp)
before=$(wc -l <"$log" 2>/dev/null || echo 0)
trap 'rm -f "$bin/codex" "$run"; kill "$app" 2>/dev/null || true' EXIT

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
printf '#!/bin/sh\necho "9.9.9 (codex-cli dummy)"\n' >"$bin/codex"
chmod +x "$bin/codex"
found=$(curl -fsS "$api/api/cli-candidates?name=codex")
echo "$found"
case "$found" in *"$bin/codex"*) echo "PASS: dummy found on the host" ;; *) echo "FAIL: dummy not found"; exit 1 ;; esac
probe=$(curl -fsS -X POST -H 'content-type: application/json' -d "{\"cli\":\"$bin/codex\"}" "$api/api/cli-test")
echo "$probe"
case "$probe" in *"9.9.9 (codex-cli dummy)"*) echo "PASS: dummy output returned" ;; *) echo "FAIL: no dummy output"; exit 1 ;; esac

echo "host bridge: program removed"
rm -f "$bin/codex"
sleep 4
found=$(curl -fsS "$api/api/cli-candidates?name=codex")
echo "$found"
case "$found" in *"$bin/codex"*) echo "FAIL: removed dummy still listed"; exit 1 ;; *) echo "PASS: removed dummy not listed" ;; esac
