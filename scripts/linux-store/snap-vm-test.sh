#!/usr/bin/env bash
# Installs a built Seira snap in a throwaway Ubuntu 24.04 VM and records whether the Electron app and the bot browser
# start with the Chromium sandbox on. It never passes a sandbox-off switch. Run it in the foreground.
#
#   scripts/linux-store/snap-vm-test.sh path/to/seira.snap
#
# Needs qemu-system-x86_64, qemu-img, xorriso, ssh, ssh-keygen and /dev/kvm.
# The app listens on its own fixed port inside the VM, which holds no other Seira.
# Environment: VM_WORK (default ~/.cache/seira-vm), VM_SSH_PORT (default 2222), VM_MEMORY_MB (default 4096),
# UBUNTU_IMAGE_URL (default: the current Ubuntu 24.04 cloud image), KEEP_VM_DISK=1 keeps the disk files.
set -euo pipefail

SNAP_FILE="${1:?usage: snap-vm-test.sh path/to/seira.snap}"
WORK="${VM_WORK:-$HOME/.cache/seira-vm}"
PORT="${VM_SSH_PORT:-2222}"
MEMORY="${VM_MEMORY_MB:-4096}"
BASE_URL="${UBUNTU_IMAGE_URL:-https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img}"
SUMS_URL="${BASE_URL%/*}/SHA256SUMS"
BASE_IMAGE="$WORK/$(basename "$BASE_URL")"
DISK="$WORK/run.qcow2"
SEED="$WORK/seed.iso"
KEY="$WORK/id_ed25519"
PIDFILE="$WORK/qemu.pid"
SSH_OPTS=(-i "$KEY" -p "$PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5)

mkdir -p "$WORK"
[ -e /dev/kvm ] || { echo "no /dev/kvm" >&2; exit 2; }

stop_vm() {
  if [ -f "$PIDFILE" ]; then
    ssh "${SSH_OPTS[@]}" tester@127.0.0.1 'sudo poweroff' >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do kill -0 "$(cat "$PIDFILE")" 2>/dev/null || break; sleep 1; done
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
  [ "${KEEP_VM_DISK:-0}" = 1 ] || rm -f "$DISK" "$SEED"
}
trap stop_vm EXIT

if [ ! -f "$BASE_IMAGE" ]; then
  curl -fsSL -o "$BASE_IMAGE.part" "$BASE_URL"
  expected="$(curl -fsSL "$SUMS_URL" | awk -v f="*$(basename "$BASE_URL")" '$2 == f { print $1 }')"
  actual="$(sha256sum "$BASE_IMAGE.part" | awk '{ print $1 }')"
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "image checksum mismatch" >&2; rm -f "$BASE_IMAGE.part"; exit 2; }
  mv "$BASE_IMAGE.part" "$BASE_IMAGE"
fi

[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N "" -f "$KEY"
cp -f "$BASE_IMAGE" "$DISK"
qemu-img resize -q "$DISK" 12G

seed_dir="$(mktemp -d)"
printf 'instance-id: seira-snap-test\nlocal-hostname: seira-test\n' > "$seed_dir/meta-data"
cat > "$seed_dir/user-data" <<EOF
#cloud-config
users:
  - name: tester
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - $(cat "$KEY.pub")
ssh_pwauth: false
EOF
xorriso -as mkisofs -quiet -output "$SEED" -volid cidata -joliet -rock "$seed_dir/user-data" "$seed_dir/meta-data"
rm -rf "$seed_dir"

qemu-system-x86_64 -enable-kvm -cpu host -smp 4 -m "$MEMORY" -display none -daemonize -pidfile "$PIDFILE" \
  -drive "file=$DISK,if=virtio,format=qcow2" -drive "file=$SEED,if=virtio,format=raw,readonly=on" \
  -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:$PORT-:22" -device virtio-net-pci,netdev=net0

for _ in $(seq 1 90); do
  ssh "${SSH_OPTS[@]}" tester@127.0.0.1 true 2>/dev/null && break
  sleep 2
done
ssh "${SSH_OPTS[@]}" tester@127.0.0.1 'cloud-init status --wait >/dev/null 2>&1; echo guest ready; . /etc/os-release; echo "$PRETTY_NAME $(uname -r)"'
scp -i "$KEY" -P "$PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$SNAP_FILE" tester@127.0.0.1:/tmp/seira.snap

ssh "${SSH_OPTS[@]}" tester@127.0.0.1 'bash -s' <<'GUEST'
set -uo pipefail
say() { echo "RESULT $*"; }

say "userns-sysctl apparmor_restrict_unprivileged_userns=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo absent)"
sudo apt-get update -qq >/dev/null 2>&1
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xvfb xauth libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libxss1 \
  libxtst6 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxkbcommon0 libxdamage1 libxrandr2 >/dev/null 2>&1
say "xvfb-installed=$(command -v Xvfb >/dev/null && echo yes || echo no)"

if sudo snap install --dangerous --classic /tmp/seira.snap 2>&1; then say "snap-install=ok"; else say "snap-install=FAIL"; exit 1; fi
snap list seira
say "snap-yaml: $(unsquashfs -cat /tmp/seira.snap meta/snap.yaml | grep -E '^(name|confinement):' | tr '\n' ' ')"
say "launcher-has-no-sandbox-switch=$(unsquashfs -cat /tmp/seira.snap command.sh | grep -c -e '--no-sandbox')"
say "setuid-files=$(unsquashfs -ll /tmp/seira.snap | grep -cE '^[-d]([rwx-]{2}s|[rwx-]{5}s)')"

DATA=$(mktemp -d)
Xvfb :99 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &
export DISPLAY=:99
sleep 2
SEIRA_DATA_DIR="$DATA" /snap/bin/seira >/tmp/electron.log 2>&1 &
APP=$!
up=no
for _ in $(seq 1 150); do
  if curl -fsS "http://127.0.0.1:8799/api/health" >/dev/null 2>&1; then up=yes; break; fi
  kill -0 "$APP" 2>/dev/null || break
  sleep 1
done
say "electron-server-answers=$up"; say "listening: $(ss -ltn | awk "NR>1{print \$4}" | tr "\n" " ")"; say "electron-procs: $(pgrep -fc seira)"
say "electron-process-alive=$(kill -0 "$APP" 2>/dev/null && echo yes || echo no)"
say "electron-cmdline-has-no-sandbox=$(ps -eo args | grep -E '[/]seira|[/]seira' | grep -c -e '--no-sandbox')"
say "electron-log-no-usable-sandbox=$(grep -ci 'no usable sandbox' /tmp/electron.log)"
say "electron-log-sandbox-lines:"; grep -i 'sandbox\|namespace\|FATAL' /tmp/electron.log | head -10 | sed 's/^/RESULT   /'
say "electron-log-head:"; tail -25 /tmp/electron.log | sed 's/^/RESULT   /'
curl -fsS "http://127.0.0.1:8799/api/health" 2>&1 | head -c 300 | sed 's/^/RESULT health: /'; echo

CHROME=$(find /snap/seira/current/resources/browser-engine/chrome -name chrome-headless-shell -type f | head -1)
say "bot-browser-binary=$CHROME"
say "bot-browser-userns-under-snap: $(snap run --shell seira -c 'unshare -U true 2>&1 && echo allowed' 2>&1 | tr '\n' ' ')"
snap run --shell seira -c "$CHROME --headless --remote-debugging-port=9333 --user-data-dir=$DATA/chrome about:blank" >/tmp/bot-browser.log 2>&1 &
BOT=$!
ok=no
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:9333/json/version >/tmp/bot-version.json 2>/dev/null; then ok=yes; break; fi
  sleep 1
done
say "bot-browser-answers=$ok"
[ "$ok" = yes ] && say "bot-browser-version: $(grep -o '"Browser": *"[^"]*"' /tmp/bot-version.json)"
say "bot-browser-cmdline-has-no-sandbox=$(ps -eo args | grep -E '[c]hrome-headless-shell' | grep -c -e '--no-sandbox')"
say "bot-browser-log-no-usable-sandbox=$(grep -ci 'no usable sandbox' /tmp/bot-browser.log)"
say "bot-browser-log:"; head -15 /tmp/bot-browser.log | sed 's/^/RESULT   /'

kill "$BOT" "$APP" 2>/dev/null; pkill -f chrome-headless-shell 2>/dev/null; pkill Xvfb 2>/dev/null
exit 0
GUEST
