#!/usr/bin/env bash
# Publishes the Seira Flatpak to the signed OSTree repository on Cloudflare R2.
#
#   scripts/linux-store/publish-flatpak.sh v<version> [--no-upload] [--init-repo]
#   scripts/linux-store/publish-flatpak.sh --write-refs | --check-refs
#
# Steps: sync the repo down from R2 into a cache, build the app, commit the build into the cache,
# update the repo (signed summary, static deltas, prune), make the release bundle, then upload.
# R2 is the source of truth. The cache is only a working copy.
# Every setting comes from an environment variable. See publish-flatpak.env.example.
set -euo pipefail

usage() {
  cat <<'EOF'
usage: publish-flatpak.sh <tag> [options]
       publish-flatpak.sh --write-refs | --check-refs

  <tag>              Release tag, for example v0.1.179. HEAD must be exactly this tag.
  --no-upload        Stop after the local repo and the bundle. Nothing is read from or sent to R2.
  --init-repo        Create a new repo when R2 has none. Use it for the first publish only.
  --repo-url URL     Repo URL for the bundle and the .flatpakref/.flatpakrepo files (test use).
                     Not allowed together with an upload.
  --out-dir DIR      Folder for the bundle and the generated files (default: release/).
  --use-build DIR    Use a finished flatpak-builder folder. Skip the build (test use).
  --skip-checks      Skip the tag, clean-tree, and version checks (test use).
  --write-refs       Write packaging/flatpak/seira.flatpakref and seira.flatpakrepo from the public key.
  --check-refs       Fail when those two files differ from what the public key gives.
EOF
}

APP_ID=bot.seira.Seira
BRANCH=stable
RUNTIME_REPO_URL=https://dl.flathub.org/repo/flathub.flatpakrepo
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG_DIR="$ROOT_DIR/packaging/flatpak"

BASE_URL="${SEIRA_FLATPAK_URL:-https://flatpak.seira.bot}"
BASE_URL="${BASE_URL%/}"
BUCKET="${SEIRA_FLATPAK_BUCKET:-seira-flatpak}"
RCLONE_REMOTE="${SEIRA_FLATPAK_RCLONE_REMOTE:-seira-r2}"
RCLONE_CONFIG_FILE="${SEIRA_FLATPAK_RCLONE_CONFIG:-}"
SIGN_HOME="${SEIRA_FLATPAK_GNUPGHOME:-${XDG_CONFIG_HOME:-$HOME/.config}/seira/flatpak-gnupg}"
PUBLIC_KEY="${SEIRA_FLATPAK_PUBLIC_KEY:-$PKG_DIR/seira-flatpak.asc}"
DATA_DIR="${SEIRA_FLATPAK_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/seira-flatpak}"
CACHE_DIR="${SEIRA_FLATPAK_CACHE_DIR:-$DATA_DIR/repo}"
BUILD_DIR="${SEIRA_FLATPAK_BUILD_DIR:-$DATA_DIR/build}"
STATE_DIR="${SEIRA_FLATPAK_STATE_DIR:-$DATA_DIR/builder-state}"
SOURCE_DIR="${SEIRA_FLATPAK_SOURCE_DIR:-$DATA_DIR/source}"
BUILDER_ARGS="${SEIRA_FLATPAK_BUILDER_ARGS:-}"

TAG=""
UPLOAD=1
INIT_REPO=0
REPO_URL=""
OUT_DIR="$ROOT_DIR/release"
USE_BUILD=""
SKIP_CHECKS=0
MODE=publish

while [ $# -gt 0 ]; do
  case "$1" in
    --no-upload) UPLOAD=0 ;;
    --init-repo) INIT_REPO=1 ;;
    --repo-url) REPO_URL="${2:?--repo-url needs a value}"; shift ;;
    --out-dir) OUT_DIR="${2:?--out-dir needs a value}"; shift ;;
    --use-build) USE_BUILD="${2:?--use-build needs a value}"; shift ;;
    --skip-checks) SKIP_CHECKS=1 ;;
    --write-refs) MODE=write-refs ;;
    --check-refs) MODE=check-refs ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) [ -z "$TAG" ] || { echo "only one tag is allowed" >&2; exit 2; }; TAG="$1" ;;
  esac
  shift
done

die() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

[ -f "$PUBLIC_KEY" ] || die "public key file not found: $PUBLIC_KEY"
need gpg
gpg_pub() { GNUPGHOME="$TMP/gpg-pub" gpg --batch --quiet "$@"; }
mkdir -m 700 "$TMP/gpg-pub"
gpg_pub --dearmor < "$PUBLIC_KEY" > "$TMP/key.gpg"
KEY_B64="$(base64 -w0 < "$TMP/key.gpg")"
PUBLIC_FPR="$(gpg_pub --show-keys --with-colons "$PUBLIC_KEY" | awk -F: '$1 == "fpr" { print $10; exit }')"
[ -n "$PUBLIC_FPR" ] || die "no key found in $PUBLIC_KEY"
SIGN_KEY="${SEIRA_FLATPAK_GPG_KEY:-$PUBLIC_FPR}"

render_ref() { # $1 = repo URL
  cat <<EOF
[Flatpak Ref]
Title=Seira
Name=$APP_ID
Branch=$BRANCH
Url=$1
SuggestRemoteName=seira
Homepage=https://seira.bot
IsRuntime=false
RuntimeRepo=$RUNTIME_REPO_URL
GPGKey=$KEY_B64
EOF
}

render_repo() { # $1 = repo URL
  cat <<EOF
[Flatpak Repo]
Title=Seira
Url=$1
Homepage=https://seira.bot
Comment=Seira for Linux
Description=Your own team of AI agents in one chat app.
DefaultBranch=$BRANCH
GPGKey=$KEY_B64
EOF
}

DEFAULT_REPO_URL="$BASE_URL/repo/"
EFFECTIVE_URL="${REPO_URL:-$DEFAULT_REPO_URL}"
case "$EFFECTIVE_URL" in */) ;; *) EFFECTIVE_URL="$EFFECTIVE_URL/" ;; esac

if [ "$MODE" = write-refs ]; then
  render_ref "$EFFECTIVE_URL" > "$PKG_DIR/seira.flatpakref"
  render_repo "$EFFECTIVE_URL" > "$PKG_DIR/seira.flatpakrepo"
  echo "wrote $PKG_DIR/seira.flatpakref and $PKG_DIR/seira.flatpakrepo"
  exit 0
fi
if [ "$MODE" = check-refs ]; then
  render_ref "$EFFECTIVE_URL" | diff -u "$PKG_DIR/seira.flatpakref" - || die "seira.flatpakref differs from the public key"
  render_repo "$EFFECTIVE_URL" | diff -u "$PKG_DIR/seira.flatpakrepo" - || die "seira.flatpakrepo differs from the public key"
  echo "refs match the public key"
  exit 0
fi

[ -n "$TAG" ] || { usage >&2; exit 2; }
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$ ]] || die "tag must look like v0.1.179"
VERSION="${TAG#v}"
[ "$UPLOAD" = 0 ] || [ -z "$REPO_URL" ] || die "--repo-url is only for --no-upload runs"

if [ "$SKIP_CHECKS" = 0 ]; then
  head_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  tag_sha="$(git -C "$ROOT_DIR" rev-parse --verify --quiet "refs/tags/$TAG^{commit}")" || die "tag $TAG does not exist here"
  [ "$head_sha" = "$tag_sha" ] || die "HEAD is not at $TAG"
  [ -z "$(git -C "$ROOT_DIR" status --porcelain)" ] || die "the working tree is not clean"
  pkg_version="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$ROOT_DIR/package.json" | head -1)"
  [ "$pkg_version" = "$VERSION" ] || die "package.json has version $pkg_version, not $VERSION"
fi

need flatpak
need ostree
[ -n "$USE_BUILD" ] || need flatpak-builder
[ "$UPLOAD" = 0 ] || need rclone
[ -d "$SIGN_HOME" ] || die "signing key folder not found: $SIGN_HOME (set SEIRA_FLATPAK_GNUPGHOME)"
GNUPGHOME="$SIGN_HOME" gpg --batch --list-secret-keys "$SIGN_KEY" >/dev/null 2>&1 || die "signing key $SIGN_KEY is not in $SIGN_HOME"
[ "$SIGN_KEY" = "$PUBLIC_FPR" ] || [ "$SIGN_KEY" = "${PUBLIC_FPR: -16}" ] || die "signing key does not match the public key file"

rc() {
  local conf=()
  [ -z "$RCLONE_CONFIG_FILE" ] || conf=(--config "$RCLONE_CONFIG_FILE")
  rclone "${conf[@]}" --s3-no-check-bucket "$@"
}
DEST="$RCLONE_REMOTE:$BUCKET"
# Files that are never part of the public repo.
LOCAL_ONLY=(--exclude "/tmp/**" --exclude "/.lock" --exclude "/state/**")
APP_REF="app/$APP_ID/x86_64/$BRANCH"

mkdir -p "$DATA_DIR" "$OUT_DIR"

# 1. R2 is the source of truth: bring the cache up to date first.
if [ "$UPLOAD" = 1 ]; then
  echo "== sync down from R2"
  listing="$(rc lsf --max-depth 1 "$DEST/repo/" 2>/dev/null)" && status=0 || status=$?
  if [ "$status" -ne 0 ] && [ "$status" -ne 3 ]; then die "cannot list the bucket (rclone exit $status)"; fi
  if grep -qx 'config' <<<"$listing"; then
    mkdir -p "$CACHE_DIR"
    rc sync "$DEST/repo" "$CACHE_DIR" "${LOCAL_ONLY[@]}"
  else
    [ "$INIT_REPO" = 1 ] || die "the bucket has no repo. Use --init-repo for the first publish only."
    [ ! -e "$CACHE_DIR/config" ] || die "the bucket has no repo, but $CACHE_DIR has one. Move that folder away, or set SEIRA_FLATPAK_CACHE_DIR to an empty folder."
    echo "bucket has no repo yet; a new one is made"
  fi
fi
if [ ! -f "$CACHE_DIR/config" ]; then
  [ "$UPLOAD" = 0 ] || [ "$INIT_REPO" = 1 ] || die "cache has no repo after the sync"
  mkdir -p "$CACHE_DIR"
  ostree init --mode=archive-z2 --repo="$CACHE_DIR"
fi

# 2. Build from a clean export of HEAD, so no untracked file enters the build.
if [ -z "$USE_BUILD" ]; then
  echo "== build"
  need git
  rm -rf "$SOURCE_DIR"
  mkdir -p "$SOURCE_DIR" "$STATE_DIR"
  git -C "$ROOT_DIR" archive HEAD | tar -x -C "$SOURCE_DIR"
  # shellcheck disable=SC2086
  flatpak-builder --force-clean --state-dir="$STATE_DIR" $BUILDER_ARGS \
    "$BUILD_DIR" "$SOURCE_DIR/packaging/flatpak/$APP_ID.yml"
  USE_BUILD="$BUILD_DIR"
fi
[ -d "$USE_BUILD/files" ] || die "not a finished build folder: $USE_BUILD"

# 3. Commit the build into the cache. The commit is signed.
echo "== export"
flatpak build-export --subject="Seira $VERSION" --gpg-sign="$SIGN_KEY" --gpg-homedir="$SIGN_HOME" \
  "$CACHE_DIR" "$USE_BUILD" "$BRANCH"

# 4. Update the summary (signed), static deltas, and prune to 3 versions.
echo "== update repo"
flatpak build-update-repo --generate-static-deltas --prune --prune-depth=2 \
  --default-branch="$BRANCH" --title=Seira --comment="Seira for Linux" --homepage=https://seira.bot \
  --gpg-import="$TMP/key.gpg" --gpg-sign="$SIGN_KEY" --gpg-homedir="$SIGN_HOME" "$CACHE_DIR"

ostree --repo="$CACHE_DIR" refs | grep -qx "$APP_REF" || die "repo has no $APP_REF"
ostree --repo="$CACHE_DIR" summary --view | grep -q "$APP_REF" || die "summary does not list $APP_REF"
[ -s "$CACHE_DIR/summary.sig" ] || die "summary is not signed"
commit="$(ostree --repo="$CACHE_DIR" rev-parse "$APP_REF")"
echo "commit $commit"

# 5. Bundle and generated files.
echo "== bundle"
BUNDLE="$OUT_DIR/Seira-$VERSION-x86_64.flatpak"
flatpak build-bundle --repo-url="$EFFECTIVE_URL" --runtime-repo="$RUNTIME_REPO_URL" \
  --gpg-keys="$TMP/key.gpg" "$CACHE_DIR" "$BUNDLE" "$APP_ID" "$BRANCH"
render_ref "$EFFECTIVE_URL" > "$OUT_DIR/seira.flatpakref"
render_repo "$EFFECTIVE_URL" > "$OUT_DIR/seira.flatpakrepo"
cp "$TMP/key.gpg" "$OUT_DIR/seira-flatpak.gpg"
echo "bundle $BUNDLE"

if [ "$UPLOAD" = 0 ]; then
  echo "done (no upload). commit=$commit"
  exit 0
fi

# 6. Upload. Order matters: files that a client reads first go last.
echo "== upload"
IMMUTABLE='Cache-Control: public, max-age=31536000, immutable'
NOCACHE='Cache-Control: no-cache'
rc copy "$CACHE_DIR" "$DEST/repo" --ignore-existing --header-upload "$IMMUTABLE" \
  --include "/objects/**" --include "/deltas/**" --include "/summaries/**"
rc copy "$CACHE_DIR" "$DEST/repo" --checksum --header-upload "$NOCACHE" "${LOCAL_ONLY[@]}" \
  --exclude "/objects/**" --exclude "/deltas/**" --exclude "/summaries/**" --exclude "/summary*"
for f in summary.sig summary summary.idx.sig summary.idx; do
  [ ! -f "$CACHE_DIR/$f" ] || rc copyto "$CACHE_DIR/$f" "$DEST/repo/$f" --header-upload "$NOCACHE"
done
rc copyto "$OUT_DIR/seira.flatpakref" "$DEST/seira.flatpakref" --header-upload "$NOCACHE" \
  --header-upload "Content-Type: application/vnd.flatpak.ref"
rc copyto "$OUT_DIR/seira.flatpakrepo" "$DEST/seira.flatpakrepo" --header-upload "$NOCACHE" \
  --header-upload "Content-Type: application/vnd.flatpak.repo"
rc copyto "$OUT_DIR/seira-flatpak.gpg" "$DEST/seira-flatpak.gpg" --header-upload "$NOCACHE"

# 7. Delete stale remote files only after the new summary is up.
echo "== remove stale files"
[ -f "$CACHE_DIR/refs/heads/$APP_REF" ] || ostree --repo="$CACHE_DIR" refs | grep -qx "$APP_REF" || die "cache looks incomplete; no delete"
rc sync "$CACHE_DIR" "$DEST/repo" --ignore-existing --delete-after "${LOCAL_ONLY[@]}"

echo "published $TAG ($commit) to $BASE_URL/repo/"
echo "attach the bundle: gh release upload $TAG $BUNDLE --repo seira-bot/seira"
