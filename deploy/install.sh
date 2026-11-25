#!/bin/sh
# Seira on a server of your own: checks the server, then installs the Seira server with HTTPS on your domain.
# Running it again repairs or updates the install and never touches your data.
#
#   curl -fsSL https://raw.githubusercontent.com/seira-bot/seira/main/deploy/install.sh | sudo sh -s -- --domain seira.example.com
#   ... | sudo sh -s -- --tunnel --account-email you@example.com   no domain, no open port: served at your Seira account's address
#   ... | sudo sh -s -- --check --domain seira.example.com    only checks the server; changes nothing
#   ... | sudo sh -s -- --uninstall                          stops the server; keeps your data
#   ... | sudo sh -s -- --domain seira.example.com <code>     also connects the server to Seira with a one-time code
#                                                            (needs SEIRA_ADMIN_URL: the address of the service that gave the code)
#
# Nothing runs until the last line calls main, so a download that is cut off part-way runs nothing. It sends no
# telemetry. The addresses it contacts are the ones the checks name: the image registries, Let's Encrypt, GitHub's
# release list and this repository's files, and cloudflare.com/cdn-cgi/trace to learn this server's public address.
# With --tunnel it also contacts your Seira account service and Cloudflare's tunnel edge, and not Let's Encrypt.
set -eu

settings() {
  SYSROOT="${SEIRA_INSTALL_SYSROOT:-}"
  INSTALL_DIR="${SEIRA_INSTALL_DIR:-/opt/seira}"
  IMAGE_REPO=seira-bot/seira
  RELEASES_URL=https://api.github.com/repos/seira-bot/seira/releases/latest
  ADMIN_URL="${SEIRA_ADMIN_URL:-}"
  SCRIPT_URL=https://raw.githubusercontent.com/seira-bot/seira/main/deploy/install.sh
  # Where the files this installer places come from: this repository at the tag of the version it installs, and at
  # main when that tag does not have them. SEIRA_INSTALL_SOURCE names one copy to use instead (https://… or file:///…).
  REPOSITORY_FILES=https://raw.githubusercontent.com/seira-bot/seira
  SOURCE_ASKED="${SEIRA_INSTALL_SOURCE:-}"
  SOURCE=""
  SOURCE_NAME=""
  # WARN-ONLY SANDBOX CHECKS. The self-check's results that do not stop an install when they fail: none of them lets a
  # bot reach what it must not, or stops bots working. Every other check, and any check this list has never heard
  # of, stops it. A result that carries its own "severity" says so itself and this list is not asked.
  SANDBOX_WARN_ONLY="keyring-denied hostname-private cpu-list-readable fly-api-hidden egress-public-allowed"
  SECCOMP=seccomp-seira-home.json
  APPARMOR_PROFILE=seira-home-narrow
  PROJECT=seira
  MIN_DOCKER=24
  MIN_CPUS=2
  MIN_MEMORY_MB=3500
  MIN_DISK_GB=20
  MAX_CLOCK_SKEW_S=300
  HEALTH_WAIT_S="${SEIRA_INSTALL_HEALTH_WAIT_S:-240}"
  HTTPS_WAIT_S="${SEIRA_INSTALL_HTTPS_WAIT_S:-180}"

  # The two outbound addresses a tunnel install needs besides the registries: the account service that gives the
  # address (SEIRA_CONTROL_PLANE_URL names another one) and the edge that Cloudflare's connector reaches.
  ACCOUNT_HOST=accounts.seira.bot
  TUNNEL_EDGE_HOST=region1.v2.argotunnel.com
  TUNNEL_WAIT_S="${SEIRA_INSTALL_TUNNEL_WAIT_S:-120}"
  CLOUD_HOST=cloud.seira.bot
  # The first release whose server image has the tunnel mode of its launcher and `seira login --events`.
  TUNNEL_MIN_VERSION=0.1.186

  MODE=install
  DOMAIN=""
  TUNNEL=no
  ACCOUNT_EMAIL=""
  EVENTS=no
  CHECK_ID=""
  CHECKING=no
  STEP=""
  ADDRESS=""
  EMAIL=""
  CODE=""
  INSTALL_DOCKER="${SEIRA_INSTALL_DOCKER:-}"
  SANDBOX=yes
  FAILED=0
  DOCKER_STATE=unknown
  DOCKER_PROBLEM=""
  DOCKER_REPORTED=no
  IMAGE=""
  PUBLIC_IP=""
  REGISTRY_TOKEN=""
  REGISTRY_STATUS=000
}

say() { printf '%s\n' "$*"; }

# One machine-readable line for an app that runs this installer, only with --events: ::seira <kind> <words>.
event() {
  if [ "$EVENTS" = yes ]; then
    printf '::seira %s\n' "$(printf '%s' "$*" | tr '\n' ' ')"
  fi
}

step() { # id: a step of the install begins
  STEP=$1
  event step "$1" start
}

step_done() {
  event step "$STEP" done
  STEP=""
}

fail() {
  if [ "$EVENTS" = yes ]; then
    if [ -n "$STEP" ]; then event step "$STEP" fail "$*"; fi
    event fail "$*"
  fi
  printf '\n%s\n' "$*" >&2
  exit 1
}

check_event() { # result sentence: a check's result, while the checks run
  if [ "$CHECKING" = yes ]; then event check "$CHECK_ID" "$1" "$2"; fi
}
ok() {
  printf '  ok    %s\n' "$*"
  check_event ok "$*"
}
note() {
  printf '  note  %s\n' "$*"
  check_event note "$*"
}
fix() {
  printf '  FIX   %s\n' "$*"
  check_event fix "$*"
  FAILED=$((FAILED + 1))
}

command_line() { # what to run again, as the person ran it
  printf 'curl -fsSL %s | sudo sh -s -- %s' "$SCRIPT_URL" "$*"
}

usage() {
  say "Usage: $(command_line '--domain seira.example.com')"
  say "       $(command_line '--tunnel --account-email you@example.com')   no domain and no open port: Seira's address for your account"
  say "       $(command_line '--check --domain seira.example.com')   only checks this server; changes nothing"
  say "       $(command_line '--uninstall')                        stops the server; keeps your data"
  say ""
  say "  --domain NAME      the name people will open, already pointing at this server"
  say "  --tunnel           serve at the address your Seira account gives this server, with no domain and no open port"
  say "  --account-email A  the email of your Seira account, which sends the code that signs this server in (with --tunnel)"
  say "  --events           print one machine-readable ::seira line per check, step and question, for an app that runs this installer; its output holds a one-time sign-in link, so do not send it to a log"
  say "  --email ADDRESS    the first admin's email, so they can sign in with an emailed code (needs a mail server: SEIRA_SIGNIN_SMTP_URL in .env)"
  say "  --install-docker   install Docker with Docker's official script when it is missing, without asking"
  say "  --dir PATH         where the install lives (default /opt/seira)"
  say "  --no-sandbox       do not prepare this server for the bots' sandbox (only for a server you alone sign in to)"
  say "  <code>             the one-time code Seira shows, to also connect this server to Seira (needs SEIRA_ADMIN_URL, the address of the service that gave the code)"
}

parse() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --check) MODE=check ;;
      --uninstall) MODE=uninstall ;;
      --install-docker) INSTALL_DOCKER=1 ;;
      --no-sandbox) SANDBOX=no ;;
      --tunnel) TUNNEL=yes ;;
      --events) EVENTS=yes ;;
      --domain | --email | --dir | --account-email)
        [ $# -ge 2 ] || fail "$1 needs a value. $(usage)"
        case "$1" in
          --domain) DOMAIN=$2 ;;
          --email) EMAIL=$2 ;;
          --account-email) ACCOUNT_EMAIL=$2 ;;
          --dir) INSTALL_DIR=$2 ;;
        esac
        shift
        ;;
      --domain=*) DOMAIN=${1#--domain=} ;;
      --email=*) EMAIL=${1#--email=} ;;
      --account-email=*) ACCOUNT_EMAIL=${1#--account-email=} ;;
      --dir=*) INSTALL_DIR=${1#--dir=} ;;
      -h | --help)
        usage
        exit 0
        ;;
      -*) fail "Unknown option $1. $(usage)" ;;
      *) CODE=$1 ;;
    esac
    shift
  done
  DOMAIN=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')
  case "$DOMAIN" in
    "") ;;
    *[!a-z0-9.-]* | .* | *. | -* | *..*) fail "$DOMAIN is not a domain name. Give the name alone, like seira.example.com, without https:// or a path." ;;
    *.*) ;;
    *) fail "$DOMAIN is not a full domain name. Give a name like seira.example.com." ;;
  esac
  if [ "$TUNNEL" = yes ] && [ -n "$DOMAIN" ]; then
    fail "--tunnel and --domain cannot be used together: use --tunnel for the address your Seira account gives, or --domain for a name of your own."
  fi
  for address in "$EMAIL" "$ACCOUNT_EMAIL"; do
    case "$address" in
      "") ;;
      *[!A-Za-z0-9@._+-]* | *@*@*) fail "That email address doesn't look right. Give one address, like you@example.com." ;;
      ?*@?*.?*) ;;
      *) fail "That email address doesn't look right. Give one address, like you@example.com." ;;
    esac
  done

  if [ -n "$ACCOUNT_EMAIL" ] && [ "$TUNNEL" != yes ]; then fail "--account-email works only with --tunnel."; fi
  if [ -n "$CODE" ] && [ "$TUNNEL" = yes ]; then fail "A connection code works only with --domain."; fi
  case "$CODE" in
    *[!A-Za-z0-9-]*) fail "That code doesn't look right. Copy the install command from Seira again." ;;
  esac
  if [ -n "$CODE" ] && [ -z "$ADMIN_URL" ]; then
    fail "A code needs SEIRA_ADMIN_URL, the address of the Seira service that gave it. To install Seira alone, run this again without the code."
  fi
  case "$INSTALL_DIR" in
    /?*) ;;
    *) fail "--dir needs a full path, like /opt/seira." ;;
  esac
  case "$INSTALL_DIR" in
    *[!A-Za-z0-9/._-]*) fail "--dir may hold only letters, digits, / . _ and -." ;;
  esac
}

is_root() { [ "$(id -u)" = 0 ]; }

need_root() {
  is_root || fail "Please run this as root: put sudo before sh, like this: $(command_line "$@")"
}

tty_available() {
  [ -t 1 ] || return 1
  (exec </dev/tty) 2>/dev/null
}

# From the install's folder, as a person and update.sh run it: Compose reads .env there, COMPOSE_FILE included.
compose() {
  (cd "$INSTALL_DIR" && docker compose "$@")
}

# Compose's own progress lines (Pulling, Creating, Started) go to a file, and reach the terminal only when it fails.
compose_quietly() {
  compose_log=$(mktemp)
  if compose "$@" >"$compose_log" 2>&1; then
    rm -f "$compose_log"
    return 0
  fi
  cat "$compose_log" >&2
  rm -f "$compose_log"
  return 1
}

env_value() { # name: its value in the install's .env, or nothing
  [ -r "$INSTALL_DIR/.env" ] || return 0
  sed -n "s/^$1=//p" "$INSTALL_DIR/.env" | tail -n 1
}

reachable() { # url: any HTTP answer counts
  curl -sS -o /dev/null --max-time 15 "$1" >/dev/null 2>&1
}

host_of() { printf '%s' "$1" | sed -e 's#^[a-z]*://##' -e 's#/.*##'; }

# The checks. Each one that fails prints one sentence saying what to fix, and none of them changes anything.

check_tools() {
  command -v curl >/dev/null 2>&1 || fix "curl isn't installed. Run: sudo apt-get install -y curl  and then run this again."
}

check_os() {
  release="$SYSROOT/etc/os-release"
  if [ ! -r "$release" ]; then
    fix "This server's operating system can't be identified. Seira's installer runs on Ubuntu 22.04 or 24.04: pick one of those."
    return
  fi
  field() { sed -n "s/^$1=//p" "$release" | head -n 1 | tr -d '"'; }
  os_id=$(field ID)
  os_version=$(field VERSION_ID)
  os_name=$(field PRETTY_NAME)
  [ -n "$os_name" ] || os_name="$os_id $os_version"
  case "$os_id $os_version" in
    "ubuntu 22.04" | "ubuntu 24.04") ok "operating system: $os_name" ;;
    *)
      if [ "${SEIRA_INSTALL_ALLOW_UNTESTED_OS:-}" = 1 ]; then
        note "This server runs $os_name, which the installer is not tested on; going on as asked."
      else
        fix "This server runs $os_name. Seira's installer runs on Ubuntu 22.04 or 24.04: pick one of those, or run again with SEIRA_INSTALL_ALLOW_UNTESTED_OS=1 to try anyway."
      fi
      ;;
  esac
}

check_arch() {
  arch=$(uname -m)
  if [ "$arch" = x86_64 ]; then
    ok "processor: x86-64"
  else
    fix "This server's processor is $arch. The installer supports Intel and AMD (x86-64) servers for now: pick an x86-64 server."
  fi
}

check_cpus() {
  cpus=$(nproc 2>/dev/null || echo 0)
  case "$cpus" in '' | *[!0-9]*) cpus=0 ;; esac
  if [ "$cpus" -ge "$MIN_CPUS" ]; then
    ok "processor cores: $cpus"
  else
    fix "This server has $cpus processor core. Seira needs at least $MIN_CPUS: pick a bigger server."
  fi
}

check_memory() {
  memory_mb=$(awk '/^MemTotal:/ { print int($2 / 1024) }' "$SYSROOT/proc/meminfo" 2>/dev/null || true)
  case "$memory_mb" in '' | *[!0-9]*) memory_mb=0 ;; esac
  memory_gb=$(awk -v m="$memory_mb" 'BEGIN { printf "%.1f", m / 1024 }')
  if [ "$memory_mb" -lt "$MIN_MEMORY_MB" ]; then
    fix "This server has $memory_gb GB of memory. Seira needs at least 4 GB: pick a bigger server."
    return
  fi
  ok "memory: $memory_gb GB"
  if [ "$memory_mb" -lt 7500 ]; then note "With $memory_gb GB of memory, bots will be slow when several work at once. We suggest at least 8 GB."; fi
}

existing_parent() {
  path=$1
  while [ ! -d "$path" ]; do path=$(dirname "$path"); done
  printf '%s' "$path"
}

free_gb() { df -Pk "$1" 2>/dev/null | awk 'NR == 2 { print int($4 / 1048576) }'; }

check_disk() {
  places=$(existing_parent "$INSTALL_DIR")
  if [ "$DOCKER_STATE" = ready ]; then
    docker_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
    if [ -n "$docker_root" ] && [ -d "$docker_root" ]; then places="$places $docker_root"; fi
  fi
  least=""
  for place in $places; do
    free=$(free_gb "$place")
    case "$free" in '' | *[!0-9]*) free=0 ;; esac
    if [ -z "$least" ] || [ "$free" -lt "$least" ]; then
      least=$free
      least_place=$place
    fi
  done
  if [ "$least" -ge "$MIN_DISK_GB" ]; then
    ok "free disk: $least GB"
  else
    fix "This server has only $least GB free at $least_place. Seira needs at least $MIN_DISK_GB GB: free some space or add a disk."
  fi
}

# DOCKER_STATE: ready, or missing (the one thing the installer offers to install), or broken (the person fixes it).
check_docker() {
  DOCKER_PROBLEM=""
  DOCKER_REPORTED=no
  if ! command -v docker >/dev/null 2>&1; then
    DOCKER_STATE=missing
    DOCKER_PROBLEM="Docker isn't installed."
    return
  fi
  DOCKER_STATE=broken
  server=$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)
  if [ -z "$server" ]; then
    if is_root; then
      fix "Docker is installed but not running. Start it with: sudo systemctl enable --now docker  and then run this again."
    else
      fix "Docker did not answer. Run this with sudo, or start Docker with: sudo systemctl enable --now docker"
    fi
    return
  fi
  major=${server%%.*}
  case "$major" in '' | *[!0-9]*) major=0 ;; esac
  if [ "$major" -lt "$MIN_DOCKER" ]; then
    fix "Docker $server is too old; Seira needs Docker $MIN_DOCKER or newer. Update it with: curl -fsSL https://get.docker.com | sudo sh  and then run this again."
    return
  fi
  security=$(docker info --format '{{json .SecurityOptions}}' 2>/dev/null || true)
  case "$security" in
    *rootless*)
      fix "Docker runs in rootless mode here. Seira needs the standard Docker service: run curl -fsSL https://get.docker.com | sudo sh  and then run this again."
      return
      ;;
  esac
  if ! docker compose version >/dev/null 2>&1; then
    fix "Docker is here without its Compose plugin. Run: sudo apt-get install -y docker-compose-plugin  and then run this again."
    return
  fi
  DOCKER_STATE=ready
  ok "Docker: $server, with Compose"
}

report_docker_missing() {
  if [ "$DOCKER_STATE" = missing ] && [ "$DOCKER_REPORTED" != yes ]; then
    DOCKER_REPORTED=yes
    if [ "$EVENTS" = yes ]; then
      fix "$DOCKER_PROBLEM It can be installed with Docker's official script."
      return
    fi
    fix "$DOCKER_PROBLEM Run this again with --install-docker to install it with Docker's official script, or install it yourself with: curl -fsSL https://get.docker.com | sudo sh"
  fi
}

# A missing Docker is its own check, so an app can offer to install it: a fix without --install-docker (when the run is a
# check or reports events), a note with it. A terminal install without the flag asks at the prompt instead.
report_docker_install() {
  [ "$DOCKER_STATE" = missing ] || return 0
  if [ "$INSTALL_DOCKER" = 1 ]; then
    DOCKER_REPORTED=yes
    note "$DOCKER_PROBLEM It will be installed with Docker's official script."
  elif [ "$MODE" = check ] || [ "$EVENTS" = yes ]; then
    report_docker_missing
  fi
}

listener_on() { # port: the listening line, or nothing
  ss -Hltnp "sport = :$1" 2>/dev/null | head -n 1
}

step_check() { # id check-function: the checks it runs report under that id
  CHECK_ID=$1
  shift
  "$@"
}

check_ports() {
  if ! command -v ss >/dev/null 2>&1; then
    note "Ports 80 and 443 could not be checked because the ss tool is missing; if something else uses them, the install will say so."
    return
  fi
  busy=""
  own=""
  for port in 80 443; do
    line=$(listener_on "$port")
    [ -n "$line" ] || continue
    if [ "$DOCKER_STATE" = ready ] && [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "publish=$port" 2>/dev/null)" ]; then
      own=yes
      continue
    fi
    owner=$(printf '%s' "$line" | sed -n 's/.*users:(("\([^"]*\)".*/\1/p')
    if [ "$owner" = docker-proxy ]; then
      fix "Port $port is already in use by another Docker container. Find it with: sudo docker ps  and stop it, then run this again."
    else
      fix "Port $port is already in use${owner:+ by $owner}. Stop what uses it${owner:+ (for example: sudo systemctl disable --now $owner)}, then run this again."
    fi
    busy=yes
  done
  if [ -n "$busy" ]; then return; fi
  if [ -n "$own" ]; then ok "ports 80 and 443: held by this install"; else ok "ports 80 and 443: free"; fi
}

public_address() {
  curl -4 -fsS --max-time 10 https://cloudflare.com/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p' | head -n 1
}

local_addresses() {
  ip -o -4 addr show scope global 2>/dev/null | awk '{ print $4 }' | cut -d/ -f1
}

check_dns() {
  if [ -z "$DOMAIN" ]; then
    note "No --domain was given, so its DNS record was not checked."
    return
  fi
  if [ "${SEIRA_INSTALL_SKIP_DNS:-}" = 1 ]; then
    note "The DNS record of $DOMAIN was not checked, as asked."
    return
  fi
  PUBLIC_IP=$(public_address || true)
  resolved=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{ print $1 }' | sort -u | tr '\n' ' ' || true)
  resolved=${resolved% }
  target=${PUBLIC_IP:-this server\'s public address}
  if [ -z "$resolved" ]; then
    fix "$DOMAIN does not resolve yet. Add an A record for it pointing at $target at your DNS provider, wait a few minutes, then run this again."
    return
  fi
  for address in $resolved; do
    for mine in $PUBLIC_IP $(local_addresses); do
      if [ "$address" = "$mine" ]; then
        ok "DNS: $DOMAIN points at this server ($address)"
        return
      fi
    done
  done
  fix "$DOMAIN points at $resolved, not at this server ($target). Change its A record to $target (on Cloudflare, set the record to DNS only), then run this again; or set SEIRA_INSTALL_SKIP_DNS=1 if a load balancer forwards ports 80 and 443 here."
}

check_outbound() {
  targets="https://ghcr.io/v2/ https://pkg-containers.githubusercontent.com/ https://registry-1.docker.io/v2/ https://auth.docker.io/ https://production.cloudflare.docker.com/"
  if [ "$TUNNEL" != yes ]; then targets="$targets https://acme-v02.api.letsencrypt.org/directory"; fi
  if [ "$DOCKER_STATE" = missing ]; then targets="$targets https://get.docker.com/ https://download.docker.com/"; fi
  if [ -n "$CODE" ]; then targets="$targets $ADMIN_URL/"; fi
  case "${SOURCE_ASKED:-$REPOSITORY_FILES}" in https://*) targets="$targets https://$(host_of "${SOURCE_ASKED:-$REPOSITORY_FILES}")/" ;; esac
  blocked=""
  for url in $targets; do
    reachable "$url" || blocked="$blocked $(host_of "$url")"
  done
  if [ -n "$blocked" ]; then
    if [ -n "${https_proxy:-}${HTTPS_PROXY:-}" ]; then
      fix "This server reaches the internet only through a web proxy, which the installer can't use. It needs direct outbound HTTPS (port 443) to:$blocked"
    else
      fix "This server can't reach$blocked over HTTPS (port 443). Allow outbound HTTPS to them in your firewall, then run this again."
    fi
    return
  fi
  if [ "$TUNNEL" = yes ]; then
    check_edge
  else
    ok "outbound: the image registries and Let's Encrypt are reachable"
  fi
}

# cloudflared dials the edge on port 7844, which answers no HTTP, so only the TCP connect is checked.
check_edge() {
  connect=$(curl -s -o /dev/null -w '%{time_connect}' --connect-timeout 5 --max-time 6 "telnet://$TUNNEL_EDGE_HOST:7844" </dev/null 2>/dev/null || true)
  case "$connect" in
    *[1-9]*) ;;
    *)
      fix "This server can't open a connection to Cloudflare's tunnel edge ($TUNNEL_EDGE_HOST) on port 7844. Allow outbound port 7844 (TCP and UDP) to it in your firewall, then run this again."
      return
      ;;
  esac
  ok "outbound: the image registries and the tunnel edge are reachable"
}

# The sign-in asks the Seira cloud for its code, and the account service gives the address.
check_account() {
  url=${SEIRA_CONTROL_PLANE_URL:-$(env_value SEIRA_CONTROL_PLANE_URL)}
  case "$url" in https://*) ACCOUNT_HOST=$(host_of "$url") ;; esac
  url=${SEIRA_CLOUD_ORIGIN:-$(env_value SEIRA_CLOUD_ORIGIN)}
  case "$url" in https://*) CLOUD_HOST=$(host_of "$url") ;; esac
  blocked=""
  for host in $ACCOUNT_HOST $CLOUD_HOST; do
    reachable "https://$host/" || blocked="$blocked $host"
  done
  if [ -z "$blocked" ]; then
    ok "account: the Seira account service ($ACCOUNT_HOST) and the sign-in service ($CLOUD_HOST) are reachable"
  else
    fix "This server can't reach$blocked over HTTPS (port 443), which signing in to your Seira account needs. Allow outbound HTTPS to them in your firewall, then run this again."
  fi
}

check_userns() {
  max=$(cat "$SYSROOT/proc/sys/user/max_user_namespaces" 2>/dev/null || echo 1)
  clone=$(cat "$SYSROOT/proc/sys/kernel/unprivileged_userns_clone" 2>/dev/null || echo 1)
  if [ "$max" = 0 ] || [ "$clone" != 1 ]; then
    fix "This server switches off user namespaces, which the bots' sandbox needs. Run: printf 'user.max_user_namespaces=63000\\nkernel.unprivileged_userns_clone=1\\n' | sudo tee /etc/sysctl.d/90-seira.conf && sudo sysctl --system  and then run this again."
  else
    ok "user namespaces: on"
  fi
}

# The bots' sandbox needs two profiles on the host, which the install puts there. This only looks.
check_sandbox() {
  if [ "$SANDBOX" != yes ]; then
    note "This server will not be prepared for the bots' sandbox, as asked. Do this only on a server you alone sign in to."
    return
  fi
  enabled=$(cat "$SYSROOT/sys/module/apparmor/parameters/enabled" 2>/dev/null || true)
  if [ "$enabled" != Y ] || ! command -v apparmor_parser >/dev/null 2>&1; then
    fix "This server is missing AppArmor or its tools, which the bots' sandbox needs. Run: sudo apt-get install -y apparmor  then restart the server and run this again; or add --no-sandbox to install without the sandbox, on a server you alone sign in to."
    return
  fi
  ok "bots' sandbox: AppArmor is on, so this server can be prepared for it"
}

check_clock() {
  now=$(date -u +%s)
  theirs=""
  header=$(curl -sSI --max-time 15 https://ghcr.io/v2/ 2>/dev/null | tr -d '\r' | sed -n 's/^[Dd]ate: //p' | head -n 1 || true)
  if [ -n "$header" ]; then theirs=$(date -u -d "$header" +%s 2>/dev/null || true); fi
  case "$theirs" in '' | *[!0-9]*) theirs="" ;; esac
  if [ -z "$theirs" ]; then
    if [ "$(date -u +%Y)" -lt 2025 ]; then
      fix "This server's clock says $(date -u +%Y), so HTTPS certificates will be refused. Run: sudo timedatectl set-ntp true  and then run this again."
    else
      note "The clock could not be compared with the internet's; it says $(date -u '+%Y-%m-%d %H:%M') UTC."
    fi
    return
  fi
  skew=$((now - theirs))
  [ "$skew" -ge 0 ] || skew=$((-skew))
  if [ "$skew" -gt "$MAX_CLOCK_SKEW_S" ]; then
    fix "This server's clock is $((skew / 60)) minutes off, so HTTPS certificates will be refused. Run: sudo timedatectl set-ntp true  and then run this again."
    return
  fi
  ok "clock: right"
  if command -v timedatectl >/dev/null 2>&1 && [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo yes)" != yes ]; then
    note "This server's clock is not kept in time. Run: sudo timedatectl set-ntp true"
  fi
}

registry_token() {
  curl -fsS --max-time 15 "https://ghcr.io/token?scope=repository:$IMAGE_REPO:pull" 2>/dev/null | sed -n 's/.*"token":"\([^"]*\)".*/\1/p' | head -n 1
}

# REGISTRY_STATUS: the registry's HTTP answer for a tag (200 it has it, 404 it does not), or 000 when it gave none.
registry_ask() { # tag
  REGISTRY_STATUS=000
  for _ in 1 2 3; do
    if [ -z "$REGISTRY_TOKEN" ]; then REGISTRY_TOKEN=$(registry_token || true); fi
    if [ -n "$REGISTRY_TOKEN" ]; then
      # The pull token goes to curl on its standard input, never on a command line.
      REGISTRY_STATUS=$(printf 'header = "Authorization: Bearer %s"\n' "$REGISTRY_TOKEN" | curl -K - -s -o /dev/null -w '%{http_code}' --max-time 15 -I \
        -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" \
        "https://ghcr.io/v2/$IMAGE_REPO/manifests/$1" 2>/dev/null || true)
      case "$REGISTRY_STATUS" in
        200 | 404) return 0 ;;
        401 | 403) REGISTRY_TOKEN="" ;;
      esac
    fi
    sleep 2
  done
}

registry_get() { # path-under-the-repository media-types: the registry's answer, the pull token on curl's standard input
  printf 'header = "Authorization: Bearer %s"\n' "$REGISTRY_TOKEN" | curl -K - -fsSL --max-time 20 -H "Accept: $2" "https://ghcr.io/v2/$IMAGE_REPO/$1" 2>/dev/null
}

# The configuration of the image a tag or digest names, read from the registry without downloading it, or nothing when
# the registry did not say.
registry_config() { # tag or sha256:digest
  [ -n "$REGISTRY_TOKEN" ] || REGISTRY_TOKEN=$(registry_token || true)
  [ -n "$REGISTRY_TOKEN" ] || return 0
  case "$(uname -m)" in aarch64 | arm64) platform=arm64 ;; *) platform=amd64 ;; esac
  answer=$(registry_get "manifests/$1" "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" | tr -d ' \n\r\t') || return 0
  case "$answer" in
    *'"manifests":['*)
      # An index: one manifest per platform. Each entry ends with its platform, so the entries split at "},{".
      digest=$(printf '%s' "$answer" | sed 's/},{/}\
{/g' | grep "\"architecture\":\"$platform\"" | grep '"os":"linux"' | sed -n 's/.*"digest":"\(sha256:[0-9a-f]\{64\}\)".*/\1/p' | head -n 1)
      [ -n "$digest" ] || return 0
      answer=$(registry_get "manifests/$digest" "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" | tr -d ' \n\r\t') || return 0
      ;;
  esac
  config=$(printf '%s' "$answer" | sed -n 's/.*"config":{[^}]*"digest":"\(sha256:[0-9a-f]\{64\}\)".*/\1/p')
  [ -n "$config" ] || return 0
  registry_get "blobs/$config" "application/vnd.oci.image.config.v1+json, application/vnd.docker.container.image.v1+json"
}

# Whether the image a tag or digest names runs the bots' sandbox (SEIRA_IMAGE=server in its settings): yes, no, or
# nothing when the registry did not say.
registry_sandbox() { # tag or sha256:digest
  case "$(registry_config "$1")" in
    '') ;;
    *'"SEIRA_IMAGE=server"'*) echo yes ;;
    *) echo no ;;
  esac
}

# The version an image names in its label, like 0.1.185, or nothing.
registry_version() { # tag or sha256:digest
  registry_config "$1" | tr -d '\n' | sed -n 's/.*"org.opencontainers.image.version": *"v\{0,1\}\([0-9][0-9.]*\)".*/\1/p'
}

# Whether version $1 is older than $2: numeric per dot part, a missing part counts as 0.
version_older() {
  older_a=$1
  older_b=$2
  while [ -n "$older_a" ] || [ -n "$older_b" ]; do
    part_a=${older_a%%.*}
    part_b=${older_b%%.*}
    case "$older_a" in *.*) older_a=${older_a#*.} ;; *) older_a="" ;; esac
    case "$older_b" in *.*) older_b=${older_b#*.} ;; *) older_b="" ;; esac
    part_a=${part_a:-0}
    part_b=${part_b:-0}
    if [ "$part_a" -lt "$part_b" ]; then return 0; fi
    if [ "$part_a" -gt "$part_b" ]; then return 1; fi
  done
  return 1
}

# Without a domain needs the launcher's tunnel mode; an older release lacks it. Fails the check when $1 is older.
tunnel_version_fix() { # version, like 0.1.185 or empty when unknown
  [ "$TUNNEL" = yes ] || return 1
  case "$1" in
    '')
      fix "Installing without a domain needs Seira $TUNNEL_MIN_VERSION or newer, and the version of the newest image could not be read. Try again after the next release."
      return 0
      ;;
    *[!0-9.]* | .* | *. | *..*) return 1 ;;
  esac
  if version_older "$1" "$TUNNEL_MIN_VERSION"; then
    fix "Installing without a domain needs Seira $TUNNEL_MIN_VERSION or newer, and the newest release is v$1. Try again after the next release."
    return 0
  fi
  return 1
}

# Says, before anything is downloaded, when the version chosen would run without the bots' sandbox.
note_sandbox() { # tag or sha256:digest
  [ "$SANDBOX" = yes ] || return 0
  if [ "$(registry_sandbox "$1" || true)" = no ]; then
    note "This version has no bots' sandbox, so bots would run beside the server, able to read its settings, keys and each other's files. That is only for a server you alone sign in to; run this again once a version with the sandbox is out."
  fi
}

newest_release() {
  curl -fsS --max-time 15 "$RELEASES_URL" 2>/dev/null | sed -n 's/.*"tag_name": *"\(v[0-9][0-9.]*\)".*/\1/p' | head -n 1
}

# The stable channel when it is published, else the newest release. Never `latest`, which follows every commit.
check_version() {
  chosen="${SEIRA_INSTALL_IMAGE:-}"
  if [ -n "$chosen" ]; then
    case "$chosen" in
      *[!A-Za-z0-9/:._@-]*)
        fix "SEIRA_INSTALL_IMAGE is not an image name."
        return
        ;;
    esac
    case "${chosen##*/}" in
      *:latest) fix "SEIRA_INSTALL_IMAGE names the latest tag, which follows every commit. Name a release, like ghcr.io/$IMAGE_REPO:v0.1.151." ;;
      *:?*)
        tag=${chosen##*:}
        if tunnel_version_fix "${tag#v}"; then return; fi
        IMAGE=$chosen
        ok "version: $IMAGE, as asked"
        ;;
      *) fix "SEIRA_INSTALL_IMAGE needs a release tag, like ghcr.io/$IMAGE_REPO:v0.1.151." ;;
    esac
    return
  fi
  pinned=$(env_value SEIRA_IMAGE)
  case "$pinned" in
    *@sha256:*)
      IMAGE=$pinned
      ok "version: the one update.sh pinned here; it stays until update.sh changes it"
      return
      ;;
  esac
  registry_ask stable
  if [ "$REGISTRY_STATUS" = 200 ]; then
    if [ "$TUNNEL" = yes ] && tunnel_version_fix "$(registry_version stable)"; then return; fi
    IMAGE="ghcr.io/$IMAGE_REPO:stable"
    ok "version: the stable channel"
    note_sandbox stable
    return
  fi
  if [ "$REGISTRY_STATUS" != 404 ]; then
    fix "The image registry ghcr.io did not say which versions exist (it answered $REGISTRY_STATUS). Check this server's outbound HTTPS, then run this again."
    return
  fi
  release=$(newest_release || true)
  if [ -z "$release" ]; then
    fix "The newest Seira release could not be read from api.github.com. Check this server's outbound HTTPS, then run this again in a few minutes."
    return
  fi
  registry_ask "$release"
  if [ "$REGISTRY_STATUS" = 404 ]; then
    fix "Seira $release has no server image yet. Run this again in a few minutes."
    return
  fi
  if [ "$REGISTRY_STATUS" != 200 ]; then
    fix "The image registry ghcr.io did not say whether it has Seira $release (it answered $REGISTRY_STATUS). Run this again in a few minutes."
    return
  fi
  if tunnel_version_fix "${release#v}"; then return; fi
  IMAGE="ghcr.io/$IMAGE_REPO:$release"
  ok "version: $release, the newest release"
  note_sandbox "$release"
}

end_checks() {
  CHECKING=no
  if [ "$FAILED" = 0 ]; then event checks ok; else event checks fix; fi
}

preflight() {
  say "Checking this server..."
  CHECKING=yes
  step_check outbound check_tools
  step_check os check_os
  step_check arch check_arch
  step_check cpu check_cpus
  step_check memory check_memory
  step_check docker check_docker
  step_check docker-install report_docker_install
  step_check disk check_disk
  if [ "$TUNNEL" != yes ]; then step_check ports check_ports; fi
  step_check userns check_userns
  step_check apparmor check_sandbox
  if ! command -v curl >/dev/null 2>&1; then
    CHECK_ID=outbound
    note "The domain, outbound reach, the clock and the version were not checked, because they need curl."
    end_checks
    return
  fi
  if [ "$TUNNEL" = yes ]; then step_check account check_account; else step_check dns check_dns; fi
  step_check outbound check_outbound
  step_check clock check_clock
  step_check version check_version
  end_checks
}

install_docker() {
  say "Installing Docker with Docker's official script (get.docker.com)..."
  tmp_docker=$(mktemp)
  curl -fsSL https://get.docker.com -o "$tmp_docker" || fail "Docker's install script could not be downloaded. Check that this server can reach https://get.docker.com, then run this again."
  sh "$tmp_docker" || fail "Docker's install script failed (its output is above). Fix that, then run this again."
  rm -f "$tmp_docker"
  if command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker >/dev/null 2>&1 || true; fi
}

# Docker is the one thing the installer installs for you, and only when you say so: the flag, or yes at the prompt.
offer_docker() {
  if [ "$INSTALL_DOCKER" != 1 ]; then
    answer=n
    if tty_available; then
      printf "%s Install the current Docker now with Docker's official script (get.docker.com)? [Y/n] " "$DOCKER_PROBLEM" >/dev/tty
      read -r answer </dev/tty || answer=n
    fi
    case "$answer" in
      "" | y | Y | yes | Yes) ;;
      *) fail "$DOCKER_PROBLEM Install it with: curl -fsSL https://get.docker.com | sudo sh  and then run this again, or run this again with --install-docker." ;;
    esac
  fi
  install_docker
  FAILED=0
  check_docker
  report_docker_missing
  [ "$FAILED" = 0 ] || fail "Docker still isn't usable after its install. Fix the line above, then run this again."
}

write_file() { # path, with the content on standard input: replaced in one step
  tmp_file=$(mktemp "$1.XXXXXX")
  cat >"$tmp_file"
  chmod "${2:-644}" "$tmp_file"
  mv "$tmp_file" "$1"
}

write_compose() {
  if [ "$TUNNEL" = yes ]; then
    write_tunnel_compose
    return
  fi
  write_file "$INSTALL_DIR/compose.yaml" <<'COMPOSE'
# Written by Seira's installer (deploy/install.sh), and written again each time it runs: put your own settings in
# .env beside this file, which the installer keeps. The server only listens on loopback inside its container, and on
# two Unix sockets in the `edge` volume, which Caddy, in its own container, reaches it through. A request on a socket is
# always a remote one to the server. Caddy does not share the server's network: a server that restarted on its own came
# back in a new one, and left Caddy refusing HTTPS in the old one.
name: seira
services:
  seira:
    image: ${SEIRA_IMAGE:?run the installer again}
    restart: unless-stopped
    init: true
    shm_size: 512m
    volumes:
      - ./data:/data
      - edge:/run/seira
      # The Update server button (update-runner.sh, root's folder): the server leaves a request in the first, reads the
      # outcome in the second.
      - /var/lib/seira-update/request:/run/seira-update/request
      - /var/lib/seira-update/status:/run/seira-update/status:ro
    environment:
      SEIRA_PORT: "8799"
      SEIRA_WEBHOOK_PORT: "8800"
      SEIRA_TUNNEL_SOCKET: /run/seira/http.sock
      SEIRA_WEBHOOK_SOCKET: /run/seira/hooks.sock
      SEIRA_WEBHOOK_PUBLIC_URL: https://${DOMAIN}
      SEIRA_PUBLIC_URL: https://${DOMAIN}
      SEIRA_SERVER_NAME: ${SEIRA_SERVER_NAME:-${DOMAIN}}
      # Passed only when .env sets them: an empty one would still be set, and Settings' own lists are used when not.
      SEIRA_SIGNIN_EMAILS:
      SEIRA_SIGNIN_MEMBER_EMAILS:
      SEIRA_SIGNIN_SMTP_URL:
      SEIRA_SIGNIN_SMTP_FROM:
      # "1": phones pair by QR through Seira Relay. Needs an account service (SEIRA_CONTROL_PLANE_URL), then sign in once:
      # docker compose exec seira seira login --relay
      SEIRA_CONTROL_PLANE_URL:
      SEIRA_PHONE_RELAY:
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://127.0.0.1:8799/api/health | grep -q -e seira -e openmausbot"]
      interval: 30s
      timeout: 5s
      retries: 3

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    # Started with the server, not after it is healthy: Caddy reaches it over the socket
    # whenever it answers, so `up` never waits on the server's health.
    depends_on:
      seira:
        condition: service_started
    environment:
      DOMAIN: ${DOMAIN}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - edge:/run/seira
      - ./caddy/data:/data
      - ./caddy/config:/config

volumes:
  # The two sockets: in memory, made afresh by the server at each start. Not under /data, which every bot's sandbox
  # sees; the sandbox has its own /run.
  edge:
    driver_opts:
      type: tmpfs
      device: tmpfs
      o: mode=1777,size=1m
COMPOSE
}

# The tunnel install: the server alone. It publishes no port and shares no network with the host, and the tunnel
# connector inside the container is the only way in.
write_tunnel_compose() {
  write_file "$INSTALL_DIR/compose.yaml" <<'TUNNELCOMPOSE'
# Written by Seira's installer (deploy/install.sh), and written again each time it runs: put your own settings in
# .env beside this file, which the installer keeps. The server publishes no port: people reach it at the address
# your Seira account gives it, through the tunnel connector that runs in this container.
name: seira
services:
  seira:
    image: ${SEIRA_IMAGE:?run the installer again}
    restart: unless-stopped
    hostname: ${SEIRA_HOSTNAME:-seira}
    init: true
    shm_size: 512m
    volumes:
      - ./data:/data
      # The Update server button (update-runner.sh, root's folder): the server leaves a request in the first, reads the
      # outcome in the second.
      - /var/lib/seira-update/request:/run/seira-update/request
      - /var/lib/seira-update/status:/run/seira-update/status:ro
    environment:
      SEIRA_PORT: "8799"
      SEIRA_WEBHOOK_PORT: "8800"
      SEIRA_ACCESS: ${SEIRA_ACCESS:?run the installer again}
      SEIRA_SERVER_NAME: ${SEIRA_SERVER_NAME:-seira}
      # Passed only when .env sets them: an empty one would still be set, and Settings' own lists are used when not.
      SEIRA_SIGNIN_EMAILS:
      SEIRA_SIGNIN_MEMBER_EMAILS:
      SEIRA_SIGNIN_SMTP_URL:
      SEIRA_SIGNIN_SMTP_FROM:
      SEIRA_CONTROL_PLANE_URL:
      SEIRA_TUNNEL_HOST_SUFFIX:
      SEIRA_CLOUD_ORIGIN:
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://127.0.0.1:8799/api/health | grep -q -e seira -e openmausbot"]
      interval: 30s
      timeout: 5s
      retries: 3
TUNNELCOMPOSE
}

write_caddyfile() {
  write_file "$INSTALL_DIR/Caddyfile" <<'CADDY'
{$DOMAIN} {
	encode zstd gzip

	# Webhook ingress is designed to be reachable by third parties (it has its
	# own per-hook secrets), so it sits outside any login. The path is passed
	# through unchanged: the receiver routes on /hooks/<id>.
	handle /hooks/* {
		reverse_proxy unix//run/seira/hooks.sock
	}

	handle {
		# Optional second wall in front of pairing (a shared password):
		#   basic_auth {
		#     {$BASIC_AUTH_USER} {$BASIC_AUTH_HASH}
		#   }
		# and set both variables in .env (hash with `caddy hash-password`,
		# every `$` doubled for Compose).
		reverse_proxy unix//run/seira/http.sock {
			# SSE: stream events as they arrive
			flush_interval -1
			# Compression is `encode`'s job above; the server would gzip its
			# JSON on its socket otherwise, as for the phone tunnel.
			header_up -Accept-Encoding
		}
	}
}
CADDY
}

set_env() { # name value: that one line of .env, leaving every other line as the person wrote it
  env_file="$INSTALL_DIR/.env"
  if [ -f "$env_file" ] && [ "$(grep -c "^$1=" "$env_file" || true)" = 1 ] && [ "$(env_value "$1")" = "$2" ]; then return 0; fi
  {
    if [ -f "$env_file" ]; then grep -v "^$1=" "$env_file" || true; fi
    printf '%s=%s\n' "$1" "$2"
  } | write_file "$env_file" 600
}

unset_env() { # name
  env_file="$INSTALL_DIR/.env"
  if grep -q "^$1=" "$env_file" 2>/dev/null; then
    { grep -v "^$1=" "$env_file" || true; } | write_file "$env_file" 600
  fi
}

write_settings() {
  if [ ! -f "$INSTALL_DIR/.env" ]; then
    write_file "$INSTALL_DIR/.env" 600 <<'ENV'
# Seira's settings on this server. The installer sets DOMAIN (or SEIRA_ACCESS=tunnel), SEIRA_IMAGE and COMPOSE_FILE and keeps every other line.
# Who may sign in with an emailed code: SEIRA_SIGNIN_EMAILS (admins) and SEIRA_SIGNIN_MEMBER_EMAILS, comma-separated.
ENV
  fi
  if [ "$TUNNEL" = yes ]; then
    set_env SEIRA_ACCESS tunnel
    if [ -n "${SEIRA_CONTROL_PLANE_URL:-}" ]; then set_env SEIRA_CONTROL_PLANE_URL "$SEIRA_CONTROL_PLANE_URL"; fi
    if [ -n "${SEIRA_TUNNEL_HOST_SUFFIX:-}" ]; then set_env SEIRA_TUNNEL_HOST_SUFFIX "$SEIRA_TUNNEL_HOST_SUFFIX"; fi
    if [ -n "${SEIRA_CLOUD_ORIGIN:-}" ]; then set_env SEIRA_CLOUD_ORIGIN "$SEIRA_CLOUD_ORIGIN"; fi
    if [ -z "$(env_value SEIRA_HOSTNAME)" ]; then
      host_name=$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9.-' || true)
      if [ -n "$host_name" ]; then set_env SEIRA_HOSTNAME "$host_name"; fi
    fi
  else
    unset_env SEIRA_ACCESS
    set_env DOMAIN "$DOMAIN"
  fi
  set_env SEIRA_IMAGE "$IMAGE"
  if [ -n "$EMAIL" ]; then
    current=$(env_value SEIRA_SIGNIN_EMAILS)
    case ",$(printf '%s' "$current" | tr -d ' ')," in
      *",$EMAIL,"*) ;;
      *) set_env SEIRA_SIGNIN_EMAILS "${current:+$current,}$EMAIL" ;;
    esac
  fi
}

fetch() { # path-in-the-repository destination [mode]: 1 when SOURCE does not have it
  tmp_fetch=$(mktemp "$2.XXXXXX")
  if curl -fsSL --max-time 60 "$SOURCE/$1" -o "$tmp_fetch" 2>/dev/null && [ -s "$tmp_fetch" ]; then
    chmod "${3:-644}" "$tmp_fetch"
    mv "$tmp_fetch" "$2"
    return 0
  fi
  rm -f "$tmp_fetch"
  return 1
}

# The version the downloaded image says it is, as the repository tags it (v1.2.3), or nothing.
image_version() {
  docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$IMAGE" 2>/dev/null |
    sed -n 's/^v\{0,1\}\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$/v\1/p' | head -n 1
}

# Tries each place the repository's files may come from, in order: the copy that was asked
# for and nothing else; or the tag of the installed version, then main. Leaves SOURCE_NAME saying which one had them.
from_repository() { # what-to-fetch
  if [ -n "$SOURCE_ASKED" ]; then
    SOURCE=$SOURCE_ASKED
    SOURCE_NAME=$SOURCE_ASKED
    "$1"
    return
  fi
  version=$(image_version || true)
  if [ -n "$version" ]; then
    SOURCE="$REPOSITORY_FILES/$version"
    SOURCE_NAME="Seira $version's own"
    if "$1"; then return 0; fi
  fi
  SOURCE="$REPOSITORY_FILES/main"
  SOURCE_NAME="the newest in the repository${version:+ ($version has none)}"
  "$1"
}

fetch_update() {
  fetch deploy/update.sh "$INSTALL_DIR/update.sh" 755
}

# update.sh (deploy/update.sh) updates with a backup and a way back; it is this repository's file, placed as it is.
place_update() {
  if from_repository fetch_update; then note "update.sh is $SOURCE_NAME."; fi
}

fetch_runner() {
  fetch deploy/update-runner.sh "$INSTALL_DIR/update-runner.sh" 755
}

data_owner() { # the data folder's user and group, as numbers: the server's container runs as them
  stat -c '%u:%g' "$INSTALL_DIR/data" 2>/dev/null || stat -f '%u:%g' "$INSTALL_DIR/data" 2>/dev/null
}

# The Update server button: update-runner.sh (deploy/update-runner.sh) has systemd run update.sh when the server asks,
# and nothing else. Without it, or without systemd, the app shows the command to run here instead.
BUTTON_PLACED=no
place_button() {
  [ -f "$INSTALL_DIR/update.sh" ] || return 0
  if ! from_repository fetch_runner; then
    note "The app cannot update this server: update-runner.sh could not be downloaded. Update it with: sudo $INSTALL_DIR/update.sh"
    return 0
  fi
  button_log=$(mktemp)
  if sh "$INSTALL_DIR/update-runner.sh" --install --dir "$INSTALL_DIR" --user "$(data_owner)" --no-restart >"$button_log" 2>&1; then
    BUTTON_PLACED=yes
    note "The app can update this server: Settings, Updates, Update server."
  else
    reason=$(tail -n 1 "$button_log")
    note "The app cannot update this server${reason:+ ($reason)}. Update it with: sudo $INSTALL_DIR/update.sh"
  fi
  rm -f "$button_log"
}

# The sandbox's host preparation and Compose settings are this repository's own (deploy/box, connector/profiles),
# fetched and used as they are, all four from the same place.
fetch_sandbox() {
  make_folders "$INSTALL_DIR/box" "$INSTALL_DIR/box/profiles"
  fetch deploy/box/prepare-host.sh "$INSTALL_DIR/box/prepare-host.sh" 755 &&
    fetch deploy/box/compose.box.yaml "$INSTALL_DIR/compose.box.yaml" &&
    fetch "connector/profiles/$SECCOMP" "$INSTALL_DIR/box/profiles/$SECCOMP" &&
    fetch "connector/profiles/$APPARMOR_PROFILE.apparmor" "$INSTALL_DIR/box/profiles/$APPARMOR_PROFILE.apparmor"
}

# An image that runs the hardened profile says so in its settings (SEIRA_IMAGE=server).
image_has_sandbox() {
  case "$(docker image inspect -f '{{json .Config.Env}}' "$IMAGE" 2>/dev/null || true)" in
    *'"SEIRA_IMAGE=server"'*) return 0 ;;
  esac
  return 1
}

# Sets SANDBOX to on when the server will start with the sandbox's settings, and says why when it will not.
prepare_sandbox() {
  if [ "$SANDBOX" != yes ]; then
    unset_env COMPOSE_FILE
    return
  fi
  if ! image_has_sandbox; then
    unset_env COMPOSE_FILE
    SANDBOX=absent
    note "This Seira version has no bots' sandbox yet. Run this command again after updating to a version that has it."
    return
  fi
  if ! from_repository fetch_sandbox; then
    fail "The files that prepare this server for the bots' sandbox could not be downloaded from ${SOURCE_ASKED:-$REPOSITORY_FILES}. Check this server's outbound HTTPS and run this again; or add --no-sandbox to install without the sandbox, on a server you alone sign in to."
  fi
  say "Preparing this server for the bots' sandbox..."
  note "The sandbox's files are $SOURCE_NAME."
  SEIRA_PROFILES_DIR="$INSTALL_DIR/box/profiles" sh "$INSTALL_DIR/box/prepare-host.sh" >/dev/null ||
    fail "This server could not be prepared for the bots' sandbox (the reason is above). Fix that and run this again; or add --no-sandbox to install without the sandbox, on a server you alone sign in to."
  set_env COMPOSE_FILE compose.yaml:compose.box.yaml
  SANDBOX=on
}

sandbox_field() { # result name: that field of one result of the self-check
  printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"
}

# The server's own self-check of the sandbox, as a bot meets it. A failed check stops the install unless it is one of
# SANDBOX_WARN_ONLY (or says "severity":"warn" itself); a self-check that gives no answer stops it too.
check_sandbox_runs() {
  [ "$SANDBOX" = on ] || return 0
  say "Checking that the bots' sandbox holds..."
  see="See it with: cd $INSTALL_DIR && sudo docker compose exec seira node dist-server/bot-box/box-check.js --public=none  and send us what it prints."
  report=$(compose exec -T seira node dist-server/bot-box/box-check.js --public=none 2>/dev/null | tr -d '\n' || true)
  case "$report" in
    *'"box":"bwrap"'*'"results":[{'*) ;;
    *) fail "Seira is running, but its bots' sandbox gave no answer to its self-check, so bots may not be separated from the server. $see" ;;
  esac
  case "$report" in
    *'"id":"config-hidden","ok":true'*) ;;
    *) fail "Seira is running, but its sandbox self-check did not show that a bot cannot read the server's settings (config-hidden), so bots are not safely separated from the server. $see" ;;
  esac
  stopping=""
  set -f
  old_ifs=$IFS
  IFS='
'
  for result in $(printf '%s' "$report" | sed 's/},{/}\
{/g' | grep '"ok":false' || true); do
    IFS=$old_ifs
    id=$(sandbox_field "$result" id)
    detail=$(sandbox_field "$result" detail)
    severity=$(sandbox_field "$result" severity)
    if [ -z "$severity" ]; then
      severity=must
      case " $SANDBOX_WARN_ONLY " in *" $id "*) [ -z "$id" ] || severity=warn ;; esac
    fi
    if [ "$severity" = warn ]; then
      note "The sandbox's self-check did not pass $id${detail:+ ($detail)}. Bots are still kept from the server's settings and from each other; tell us about it."
    else
      stopping="$stopping ${id:-an unnamed check}${detail:+ ($detail)},"
    fi
  done
  IFS=$old_ifs
  set +f
  if [ -z "$stopping" ]; then
    case "$report" in
      *'"failed":[]'*) ;;
      *) case "$report" in *'"ok":false'*) ;; *) stopping=" checks it did not name," ;; esac ;;
    esac
  fi
  [ -z "$stopping" ] || fail "Seira is running, but its bots' sandbox failed its self-check:${stopping%,}. Bots are not safely separated from the server. $see"
  say "The bots' sandbox is on: a bot cannot read the server's settings, keys or other bots' files."
}

# A new data folder is handed to the user the image runs as. A folder that already exists is never touched.
prepare_data() {
  if [ -d "$INSTALL_DIR/data" ]; then return; fi
  owner=$(docker run --rm --network none --entrypoint id "$IMAGE" -u 2>/dev/null || true)
  group=$(docker run --rm --network none --entrypoint id "$IMAGE" -g 2>/dev/null || true)
  case "$owner:$group" in
    *[!0-9:]* | : | :* | *:) fail "The Seira image did not say which user it runs as. Run this again; if it still fails, send us this line." ;;
  esac
  mkdir -m 700 "$INSTALL_DIR/data"
  chown "$owner:$group" "$INSTALL_DIR/data"
}

wait_healthy() {
  waited=0
  while [ "$waited" -lt "$HEALTH_WAIT_S" ]; do
    container=$(compose ps -q seira 2>/dev/null | head -n 1 || true)
    if [ -n "$container" ] && [ "$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || true)" = healthy ]; then return 0; fi
    sleep 5
    waited=$((waited + 5))
  done
  return 1
}

# The address the account gave this server, as `seira status` reads it from the server's own sign-in record. A log is
# never read for it: anything that can print a line could print a false one.
tunnel_address() {
  compose exec -T seira seira status 2>/dev/null | sed -n 's#^Seira web address: \(http[s]*://[^ ]*\) .*#\1#p' | head -n 1
}

# True only for exactly https://c-<32 lowercase hex>.<suffix>, with no port, path or other label.
tunnel_host_allowed() { # address
  host=${1#https://}
  [ "$host" != "$1" ] || return 1
  case "$host" in *[!a-z0-9.-]*) return 1 ;; esac
  label=${host%%.*}
  zone=${host#*.}
  case "$label" in c-????????????????????????????????) ;; *) return 1 ;; esac
  case "${label#c-}" in *[!0-9a-f]*) return 1 ;; esac
  # Seira's own zone, and the one SEIRA_TUNNEL_HOST_SUFFIX names when you also run an account service of your own
  # (SEIRA_CONTROL_PLANE_URL), as the server itself allows.
  suffixes=seira.run
  plane=${SEIRA_CONTROL_PLANE_URL:-$(env_value SEIRA_CONTROL_PLANE_URL)}
  extra=${SEIRA_TUNNEL_HOST_SUFFIX:-$(env_value SEIRA_TUNNEL_HOST_SUFFIX)}
  if [ -n "$plane" ] && [ -n "$extra" ]; then suffixes="$suffixes $extra"; fi
  for suffix in $suffixes; do
    if [ "$zone" = "$suffix" ]; then return 0; fi
  done
  return 1
}

tunnel_answers() { # address
  curl -fsS --max-time 10 "$1/api/health" 2>/dev/null | grep -q -e seira -e openmausbot
}

wait_tunnel() { # sets ADDRESS once the tunnel's address answers as Seira
  waited=0
  while [ "$waited" -lt "$TUNNEL_WAIT_S" ]; do
    found=$(tunnel_address || true)
    if [ -n "$found" ]; then
      tunnel_host_allowed "$found" || fail "The address this server was given is not one that Seira issues, so the installer does not use it. Run this again; if it is the same, tell us."
      if tunnel_answers "$found"; then
        ADDRESS=$found
        return 0
      fi
    fi
    sleep 5
    waited=$((waited + 5))
  done
  return 1
}

account_email() {
  sed -n 's/.*"companionAccountEmail"[^"]*"\([^"]*\)".*/\1/p' "$INSTALL_DIR/data/.seira/tunnel-account.json" 2>/dev/null | head -n 1
}

account_signed_in() {
  grep -q '"companionAccountEmail"' "$INSTALL_DIR/data/.seira/tunnel-account.json" 2>/dev/null
}

# The last error sentence `seira login` wrote, with anything that looks like a code taken out.
login_problem() { # file
  tail -n 1 "$1" 2>/dev/null | sed 's/[0-9]\{8\}/********/g'
}

run_login() { # the code is read from standard input with --events
  if [ "$EVENTS" = yes ]; then
    compose run --rm --no-deps -T seira seira login --email "$ACCOUNT_EMAIL" --events
  elif [ -n "$ACCOUNT_EMAIL" ]; then
    compose run --rm --no-deps -T seira seira login --email "$ACCOUNT_EMAIL"
  else
    compose run --rm --no-deps -T seira seira login
  fi
}

# Signs this server in to the Seira account in a one-off container on the data folder, before the server starts. The
# code comes from the person's terminal, or with --events on this installer's standard input as a "code" line. The
# login asks for it, tries up to three times, and is never given the code in an argument or a file.
sign_in_account() {
  if account_signed_in; then return 0; fi
  login_error=$(mktemp)
  login_ok=no
  if [ "$EVENTS" = yes ]; then
    if run_login 2>"$login_error"; then login_ok=yes; fi
  else
    say "Signing this server in to your Seira account. Seira emails a code: type it when asked."
    if run_login </dev/tty 2>"$login_error"; then login_ok=yes; fi
  fi
  reason=$(login_problem "$login_error")
  rm -f "$login_error"
  if [ "$login_ok" = yes ]; then
    if account_signed_in; then return 0; fi
    reason="The sign-in did not finish."
  fi
  if [ "$EVENTS" = yes ]; then fail "${reason:-Signing in to your Seira account did not work.}"; fi
  fail "Signing in to your Seira account did not work${reason:+: $reason}. Run this again to try once more."
}

https_answers() {
  curl -fsS --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" 2>/dev/null | grep -q -e seira -e openmausbot
}

wait_https() {
  waited=0
  while [ "$waited" -lt "$HTTPS_WAIT_S" ]; do
    if https_answers; then return 0; fi
    sleep 5
    waited=$((waited + 5))
  done
  return 1
}

# An install's folder, or its data, that others may write to (made by hand, or by an installer before this one) is closed
# to them: root runs what is in it.
close_to_others() { # folder, judged where a link to it leads
  if [ -n "$(find -H "$1" -prune \( -perm -020 -o -perm -002 \) 2>/dev/null)" ]; then
    chmod go-w "$1"
    note "$1 could be changed by others on this server; now only its owner can change it."
  fi
}

# A new folder is made 755; one that is there keeps its own mode, only closed to others when it was open (a folder its
# owner made 700 stays 700).
make_folders() { # folder...
  for folder in "$@"; do
    if [ -d "$folder" ]; then close_to_others "$folder"; else install -d -m 755 "$folder"; fi
  done
}

install_server() {
  say ""
  say "Installing Seira in $INSTALL_DIR..."
  step files
  if [ -d "$INSTALL_DIR/data" ]; then close_to_others "$INSTALL_DIR/data"; fi
  if [ "$TUNNEL" = yes ]; then
    make_folders "$INSTALL_DIR"
  else
    make_folders "$INSTALL_DIR" "$INSTALL_DIR/caddy" "$INSTALL_DIR/caddy/data" "$INSTALL_DIR/caddy/config"
  fi
  write_compose
  if [ "$TUNNEL" != yes ]; then write_caddyfile; fi
  write_settings
  step_done
  step image
  say "Downloading Seira..."
  compose_quietly pull -q || fail "Seira could not be downloaded (Docker's message is above). Check this server's outbound HTTPS, then run this again."
  step_done
  place_update
  step sandbox
  prepare_sandbox
  prepare_data
  place_button
  step_done
  if [ "$TUNNEL" = yes ]; then
    step signin
    sign_in_account
    step_done
  fi
  step start
  say "Starting Seira..."
  compose_quietly up -d --remove-orphans || fail "Seira could not be started (Docker's message is above). Fix that, then run this again."
  step_done
  step health
  wait_healthy || fail "Seira started but did not report healthy within $HEALTH_WAIT_S seconds. Its log: cd $INSTALL_DIR && sudo docker compose logs seira --tail 50"
  check_sandbox_runs
  if [ "$BUTTON_PLACED" = yes ]; then sh "$INSTALL_DIR/update-runner.sh" --dir "$INSTALL_DIR" >/dev/null 2>&1 || true; fi
  if [ "$TUNNEL" = yes ]; then
    step_done
    step tunnel
    say "Waiting for the address your Seira account gives this server..."
    wait_tunnel || fail "Seira is running, but its address did not answer within $TUNNEL_WAIT_S seconds. Run this again to try once more. Its log: cd $INSTALL_DIR && sudo docker compose logs seira --tail 50"
    event address "$ADDRESS"
    step_done
    return
  fi
  ADDRESS="https://$DOMAIN"
  say "Waiting for the HTTPS certificate of $DOMAIN..."
  wait_https || fail "Seira is running, but https://$DOMAIN did not answer within $HTTPS_WAIT_S seconds, usually because the certificate could not be issued. Check that $DOMAIN points at this server and that ports 80 and 443 are open in your provider's firewall, then run this again. Caddy's reason: cd $INSTALL_DIR && sudo docker compose logs caddy --tail 30"
  step_done
  event address "$ADDRESS"
}

# The connector has its own installer, which Seira serves with its address and the connector's image filled in.
# It is run as it is, with the code.
connect_server() {
  say ""
  say "Connecting this server to Seira..."
  connector_script="${SEIRA_CONNECTOR_INSTALLER:-}"
  fetched=""
  if [ -z "$connector_script" ]; then
    fetched=$(mktemp)
    connector_script=$fetched
    if ! curl -fsSL --max-time 60 "$ADMIN_URL/install.sh" -o "$connector_script"; then
      rm -f "$fetched"
      fail "Seira is installed and running here, but the connector's installer could not be downloaded from $ADMIN_URL. Nothing needs reinstalling: run this again with your code once that address answers."
    fi
  fi
  if ! grep -q 'seira-connector' "$connector_script" 2>/dev/null; then
    [ -z "$fetched" ] || rm -f "$fetched"
    fail "Seira is installed and running here, but what $ADMIN_URL sent is not the connector's installer. Nothing needs reinstalling: copy the install command from Seira again."
  fi
  # Always customer-run, on this install's folder (--dir included): the connector attaches to the server installed here
  # and never starts a second one beside it. A connector installer that does not know --customer-run refuses it, and
  # nothing is connected.
  status=0
  if [ "$INSTALL_DOCKER" = 1 ]; then
    SEIRA_ADMIN_URL="$ADMIN_URL" SEIRA_INSTALL_DIR="$INSTALL_DIR" sh "$connector_script" "$CODE" --customer-run --install-docker || status=$?
  else
    SEIRA_ADMIN_URL="$ADMIN_URL" SEIRA_INSTALL_DIR="$INSTALL_DIR" sh "$connector_script" "$CODE" --customer-run || status=$?
  fi
  [ -z "$fetched" ] || rm -f "$fetched"
  [ "$status" = 0 ] || fail "Seira is installed and running here, but connecting it did not finish (the reason is above). Nothing needs reinstalling: fix that and run this again with a new code."
}

# The first admin's one-time sign-in link, as `seira pair` prints it: its code line (until when it works) and the
# link. Nothing when the server would not make one.
first_admin_link() {
  made=$(compose exec -T seira seira pair --label "First admin" --ttl 10m 2>/dev/null) || return 1
  lines=$(printf '%s\n' "$made" | grep -E '^(Pairing code|Link) ' || true)
  case "$lines" in *"Link "*"$ADDRESS/pair#code="*) printf '%s\n' "$lines" | sed 's/^/  /' ;; *) return 1 ;; esac
}

finish() {
  say ""
  say "Seira is running at $ADDRESS"
  say ""
  pair_command="cd $INSTALL_DIR && sudo docker compose exec seira seira pair --label \"First admin\""
  # Only to an app that asked for events, or to a terminal: in a log, the link would let whoever reads it sign in as the
  # admin until it is used or expires.
  if [ "$EVENTS" = yes ]; then
    step pair
    link=$(first_admin_link) || fail "The one-time sign-in link for the first admin could not be made. Make one on this server with: $pair_command"
    event pair "$(printf '%s\n' "$link" | sed -n 's/^ *Link  *//p' | head -n 1)"
    step_done
    say "The one-time sign-in link for the first admin was handed to the app that runs this installer."
  elif [ -t 1 ] && link=$(first_admin_link); then
    say "To sign in as the first admin, open this one-time link in your browser. Anyone who has it can use it, once:"
    say "$link"
    say "To make another: $pair_command"
  else
    say "To sign in as the first admin, make a one-time link on this server and open it in your browser:"
    say "  $pair_command"
    [ -t 1 ] || say "(The link is not made here because this output is not a terminal: a log must not hold a link that signs in as the admin.)"
  fi
  admins=$(env_value SEIRA_SIGNIN_EMAILS)
  if [ -n "$admins" ]; then
    if [ -n "$(env_value SEIRA_SIGNIN_SMTP_URL)" ]; then
      say "Or open $ADDRESS/pair and sign in with an emailed code as: $admins"
    else
      say "Signing in with an emailed code needs a mail server: set SEIRA_SIGNIN_SMTP_URL (and SEIRA_SIGNIN_SMTP_FROM) in $INSTALL_DIR/.env, then run this again. The pairing link works without it."
    fi
  fi
  say ""
  if [ -x "$INSTALL_DIR/update.sh" ]; then
    say "To update later, with a backup first and a way back:  sudo $INSTALL_DIR/update.sh"
  else
    say "To update later, run this command again."
  fi
  say ""
  say "Settings: $INSTALL_DIR/.env    Your data: $INSTALL_DIR/data    Run this command again to repair."
  event done
}

# A rerun with neither --tunnel nor --domain keeps the mode the install already has.
resolve_mode() {
  if [ "$TUNNEL" != yes ] && [ -z "$DOMAIN" ] && [ "$(env_value SEIRA_ACCESS)" = tunnel ]; then TUNNEL=yes; fi
  if [ "$TUNNEL" != yes ] && [ -z "$DOMAIN" ]; then DOMAIN=$(env_value DOMAIN); fi
}

run_install() {
  need_root "$(if [ "$TUNNEL" = yes ]; then printf %s '--tunnel --account-email you@example.com'; else printf %s "--domain ${DOMAIN:-seira.example.com}"; fi)"
  resolve_mode
  if [ "$TUNNEL" != yes ]; then
    [ -n "$DOMAIN" ] || fail "Say which name people will open, like this: $(command_line '--domain seira.example.com')  Or use $(command_line '--tunnel --account-email you@example.com') for no domain."
  elif account_signed_in; then
    signed_as=$(account_email)
    if [ -n "$ACCOUNT_EMAIL" ] && [ -n "$signed_as" ] && [ "$(printf '%s' "$ACCOUNT_EMAIL" | tr 'A-Z' 'a-z')" != "$(printf '%s' "$signed_as" | tr 'A-Z' 'a-z')" ]; then
      fail "This server is already signed in as $signed_as. Run this again with --account-email $signed_as, or without --account-email."
    fi
  else
    if [ "$EVENTS" = yes ] && [ -z "$ACCOUNT_EMAIL" ]; then fail "--account-email is needed to sign this server in to your Seira account."; fi
    if [ "$EVENTS" != yes ] && ! tty_available; then fail "Signing in to your Seira account needs a terminal to type the emailed code in. Run this in an SSH session, or add --events and send the code as a line like: code 12345678"; fi
  fi
  preflight
  if [ "$FAILED" != 0 ]; then
    report_docker_missing
    fail "This server is not ready: fix the $FAILED line(s) marked FIX above, then run this again. Nothing was changed."
  fi
  if [ "$DOCKER_STATE" = missing ]; then
    step docker
    offer_docker
    step_done
  fi
  install_server
  if [ -n "$CODE" ]; then connect_server; fi
  finish
}

run_check() {
  resolve_mode
  preflight
  if [ "$FAILED" != 0 ]; then
    fail "This server is not ready: fix the $FAILED line(s) marked FIX above. Nothing was changed."
  fi
  say ""
  say "This server is ready for Seira. Nothing was changed."
  event done
}

# Stops the server and removes its containers. The data, the settings and the certificates stay where they are.
run_uninstall() {
  need_root --uninstall
  [ -f "$INSTALL_DIR/compose.yaml" ] || fail "Seira isn't installed in $INSTALL_DIR, so there is nothing to stop."
  command -v docker >/dev/null 2>&1 || fail "Docker isn't installed here, so Seira isn't running. Your data is in $INSTALL_DIR/data."
  say "Stopping Seira..."
  compose_quietly down --remove-orphans || fail "Seira could not be stopped (Docker's message is above)."
  if [ -f "$INSTALL_DIR/update-runner.sh" ]; then sh "$INSTALL_DIR/update-runner.sh" --remove --dir "$INSTALL_DIR" >/dev/null 2>&1 || true; fi
  say "Seira is stopped and its containers are removed."
  if [ "$(env_value SEIRA_ACCESS)" = tunnel ]; then
    say "Your data is kept in $INSTALL_DIR/data and your settings in $INSTALL_DIR/.env."
    say "To start it again: $(command_line "--tunnel")"
  else
    say "Your data is kept in $INSTALL_DIR/data, your settings in $INSTALL_DIR/.env and the HTTPS certificates in $INSTALL_DIR/caddy."
    say "To start it again: $(command_line "--domain $(env_value DOMAIN)")"
  fi
  say "This command never deletes your data. To delete it yourself: sudo rm -rf $INSTALL_DIR"
  if [ -f "$SYSROOT/etc/seira/$SECCOMP" ]; then
    say "The sandbox's two profiles stay on this server: /etc/seira/$SECCOMP and /etc/apparmor.d/$APPARMOR_PROFILE."
  fi
  if [ -n "$(docker ps -aq --filter name=seira-connector 2>/dev/null || true)" ]; then
    say "This server is still connected to Seira. To disconnect it, run the uninstall command Seira shows for the connector."
  fi
}

main() {
  # SECURITY: what this makes in the install's folder is run by root later (compose.yaml, update.sh), so its modes are
  # set here and by each write, never left to the caller's umask: a root shell with umask 000 would make them writable
  # by everyone on the server.
  umask 022
  settings
  case " $* " in *" --events "*) EVENTS=yes ;; esac
  parse "$@"
  case "$MODE" in
    check) run_check ;;
    uninstall) run_uninstall ;;
    *) run_install ;;
  esac
}

main "$@"
