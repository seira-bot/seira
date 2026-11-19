#!/usr/bin/env bash
# Tests the Flatpak repo flow end to end, with no upload to R2. Run it in the foreground.
#
#   scripts/linux-store/flatpak-repo-test.sh [stage ...]
#
# Stages (default: host verify vm checks): host, verify, vm, checks, clean.
#   host    build once, then publish version A into a test repo (--no-upload)
#   verify  check the repo and its signatures on the host
#   vm      Ubuntu 24.04 VM: install from the .flatpakref, publish B, update; then bundle install and update
#   checks  secret and local-detail checks on the files of this change
#   clean   delete everything except the logs and the Ubuntu image
#
# Needs flatpak, flatpak-builder, ostree, gpg, python3, curl, qemu-system-x86_64, qemu-img, xorriso, ssh, /dev/kvm,
# and the runtimes of packaging/flatpak/bot.seira.Seira.yml. Run it under a memory limit.
# Environment:
#   SEIRA_TEST_ROOT        work folder (default: $XDG_CACHE_HOME/seira-flatpak-test)
#   SEIRA_TEST_KEY=real    sign with the key of SEIRA_FLATPAK_GNUPGHOME instead of a throwaway key
#   SEIRA_FLATPAK_BUILDER_ARGS  extra flatpak-builder arguments, for example --user
#   VM_MEMORY_MB (default 2048), UBUNTU_IMAGE_URL (default: current Ubuntu 24.04 cloud image)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
PUBLISH="$HERE/publish-flatpak.sh"
ROOT="${SEIRA_TEST_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/seira-flatpak-test}"
APP_ID=bot.seira.Seira
APP_REF="app/$APP_ID/x86_64/stable"
VER_A=0.1.179-test.a
VER_B=0.1.179-test.b
# The build takes the app version from package.json, not from the test version names above.
PKG_VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$REPO_ROOT/package.json" | head -1)"
MEMORY="${VM_MEMORY_MB:-2048}"
BASE_URL="${UBUNTU_IMAGE_URL:-https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img}"

mkdir -p "$ROOT/logs" "$ROOT/tmp"
touch "$ROOT/.seira-flatpak-test"
export TMPDIR="$ROOT/tmp"
export SEIRA_FLATPAK_CACHE_DIR="$ROOT/serve/repo"
export SEIRA_FLATPAK_BUILD_DIR="$ROOT/build"
export SEIRA_FLATPAK_STATE_DIR="$ROOT/builder-state"
export SEIRA_FLATPAK_SOURCE_DIR="$ROOT/source"
export SEIRA_FLATPAK_DATA_DIR="$ROOT/data"

FAILS=0
pass() { echo "RESULT: PASS - $*"; }
fail() { echo "RESULT: FAIL - $*"; FAILS=$((FAILS + 1)); }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi; }

free_port() { # $1 = first port to try
  local p="$1"
  while ss -ltn | awk '{print $4}' | grep -q ":$p\$"; do p=$((p + 1)); done
  echo "$p"
}

HTTP_PID=""
VM_PIDFILE="$ROOT/vm/qemu.pid"
VM_KEY="$ROOT/vm/id_ed25519"
VM_PORT_FILE="$ROOT/vm/ssh-port"
stop_all() {
  [ -z "$HTTP_PID" ] || kill "$HTTP_PID" 2>/dev/null || true
  if [ -f "$VM_PIDFILE" ]; then
    vm_ssh 'sudo poweroff' >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do kill -0 "$(cat "$VM_PIDFILE")" 2>/dev/null || break; sleep 1; done
    kill "$(cat "$VM_PIDFILE")" 2>/dev/null || true
    rm -f "$VM_PIDFILE"
  fi
}
trap stop_all EXIT

vm_ssh() {
  ssh -i "$VM_KEY" -p "$(cat "$VM_PORT_FILE")" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR -o ConnectTimeout=5 -o ServerAliveInterval=15 tester@127.0.0.1 "$@"
}
vm_scp() {
  scp -i "$VM_KEY" -P "$(cat "$VM_PORT_FILE")" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR "$@"
}

prepare_keys() {
  mkdir -p "$ROOT/keys"
  if [ "${SEIRA_TEST_KEY:-}" = real ]; then
    : "${SEIRA_FLATPAK_GNUPGHOME:?SEIRA_TEST_KEY=real needs SEIRA_FLATPAK_GNUPGHOME}"
    unset SEIRA_FLATPAK_PUBLIC_KEY SEIRA_FLATPAK_GPG_KEY
    echo "signing with the real key (SEIRA_FLATPAK_GNUPGHOME)"
    return
  fi
  if [ ! -d "$ROOT/keys/home" ]; then
    mkdir -m 700 "$ROOT/keys/home"
    GNUPGHOME="$ROOT/keys/home" gpg --batch --quiet --passphrase '' --quick-generate-key \
      "Seira Flatpak Test <test@example.invalid>" rsa3072 sign never
    GNUPGHOME="$ROOT/keys/home" gpg --batch --armor --export "Seira Flatpak Test" > "$ROOT/keys/public.asc"
  fi
  export SEIRA_FLATPAK_GNUPGHOME="$ROOT/keys/home"
  export SEIRA_FLATPAK_PUBLIC_KEY="$ROOT/keys/public.asc"
  unset SEIRA_FLATPAK_GPG_KEY
}

key_binary() { # writes the binary public key used by this run
  local pub="${SEIRA_FLATPAK_PUBLIC_KEY:-$REPO_ROOT/packaging/flatpak/seira-flatpak.asc}"
  mkdir -m 700 -p "$ROOT/keys/tmp-home"
  GNUPGHOME="$ROOT/keys/tmp-home" gpg --batch --quiet --dearmor < "$pub" > "$ROOT/keys/public.gpg"
}

load_ports() {
  [ -f "$ROOT/http-port" ] || free_port 18080 > "$ROOT/http-port"
  HTTP_PORT="$(cat "$ROOT/http-port")"
  TEST_URL="http://10.0.2.2:$HTTP_PORT/repo/"
}

publish() { # $1 = version, $2 = out dir
  "$PUBLISH" "v$1" --no-upload --skip-checks --repo-url "$TEST_URL" --out-dir "$2" --use-build "$ROOT/build"
}

stage_host() {
  load_ports
  prepare_keys
  mkdir -p "$ROOT/serve" "$ROOT/logs"
  echo "== A: build and publish version $VER_A"
  # No --use-build on the first run: the script builds the app once into $ROOT/build.
  if [ -d "$ROOT/build/files" ] && [ "${REUSE_BUILD:-0}" = 1 ]; then
    publish "$VER_A" "$ROOT/out-a" 2>&1 | tee "$ROOT/logs/publish-a.log"
  else
    "$PUBLISH" "v$VER_A" --no-upload --skip-checks --repo-url "$TEST_URL" --out-dir "$ROOT/out-a" 2>&1 | tee "$ROOT/logs/publish-a.log"
  fi
  COMMIT_A="$(ostree --repo="$SEIRA_FLATPAK_CACHE_DIR" rev-parse "$APP_REF")"
  echo "$COMMIT_A" > "$ROOT/commit-a"
  check "a: build and publish A ($VER_A, commit $COMMIT_A)" test -s "$ROOT/out-a/Seira-$VER_A-x86_64.flatpak"
  check "a: refs files are generated for the test URL" grep -q "Url=$TEST_URL" "$ROOT/out-a/seira.flatpakref"
  local got
  got="$(zcat "$ROOT"/build/files/share/{swcatalog/xml,app-info/xmls}/"$APP_ID".xml.gz 2>/dev/null \
    | grep -o '<release [^>]*version="[^"]*"' | head -1 | sed 's/.*version="//; s/"$//' || true)"
  [ "$got" = "$PKG_VERSION" ] && pass "a: app data has version $PKG_VERSION" || fail "a: app data has version '$got', not $PKG_VERSION"
}

make_b() {
  echo B > "$ROOT/build/files/share/seira-test-marker"
  publish "$VER_B" "$ROOT/out-b" 2>&1 | tee "$ROOT/logs/publish-b.log"
  COMMIT_B="$(ostree --repo="$SEIRA_FLATPAK_CACHE_DIR" rev-parse "$APP_REF")"
  echo "$COMMIT_B" > "$ROOT/commit-b"
}

stage_verify() {
  load_ports
  prepare_keys
  key_binary
  local repo="$SEIRA_FLATPAK_CACHE_DIR" v="$ROOT/verify-repo" fp="$ROOT/fpuser"
  rm -rf "$v" "$fp"
  mkdir -p "$fp"
  COMMIT_A="$(cat "$ROOT/commit-a")"
  check "c: repo lists $APP_REF" bash -c "ostree --repo='$repo' refs | grep -qx '$APP_REF'"
  check "c: summary lists $APP_REF" bash -c "ostree --repo='$repo' summary --view | grep -q '$APP_REF'"
  check "c: summary is signed" test -s "$repo/summary.sig"
  ostree --repo="$repo" show "$APP_REF" | sed 's/^/  /'

  ostree init --mode=archive-z2 --repo="$v"
  ostree --repo="$v" remote add --gpg-import="$ROOT/keys/public.gpg" --set=gpg-verify-summary=true seira "file://$repo"
  check "c: pull with the Seira key verifies commit and summary" ostree --repo="$v" pull seira "$APP_REF"
  GNUPGHOME="$ROOT/keys/tmp-home" gpg --batch --quiet --passphrase '' --quick-generate-key "Other <other@example.invalid>" rsa2048 sign never 2>/dev/null || true
  GNUPGHOME="$ROOT/keys/tmp-home" gpg --batch --export Other > "$ROOT/keys/other.gpg"
  ostree --repo="$v" remote add --gpg-import="$ROOT/keys/other.gpg" --set=gpg-verify-summary=true other "file://$repo"
  if ostree --repo="$v" pull other "$APP_REF" >/dev/null 2>&1; then fail "c: pull with another key is refused"; else pass "c: pull with another key is refused"; fi

  FLATPAK_USER_DIR="$fp" flatpak remote-add --user --gpg-import="$ROOT/keys/public.gpg" seiratest "file://$repo"
  check "c: flatpak remote-ls shows $APP_ID" bash -c "FLATPAK_USER_DIR='$fp' flatpak remote-ls --user --app --columns=application seiratest | grep -qx '$APP_ID'"
  check "c: committed refs files match the committed public key" env -u SEIRA_FLATPAK_PUBLIC_KEY -u SEIRA_FLATPAK_URL "$PUBLISH" --check-refs
}

stage_vm() {
  load_ports
  prepare_keys
  local vm="$ROOT/vm" base disk seed image sums port
  mkdir -p "$vm"
  [ -e /dev/kvm ] || { echo "no /dev/kvm" >&2; exit 2; }
  image="$(basename "$BASE_URL")"; base="$ROOT/$image"; disk="$vm/run.qcow2"; seed="$vm/seed.iso"
  sums="${BASE_URL%/*}/SHA256SUMS"
  if [ ! -f "$base" ]; then
    curl -fsSL -o "$base.part" "$BASE_URL"
    local expected actual
    expected="$(curl -fsSL "$sums" | awk -v f="*$image" '$2 == f { print $1 }')"
    actual="$(sha256sum "$base.part" | awk '{ print $1 }')"
    [ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "image checksum mismatch" >&2; rm -f "$base.part"; exit 2; }
    mv "$base.part" "$base"
  fi
  [ -f "$VM_KEY" ] || ssh-keygen -q -t ed25519 -N "" -f "$VM_KEY"
  free_port 22300 > "$VM_PORT_FILE"
  port="$(cat "$VM_PORT_FILE")"
  cp -f "$base" "$disk"
  qemu-img resize -q "$disk" 12G
  local sd; sd="$(mktemp -d)"
  printf 'instance-id: seira-flatpak-test\nlocal-hostname: seira-test\n' > "$sd/meta-data"
  cat > "$sd/user-data" <<EOF
#cloud-config
users:
  - name: tester
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - $(cat "$VM_KEY.pub")
ssh_pwauth: false
EOF
  xorriso -as mkisofs -quiet -output "$seed" -volid cidata -joliet -rock "$sd/user-data" "$sd/meta-data"
  rm -rf "$sd"

  # The guest reaches this host at 10.0.2.2, which is the host loopback.
  python3 -m http.server "$HTTP_PORT" --bind 127.0.0.1 --directory "$ROOT/serve" >"$ROOT/logs/http.log" 2>&1 &
  HTTP_PID=$!
  qemu-system-x86_64 -enable-kvm -cpu host -smp 4 -m "$MEMORY" -display none -daemonize -pidfile "$VM_PIDFILE" \
    -drive "file=$disk,if=virtio,format=qcow2" -drive "file=$seed,if=virtio,format=raw,readonly=on" \
    -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:$port-:22" -device virtio-net-pci,netdev=net0
  for _ in $(seq 1 90); do vm_ssh true 2>/dev/null && break; sleep 2; done
  vm_ssh 'cloud-init status --wait >/dev/null 2>&1; . /etc/os-release; echo "guest ready: $PRETTY_NAME"'
  vm_ssh 'sudo apt-get update -qq >/dev/null 2>&1; sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq flatpak >/dev/null 2>&1; flatpak --version'
  check "d: guest can read the test repo over HTTP" vm_ssh "curl -fsS ${TEST_URL}config | grep -q archive"

  local commit_a commit_b guest_commit
  commit_a="$(cat "$ROOT/commit-a")"
  vm_scp "$ROOT/out-a/seira.flatpakref" "$ROOT/out-a/Seira-$VER_A-x86_64.flatpak" tester@127.0.0.1:/home/tester/
  echo "== d: install from the .flatpakref"
  vm_ssh 'flatpak install --user -y --noninteractive ./seira.flatpakref' 2>&1 | tee "$ROOT/logs/vm-install-ref.log" | tail -15
  guest_commit="$(vm_ssh "flatpak info --user --show-commit $APP_ID" || true)"
  [ "$guest_commit" = "$commit_a" ] && pass "d: installed from .flatpakref, commit is A ($guest_commit)" || fail "d: installed commit '$guest_commit' is not A ($commit_a)"
  check "d: the runtime came from Flathub" vm_ssh "flatpak list --user --runtime --columns=application,origin | grep -q 'org.freedesktop.Platform.*flathub'"
  vm_ssh 'flatpak remotes --user -d' | tee "$ROOT/logs/vm-remotes-1.log"
  check "d: remote seira has the test URL" bash -c "grep -q '${TEST_URL}' '$ROOT/logs/vm-remotes-1.log'"
  check "d: remote seira checks signatures (gpg-verify on)" vm_ssh "! grep -A12 '^\[remote \"seira\"\]' ~/.local/share/flatpak/repo/config | grep -q 'gpg-verify=false'; test -s ~/.local/share/flatpak/repo/seira.trustedkeys.gpg"
  vm_ssh "flatpak info --user $APP_ID | grep -E 'Version|Commit|Subject'" | sed 's/^/  A: /'
  check "d: flatpak info shows version $PKG_VERSION" vm_ssh "flatpak info --user $APP_ID | grep -qE '^ *Version: ${PKG_VERSION//./\\.}\$'"

  echo "== B: publish version $VER_B, then update in the guest"
  make_b
  commit_b="$(cat "$ROOT/commit-b")"
  [ "$commit_b" != "$commit_a" ] && pass "b: B is a new commit ($commit_b)" || fail "b: B has the same commit as A"
  vm_ssh 'flatpak update --user -y --noninteractive' 2>&1 | tee "$ROOT/logs/vm-update-1.log" | tail -10
  guest_commit="$(vm_ssh "flatpak info --user --show-commit $APP_ID" || true)"
  [ "$guest_commit" = "$commit_b" ] && pass "d: flatpak update moved the install to B ($guest_commit)" || fail "d: after update the commit is '$guest_commit', not B ($commit_b)"
  vm_ssh "flatpak info --user $APP_ID | grep -E 'Version|Commit|Subject'" | sed 's/^/  B: /'

  echo "== e: bundle of A in a clean state"
  vm_ssh "flatpak uninstall --user -y --noninteractive --delete-data $APP_ID; flatpak remote-delete --user --force seira" >/dev/null 2>&1 || true
  vm_ssh 'flatpak remotes --user -d' > "$ROOT/logs/vm-remotes-clean.log"
  if grep -q "$TEST_URL" "$ROOT/logs/vm-remotes-clean.log"; then fail "e: clean state still has the test remote"; else pass "e: clean state has no test remote"; fi
  vm_ssh "flatpak install --user -y --noninteractive --bundle ./Seira-$VER_A-x86_64.flatpak" 2>&1 | tee "$ROOT/logs/vm-install-bundle.log" | tail -10
  guest_commit="$(vm_ssh "flatpak info --user --show-commit $APP_ID" || true)"
  [ "$guest_commit" = "$commit_a" ] && pass "e: bundle installed, commit is A ($guest_commit)" || fail "e: bundle commit '$guest_commit' is not A ($commit_a)"
  vm_ssh 'flatpak remotes --user -d' | tee "$ROOT/logs/vm-remotes-2.log"
  check "e: flatpak remotes -d shows a remote with the test URL" grep -q "$TEST_URL" "$ROOT/logs/vm-remotes-2.log"
  vm_ssh 'flatpak update --user -y --noninteractive' 2>&1 | tee "$ROOT/logs/vm-update-2.log" | tail -10
  guest_commit="$(vm_ssh "flatpak info --user --show-commit $APP_ID" || true)"
  [ "$guest_commit" = "$commit_b" ] && pass "e: flatpak update after the bundle gets B ($guest_commit)" || fail "e: after update the commit is '$guest_commit', not B ($commit_b)"

  stop_all
  HTTP_PID=""
}

stage_checks() {
  # The pattern is built in parts so that this file does not match itself.
  local needle="PRIVATE"" KEY" out lw="$ROOT/tmp/leak-check"
  out="$(cd "$REPO_ROOT" && git grep -n "$needle" -- scripts/linux-store packaging/flatpak docs/releasing.md || true)"
  [ -z "$out" ] && pass "f: no private key text in the files of this change" || { echo "$out"; fail "f: private key text found"; }
  # Check a clean checkout of HEAD, so untracked files of this machine do not count.
  rm -rf "$lw"
  git -C "$REPO_ROOT" worktree add -q --detach "$lw" HEAD
  if (cd "$lw" && node scripts/check-local-leaks.mjs); then pass "f: check-local-leaks passes"; else fail "f: check-local-leaks reports findings"; fi
  git -C "$REPO_ROOT" worktree remove --force "$lw"
}

stage_clean() {
  [ -f "$ROOT/.seira-flatpak-test" ] || { echo "not a test folder: $ROOT" >&2; exit 2; }
  stop_all
  local d
  for d in vm serve build builder-state source data out-a out-b fpuser verify-repo keys tmp; do
    rm -rf "${ROOT:?}/$d"
  done
  echo "cleaned $ROOT (logs and the Ubuntu image stay)"
}

STAGES=("$@")
[ "${#STAGES[@]}" -gt 0 ] || STAGES=(host verify vm checks)
for s in "${STAGES[@]}"; do
  case "$s" in
    host|verify|vm|checks|clean) "stage_$s" ;;
    *) echo "unknown stage: $s" >&2; exit 2 ;;
  esac
done

if [ "$FAILS" -eq 0 ]; then echo "RESULT: PASS - all checks"; else echo "RESULT: FAIL - $FAILS check(s) failed"; exit 1; fi
