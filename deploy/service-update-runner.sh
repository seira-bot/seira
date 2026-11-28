#!/bin/bash
# seira-service-update: updates a Seira server that runs as a systemd service from an npm install, with a way back.
#
#   sudo bash service-update-runner.sh --install [--unit seira]   adds the Update server button and automatic updates
#   sudo seira-service-update --now                             updates now, as a person at a terminal
#   sudo seira-service-update --rollback [--yes]                puts back the version and data from before the last update
#   sudo seira-service-update --remove                          takes the runner away (the copies of the data stay)
#
# SECURITY: the server's request is a file that exists, and nothing else: this never reads it. Anything that runs as the
# server's user can leave it, a bot included, so what a request can cause is fixed here: the version that the stable
# channel (else the npm registry's `latest`) names, only when it is newer than the one installed, at most once per
# version after a rollback, and runs that stop the server GAP_S apart.
# SECURITY: root never runs code, and never reads settings, that the server's user can change. npm runs as that user,
# with no scripts, no npmrc and a fixed registry; root checks first that the user cannot change node or npm. Every change
# in the user's folders is made as the user. The copies of the data go to a folder only root can read: they hold the
# server's keys and tokens.
set -u
umask 022

MARK="# seira-service-update"
SBIN_DIR=${SEIRA_SBIN_DIR:-/usr/local/sbin}
SYSTEMD_DIR=${SEIRA_SYSTEMD_DIR:-/etc/systemd/system}
STATE=${SEIRA_UPDATE_STATE_DIR:-/var/lib/seira-update}
POLICY=${SEIRA_UPDATE_POLICY:-/etc/seira/policy.json}
BACKUPS=${SEIRA_UPDATE_BACKUP_DIR:-/var/backups/seira-update}
STABLE_URL=${SEIRA_STABLE_URL:-https://raw.githubusercontent.com/seira-bot/seira/channels/stable.json}
REGISTRY=${SEIRA_NPM_REGISTRY:-https://registry.npmjs.org}
SERVICE=${SEIRA_SERVICE_UNIT:-seira}
GAP_S=${SEIRA_RUNNER_GAP_S:-240}
QUIET_S=${SEIRA_RUNNER_QUIET_S:-30}
IDLE_S=${SEIRA_RUNNER_IDLE_S:-300}
WAIT_S=${SEIRA_UPDATE_WAIT_S:-180}
ENGINE_WAIT_S=${SEIRA_UPDATE_ENGINE_WAIT_S:-120}
POLL_S=${SEIRA_UPDATE_POLL_S:-5}
NPM_TIMEOUT_S=${SEIRA_UPDATE_NPM_TIMEOUT_S:-900}
KEEP=2
PACKAGE=@seira-bot/seira
UNIT=seira-update
RUNNER=seira-service-update
REQUESTS="$STATE/request"
STATUS="$STATE/status"
JOURNAL="$STATE/journal"
BLOCKED="$STATE/blocked"
IDLE="$STATE/idle"
# Big folders of the data that no version changes on an update: kept out of the copy, and left alone by a rollback.
SKIP="task-workspaces workspaces browser native tools app"
SAFE_DIR='^/[A-Za-z0-9/._-]{1,200}$'
SEMVER='^[0-9]+\.[0-9]+\.[0-9]+$'

say() { printf '%s\n' "$*"; }
fail() {
  printf '%s\n' "$*" >&2
  exit 1
}
number() { case "$1" in '' | *[!0-9]*) echo 0 ;; *) echo "$1" ;; esac; }
# Whole numbers only for the root settings above: anything else is the default.
for name in GAP_S QUIET_S IDLE_S WAIT_S ENGINE_WAIT_S POLL_S NPM_TIMEOUT_S; do
  case "${!name}" in '' | *[!0-9]*) unset "$name" ;; esac
done
GAP_S=${GAP_S:-240} QUIET_S=${QUIET_S:-30} IDLE_S=${IDLE_S:-300} WAIT_S=${WAIT_S:-180}
ENGINE_WAIT_S=${ENGINE_WAIT_S:-120} POLL_S=${POLL_S:-5} NPM_TIMEOUT_S=${NPM_TIMEOUT_S:-900}
case "$SERVICE" in *[!A-Za-z0-9@._-]* | '') fail "The service's name may hold only letters, digits, @ . _ and -." ;; esac

MODE=run
YES=no
while [ $# -gt 0 ]; do
  case "$1" in
    --install) MODE=install ;;
    --remove) MODE=remove ;;
    --now) MODE=now ;;
    --rollback) MODE=rollback ;;
    --yes) YES=yes ;;
    --unit)
      [ $# -ge 2 ] || fail "--unit needs the service's name, like seira."
      SERVICE=${2%.service}
      case "$SERVICE" in *[!A-Za-z0-9@._-]* | '') fail "The service's name may hold only letters, digits, @ . _ and -." ;; esac
      shift
      ;;
    -h | --help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
  shift
done

# Writes stdin to `target` through a temporary file in root's folder; a target that is a link is refused.
place() { # target mode
  [ ! -L "$1" ] || fail "$1 is a link, so it was left alone."
  tmp=$(mktemp "$STATE/.place.XXXXXX") || fail "Could not write in $STATE."
  if ! cat >"$tmp" || ! chmod "$2" "$tmp" || ! mv -f "$tmp" "$1"; then
    rm -f "$tmp"
    fail "Could not write $1."
  fi
}
write_status() { # file, then key=value lines
  file=$1
  shift
  printf '%s\n' "$@" | place "$STATUS/$file" 644
}
status_value() { sed -n "s/^$2=//p" "$STATUS/$1" 2>/dev/null | head -n 1; }
state_value() { sed -n "s/^$2=//p" "$STATE/$1" 2>/dev/null | head -n 1; }
held() { grep -Eq '"updates"[[:space:]]*:[[:space:]]*"hold"' "$POLICY" 2>/dev/null; }
held_word() { if held; then echo yes; else echo no; fi; }
write_runner() { write_status runner layout=service "dir=$PREFIX" "held=$(held_word)" release=yes "unit=$SERVICE"; }
# The string value of top-level key $1 in the JSON object on stdin; fails when the key is missing, twice, or not a string.
json_top() {
  LC_ALL=C awk -v want="$1" '
    { text = text $0 "\n" }
    END {
      n = length(text); depth = 0; expect = ""; key = ""; found = 0; value = ""
      for (i = 1; i <= n; i++) {
        c = substr(text, i, 1)
        if (c == "\"") {
          start = i + 1
          for (i++; i <= n; i++) { c = substr(text, i, 1); if (c == "\\") i++; else if (c == "\"") break }
          s = substr(text, start, i - start)
          if (depth == 1 && expect == "value") { if (key == want) { found++; value = s }; expect = "" }
          else if (depth == 1) key = s
        } else if (c == ":") { if (depth == 1) expect = "value" }
        else if (c == "{" || c == "[") { if (depth == 1 && expect == "value") { if (key == want) found += 2; expect = "" }; depth++ }
        else if (c == "}" || c == "]") depth--
        else if (c == ",") { if (depth == 1) expect = "" }
        else if (c !~ /[ \t\r\n]/ && depth == 1 && expect == "value") { if (key == want) found += 2; expect = "" }
      }
      if (found != 1) exit 1
      print value
    }'
}
top_version() { json_top version | grep -Ex '[0-9]+\.[0-9]+\.[0-9]+'; }
newer() { # true when $1 is a newer X.Y.Z than $2
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)" = "$1" ]
}
stamp() { date -u +%Y%m%dT%H%M%SZ; }

# --- What the service runs, from systemd (root's) ---------------------------------------------------------------------

unit_prop() { printf '%s\n' "$PROPS" | sed -n "s/^$1=//p" | head -n 1; }
# "PATH user:group mode", as the server shows a refusal.
line_of() { printf '%s %s' "$1" "$(stat -L -c '%U:%G %a' "$1" 2>/dev/null)"; }
in_user_groups() { case " $USER_GIDS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
# True when the service's user can change `path`, or rename it through a folder above: then root must not run it, even as
# that user outside the service's own limits. Sets UNSAFE_AT.
user_can_change() {
  p=$1
  while :; do
    if [ ! -e "$p" ]; then UNSAFE_AT=$p; return 0; fi
    owner=$(stat -L -c %u "$p" 2>/dev/null) || { UNSAFE_AT=$p; return 0; }
    mode=$((8#$(stat -L -c %a "$p")))
    group=$(stat -L -c %g "$p")
    if [ "$owner" = "$USER_UID" ]; then UNSAFE_AT=$p; return 0; fi
    if [ $((mode & 2)) != 0 ] && ! { [ -d "$p" ] && [ $((mode & 512)) != 0 ]; }; then UNSAFE_AT=$p; return 0; fi
    if [ $((mode & 16)) != 0 ] && in_user_groups "$group"; then UNSAFE_AT=$p; return 0; fi
    [ "$p" = / ] && return 1
    p=$(dirname "$p")
  done
}

# Reads the service from systemd. Sets USER_NAME USER_UID USER_GIDS PKG PREFIX DATA PORT NODE NPM_CLI, or FACT_RESULT
# (no-updater or unsafe) with FACT_WHY, and FACT_DETAIL for unsafe.
facts() {
  FACT_RESULT="" FACT_WHY="" FACT_DETAIL=""
  PROPS=$(systemctl show "$SERVICE.service" -p LoadState -p User -p ExecStart -p Environment 2>/dev/null)
  if [ "$(unit_prop LoadState)" != loaded ]; then FACT_RESULT=no-updater FACT_WHY="systemd has no $SERVICE.service."; return 1; fi
  USER_NAME=$(unit_prop User)
  case "$USER_NAME" in
    '' | root | 0) FACT_RESULT=no-updater FACT_WHY="$SERVICE.service runs as root. Run Seira as its own user (seira service install says how)."; return 1 ;;
    *[!A-Za-z0-9._-]*) FACT_RESULT=no-updater FACT_WHY="$SERVICE.service names a user this cannot use."; return 1 ;;
  esac
  USER_UID=$(id -u "$USER_NAME" 2>/dev/null) && [ -n "$USER_UID" ] && [ "$USER_UID" != 0 ] || { FACT_RESULT=no-updater FACT_WHY="There is no user $USER_NAME."; return 1; }
  USER_GIDS=$(id -G "$USER_NAME" 2>/dev/null)
  argv=$(unit_prop ExecStart)
  argv=${argv#*argv\[\]=}
  argv=${argv%% ;*}
  read -r -a ARGS <<<"$argv"
  unit_path="" unit_home="" DATA="" PORT=""
  for word in $(unit_prop Environment); do
    case "$word" in
      PATH=*) unit_path=${word#PATH=} ;;
      HOME=*) unit_home=${word#HOME=} ;;
      SEIRA_DATA_DIR=*) DATA=${word#SEIRA_DATA_DIR=} ;;
      SEIRA_PORT=*) PORT=${word#SEIRA_PORT=} ;;
    esac
  done
  [ -n "$unit_path" ] || unit_path=/usr/local/bin:/usr/bin:/bin
  [ -n "$unit_home" ] || unit_home=$(getent passwd "$USER_NAME" 2>/dev/null | cut -d: -f6)
  script="" node=""
  case "$(basename "${ARGS[0]:-}")" in
    node | nodejs | node[0-9]*) node=${ARGS[0]} script=${ARGS[1]:-} ;;
    *) script=${ARGS[0]:-} ;;
  esac
  i=0
  while [ $i -lt ${#ARGS[@]} ]; do
    case "${ARGS[$i]}" in
      --port) PORT=${ARGS[$((i + 1))]:-} ;;
      --data-dir) DATA=${ARGS[$((i + 1))]:-} ;;
    esac
    i=$((i + 1))
  done
  [ -n "$DATA" ] || DATA="$unit_home/.seira"
  [ -n "$PORT" ] || PORT=8799
  real=$(readlink -f -- "$script" 2>/dev/null)
  case "$real" in
    */node_modules/$PACKAGE/*) ;;
    *) FACT_RESULT=no-updater FACT_WHY="$SERVICE.service does not run Seira from an npm install."; return 1 ;;
  esac
  PKG="${real%/node_modules/$PACKAGE/*}/node_modules/$PACKAGE"
  base=${PKG%/node_modules/$PACKAGE}
  case "$base" in */lib) PREFIX=${base%/lib} GLOBAL=yes ;; *) PREFIX=$base GLOBAL=no ;; esac
  for value in "$PREFIX" "$DATA"; do
    if ! printf '%s' "$value" | grep -Eq "$SAFE_DIR"; then FACT_RESULT=no-updater FACT_WHY="$value may hold only letters, digits, / . _ and -."; return 1; fi
  done
  case "$PORT" in '' | *[!0-9]*) FACT_RESULT=no-updater FACT_WHY="$SERVICE.service names a port this cannot use."; return 1 ;; esac
  if [ -z "$node" ]; then node=$(PATH=$unit_path command -v node 2>/dev/null); fi
  NODE=$(readlink -f -- "$node" 2>/dev/null)
  [ -n "$NODE" ] && [ -x "$NODE" ] || { FACT_RESULT=no-updater FACT_WHY="Could not find the node that $SERVICE.service runs."; return 1; }
  NPM_CLI=$(readlink -f -- "$(dirname "$NODE")/../lib/node_modules/npm/bin/npm-cli.js" 2>/dev/null)
  if [ ! -f "$NPM_CLI" ]; then NPM_CLI=$(readlink -f -- "$(PATH=$unit_path command -v npm 2>/dev/null)" 2>/dev/null); fi
  [ -n "$NPM_CLI" ] && [ -f "$NPM_CLI" ] || { FACT_RESULT=no-updater FACT_WHY="Could not find npm beside $NODE."; return 1; }
  for tool in "$NODE" "$(dirname "$(dirname "$NPM_CLI")")" "$NPM_CLI"; do
    if user_can_change "$tool"; then
      FACT_RESULT=unsafe FACT_DETAIL=$(line_of "$UNSAFE_AT")
      FACT_WHY="$USER_NAME can change $UNSAFE_AT, which this runs to install Seira. Install Node.js and npm so that only root can change them."
      return 1
    fi
  done
}

# --- Acting as the service's user ---------------------------------------------------------------------------------------

as_named() { # user command...
  local who=$1
  shift
  (cd / && runuser -u "$who" -- env -i HOME=/nonexistent PATH=/usr/bin:/bin LANG=C.UTF-8 "$@")
}
as_user() { as_named "$USER_NAME" "$@"; }
installed_version() { as_user cat "$PKG/package.json" 2>/dev/null | top_version; }
work() { printf '%s/.seira-update' "$PREFIX"; }

# The version to take: the stable channel's when it has one that npm has, else npm's `latest`. Sets TARGET (empty: none
# yet). Fails when neither can be read.
fetch() { # url outfile → status: 200, 404 or another
  code=$(curl -sS --max-time 30 --proto '=https,file' -H 'accept: application/json' -o "$2" -w '%{http_code}' -- "$1" 2>/dev/null)
  rc=$?
  case "$1" in file://*) if [ $rc = 0 ]; then echo 200; elif [ $rc = 37 ]; then echo 404; else echo 0; fi; return ;; esac
  [ $rc = 0 ] && echo "$code" || echo 0
}
choose_target() {
  TARGET=""
  body=$(mktemp "$STATE/.fetch.XXXXXX") || return 1
  code=$(fetch "$STABLE_URL" "$body")
  case "$code" in
    200) stable=$(top_version <"$body") ;;
    404) stable="" ;;
    *) rm -f "$body"; return 1 ;;
  esac
  if [ -n "$stable" ]; then
    code=$(fetch "$REGISTRY/$PACKAGE/$stable" "$body")
    case "$code" in 200) TARGET=$stable ;; 404) TARGET="" ;; *) rm -f "$body"; return 1 ;; esac
    rm -f "$body"
    return 0
  fi
  code=$(fetch "$REGISTRY/$PACKAGE/latest" "$body")
  [ "$code" = 200 ] || { rm -f "$body"; return 1; }
  TARGET=$(top_version <"$body")
  rm -f "$body"
  printf '%s' "$TARGET" | grep -Eq "$SEMVER" || return 1
}

# --- The server ---------------------------------------------------------------------------------------------------------

answers() { curl -sf --max-time 5 --proto '=http' "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q -e seira -e openmausbot; }
reported_version() {
  for name in seira openmausbot; do
    curl -sf --max-time 5 --proto '=http' "http://127.0.0.1:$PORT/.well-known/$name/environment" 2>/dev/null && break
  done | top_version
}
engine_count() { curl -sS --max-time 10 --proto '=http' "http://127.0.0.1:$PORT/api/health/engines" 2>/dev/null | sed -n 's/.*"engines":\([0-9][0-9]*\).*/\1/p' | head -n 1; }
restarts() { number "$(systemctl show "$SERVICE.service" -p NRestarts --value 2>/dev/null)"; }
stopped() { ! systemctl is-active --quiet "$SERVICE.service"; }
stop_server() { systemctl stop "$SERVICE.service" >/dev/null 2>&1 && stopped; }
start_server() { systemctl start "$SERVICE.service" >/dev/null 2>&1; }
# Answers /api/health three times in a row as version $1, within WAIT_S. Sets WHY.
wait_healthy() {
  want=$1 WHY="" streak=0 deadline=$(($(date +%s) + WAIT_S)) first=$(restarts)
  while :; do
    if [ $(($(restarts) - first)) -ge 3 ]; then WHY="it kept stopping as it started"; return 1; fi
    if answers; then streak=$((streak + 1)); else streak=0; fi
    if [ "$streak" -ge 3 ]; then
      said=$(reported_version)
      [ "$said" = "$want" ] && return 0
      WHY="it says it is version ${said:-unknown}, not $want"
      return 1
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then WHY="it did not answer within $WAIT_S seconds"; return 1; fi
    sleep "$POLL_S"
  done
}
# An engine could start a bot before the update: one still can after it, within ENGINE_WAIT_S.
wait_engines() {
  [ "$(number "$1")" -gt 0 ] || return 0
  deadline=$(($(date +%s) + ENGINE_WAIT_S))
  while :; do
    [ "$(number "$(engine_count)")" -gt 0 ] && return 0
    if [ "$(date +%s)" -ge "$deadline" ]; then WHY="no engine can start a bot on it, and one could before"; return 1; fi
    sleep "$POLL_S"
  done
}

# --- Copies of the data, in root's folder -------------------------------------------------------------------------------

skip_args() { for name in $SKIP; do printf -- '--exclude=./%s\n' "$name"; done; }
# The data without SKIP, read by the user and written by root to a file only root can read.
copy_data() { # file
  install -d -m 0700 -o 0 -g 0 "$BACKUPS" || return 1
  part="$1.part"
  rm -f "$part"
  # tar's 1 is a file that changed while it was read; the server is stopped, so that is a log or a socket.
  # shellcheck disable=SC2046
  if ! (
    umask 077
    as_user tar -C "$DATA" $(skip_args) -cf - . | gzip -1 >"$part"
    codes=("${PIPESTATUS[@]}")
    [ "${codes[0]}" -le 1 ] && [ "${codes[1]}" = 0 ]
  ) || ! gzip -t "$part" 2>/dev/null; then
    rm -f "$part"
    return 1
  fi
  chmod 600 "$part" && mv -f "$part" "$1"
}
# Puts the data back from `file`: what the newer version wrote is moved aside first, then removed once the copy is back.
restore_data() { # file
  aside="$DATA/.seira-update-replaced"
  as_user rm -rf -- "$aside" || return 1
  as_user mkdir -m 0700 -- "$aside" || return 1
  # shellcheck disable=SC2046
  as_user find "$DATA" -mindepth 1 -maxdepth 1 ! -name .seira-update-replaced $(for name in $SKIP; do printf '! -name %s ' "$name"; done) -exec mv -t "$aside" -- {} + || return 1
  if ! gzip -dc "$1" | as_user tar -C "$DATA" -xf -; then return 1; fi
  as_user rm -rf -- "$aside"
}
# Keeps the KEEP newest copies. A run the server asked for never removes a copy from a person's run.
prune_copies() { # by
  find "$BACKUPS" -maxdepth 1 -type f -name 'seira-data-*.tar.gz' -printf '%T@ %p\n' | sort -rn | awk -v keep="$KEEP" 'NR > keep { sub(/^[^ ]* /, ""); print }' |
    while IFS= read -r old; do
      case "$old" in *-manual.tar.gz) [ "$1" = person ] || continue ;; esac
      rm -f -- "$old"
    done
}
free_kb() { df -Pk "$1" 2>/dev/null | awk 'NR == 2 { print $4 }'; }

# --- One update ---------------------------------------------------------------------------------------------------------

journal() { printf '%s\n' "$@" | place "$JOURNAL" 600; }
# False while an earlier run is unfinished. A run cut off (a reboot, a kill) after its new version started is kept
# when that version is installed and answers; any other needs a person: sudo seira-service-update --rollback.
settled() {
  [ -f "$JOURNAL" ] || return 0
  to=$(state_value journal to)
  if [ "$(state_value journal step)" = started ] && [ -n "$to" ] && [ "$(installed_version)" = "$to" ] && answers && [ "$(reported_version)" = "$to" ]; then
    rm -f "$JOURNAL"
    return 0
  fi
  return 1
}
# Takes TARGET over the installed version: 0 updated, 1 rolled back, 2 could not roll back, 4 nothing changed, 6 no room.
update_to() { # by
  by=$1 from=$(installed_version)
  dir=$(work) parent=$(dirname "$PKG")
  staged="$dir/prefix/lib/node_modules/$PACKAGE"
  say "Downloading $TARGET…"
  as_user rm -rf -- "$dir" && as_user mkdir -p -m 0700 -- "$dir/home" "$dir/prefix" || { say "Could not write in $PREFIX. Nothing was changed."; return 4; }
  # SECURITY: no scripts, no npmrc of the user's or the prefix's, and the registry fixed by root.
  if ! (cd / && timeout "$NPM_TIMEOUT_S" runuser -u "$USER_NAME" -- env -i HOME="$dir/home" PATH="/usr/bin:/bin:$(dirname "$NODE")" LANG=C.UTF-8 \
    "$NODE" "$NPM_CLI" install --global --prefix "$dir/prefix" --ignore-scripts --no-audit --no-fund --no-update-notifier \
    --userconfig=/dev/null --globalconfig=/dev/null --cache="$dir/home/.npm" --registry="$REGISTRY/" "$PACKAGE@$TARGET"); then
    as_user rm -rf -- "$dir"
    say "Could not download $PACKAGE@$TARGET. Nothing was changed."
    return 4
  fi
  got=$(as_user cat "$staged/package.json" 2>/dev/null | top_version)
  if [ "$got" != "$TARGET" ] || ! as_user test -f "$staged/cli.js"; then
    as_user rm -rf -- "$dir"
    say "The download is not $PACKAGE@$TARGET. Nothing was changed."
    return 4
  fi
  if [ "$(number "$(free_kb "$(dirname "$BACKUPS")")")" -lt 524288 ]; then
    as_user rm -rf -- "$dir"
    say "There is not enough free disk for a copy of the data. Nothing was changed."
    return 6
  fi
  engines=$(engine_count)
  suffix=""
  [ "$by" = person ] && suffix=-manual
  copy="$BACKUPS/seira-data-$from-$(stamp)$suffix.tar.gz"
  journal step=stopping "from=$from" "to=$TARGET" "copy=$copy" "by=$by"
  say "Stopping the server and copying its data aside…"
  if ! stop_server; then
    start_server
    as_user rm -rf -- "$dir"
    say "The server did not stop. Nothing was changed."
    rm -f "$JOURNAL"
    return 4
  fi
  if ! copy_data "$copy"; then
    start_server
    as_user rm -rf -- "$dir"
    rm -f "$JOURNAL"
    if [ "$(number "$(free_kb "$BACKUPS")")" -lt 65536 ]; then
      say "There was not enough free disk for a copy of the data. Nothing was changed."
      return 6
    fi
    say "Could not copy the data. Nothing was changed."
    return 4
  fi
  journal step=swapping "from=$from" "to=$TARGET" "copy=$copy" "by=$by"
  if ! as_user rm -rf -- "$parent/.seira-previous" || ! as_user mv -- "$PKG" "$parent/.seira-previous"; then
    start_server
    rm -f "$JOURNAL"
    say "Could not set the old version aside. Nothing was changed."
    return 4
  fi
  if ! as_user mv -- "$staged" "$PKG"; then
    as_user mv -- "$parent/.seira-previous" "$PKG"
    start_server
    rm -f "$JOURNAL"
    say "Could not put the new version in place. Nothing was changed."
    return 4
  fi
  as_user rm -rf -- "$dir"
  journal step=started "from=$from" "to=$TARGET" "copy=$copy" "by=$by"
  say "Starting $TARGET…"
  start_server
  if wait_healthy "$TARGET" && wait_engines "$engines"; then
    rm -f "$JOURNAL"
    prune_copies "$by" "$copy"
    say "Updated from $from to $TARGET. The data from before the update is in $copy. To go back: sudo $RUNNER --rollback"
    return 0
  fi
  say "$TARGET is not healthy: $WHY. Putting $from back…"
  roll_back "$from" "$copy"
}

# Puts the version set aside and the data from `copy` back: 1 when that version is healthy again, else 2.
roll_back() { # version copy
  parent=$(dirname "$PKG")
  journal step=rolling-back "from=$1" "copy=$2"
  if ! stop_server; then
    say "The server did not stop, so nothing was put back. The data from before is in $2. Run sudo $RUNNER --rollback when the server is stopped."
    return 2
  fi
  if ! as_user test -d "$parent/.seira-previous"; then
    say "The version from before is gone, so it could not be put back. The data from before is in $2."
    return 2
  fi
  if ! as_user rm -rf -- "$PKG" || ! as_user mv -- "$parent/.seira-previous" "$PKG" || ! restore_data "$2"; then
    start_server
    say "Could not put $1 and its data back. The data from before is in $2."
    return 2
  fi
  start_server
  if wait_healthy "$1"; then
    rm -f "$JOURNAL"
    say "$1 runs again, with its data from before the update."
    return 1
  fi
  say "$1 did not start again either: $WHY. The data from before is in $2."
  return 2
}

# --- Entry points -------------------------------------------------------------------------------------------------------

result_of() {
  case "$1" in
    0) echo updated ;;
    1) echo rolled-back ;;
    2) echo rollback-failed ;;
    3) echo busy ;;
    4) echo refused ;;
    5) echo older ;;
    6) echo no-room ;;
    *) echo failed ;;
  esac
}

lock() {
  exec 9>"$STATE/lock" || return 1
  flock -n 9
}

# The request folder belongs to the service user, so its owner removes what is in it. Root removes only the two names, not their contents.
clear_requests() {
  local owner
  owner=$(stat -c %U -- "$REQUESTS" 2>/dev/null)
  case "$owner" in
    '' | root | UNKNOWN | *[!A-Za-z0-9._-]*) rm -f -- "$REQUESTS/request" "$REQUESTS/fresh" ;;
    *) as_named "$owner" rm -rf -- "$REQUESTS/request" "$REQUESTS/fresh" || true ;;
  esac
}

# systemd starts this when the request appears or the owner's policy changes.
run_requested() {
  [ -d "$STATUS" ] || exit 0
  [ "$(status_value runner layout)" = service ] || exit 0
  PREFIX=$(status_value runner dir)
  write_runner
  [ -e "$REQUESTS/request" ] || [ -L "$REQUESTS/request" ] || exit 0
  fresh=no
  if [ -e "$REQUESTS/fresh" ] || [ -L "$REQUESTS/fresh" ]; then fresh=yes; fi
  clear_requests
  run=$(($(number "$(status_value last run)") + 1))
  ran=$(number "$(status_value last ran)")
  since=$(($(date +%s) - $(number "$(status_value last at)")))
  if [ "$since" -lt "$QUIET_S" ]; then sleep $((QUIET_S - since)); fi
  now=$(date +%s)
  version="" detail=""
  done_with() { write_status last "run=$run" state=done "result=$1" "at=$(date +%s)" "ran=$ran" ${version:+"version=$version"} ${detail:+"detail=$detail"}; }
  if ! lock; then done_with busy; return; fi
  if held; then done_with held; return; fi
  if ! facts; then
    [ "$FACT_RESULT" = unsafe ] && detail=$FACT_DETAIL
    say "$FACT_WHY"
    done_with "$FACT_RESULT"
    return
  fi
  write_runner
  if ! settled; then done_with failed; return; fi
  current=$(installed_version)
  if ! printf '%s' "$current" | grep -Eq "$SEMVER"; then done_with failed; return; fi
  if [ "$fresh" = no ] && [ "$(state_value idle installed)" = "$current" ] && [ $((now - $(number "$(state_value idle at)"))) -lt "$IDLE_S" ]; then
    version=$(state_value idle version)
    done_with updated
    return
  fi
  if ! choose_target; then done_with refused; return; fi
  version=${TARGET:-$current}
  if [ -z "$TARGET" ] || ! newer "$TARGET" "$current"; then
    printf '%s\n' "installed=$current" "at=$now" "version=$version" | place "$IDLE" 600
    done_with updated
    return
  fi
  if [ "$(state_value blocked installed)" = "$current" ] && [ "$(state_value blocked target)" = "$TARGET" ]; then done_with not-retried; return; fi
  if [ $((now - ran)) -lt "$GAP_S" ]; then done_with too-soon; return; fi
  write_status last "run=$run" state=running "at=$now" "ran=$ran" "version=$version"
  ran=$now
  code=0
  update_to runner || code=$?
  rm -f "$IDLE"
  case "$code" in
    0) rm -f "$BLOCKED" ;;
    1) printf '%s\n' "installed=$current" "target=$TARGET" | place "$BLOCKED" 600 ;;
    4 | 6) ran=$(number "$(status_value last ran)") ;;
  esac
  done_with "$(result_of "$code")"
}

need_root() { [ "$(id -u)" = 0 ] || fail "Run this as root: sudo $RUNNER $*"; }

update_now() {
  need_root --now
  [ -d "$STATE" ] || fail "The runner is not installed here. Install it first: sudo bash service-update-runner.sh --install"
  lock || fail "Another update is running here."
  facts || fail "$FACT_WHY"
  settled || fail "An earlier update did not finish (see $JOURNAL). Put the version from before back first: sudo $RUNNER --rollback"
  current=$(installed_version)
  printf '%s' "$current" | grep -Eq "$SEMVER" || fail "Could not tell which version is installed in $PKG."
  choose_target || fail "Could not read which version to take. Nothing was changed."
  if [ -z "$TARGET" ] || ! newer "$TARGET" "$current"; then
    say "$current is the newest version that can be installed. Nothing to do."
    exit 0
  fi
  code=0
  update_to person || code=$?
  rm -f "$IDLE" "$BLOCKED"
  exit "$code"
}

roll_back_now() {
  need_root --rollback
  [ -d "$STATE" ] || fail "The runner is not installed here."
  lock || fail "Another update is running here."
  facts || fail "$FACT_WHY"
  copy=$(state_value journal copy)
  from=$(state_value journal from)
  if [ -z "$copy" ]; then
    copy=$(find "$BACKUPS" -maxdepth 1 -type f -name 'seira-data-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n 1 | cut -d' ' -f2-)
    from=$(basename "$copy" | sed -n 's/^seira-data-\([0-9]*\.[0-9]*\.[0-9]*\)-.*/\1/p')
  fi
  [ -n "$copy" ] && [ -f "$copy" ] || fail "There is no copy of the data in $BACKUPS, so there is nothing to go back to."
  previous=$(as_user cat "$(dirname "$PKG")/.seira-previous/package.json" 2>/dev/null | top_version)
  [ -n "$previous" ] || fail "There is no version from before the last update in $(dirname "$PKG")."
  [ "$previous" = "$from" ] || fail "The version set aside ($previous) is not the one the copy of the data was made from ($from). Nothing was changed."
  if [ "$YES" != yes ]; then
    [ -t 0 ] || fail "This puts back $from and its data from $copy, and loses what changed since. Run it again with --yes."
    printf 'This puts back %s and its data from %s, and loses what changed since. Go on? [y/N] ' "$from" "$copy"
    read -r answer
    case "$answer" in y | Y | yes) ;; *) fail "Nothing was changed." ;; esac
  fi
  bad=$(installed_version)
  code=0
  roll_back "$from" "$copy" || code=$?
  [ "$code" = 1 ] || exit "$code"
  # The app does not take the version that was put back again; sudo seira-service-update --now still does.
  rm -f "$IDLE"
  if [ -n "$bad" ]; then printf '%s\n' "installed=$from" "target=$bad" | place "$BLOCKED" 600; fi
  exit 0
}

install_runner() {
  need_root --install
  command -v systemctl >/dev/null 2>&1 && [ -d "$SYSTEMD_DIR" ] || fail "This server has no systemd, so it cannot update itself."
  for tool in runuser flock curl tar gzip; do command -v "$tool" >/dev/null 2>&1 || fail "This needs $tool. Install it, then run this again."; done
  [ -f "$0" ] && grep -qF "$MARK" "$0" || fail "Run this from the downloaded file: sudo bash service-update-runner.sh --install"
  [ ! -L "$STATE" ] || fail "$STATE is a link, so it was left alone."
  layout=$(status_value runner layout)
  if [ -n "$layout" ] && [ "$layout" != service ]; then
    fail "This server's Update server button already updates a Docker install. One install per server."
  fi
  other=$(status_value runner unit)
  if [ -n "$other" ] && [ "$other" != "$SERVICE" ]; then
    fail "This server's runner already updates $other.service. To move it: sudo $RUNNER --remove, then run this again."
  fi
  facts || fail "$FACT_WHY"
  install -d -m 0755 -o 0 -g 0 "$STATE" "$STATUS" || fail "Could not make $STATE."
  gid=$(id -g "$USER_NAME")
  install -d -m 0700 -o "$USER_UID" -g "$gid" "$REQUESTS" || fail "Could not make $REQUESTS."
  install -d -m 0700 -o 0 -g 0 "$BACKUPS" || fail "Could not make $BACKUPS."
  install -d -m 0755 "$SBIN_DIR"
  place "$SBIN_DIR/$RUNNER" 755 <"$0"
  extra=""
  for name in SEIRA_STABLE_URL SEIRA_NPM_REGISTRY SEIRA_UPDATE_WAIT_S SEIRA_UPDATE_ENGINE_WAIT_S SEIRA_RUNNER_GAP_S SEIRA_RUNNER_QUIET_S SEIRA_RUNNER_IDLE_S; do
    value=$(printenv "$name" || true)
    case "$value" in '' | *[!A-Za-z0-9:/._-]*) ;; *) extra="$extra $name=$value" ;; esac
  done
  place "$SYSTEMD_DIR/$UNIT.path" 644 <<UNITFILE
[Unit]
Description=Updates Seira when the server asks (Settings, Update server, or by itself when idle)

[Path]
PathExists=$REQUESTS/request
PathChanged=$POLICY

[Install]
WantedBy=multi-user.target
UNITFILE
  place "$SYSTEMD_DIR/$UNIT.service" 644 <<UNITFILE
[Unit]
Description=Updates $SERVICE.service from npm, asked for by the server

[Service]
Type=oneshot
Environment=HOME=/root SEIRA_SERVICE_UNIT=$SERVICE$extra
ExecStart=$SBIN_DIR/$RUNNER
TimeoutStartSec=2h
UNITFILE
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable --now "$UNIT.path" >/dev/null 2>&1 || fail "systemd did not switch on $UNIT.path. See: systemctl status $UNIT.path"
  [ -f "$STATUS/last" ] || write_status last run=0 state=done result=updated at=0 ran=0
  rm -f "$BLOCKED" "$IDLE"
  write_runner
  sandbox=$(systemctl show "$SERVICE.service" -p ProtectSystem --value 2>/dev/null)
  writable=$(systemctl show "$SERVICE.service" -p ReadWritePaths --value 2>/dev/null)
  if [ "$sandbox" = strict ] && ! printf ' %s ' "$writable" | grep -qE " ($STATE|$REQUESTS)/? "; then
    say "$SERVICE.service sees the system read-only. Add this line under [Service] in its unit, then restart it:"
    say "  ReadWritePaths=$REQUESTS"
  fi
  say "Seira $(installed_version) in $PREFIX now updates from the app (Settings, Update server), and by itself when no bot is working."
  say "To stop the updates it makes by itself, set SEIRA_AUTO_UPDATE=off in $SERVICE.service. To hold every update: {\"updates\": \"hold\"} in $POLICY."
  say "Copies of the data: $BACKUPS (root only). To take the runner away: sudo $RUNNER --remove"
}

remove_runner() {
  need_root --remove
  if command -v systemctl >/dev/null 2>&1; then systemctl disable --now "$UNIT.path" >/dev/null 2>&1 || true; fi
  [ "$(status_value runner layout)" = service ] || [ ! -d "$STATUS" ] || fail "The runner here updates a Docker install. Remove it with update-runner.sh --remove."
  rm -f "$SYSTEMD_DIR/$UNIT.path" "$SYSTEMD_DIR/$UNIT.service" "$SBIN_DIR/$RUNNER"
  if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload >/dev/null 2>&1 || true; fi
  if [ ! -L "$STATE" ]; then rm -rf -- "$STATE"; fi
  say "The app no longer updates this server. The copies of the data stay in $BACKUPS."
}

case "$MODE" in
  install) install_runner ;;
  remove) remove_runner ;;
  now) update_now ;;
  rollback) roll_back_now ;;
  *) run_requested ;;
esac
