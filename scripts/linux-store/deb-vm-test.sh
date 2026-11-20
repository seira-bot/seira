#!/usr/bin/env bash
# Tests the Linux release files in a throwaway Ubuntu 24.04 VM that keeps the stock user-namespace restriction on.
# It records, as RESULT lines:
#   - the new AppImage: it stops with the install message and starts no Electron process;
#   - the DEB: Seira starts and answers /api/health with the Chromium sandbox on;
#   - an optional older AppImage, to show how the unpatched AppRun behaves on the same host.
# It never passes a sandbox-off switch and never changes the user-namespace setting. Run it in the foreground.
#
#   scripts/linux-store/deb-vm-test.sh path/to/Seira-<version>-amd64.deb path/to/Seira-<version>-x86_64.AppImage \
#     [path/to/older.AppImage]
#
# Needs qemu-system-x86_64, qemu-img, xorriso, ssh, ssh-keygen and /dev/kvm.
# Seira listens on its default port inside the VM, which holds no other Seira.
# Environment: VM_WORK (default ~/.cache/seira-vm-deb), VM_SSH_PORT (default 2232), VM_MEMORY_MB (default 4096),
# UBUNTU_IMAGE_URL (default: the current Ubuntu 24.04 cloud image), KEEP_VM_DISK=1 keeps the disk files.
# The screenshot of the AppImage message is written to $VM_WORK/appimage-message.png.
set -euo pipefail

DEB_FILE="${1:?usage: deb-vm-test.sh path/to/Seira-amd64.deb path/to/Seira.AppImage [path/to/older.AppImage]}"
APPIMAGE_FILE="${2:?usage: deb-vm-test.sh path/to/Seira-amd64.deb path/to/Seira.AppImage [path/to/older.AppImage]}"
OLD_APPIMAGE_FILE="${3:-}"
WORK="${VM_WORK:-$HOME/.cache/seira-vm-deb}"
PORT="${VM_SSH_PORT:-2232}"
MEMORY="${VM_MEMORY_MB:-4096}"
BASE_URL="${UBUNTU_IMAGE_URL:-https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img}"
SUMS_URL="${BASE_URL%/*}/SHA256SUMS"
BASE_IMAGE="$WORK/$(basename "$BASE_URL")"
DISK="$WORK/run.qcow2"
SEED="$WORK/seed.iso"
KEY="$WORK/id_ed25519"
PIDFILE="$WORK/qemu.pid"
SSH_OPTS=(-i "$KEY" -p "$PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5)
SCP_OPTS=(-i "$KEY" -P "$PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)

for file in "$DEB_FILE" "$APPIMAGE_FILE" ${OLD_APPIMAGE_FILE:+"$OLD_APPIMAGE_FILE"}; do
  [ -f "$file" ] || { echo "missing file: $file" >&2; exit 2; }
done
mkdir -p "$WORK"
[ -e /dev/kvm ] || { echo "no /dev/kvm" >&2; exit 2; }

stop_vm() {
  if [ -f "$PIDFILE" ]; then
    # Read the PID first: qemu deletes its PID file when the guest powers off.
    local pid
    pid="$(cat "$PIDFILE")"
    ssh "${SSH_OPTS[@]}" tester@127.0.0.1 'sudo poweroff' >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill "$pid" 2>/dev/null || true
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
qemu-img resize -q "$DISK" 16G

seed_dir="$(mktemp -d)"
printf 'instance-id: seira-deb-test\nlocal-hostname: seira-test\n' > "$seed_dir/meta-data"
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
scp "${SCP_OPTS[@]}" "$DEB_FILE" tester@127.0.0.1:/tmp/Seira-amd64.deb
scp "${SCP_OPTS[@]}" "$APPIMAGE_FILE" tester@127.0.0.1:/tmp/Seira.AppImage
[ -z "$OLD_APPIMAGE_FILE" ] || scp "${SCP_OPTS[@]}" "$OLD_APPIMAGE_FILE" tester@127.0.0.1:/tmp/Seira-old.AppImage

ssh "${SSH_OPTS[@]}" tester@127.0.0.1 'bash -s' <<'GUEST'
set -uo pipefail
say() { echo "RESULT $*"; }
HEALTH=http://127.0.0.1:8799/api/health

# Waits up to $2 seconds for /api/health while process $1 lives. Prints the seconds it took, or "no".
wait_health() {
  local pid=$1 limit=$2 started=$SECONDS
  while [ $((SECONDS - started)) -lt "$limit" ]; do
    if curl -fsS "$HEALTH" >/dev/null 2>&1; then echo "$((SECONDS - started))"; return; fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  echo no
}

# Stops process $1 and everything Seira started, then waits until the port is free.
stop_app() {
  kill "$1" 2>/dev/null
  sleep 3
  pkill -f '/opt/Seira/|/tmp/\.mount_Seira|chrome-headless-shell' 2>/dev/null
  for _ in $(seq 1 20); do curl -fsS "$HEALTH" >/dev/null 2>&1 || break; sleep 1; done
}

electron_count() { pgrep -fc -- '--type=(zygote|renderer|gpu-process)' || true; }

say "userns-sysctl apparmor_restrict_unprivileged_userns=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo absent)"
say "userns-probe-as-user: $(unshare -Ur true 2>&1 && echo allowed || echo blocked)"
sudo apt-get update -qq >/dev/null 2>&1
say "zenity-in-ubuntu-desktop-minimal=$(apt-cache depends ubuntu-desktop-minimal 2>/dev/null | grep -c -w zenity)"
# The Electron libraries, Xvfb, FUSE 3 and zenity, as a stock Ubuntu desktop has them. imagemagick takes the screenshot.
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xvfb xauth fuse3 zenity imagemagick libgtk-3-0t64 libnss3 \
  libasound2t64 libgbm1 libxss1 libxtst6 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxkbcommon0 libxdamage1 \
  libxrandr2 >/dev/null 2>&1
say "xvfb-installed=$(command -v Xvfb >/dev/null && echo yes || echo no) zenity-installed=$(command -v zenity >/dev/null && echo yes || echo no)"
chmod +x /tmp/Seira.AppImage /tmp/Seira-old.AppImage 2>/dev/null

# 1. New AppImage, no display: the message goes to the terminal.
started=$SECONDS
env -u DISPLAY -u WAYLAND_DISPLAY SEIRA_DATA_DIR="$(mktemp -d)" timeout 20 /tmp/Seira.AppImage >/tmp/appimage.out 2>/tmp/appimage.err
code=$?
say "appimage-terminal-exit=$code seconds=$((SECONDS - started))"
say "appimage-terminal-message=$(grep -c "Seira can't open from this AppImage on this computer." /tmp/appimage.err)"
say "appimage-terminal-names-deb=$(grep -c 'sudo apt install ./Seira-amd64.deb' /tmp/appimage.err)"
say "appimage-terminal-electron-procs=$(electron_count)"
say "appimage-terminal-stderr:"; sed 's/^/RESULT   /' /tmp/appimage.err

Xvfb :99 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &
export DISPLAY=:99
sleep 2

# 2. New AppImage on a desktop: the message shows as a dialog. Close it the way a person would.
SEIRA_DATA_DIR="$(mktemp -d)" /tmp/Seira.AppImage >/tmp/appimage-gui.out 2>/tmp/appimage-gui.err &
GUI=$!
for _ in $(seq 1 10); do pgrep -x zenity >/dev/null && break; sleep 1; done
sleep 1
say "appimage-desktop-dialog=$(pgrep -cx zenity || true)"
import -window root /tmp/appimage-message.png 2>/dev/null && say "appimage-desktop-screenshot=ok"
say "appimage-desktop-electron-procs=$(electron_count)"
pkill -x zenity 2>/dev/null
wait "$GUI"
say "appimage-desktop-exit=$?"

# 3. The older AppImage, when given: the unpatched AppRun on the same host.
if [ -x /tmp/Seira-old.AppImage ]; then
  SEIRA_DATA_DIR="$(mktemp -d)" /tmp/Seira-old.AppImage >/tmp/old-appimage.log 2>&1 &
  OLD=$!
  say "old-appimage-health-seconds=$(wait_health "$OLD" 150)"
  say "old-appimage-cmdline-has-no-sandbox=$(ps -eo args | grep -E '[/]tmp/\.mount_Seira' | grep -c -e '--no-sandbox')"
  say "old-appimage-log-no-usable-sandbox=$(grep -ci 'no usable sandbox' /tmp/old-appimage.log)"
  stop_app "$OLD"
fi

# 4. The DEB, installed as the docs say.
if sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq /tmp/Seira-amd64.deb >/tmp/deb-install.log 2>&1; then
  say "deb-install=ok"
else
  say "deb-install=FAIL"; tail -20 /tmp/deb-install.log | sed 's/^/RESULT   /'; exit 1
fi
say "deb-package: $(dpkg-query -W -f='${Package} ${Version} ${Status}' seira)"
say "deb-chrome-sandbox=$(stat -c '%U:%G:%a' /opt/Seira/chrome-sandbox)"
say "deb-browser-profile-loaded=$(sudo aa-status 2>/dev/null | grep -c seira-browser)"
say "deb-desktop-entry=$(grep -h '^Exec=' /usr/share/applications/bot.seira.app.desktop)"

DATA=$(mktemp -d)
SEIRA_DATA_DIR="$DATA" /opt/Seira/seira >/tmp/deb-electron.log 2>&1 &
APP=$!
say "deb-health-seconds=$(wait_health "$APP" 150)"
sleep 5
say "deb-process-alive=$(kill -0 "$APP" 2>/dev/null && echo yes || echo no)"
say "deb-cmdline-has-no-sandbox=$(ps -eo args | grep -E '^/opt/Seira/' | grep -c -e '--no-sandbox')"
say "deb-setuid-sandbox-procs=$(ps -eo args | grep -c '^/opt/Seira/chrome-sandbox')"
seccomp=""
for pid in $(pgrep -f -- '^/opt/Seira/seira --type=renderer'); do
  seccomp="$seccomp $(awk '/^Seccomp:/ { print $2 }' "/proc/$pid/status" 2>/dev/null)"
done
say "deb-renderer-seccomp-modes:${seccomp:- none}"
say "deb-log-no-usable-sandbox=$(grep -ci 'no usable sandbox' /tmp/deb-electron.log)"
say "deb-log-sandbox-lines:"; grep -i 'sandbox\|namespace\|FATAL' /tmp/deb-electron.log | head -10 | sed 's/^/RESULT   /'
curl -fsS "$HEALTH" 2>&1 | head -c 300 | sed 's/^/RESULT health: /'; echo

CHROME=$(find /opt/Seira/resources/browser-engine -name chrome-headless-shell -type f | head -1)
say "deb-bot-browser-binary=$CHROME"
"$CHROME" --headless --remote-debugging-port=9333 --user-data-dir="$DATA/chrome" about:blank >/tmp/bot-browser.log 2>&1 &
BOT=$!
ok=no
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:9333/json/version >/dev/null 2>&1; then ok=yes; break; fi
  sleep 1
done
say "deb-bot-browser-answers=$ok"
say "deb-bot-browser-log-no-usable-sandbox=$(grep -ci 'no usable sandbox' /tmp/bot-browser.log)"

kill "$BOT" 2>/dev/null
stop_app "$APP"
pkill Xvfb 2>/dev/null
exit 0
GUEST

scp "${SCP_OPTS[@]}" tester@127.0.0.1:/tmp/appimage-message.png "$WORK/appimage-message.png" 2>/dev/null \
  && echo "RESULT screenshot: $WORK/appimage-message.png"
